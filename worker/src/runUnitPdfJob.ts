/**
 * runUnitPdfJob — render + send a unit's one-pager (unit_pdf_jobs queue).
 *
 * The basic WhatsApp bot resolved a customer's unit code to a units record and
 * enqueued here; it already sent a short intro text line. This lane renders the
 * EXACT rep one-pager (headless Chromium, identical HTML to the in-app builder),
 * uploads it to wassel-files, and hands it to the existing scheduled-send queue
 * so the Fly WAHA loop delivers it as a WhatsApp document (Vercel egress to WAHA
 * is 403-blocked, so every send rides scheduled_whatsapp_jobs).
 *
 * Owns its own job lifecycle: unit_pdf_job_complete on success,
 * unit_pdf_job_fail on any throw (both only touch a 'running' row, so a late
 * finish after the watchdog swept the job is a harmless no-op). Rethrows after
 * failing so the poll loop logs the stack.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { resolveUnitPdfInputs } from './unitData.js';
import { buildUnitHtml, renderUnitPdf } from './unitPdf.js';

const FILES_BUCKET = 'wassel-files';
const PDF_MIME = 'application/pdf';

export interface UnitPdfJob {
  id: string;
  unitId: string;
  unitCode: string | null;
  chatWid: string;
  phone: string | null;
  deviceId: string | null;
  lang: 'ar' | 'en';
  attempts: number;
}

export interface RunUnitPdfJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: UnitPdfJob;
}

/** Filesystem-/URL-safe token for the storage object name. */
function slug(s: string | null | undefined, fallback: string): string {
  const base = (s ?? '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-');
  return base || fallback;
}

/**
 * The active device to deliver on. Prefer the bot-supplied device when it is an
 * active row; otherwise the active default. Mirrors the resolution in
 * api/_lib/aiSend.ts + worker/src/runScheduledWhatsappJob.ts. Returns null when
 * no active device exists (the job then fails loudly rather than queueing a send
 * that would die at the gateway).
 */
async function resolveDeviceId(supabase: SupabaseClient, requested: string | null): Promise<string | null> {
  const req = requested?.trim() || null;
  if (req) {
    const { data } = await supabase
      .from('whatsapp_numbers').select('device_id').eq('device_id', req).eq('is_active', true).maybeSingle();
    const id = (data as { device_id?: string } | null)?.device_id;
    if (id) return id;
  }
  const { data: def } = await supabase
    .from('whatsapp_numbers').select('device_id')
    .eq('is_active', true).eq('is_default', true).maybeSingle();
  return (def as { device_id?: string } | null)?.device_id ?? null;
}

export async function runUnitPdfJob({ supabase, env, job }: RunUnitPdfJobArgs): Promise<void> {
  const isAr = job.lang !== 'en';
  try {
    // 1. Resolve the exact ProjectView/UnitView + images, build the HTML, render.
    const inputs = await resolveUnitPdfInputs(supabase, env, job.unitId, isAr);
    const code = inputs.unit.code ?? job.unitCode ?? `#${job.unitId.slice(0, 8)}`;
    const html = buildUnitHtml({
      project: inputs.project,
      unit: inputs.unit,
      isAr,
      logoDataUri: inputs.logoDataUri,
      planDataUri: inputs.planDataUri,
    });
    console.log(`[unit-pdf] job=${job.id} rendering unit=${job.unitId} code=${code}`);
    const pdf = await renderUnitPdf(html);
    console.log(`[unit-pdf] job=${job.id} rendered ${pdf.length} bytes`);

    // 2. Upload to wassel-files. The path is deterministic (one object per unit),
    //    so upsert:true just overwrites a prior render — cheap and idempotent.
    const storagePath = `unit-pdf/${job.unitId}/${slug(code, job.unitId.slice(0, 8))}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(FILES_BUCKET)
      .upload(storagePath, pdf, { contentType: PDF_MIME, upsert: true });
    if (upErr) throw new Error(`upload failed: ${upErr.message}`);

    // 3. Enqueue the WhatsApp send (the WAHA loop delivers). The bot already sent
    //    the intro text, so the media caption is short — no long re-intro.
    const deviceId = await resolveDeviceId(supabase, job.deviceId);
    if (!deviceId) throw new Error('no active WhatsApp device configured');
    const digits = (job.chatWid.split('@')[0] ?? '').replace(/\D/g, '');
    const caption = isAr ? `بطاقة الوحدة ${code}` : `Unit ${code} details`;

    const { error: enqErr } = await supabase.rpc('scheduled_whatsapp_enqueue', {
      p_device_id: deviceId,
      p_chat_wid: job.chatWid,
      p_phone: digits ? `+${digits}` : (job.phone ?? null),
      p_body: null,
      p_media: [{ fileId: `wt_${storagePath}`, kind: 'document', caption }],
      p_reference: `unit-pdf:${job.id}`,
      p_deliver_at: new Date().toISOString(),
      p_user_id: null,
    });
    if (enqErr) throw new Error(`scheduled_whatsapp_enqueue failed: ${enqErr.message}`);

    // 4. Mark the render/enqueue job done.
    const { error: doneErr } = await supabase.rpc('unit_pdf_job_complete', {
      p_job_id: job.id,
      p_result: { file_path: storagePath, device_id: deviceId, bytes: pdf.length },
    });
    if (doneErr) console.error(`[unit-pdf] unit_pdf_job_complete RPC failed: ${doneErr.message}`);
    else console.log(`[unit-pdf] job=${job.id} done → ${storagePath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const { error: failErr } = await supabase.rpc('unit_pdf_job_fail', { p_job_id: job.id, p_error: msg });
      if (failErr) console.error(`[unit-pdf] unit_pdf_job_fail RPC failed: ${failErr.message}`);
    } catch (innerErr) {
      console.error(`[unit-pdf] could not mark job failed: ${(innerErr as Error).message}`);
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}
