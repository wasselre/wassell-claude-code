/**
 * runMigrationJob — the durable-queue replacement for the Data Migration
 * wizard's long AI vision work, ported out of the browser
 * (src/pages/DataMigration/lib/jobRunner.ts) so it can run on the Fly worker
 * with NO wall-clock ceiling. Three job kinds:
 *
 *   - 'extract'  : the WHOLE extraction run. records-mode = source fusion
 *                  (discover → fuse_batch per ~20 units, auto-split on
 *                  truncation, conflict capture); project-mode = one aggregated
 *                  row + the Arabic marketing document. discover/fuse are NOT
 *                  separate jobs — keeping them in one run preserves the unit
 *                  index, the fuse prompt-cache, and the auto-split logic.
 *   - 'plan'     : one pre-extraction clarify-chat turn (reads the files).
 *   - 'discuss'  : one post-extraction recount/revise chat turn (re-reads files,
 *                  may edit the raw table).
 *
 * Writes flow ONLY through here (and the enqueue endpoint) — never the browser —
 * so the realtime echo-dedup never suppresses a worker update. Every write uses
 * record_save + p_expected_version + retry-on-40001 (the image-chats posture in
 * runImageJob.ts) so a stray concurrent write (or the enqueue's own busy-flag
 * write) can't clobber progress.
 *
 * The extraction logic itself is the copied migrateAgent.ts — this file is only
 * the orchestration wrapper. KEEP fuseResolved / buildFusionSummary /
 * applyDiscussColumns / FUSE_BATCH_SIZE in sync with jobRunner.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import {
  runExtract,
  runDiscover,
  runFuseBatch,
  runDiscuss,
  runPlan,
  type ExtractFileInput,
  type TargetFieldLite,
  type DiscoveredUnit,
  type FuseBatchResult,
  type EnrichColumn,
  type PlanColumn,
  type PlanQuestion,
} from './migrateAgent.js';

/** Shape of a claimed data_migration_jobs row. */
export interface MigrationJob {
  /** data_migration_jobs.id */
  id: string;
  /** records.id — the data_migration record. */
  recordId: string;
  /** auth.users.id of the submitter (scopes signed-URL minting). */
  userId: string;
  kind: 'plan' | 'extract' | 'discuss' | 'import';
  /** Frozen turn-specific snapshot (see per-kind payload reads). */
  payload: Record<string, unknown>;
  attempts: number;
}

const MIGRATIONS_BUCKET = 'wassel-migrations';
/** Units per fusion batch. Keep in sync with jobRunner.ts — a throughput knob,
 * not a correctness one (a batch that still truncates auto-splits). */
const FUSE_BATCH_SIZE = 20;
/** Signed-URL lifetime per Anthropic call. Re-minted before discover and before
 * each fuse batch so a long multi-batch run never trips URL expiry. */
const SIGNED_URL_TTL = 3600;
const MAX_SAVE_ATTEMPTS = 6;

interface SourceFile {
  path: string;
  name: string;
  mimeType: string;
  size?: number;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
}

interface RawTableShape {
  headers: string[];
  rows: string[][];
  notes?: string;
  summary?: string;
  truncated?: boolean;
  source?: string;
  conflicts?: unknown[];
  sources?: unknown[];
  row_keys?: string[];
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: MigrationJob;
}

