import { spawn } from 'node:child_process';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DaemonEnv } from './env.ts';
import type {
  PresentationErrorCode,
  PresentationJob,
  PresentationJobResult,
} from './types.ts';

/** Sentinel the slash command must emit on stdout before exiting. Everything
 *  after the prefix on the same line must be a single-line JSON object whose
 *  shape matches PresentationJobResult. The daemon parses the LAST sentinel it
 *  sees (templates are allowed to print drafts during the run), so writing a
 *  "final" sentinel at the end is always correct.
 *
 *  Progress sentinels use a second prefix; they update progress_stage /
 *  progress_message_* without finalizing the job. */
export const RESULT_SENTINEL_PREFIX = '###PRESENTATION-RESULT###';
export const PROGRESS_SENTINEL_PREFIX = '###PRESENTATION-PROGRESS###';

/** How much of tail stdout to keep when a job fails, for the detail page's
 *  collapsed "Technical detail" block. */
const ERROR_DETAIL_CHAR_BUDGET = 4_000;

/** Turn an inputs payload into a single positional argument for the slash
 *  command. The current templates (e.g. `/wassel`) accept a free-text brief;
 *  we stitch the user's inputs into a readable block rather than passing each
 *  field as a flag, which keeps template authors free to define their own
 *  input shape without teaching the daemon about it. */
