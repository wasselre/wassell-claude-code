/**
 * Writes a reconcile result to the CRM and records every change in
 * project_update_changes (before/after of exactly the changed keys), which is
 * what project_update_revert(run) undoes.
 *
 * Unit writes go through record_save like every other writer: updates via
 * recordSaveWithRetry (read → merge → versioned save, retried on a version
 * conflict), creates with a fresh id and pre-allocated U- code.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSaveWithRetry } from '../lib/recordSaveRetry.js';
import { BROWSER_UA } from './http.js';
import type { ReconcileResult, UnitCreate } from './types.js';
import { incompleteNotice, incompleteSignature } from './reconcile.js';

export const UNITS_MODEL_ID = '7ca3014d-f658-418e-9c53-2d279c97f009';
export const PROJECTS_MODEL_ID = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
export const UNIT_UPDATES_MODEL_ID = 'aa10c001-2026-4824-9000-000000000001';
/** The identity every migration/reconcile run has written as since 2026-06-28. */
export const MIGRATION_USER_ID = 'a3374d65-9cee-4daa-8880-5e8ff23e7db0';
const MIGRATION_AUTH_UID = '31621e58-c723-45ad-9e4f-6f8ba1689fe7';

export interface ApplyOutcome {
  updated: number;
  created: number;
  plans: number;
  failures: string[];
  /** New units the source lists but that lack an essential — not created. */
  incomplete: number;
  /** The WhatsApp notice about them: job id, 'unchanged' (already told about
   *  this exact list), or the error that stopped it. */
  incomplete_notice?: string;
}

/** True when a unit about to be created carries all four essentials. The
 *  reconciler already filters; this is the last check before the write, so
 *  no future path can add an incomplete unit by building creates itself. */
export function hasEssentials(d: Record<string, unknown>): boolean {
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return pos(d.total_price) && pos(d.unit_area)
    && typeof d.bedrooms === 'number' && Number.isFinite(d.bedrooms) && d.bedrooms >= 0
    && typeof d.unit_type === 'string' && d.unit_type.length > 0;
}

/** Tell the operator (WhatsApp, operations line) which units were not added.
 *  The same list is sent once per project — a weekly run that finds it again
 *  stays quiet (project_update_notify_incomplete compares a signature). */
async function notifyIncomplete(
  supabase: SupabaseClient,
  args: { projectId: string; projectName: string; sourceLabel: string; result: ReconcileResult },
): Promise<string> {
  const items = args.result.incomplete;
  const { data, error } = await supabase.rpc('project_update_notify_incomplete', {
    p_project_id: args.projectId,
    p_signature: incompleteSignature(items),
    p_body: incompleteNotice(args.projectName, args.sourceLabel, items),
  });
  if (error) throw new Error(error.message);
  return typeof data === 'string' ? data : 'unchanged';
}

