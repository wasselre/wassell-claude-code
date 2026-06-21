/**
 * Document generation job (document_jobs queue).
 *
 * Turns a CRM record into a branded A4 PDF generated from an authored template
 * (an ordinary wassel_doc with {{token}} placeholders, A4 page settings,
 * header/footer, embedded logo, terms, and signature sections):
 *
 *   1. Resolve {{tokens}} from the source record + its linked client / unit /
 *      project (the SAME formatting conventions as the in-app editor preview —
 *      see worker/src/documents/variables.ts).
 *   2. Stamp the tokens into a deep clone of the template's content_json.
 *   3. Build a branded DOCX (logo embedded) and convert it to PDF with headless
 *      LibreOffice — the SAME engine the office-preview queue uses (Arabic/Amiri
 *      render correctly; A4 + headers/footers from the template's page settings).
 *   4. Upload the PDF to wassel-files, INSERT a first-class `files` row
 *      (kind='pdf'), and link it to the client / unit / project records via
 *      document_links so it surfaces on each related record.
 *
 * This is ONE reusable engine — reservations, offers, financing, deed transfer,
 * contracts, brochures all flow through here; only the bound template differs.
 *
 * Throws on any failure — index.ts catches and routes to document_job_fail.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { buildDocxBuffer, type JSONContent } from './documents/docx.js';
import { normalizePageSettings } from './documents/pageSettings.js';
import {
  recordTitle,
  resolveDocVariables,
  replaceTextTokens,
  type DocLink,
  type DocModel,
  type DocRecord,
} from './documents/variables.js';

const FILES_BUCKET = 'wassel-files';
const PDF_MIME = 'application/pdf';
/** files.original_name has CHECK (length BETWEEN 1 AND 500). */
const MAX_NAME_LENGTH = 500;
/** Hard ceiling on a single soffice run (matches the office-preview queue). */
const CONVERT_TIMEOUT_MS = 240_000;
/** Conventional slug linking a unit to its project (all_projects). */
const UNIT_PROJECT_SLUG = 'project_id';

export interface DocumentJob {
  id: string;
  sourceRecordId: string;
  sourceModelId: string;
  templateId: string;
  templateFileId: string;
  targetFolderId: string | null;
  ownerUserId: string;
  ownerAuthUid: string;
  clientRecordId: string | null;
  unitRecordId: string | null;
  projectRecordId: string | null;
  attempts: number;
  templateLabelAr: string;
  templateLabelEn: string;
  contentJson: JSONContent;
  settings: unknown;
}

export interface RunDocumentJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: DocumentJob;
}

interface LoadedRecord {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
}