function formatInputsAsBrief(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs);
  if (entries.length === 1 && typeof entries[0]![1] === 'string') {
    // Single-string input → pass the raw value, no labels. Matches how users
    // invoke `/wassel "project brief..."` interactively.
    return entries[0]![1] as string;
  }
  return entries
    .map(([k, v]) => {
      const display = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${display}`;
    })
    .join('\n');
}

function classifyError(tail: string, exitCode: number | null, reason?: 'timeout'): PresentationErrorCode {
  if (reason === 'timeout') return 'timeout';
  const lower = tail.toLowerCase();
  if (
    lower.includes('paseet.ai') &&
    (lower.includes('sign in') || lower.includes('login') || lower.includes('session'))
  ) {
    return 'chrome_session_expired';
  }
  if (lower.includes('drive') && (lower.includes('upload') || lower.includes('create_file'))) {
    return 'drive_upload_failed';
  }
  if (exitCode !== 0) return 'claude_error';
  return 'unknown';
}

/** Pull the last JSON payload following RESULT_SENTINEL_PREFIX out of a stdout
 *  buffer. Returns null when no well-formed sentinel is present. */
function extractResultSentinel(stdout: string): PresentationJobResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const idx = line.indexOf(RESULT_SENTINEL_PREFIX);
    if (idx === -1) continue;
    const after = line.slice(idx + RESULT_SENTINEL_PREFIX.length).trim();
    if (!after.startsWith('{')) continue;
    try {
      return JSON.parse(after) as PresentationJobResult;
    } catch {
      // Keep scanning earlier lines — a later malformed sentinel shouldn't
      // mask an earlier valid one.
    }
  }
  return null;
}

interface ProgressUpdate {
  stage?: string;
  message_ar?: string;
  message_en?: string;
}

function extractProgressSentinel(line: string): ProgressUpdate | null {
  const idx = line.indexOf(PROGRESS_SENTINEL_PREFIX);
  if (idx === -1) return null;
  const after = line.slice(idx + PROGRESS_SENTINEL_PREFIX.length).trim();
  if (!after.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(after) as ProgressUpdate;
    return parsed;
  } catch {
    return null;
  }
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('presentation_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) {
    console.error(`[runner] job ${jobId} update failed: ${error.message}`);
  }
}

export interface RunJobResult {
  terminalStatus: 'completed' | 'failed';
  errorCode?: PresentationErrorCode;
}

/**
 * Run one claimed job end-to-end: build the prompt, spawn `claude --print`,
 * tail stdout for progress + result sentinels, and write the final status
 * back to the row.
 */
export async function runJob(
  supabase: SupabaseClient,
  env: DaemonEnv,
  job: PresentationJob,
): Promise<RunJobResult> {
  const tpl = job.template_snapshot;
  const prompt = `${tpl.command} ${formatInputsAsBrief(job.inputs)}`.trim();

  console.log(`[runner] starting job ${job.id} — template=${tpl.slug}`);

  return new Promise<RunJobResult>((resolveRun) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    // Windows needs cmd.exe to launch claude.exe (shell:false fails with
    // STATUS_DLL_INIT_FAILED regardless of stdio configuration). cmd.exe on
    // most Windows installs defaults to the system ANSI code page for pipe
    // I/O, which turns Claude's UTF-8 stdout into mojibake before Node ever
    // sees it (em-dashes and Arabic come through as `â€"` / `Ø…`). We prefix
    // the command with `chcp 65001` to force UTF-8 end-to-end, and `> nul &`
    // to chain without polluting Claude's stdout.
    //
    // The prompt itself still goes through stdin — argv on Windows gets
    // re-encoded through the OEM code page even with chcp applied, and stdin
    // bypasses that path entirely.
    const claudeArgs = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'text',
      '--input-format', 'text',
    ];
    let spawnCmd: string;
    let spawnArgs: string[];
    if (process.platform === 'win32') {
      const quoted = (s: string): string => (/\s/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s);
      const cmdLine = `chcp 65001 > nul & ${quoted(env.claudeBin)} ${claudeArgs.map(quoted).join(' ')}`;
      spawnCmd = 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', cmdLine];
    } else {
      spawnCmd = env.claudeBin;
      spawnArgs = claudeArgs;
    }
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Write the prompt and close stdin so claude knows there's no more input.
    // Guard against a spawn error that fires before stdin is writable — the
    // 'error' handler above catches and classifies those.
    if (child.stdin) {
      child.stdin.on('error', () => {
        // Pipe closed prematurely (spawn error in flight). finish() will
        // handle it via the 'error' / 'close' listeners.
      });
      child.stdin.end(prompt, 'utf8');
    }

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      console.warn(`[runner] job ${job.id} timed out after ${env.jobTimeoutSeconds}s — killing`);
      child.kill('SIGTERM');
      // Force-kill shortly after in case SIGTERM is ignored (Windows especially).
      setTimeout(() => {
        if (!settled && !child.killed) child.kill('SIGKILL');
      }, 5_000);
    }, env.jobTimeoutSeconds * 1_000);

    const handleProgressLines = (chunk: string): void => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        const progress = extractProgressSentinel(line);
        if (progress) {
          void updateJob(supabase, job.id, {
            progress_stage: progress.stage ?? null,
            progress_message_ar: progress.message_ar ?? null,
            progress_message_en: progress.message_en ?? null,
          });
        }
      }
    };

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout += text;
      handleProgressLines(text);
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });

    const finish = async (exitCode: number | null, reason?: 'timeout' | 'spawn_error', spawnErr?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);

      const duration = Date.now() - startedAt;
      const result = extractResultSentinel(stdout);

      if (reason === 'spawn_error') {
        const msg = spawnErr?.message ?? 'spawn failed';
        await updateJob(supabase, job.id, {
          status: 'failed',
          error_code: 'claude_error',
          error_message: msg,
          error_detail: msg,
          finished_at: new Date().toISOString(),
          duration_ms: duration,
        });
        console.error(`[runner] job ${job.id} spawn error: ${msg}`);
        resolveRun({ terminalStatus: 'failed', errorCode: 'claude_error' });
        return;
      }

      const tail = (stdout + '\n' + stderr).slice(-ERROR_DETAIL_CHAR_BUDGET);

      if (result && result.ok) {
        await updateJob(supabase, job.id, {
          status: 'completed',
          result,
          drive_folder_url: result.drive_folder_url ?? null,
          drive_deck_url: result.drive_deck_url ?? null,
          progress_stage: null,
          progress_message_ar: null,
          progress_message_en: null,
          finished_at: new Date().toISOString(),
          duration_ms: duration,
        });
        console.log(
          `[runner] job ${job.id} completed in ${Math.round(duration / 1000)}s — ${result.drive_deck_url ?? '(no deck url)'}`,
        );
        resolveRun({ terminalStatus: 'completed' });
        return;
      }

      // Failed path: either the sentinel is missing, it reported ok=false, or
      // the exit code was non-zero.
      const errorCode = classifyError(tail, exitCode, reason);
      const errorMessage =
        reason === 'timeout'
          ? `timed out after ${env.jobTimeoutSeconds}s`
          : result && !result.ok
            ? (result.warnings?.[0] ?? 'command reported ok=false')
            : exitCode !== 0
              ? `claude exited with code ${exitCode}`
              : 'no result sentinel emitted';

      await updateJob(supabase, job.id, {
        status: 'failed',
        error_code: errorCode,
        error_message: errorMessage,
        error_detail: tail,
        result: result ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: duration,
      });
      console.warn(`[runner] job ${job.id} failed (${errorCode}): ${errorMessage}`);
      resolveRun({ terminalStatus: 'failed', errorCode });
    };

    child.on('error', (err) => {
      void finish(null, 'spawn_error', err instanceof Error ? err : new Error(String(err)));
    });
    child.on('close', (exitCode) => {
      void finish(exitCode, timedOut ? 'timeout' : undefined);
    });
  });
}