export async function logChange(
  supabase: SupabaseClient,
  row: {
    run_id: string; project_id: string | null; record_id: string; model: string;
    action: 'update' | 'create' | 'delete'; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string;
  },
): Promise<void> {
  // The record is already written; losing its audit row would make the run
  // un-revertable for that record. Retry (a timed-out request is the usual
  // cause — 2026-10-05), then surface it naming the record, never swallow it.
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase.from('project_update_changes').insert(row);
      if (!error) return;
      last = error.message;
    } catch (err) {
      last = (err as Error).message;
    }
    console.error(`[project-update] change log insert attempt ${attempt}/3 failed for ${row.record_id}: ${last}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`UNLOGGED ${row.model} ${row.record_id} — change log insert failed: ${last}`);
}

/** Patch one record; returns the before-values it replaced, or null if the
 *  record already held every patched value (nothing written). */
export async function patchRecord(
  supabase: SupabaseClient,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // Held in an object so the value the LAST build() attempt saw survives a
  // version-conflict retry (each retry re-reads the row and rebuilds).
  const holder: { before: Record<string, unknown> | null } = { before: null };
  await recordSaveWithRetry(supabase, {
    recordId,
    build: (cur) => {
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v ?? null)) changed[k] = cur[k] ?? null;
      }
      if (Object.keys(changed).length === 0) { holder.before = null; return null; }
      holder.before = changed;
      return { ...cur, ...patch };
    },
  });
  return holder.before;
}

async function uploadPlan(
  supabase: SupabaseClient,
  unitId: string,
  c: UnitCreate,
  projectName: string,
): Promise<string> {
  const url = c.source.planUrl!;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://riva.sa/' } });
  if (!res.ok) throw new Error(`plan download ${res.status}`);
  const mime = (res.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim();
  if (!mime.startsWith('image/')) throw new Error(`plan is ${mime}, not an image`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const fileId = randomUUID();
  const path = `${MIGRATION_AUTH_UID}/${fileId}.${ext}`;
  const up = await supabase.storage.from('wassel-files').upload(path, bytes, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`plan upload: ${up.error.message}`);
  const title = `مخطط ${c.label} - ${projectName}`.slice(0, 480);
  const { error } = await supabase.from('files').insert({
    id: fileId,
    model_id: UNITS_MODEL_ID,
    record_id: unitId,
    uploaded_by_user_id: MIGRATION_USER_ID,
    owner_user_id: MIGRATION_USER_ID,
    original_name: `${title}.${ext}`,
    title,
    mime_type: mime,
    size_bytes: bytes.length,
    storage_bucket: 'wassel-files',
    storage_path: path,
    kind: 'image',
    document_type: 'floor_plan',
    origin: 'integration_inbound',
  });
  if (error) {
    // Don't leave an orphan object behind a failed row.
    const rm = await supabase.storage.from('wassel-files').remove([path]);
    if (rm.error) console.error(`[project-update] orphan plan ${path} could not be removed: ${rm.error.message}`);
    throw new Error(`plan files row: ${error.message}`);
  }
  return fileId;
}

export async function applyResult(
  supabase: SupabaseClient,
  args: {
    runId: string; projectId: string; projectName: string; result: ReconcileResult;
    /** Named in the operator's notice («بوابة وسطاء ريفا», «واتساب الرمز»…). */
    sourceLabel: string;
    /** Called between writes — a big project must keep the run's heartbeat
     *  fresh or the watchdog hands the run to a second machine mid-way. */
    heartbeat?: () => Promise<void>;
  },
): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { updated: 0, created: 0, plans: 0, failures: [], incomplete: args.result.incomplete.length };

  if (args.result.incomplete.length) {
    try {
      out.incomplete_notice = await notifyIncomplete(supabase, args);
    } catch (err) {
      // The notice failing must not undo or block the run's real writes — but
      // it is reported on the run (failures) and logged, never dropped.
      const msg = `incomplete-units notice: ${(err as Error).message}`;
      console.error(`[project-update] ${args.projectName}: ${msg}`);
      out.failures.push(msg);
      out.incomplete_notice = `error: ${(err as Error).message}`;
    }
  }

  for (const u of args.result.updates) {
    if (args.heartbeat) await args.heartbeat();
    try {
      const before = await patchRecord(supabase, u.unitId, u.patch);
      if (!before) continue;
      await logChange(supabase, {
        run_id: args.runId, project_id: args.projectId, record_id: u.unitId, model: 'units',
        action: 'update', before, after: u.patch, reason: u.reasons.join('; '),
      });
      out.updated++;
    } catch (err) {
      out.failures.push(`${u.label}: ${(err as Error).message}`);
    }
  }

  if (args.result.creates.length) {
    const { data: codes, error } = await supabase.rpc('project_update_next_codes', {
      p_kind: 'unit', p_n: args.result.creates.length,
    });
    if (error || !Array.isArray(codes) || codes.length !== args.result.creates.length) {
      out.failures.push(`unit code allocation failed: ${error?.message ?? 'wrong count'}`);
      return out;
    }
    for (let i = 0; i < args.result.creates.length; i++) {
      if (args.heartbeat) await args.heartbeat();
      const c = args.result.creates[i]!;
      const id = randomUUID();
      const data = { ...c.data, unit_code: codes[i] as string };
      if (!hasEssentials(data)) {
        out.failures.push(`create ${c.label}: refused — missing area/price/bedrooms/type`);
        continue;
      }
      try {
        const { error: saveErr } = await supabase.rpc('record_save', {
          p_model_id: UNITS_MODEL_ID, p_id: id, p_data: data,
          p_created_by: MIGRATION_USER_ID, p_expected_version: null,
        });
        if (saveErr) throw new Error(saveErr.message);
        await logChange(supabase, {
          run_id: args.runId, project_id: args.projectId, record_id: id, model: 'units',
          action: 'create', before: null, after: data, reason: 'new unit on the source',
        });
        out.created++;
      } catch (err) {
        out.failures.push(`create ${c.label}: ${(err as Error).message}`);
        continue;
      }
      if (c.source.planUrl) {
        try {
          const fileId = await uploadPlan(supabase, id, c, args.projectName);
          await patchRecord(supabase, id, { unit_plan: fileId });
          out.plans++;
        } catch (err) {
          // The unit exists without its plan — reported, never fabricated.
          out.failures.push(`plan ${c.label}: ${(err as Error).message}`);
        }
      }
    }
  }
  return out;
}