export async function runDocumentJob({ supabase, env, job }: RunDocumentJobArgs): Promise<string> {
  // Arabic-first company — templates read in Arabic and the editor preview uses
  // the app language; default ar so the generated PDF matches that preview.
  const isAr = true;
  const settings = normalizePageSettings(job.settings);

  // ── 1. Load models + every record we resolve tokens from ─────────────
  const { data: modelRows, error: mdlErr } = await supabase
    .from('models')
    .select('id, name, label_ar, label_en, schema');
  if (mdlErr || !modelRows) throw new Error(`models load failed: ${mdlErr?.message ?? 'no data'}`);
  const models = modelRows as unknown as DocModel[];

  const wantIds = [job.sourceRecordId, job.clientRecordId, job.unitRecordId, job.projectRecordId].filter(
    (x): x is string => !!x,
  );
  const loaded = await loadRecords(supabase, wantIds);
  const source = loaded.find((r) => r.id === job.sourceRecordId);
  if (!source) throw new Error(`source record not found: ${job.sourceRecordId}`);

  // Supplement with the unit's project (all_projects) so {{project_name}}
  // resolves reliably even when the source carries no explicit project link.
  const unit = job.unitRecordId ? loaded.find((r) => r.id === job.unitRecordId) : undefined;
  const unitProjectId = unit && typeof unit.data[UNIT_PROJECT_SLUG] === 'string'
    ? (unit.data[UNIT_PROJECT_SLUG] as string)
    : null;
  let unitProject: LoadedRecord | undefined;
  if (unitProjectId && !loaded.some((r) => r.id === unitProjectId)) {
    unitProject = (await loadRecords(supabase, [unitProjectId]))[0];
  } else if (unitProjectId) {
    unitProject = loaded.find((r) => r.id === unitProjectId);
  }

  // ── 2. Build the {slug → value} token map ────────────────────────────
  const allRecords = [...loaded, ...(unitProject && !loaded.includes(unitProject) ? [unitProject] : [])];
  const recordsMap: Record<string, DocRecord[]> = {};
  for (const r of allRecords) {
    (recordsMap[r.model_id] ??= []).push({ id: r.id, data: r.data });
  }
  // Synthetic ordered link list — first record carrying a slug wins, so source
  // overrides, then client, unit, the unit's project, then any explicit project.
  const orderedIds = [
    job.sourceRecordId,
    job.clientRecordId,
    job.unitRecordId,
    unitProject?.id ?? null,
    job.projectRecordId,
  ].filter((x): x is string => !!x);
  const links: DocLink[] = orderedIds
    .map((id) => {
      const r = allRecords.find((x) => x.id === id);
      return r ? { id: `synthetic-${id}`, model_id: r.model_id, record_id: id } : null;
    })
    .filter((x): x is DocLink => x !== null);

  const { values } = resolveDocVariables(links, models, recordsMap, isAr);

  // Engine-resolved tokens the generic walk can't produce.
  values.today = new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  // {{sales_rep}} — assignee resolves to a raw user id via the generic walk;
  // replace with the user's display name.
  const repName = await resolveAssigneeName(supabase, source.data.sales_rep);
  if (repName) values.sales_rep = repName;
  // {{client_phone}} — canonical KSA E.164 (clients store mixed formats).
  const client = job.clientRecordId ? loaded.find((r) => r.id === job.clientRecordId) : undefined;
  const clientPhone = client ? canonicalizeKsaPhone(String(client.data.phone_number ?? '')) : null;
  if (clientPhone) values.client_phone = clientPhone;

  // ── 3. Stamp tokens into a clone of the template content ─────────────
  const clone = JSON.parse(JSON.stringify(job.contentJson)) as JSONContent;
  const filled = replaceTextTokens(clone, values) as JSONContent;

  // ── 4. Build DOCX → PDF via LibreOffice ──────────────────────────────
  console.log(`[document] job=${job.id} building DOCX for record=${job.sourceRecordId}`);
  const docx = await buildDocxBuffer(filled, isAr, settings);

  const work = await mkdtemp(path.join(os.tmpdir(), 'wassel-document-'));
  let pdf: Buffer;
  try {
    const inPath = path.join(work, 'in.docx');
    const outDir = path.join(work, 'out');
    const profileDir = path.join(work, 'lo-profile');
    await writeFile(inPath, docx);

    console.log(`[document] job=${job.id} converting docx → pdf`);
    const t0 = Date.now();
    await runSoffice(env.SOFFICE_BIN, [
      '--headless',
      '--norestore',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      inPath,
    ]);
    const produced = (await readdir(outDir).catch(() => [] as string[])).find((f) =>
      f.toLowerCase().endsWith('.pdf'),
    );
    if (!produced) throw new Error('soffice produced no PDF output');
    pdf = await readFile(path.join(outDir, produced));
    console.log(`[document] job=${job.id} converted in ${Date.now() - t0}ms → ${pdf.length} bytes`);
  } finally {
    void rm(work, { recursive: true, force: true }).catch((err) => {
      console.error(`[document] tmp cleanup failed for ${work}:`, err);
    });
  }

  // ── 5. Upload + register the files row ───────────────────────────────
  const newFileId = randomUUID();
  const storagePath = `${job.ownerAuthUid}/${newFileId}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(FILES_BUCKET)
    .upload(storagePath, pdf, { contentType: PDF_MIME, upsert: false });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  const title = recordTitle(models.find((m) => m.id === job.sourceModelId), { id: source.id, data: source.data }, isAr);
  const label = isAr ? job.templateLabelAr : job.templateLabelEn;
  const fileName = buildPdfName(label, title);

  const { error: insErr } = await supabase.from('files').insert({
    id: newFileId,
    folder_id: job.targetFolderId,
    model_id: job.sourceModelId,
    record_id: job.sourceRecordId,
    uploaded_by_user_id: job.ownerUserId,
    original_name: fileName,
    mime_type: PDF_MIME,
    size_bytes: pdf.length,
    storage_bucket: FILES_BUCKET,
    storage_path: storagePath,
    kind: 'pdf',
  });
  if (insErr) {
    await supabase.storage
      .from(FILES_BUCKET)
      .remove([storagePath])
      .catch((e: unknown) => console.error(`[document] orphan cleanup failed for ${storagePath}:`, e));
    throw new Error(`files insert failed: ${insErr.message}`);
  }

  // ── 6. Link the PDF to client / unit / project (NOT the source — the
  //      source shows generated docs via its own panel; linking it too would
  //      double-list it in the source's LinkedDocumentsPanel). ────────────
  const linkTargets: Array<{ recordId: string; modelId: string }> = [];
  for (const id of [job.clientRecordId, job.unitRecordId, job.projectRecordId]) {
    if (!id) continue;
    const r = allRecords.find((x) => x.id === id);
    if (r) linkTargets.push({ recordId: id, modelId: r.model_id });
  }
  if (linkTargets.length > 0) {
    const { error: linkErr } = await supabase.from('document_links').insert(
      linkTargets.map((t) => ({
        file_id: newFileId,
        model_id: t.modelId,
        record_id: t.recordId,
        created_by_user_id: job.ownerUserId,
      })),
    );
    // Non-fatal: the PDF exists and is linked to the source via files.record_id;
    // a failed cross-link only means it won't show on the client/unit/project.
    if (linkErr) console.error(`[document] document_links insert failed (non-fatal): ${linkErr.message}`);
  }

  console.log(`[document] job=${job.id} done → file=${newFileId} "${fileName}"`);
  return newFileId;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadRecords(supabase: SupabaseClient, ids: string[]): Promise<LoadedRecord[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, model_id, data')
    .in('id', ids);
  if (error) throw new Error(`record load failed: ${error.message}`);
  return (data ?? []) as LoadedRecord[];
}

/** Resolve an assignee field value (user id, array of ids, or {id} objects) to
 *  a display name. Matches on public.users.id OR auth_uid to be format-agnostic. */
async function resolveAssigneeName(supabase: SupabaseClient, raw: unknown): Promise<string | null> {
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) ids.push(v.trim());
    else if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
      ids.push((v as { id: string }).id);
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  if (ids.length === 0) return null;

  const list = ids.map((s) => `"${s.replace(/"/g, '')}"`).join(',');
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .or(`id.in.(${list}),auth_uid.in.(${list})`);
  if (error || !data) return null;
  const names = (data as Array<Record<string, unknown>>)
    .map((u) => {
      const cand = u.name ?? u.full_name ?? u.display_name ?? u.email;
      return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
    })
    .filter((x): x is string => !!x);
  return names.length > 0 ? names.join('، ') : null;
}