function isVersionConflict(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '40001' || /version_mismatch/i.test(err.message ?? '');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Bilingual extraction summary — ports buildFusionSummary from jobRunner.ts. */
function buildFusionSummary(
  isAr: boolean,
  files: number,
  sources: { name: string }[],
  unitsDiscovered: number,
  resolved: number,
  conflictCount: number,
  discoverNotes?: string,
): string {
  const srcList = sources.map((s) => s.name).filter(Boolean).join('، ');
  const head = isAr
    ? `حلّلت ${files} ملف${srcList ? ` (${srcList})` : ''} وربطت الحقائق لكل وحدة من جميع المصادر. اكتُشفت ${unitsDiscovered} وحدة، تم حلّ ${resolved} منها. ${conflictCount} تعارض/تنبيه بحاجة لمراجعة.`
    : `Analyzed ${files} file(s)${srcList ? ` (${srcList})` : ''} and fused facts per unit across all sources. Discovered ${unitsDiscovered} units, resolved ${resolved}. ${conflictCount} conflict(s)/warning(s) flagged for review.`;
  return discoverNotes ? `${head}\n\n${discoverNotes}` : head;
}

/** Merge AI discuss-column edits into a raw table — ports applyDiscussColumns
 * from StepReviewRaw.tsx (existing header → fill/overwrite with non-empty
 * values; unknown header → append a new column). */
function applyDiscussColumns(table: RawTableShape, columns: EnrichColumn[]): RawTableShape {
  const headers = [...table.headers];
  const rows = table.rows.map((r) => [...r]);
  for (const col of columns) {
    let idx = headers.findIndex((h) => h.trim() === col.header.trim());
    if (idx === -1) {
      headers.push(col.header);
      idx = headers.length - 1;
    }
    rows.forEach((r, i) => {
      while (r.length <= idx) r.push('');
      const val = (col.values[i] ?? '').trim();
      if (val) r[idx] = val;
    });
  }
  return { ...table, headers, rows };
}

export async function runMigrationJob({ supabase, env, job }: RunArgs): Promise<Record<string, unknown>> {
  const apiKey = env.ANTHROPIC_API_KEY;
  const payload = job.payload ?? {};
  const language = payload.language === 'en' ? 'en' : 'ar';
  const isAr = language === 'ar';
  const fields = (Array.isArray(payload.fields) ? payload.fields : []) as TargetFieldLite[];

  // ── Resolve the data_migration model id (for record_save dispatch) ──────
  const { data: modelRow, error: modelErr } = await supabase
    .from('models')
    .select('id')
    .eq('name', 'data_migration')
    .single();
  if (modelErr || !modelRow) {
    throw new Error(`data_migration model not found: ${modelErr?.message ?? 'unknown'}`);
  }
  const modelId = modelRow.id as string;

  /** Read the freshest record data (+ version + owner) from records. */
  const readRecord = async (): Promise<{
    data: Record<string, unknown>;
    version: number | null;
    createdBy: string | null;
  }> => {
    const { data: row, error } = await supabase
      .from('records')
      .select('data, version, created_by_user_id')
      .eq('id', job.recordId)
      .single();
    if (error || !row) {
      throw new Error(`failed to read migration record ${job.recordId}: ${error?.message ?? 'not found'}`);
    }
    return {
      data: ((row.data as Record<string, unknown>) ?? {}) as Record<string, unknown>,
      version: (row as { version: number | null }).version ?? null,
      createdBy: (row as { created_by_user_id: string | null }).created_by_user_id ?? null,
    };
  };

  /**
   * Patch the record by merging `compute(freshData)` into records.data. Reads
   * the freshest row each attempt and saves with the optimistic version; on a
   * 40001 version-mismatch it re-reads and re-applies (so a stray concurrent
   * write can never drop a progress patch). Preserves created_by_user_id.
   */
  const patchRecord = async (
    compute: (data: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const { data, version, createdBy } = await readRecord();
      const newData = { ...data, ...compute(data) };
      const { error: saveErr } = await supabase.rpc('record_save', {
        p_model_id: modelId,
        p_id: job.recordId,
        p_data: newData,
        p_created_by: createdBy,
        p_expected_version: version,
      });
      if (!saveErr) return;
      if (isVersionConflict(saveErr as { code?: string; message?: string })) continue;
      throw new Error(`record_save failed: ${saveErr.message}`);
    }
    throw new Error(
      `record_save failed after ${MAX_SAVE_ATTEMPTS} version-conflict retries (record ${job.recordId})`,
    );
  };

  /** Mint fresh signed URLs for the record's source files (service role). */
  const signFiles = async (files: SourceFile[]): Promise<ExtractFileInput[]> => {
    const out: ExtractFileInput[] = [];
    for (const f of files) {
      const { data, error } = await supabase.storage
        .from(MIGRATIONS_BUCKET)
        .createSignedUrl(f.path, SIGNED_URL_TTL);
      if (error || !data?.signedUrl) {
        throw new Error(`could not sign "${f.name}": ${error?.message ?? 'no signed URL'}`);
      }
      out.push({ name: f.name, mimeType: f.mimeType, url: data.signedUrl });
    }
    return out;
  };

  const readSourceFiles = (data: Record<string, unknown>): SourceFile[] =>
    (Array.isArray(data.source_files) ? data.source_files : []) as SourceFile[];

  const isCancelled = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('data_migration_jobs')
      .select('status')
      .eq('id', job.id)
      .single();
    return (data?.status as string | undefined) === 'cancelled';
  };

  // Reflect a thrown failure onto the record so the SPA spinner exits via
  // Realtime (extract → status='failed'; plan/discuss → clear the busy flag,
  // status untouched), then rethrow so index.ts marks the job failed.
  try {
  // ─────────────────────────────────────────────────────────────────────
  if (job.kind === 'extract') {
    const mode = payload.mode === 'project' ? 'project' : 'records';
    const guidance = typeof payload.guidance === 'string' ? payload.guidance : undefined;
    const { data: rec0 } = await readRecord();
    const sourceFiles = readSourceFiles(rec0);
    if (sourceFiles.length === 0) throw new Error('No source files to extract.');

    if (mode === 'project') {
      await patchRecord(() => ({ status: 'extracting', phase: 'analyzing', error_message: null }));
      const files = await signFiles(sourceFiles);
      const result = await runExtract(apiKey, files, language, fields, 'project', guidance);
      await patchRecord(() => ({
        raw_table: {
          headers: result.headers,
          rows: result.rows,
          notes: result.notes,
          summary: result.summary,
          truncated: result.truncated,
          source: 'ai_extract',
        },
        project_document: result.document,
        project_intelligence: result.intelligence,
        step: 'review_raw',
        status: 'draft',
        phase: null,
        error_message: null,
      }));
      return { mode, rows: result.rows.length };
    }

    // ── records-mode source fusion: discover → batched fuse → assemble ──
    await patchRecord(() => ({ status: 'extracting', phase: 'discovering', progress_done: 0, progress_total: null, error_message: null }));
    const disc = await runDiscover(apiKey, await signFiles(sourceFiles), language, fields, guidance);

    const headers = disc.headers;
    await patchRecord(() => ({ phase: 'fusing', progress_done: 0, progress_total: disc.units.length }));

    const rows: string[][] = [];
    const rowKeys: string[] = [];
    const conflicts: unknown[] = [];
    const seen = new Set<string>();
    let resolved = 0;

    for (const batch of chunk(disc.units, FUSE_BATCH_SIZE)) {
      if (await isCancelled()) {
        await patchRecord(() => ({ status: 'draft', phase: null, error_message: null }));
        return { cancelled: true };
      }
      // Re-sign per batch so a long run never trips the URL TTL.
      const batchFiles = await signFiles(sourceFiles);
      const fused = await fuseResolved(apiKey, batchFiles, language, fields, headers, batch, guidance);
      const byKey = new Map(fused.rows.map((r) => [r.key, r.values]));
      for (const u of batch) {
        if (seen.has(u.key)) continue; // de-dup defensively across batches
        seen.add(u.key);
        rowKeys.push(u.key);
        const vals = byKey.get(u.key);
        if (vals && vals.length > 0) {
          rows.push(vals.length === headers.length ? vals : headers.map((_, i) => vals[i] ?? ''));
          resolved += 1;
        } else {
          // Never silently drop a discovered unit — blank row + loud note.
          rows.push(headers.map(() => ''));
          conflicts.push({
            rowKey: u.key,
            header: '',
            candidates: [],
            chosen: '',
            note: isAr
              ? `لم تُرجع المعالجة بيانات للوحدة ${u.key} — تحقّق يدويًا.`
              : `Fusion returned no data for unit ${u.key} — verify manually.`,
          });
        }
      }
      conflicts.push(...fused.conflicts);
      await patchRecord(() => ({ progress_done: rows.length, progress_total: disc.units.length }));
    }

    // Zero rows from a non-empty unit index means something went wrong upstream
    // — surface it, never bank an empty table as a success.
    if (rows.length === 0) {
      throw new Error(isAr ? 'لم يتم العثور على وحدات في الملفات.' : 'No units were found in the files.');
    }

    const skippedNote = disc.files_skipped.length
      ? (isAr ? 'تم تخطي: ' : 'Skipped: ') +
        disc.files_skipped.map((s) => `${s.name} (${s.reason})`).join('، ')
      : '';
    const notes = [disc.notes, skippedNote].filter(Boolean).join('\n\n') || undefined;

    await patchRecord(() => ({
      raw_table: {
        headers,
        rows,
        row_keys: rowKeys,
        conflicts,
        sources: disc.sources,
        notes,
        summary: buildFusionSummary(isAr, disc.files_processed, disc.sources, disc.units.length, resolved, conflicts.length, notes),
        truncated: disc.truncated,
        source: 'ai_extract',
      },
      step: 'review_raw',
      status: 'draft',
      phase: null,
      error_message: null,
    }));
    return { mode, rows: rows.length, conflicts: conflicts.length };
  }

  // ─────────────────────────────────────────────────────────────────────
  if (job.kind === 'plan') {
    const instructions = typeof payload.instructions === 'string' ? payload.instructions : undefined;
    const { data: rec0 } = await readRecord();
    const priorChat = (Array.isArray(rec0.prep_chat) ? rec0.prep_chat : []) as ChatTurn[];
    const files = await signFiles(readSourceFiles(rec0));
    const messages = priorChat.map((m) => ({ role: m.role, content: m.content }));

    const { reply, questions, proposedColumns, ready } = await runPlan(apiKey, {
      messages: messages.length ? messages : [{ role: 'user' as const, content: '(no message)' }],
      instructions,
      fields,
      files,
      language,
    });
    const now = new Date().toISOString();
    await patchRecord((data) => {
      const chat = (Array.isArray(data.prep_chat) ? data.prep_chat : []) as ChatTurn[];
      return {
        prep_chat: [...chat, { role: 'assistant', content: reply || (isAr ? 'تم.' : 'Done.'), ts: now }],
        prep_structure: proposedColumns as PlanColumn[],
        prep_questions: questions as PlanQuestion[],
        prep_ready: ready,
        prep_busy: false,
        error_message: null,
      };
    });
    return { questions: questions.length, ready };
  }

  // ─────────────────────────────────────────────────────────────────────
  if (job.kind === 'discuss') {
    const { data: rec0 } = await readRecord();
    const priorChat = (Array.isArray(rec0.chat) ? rec0.chat : []) as ChatTurn[];
    const table = (rec0.raw_table ?? { headers: [], rows: [] }) as RawTableShape;
    const files = await signFiles(readSourceFiles(rec0));

    // Seed the model with its own extraction summary (the conversation's
    // opening, shown separately in the UI — not stored in `chat`), then the
    // persisted thread. Mirrors the old client runAsk.
    const summary = typeof table.summary === 'string' ? table.summary : '';
    const { reply, columns } = await runDiscuss(apiKey, {
      messages: [
        ...(summary ? [{ role: 'assistant' as const, content: summary }] : []),
        ...priorChat.map((m) => ({ role: m.role, content: m.content })),
      ],
      headers: table.headers,
      rows: table.rows,
      fields,
      files,
      language,
    });
    const now = new Date().toISOString();
    await patchRecord((data) => {
      const chat = (Array.isArray(data.chat) ? data.chat : []) as ChatTurn[];
      const rt = (data.raw_table ?? { headers: [], rows: [] }) as RawTableShape;
      const patch: Record<string, unknown> = {
        chat: [...chat, { role: 'assistant', content: reply || (isAr ? 'تم.' : 'Done.'), ts: now }],
        discuss_busy: false,
        error_message: null,
      };
      if (columns.length > 0) patch.raw_table = applyDiscussColumns(rt, columns);
      return patch;
    });
    return { columns: columns.length };
  }

  throw new Error(`runMigrationJob: unsupported kind "${job.kind}" (import stays client-side)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchRecord(() => {
      if (job.kind === 'plan') return { prep_busy: false, error_message: msg };
      if (job.kind === 'discuss') return { discuss_busy: false, error_message: msg };
      return { status: 'failed', phase: null, error_message: msg };
    }).catch((e) => console.error(`[run-migration] could not reflect failure: ${(e as Error).message}`));
    throw err;
  }
}

/**
 * Resolve ONE batch of units by fusing facts across every source. On a
 * max_tokens truncation (the thrown Error carries code:'max_tokens') the batch
 * is split in half and each half retried recursively — so the output can never
 * overflow. A genuine non-truncation error still propagates (loud failure).
 * Conflicts are re-keyed from the unit key to the row key. Ports fuseResolved
 * from jobRunner.ts.
 */
async function fuseResolved(
  apiKey: string,
  files: ExtractFileInput[],
  language: 'ar' | 'en',
  fields: TargetFieldLite[],
  headers: string[],
  units: DiscoveredUnit[],
  guidance: string | undefined,
): Promise<{ rows: { key: string; values: string[] }[]; conflicts: unknown[] }> {
  try {
    const res: FuseBatchResult = await runFuseBatch(apiKey, files, language, fields, headers, units, guidance);
    return {
      rows: res.rows,
      conflicts: res.conflicts.map((c) => ({
        rowKey: c.unitKey,
        header: c.header,
        candidates: c.candidates,
        chosen: c.chosen,
        note: c.note,
      })),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'max_tokens' && units.length > 1) {
      const mid = Math.ceil(units.length / 2);
      const a = await fuseResolved(apiKey, files, language, fields, headers, units.slice(0, mid), guidance);
      const b = await fuseResolved(apiKey, files, language, fields, headers, units.slice(mid), guidance);
      return { rows: [...a.rows, ...b.rows], conflicts: [...a.conflicts, ...b.conflicts] };
    }
    throw err;
  }
}
