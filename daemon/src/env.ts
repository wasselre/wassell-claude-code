import { config as loadDotenv } from 'dotenv';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

loadDotenv();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `[daemon] missing required env var ${name}. Copy daemon/.env.example to daemon/.env and fill it in.`,
    );
  }
  return v.trim();
}

function parseInt_(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[daemon] env var ${name} must be a positive integer; got: ${raw}`);
  }
  return n;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return resolve(homedir(), p.slice(p.startsWith('~/') || p.startsWith('~\\') ? 2 : 1));
  }
  return resolve(p);
}

export interface DaemonEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Resolved absolute path to the `claude` CLI, or the literal string 'claude'
   *  if the user left CLAUDE_BIN blank (rely on PATH). */
  claudeBin: string;
  /** Absolute path to the templates directory (e.g. `~/.claude/ppt/templates`). */
  templatesDir: string;
  /** Absolute path to the daemon log directory. Defaults to `daemon/logs`. */
  logDir: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  jobTimeoutSeconds: number;
}

export function loadEnv(): DaemonEnv {
  const defaultTemplates = resolve(homedir(), '.claude', 'ppt', 'templates');
  const templatesDir = process.env.TEMPLATES_DIR
    ? expandHome(process.env.TEMPLATES_DIR)
    : defaultTemplates;

  // Default log dir is `daemon/logs` relative to this file's package root.
  // `resolve` with a relative path resolves against `process.cwd()`, which is
  // the daemon folder when launched via `npm start`. That's the desired behavior.
  const logDir = process.env.LOG_DIR
    ? expandHome(process.env.LOG_DIR)
    : resolve('logs');

  const claudeBinRaw = (process.env.CLAUDE_BIN ?? '').trim();
  const claudeBin = claudeBinRaw === '' ? 'claude' : expandHome(claudeBinRaw);

  return {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    claudeBin,
    templatesDir,
    logDir,
    pollIntervalMs: parseInt_('POLL_INTERVAL_MS', 5_000),
    heartbeatIntervalMs: parseInt_('HEARTBEAT_INTERVAL_MS', 15_000),
    jobTimeoutSeconds: parseInt_('JOB_TIMEOUT_SECONDS', 1_800),
  };
}