/** Canonicalize a Saudi phone to E.164 (+9665XXXXXXXX). Clients store mixed
 *  bare-9-digit / 05… / +966… formats — display the canonical form. */
function canonicalizeKsaPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('966')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+966${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith('5')) return `+966${digits}`;
  return raw.trim() || null;
}

/** "<template label> — <record title>.pdf", clamped to the files CHECK length. */
function buildPdfName(label: string, title: string): string {
  const SUFFIX = '.pdf';
  const base = `${label} — ${title}`.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';
  return base.slice(0, MAX_NAME_LENGTH - SUFFIX.length) + SUFFIX;
}

/**
 * Run soffice with a hard timeout that kills the ENTIRE process group.
 * COPY of runSoffice in worker/src/runPreviewJob.ts — soffice re-spawns
 * soffice.bin, so killing only the launcher orphans the grandchild (live
 * incident 2026-06-11). detached:true + kill(-pid) reaps the whole tree.
 */
function runSoffice(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });

    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Group already gone — exactly the state we want.
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      reject(new Error(`conversion timed out after ${CONVERT_TIMEOUT_MS / 1000}s`));
    }, CONVERT_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`soffice failed to start: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() || `exit code ${code ?? `signal ${signal}`}`;
        reject(new Error(`soffice conversion failed: ${detail}`));
      }
    });
  });
}
