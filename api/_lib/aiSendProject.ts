/**
 * Shared: send ONE of our projects to a WhatsApp customer using the FULL rep
 * flow — the marketing MESSAGE, the project BROCHURE, and the top project PHOTOS
 * — server-side, in-process, with no browser and no user JWT.
 *
 * This is the bot's equivalent of what a human rep does through
 * ProjectWhatsAppFlow (compose → files → chat): it reuses the exact same message
 * resolution (saved message → fact-checked → fresh AI → deterministic sheet) and
 * the same "bulk" file default (one brochure + the top 3 photos, sent
 * text → PDF → pictures). The rep gets to tick/untick; the bot takes the default.
 *
 * Delivery rides the existing scheduled-send queue (the Fly worker delivers —
 * Vercel egress to WAHA is 403-blocked), same as api/_lib/aiSend.ts and
 * api/whatsapp/send-media-batch.ts:
 *   • TEXT  → enqueueAiReply (gate re-check + device resolve + audit) at `now`.
 *   • MEDIA → scheduled_whatsapp_enqueue, one staggered row per item after the
 *             text, so the customer sees text → brochure → photos in order.
 *
 * Auth is the caller's (the endpoint checks WHATSAPP_AI_SECRET); everything here
 * runs as service role because the bot has no JWT — geography, project data, the
 * saved template, and the linked files are all read with `svc`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueAiReply } from './aiSend.js';
import { resolveDefaultDeviceId, scheduledMediaItem } from './whatsappGateway.js';
import { resolveProjectSheet } from './projectSheet.js';
import { generateProjectMessage } from './projectMessageAi.js';
import { savedMessageMatchesCurrentFacts } from '../../src/lib/projectMessage/factsMatch.js';
import type { ProjectMessageFacts } from '../../src/lib/projectMessage/compose.js';
import {
  buildPickerItems, isUnitPlanFile, defaultBulkSelection, orderSelectedRefsBulk,
} from '../../src/pages/Chats/lib/projectFilePicker.js';
import type { SendableFile } from '../../src/lib/files/recordFiles.js';

/** CRM Files live here — a signed URL on this bucket is re-signable at delivery
 *  time (scheduledMediaItem → `wt_<path>`); other buckets must be public. Must
 *  match WA_TEMP_BUCKET in whatsappGateway.ts / waha.ts / the worker. */
const WA_TEMP_BUCKET = 'wassel-files';
/** Delivery spacing for the media stream — one tick per item after the text, so
 *  the queue drips text → brochure → photo1 → photo2… single-file. Kept above
 *  the worker's ~3s poll (same value the bulk rep flow uses). */
const SPACING_MS = 4_000;

export interface AiSendProjectResult {
  /** True when the text was accepted into the send queue. */
  queued: boolean;
  blocked?: boolean;
  reason?: string;
  error?: string;
  /** How the message text was resolved — for the bot's log / the tool output. */
  message_source?: 'saved' | 'saved-factchecked' | 'ai-generated' | 'sheet';
  project_id?: string;
  /** Media messages enqueued (brochure + photos). Media that couldn't be turned
   *  into a sendable ref (e.g. an odd storage bucket) is skipped best-effort and
   *  never counted here — partial media is still success. */
  media_queued?: number;
  media_failed?: number;
  /** The text send's queue ref (`sched:<id>`), for the bot's log. */
  wid?: string;
}

/**
 * Resolve the message TEXT for the project, matching ProjectMessageComposeStep's
 * order: a saved template (skip the AI when its numbers already match, else
 * fact-check them) → a fresh AI rewrite → the deterministic sheet. Never returns
 * a knowingly-stale saved message: if the fact-check fails, it falls back to the
 * sheet (guaranteed-current numbers) rather than the un-corrected saved copy.
 */
async function resolveMessageText(
  svc: SupabaseClient,
  projectId: string,
  sheetBodyAr: string,
  sheetFacts: ProjectMessageFacts,
): Promise<{ text: string; source: NonNullable<AiSendProjectResult['message_source']> }> {
  const pick = (ar: string, en: string) => (ar.trim() || en.trim());

  // Saved template for this project (chat_templates.data.project_id === id).
  const { data: tplModel } = await svc.from('models').select('id').eq('name', 'chat_templates').maybeSingle();
  let savedAr = '';
  let savedEn = '';
  if (tplModel?.id) {
    const { data: rows } = await svc
      .from('records').select('data')
      .eq('model_id', tplModel.id as string)
      .eq('data->>project_id', projectId)
      .limit(1);
    const t = (rows?.[0]?.data ?? null) as Record<string, unknown> | null;
    if (t) {
      savedAr = typeof t.body_ar === 'string' ? t.body_ar : '';
      savedEn = typeof t.body_en === 'string' ? t.body_en : '';
    }
  }

  if (savedAr.trim() || savedEn.trim()) {
    // The numbers already current → send the saved copy verbatim (no AI).
    if (savedMessageMatchesCurrentFacts(sheetFacts, savedAr, savedEn)) {
      return { text: pick(savedAr, savedEn), source: 'saved' };
    }
    // Numbers drifted → fact-check (correct numbers, keep wording). On any
    // failure fall through to the sheet — never send the stale saved copy.
    const fc = await generateProjectMessage(svc, svc, { projectId, existingAr: savedAr, existingEn: savedEn });
    if (fc.ok) return { text: pick(fc.body_ar, fc.body_en), source: 'saved-factchecked' };
    console.error(`[aiSendProject] fact-check failed for ${projectId} (${fc.error}) — falling back to the deterministic sheet`);
    return { text: sheetBodyAr, source: 'sheet' };
  }

  // No saved message → fresh AI rewrite, else the deterministic sheet.
  const gen = await generateProjectMessage(svc, svc, { projectId });
  if (gen.ok) return { text: pick(gen.body_ar, gen.body_en), source: 'ai-generated' };
  console.error(`[aiSendProject] AI generate failed for ${projectId} (${gen.error}) — falling back to the deterministic sheet`);
  return { text: sheetBodyAr, source: 'sheet' };
}

/**
 * Pick the bulk default — ONE brochure + the top 3 photos, floor plans excluded —
 * from the project's linked files, and resolve each to a scheduled-media ref
 * (a re-signable `wt_` ref for a wassel-files object, else a public URL). Refs
 * are returned in send order: documents → photos. Best-effort: a file that can't
 * be turned into a sendable ref is skipped (partial media is success).
 */
async function resolveMediaRefs(
  svc: SupabaseClient,
  allProjectsModelId: string,
  projectId: string,
): Promise<Array<{ fileId?: string; url?: string; caption: string | null }>> {
  const { data: links, error: linkErr } = await svc
    .from('file_links').select('file_id').eq('model_id', allProjectsModelId).eq('record_id', projectId);
  if (linkErr) { console.error('[aiSendProject] file_links lookup failed:', linkErr.message); return []; }
  const ids = [...new Set((links ?? []).map((l) => (l as { file_id: string }).file_id))];
  if (ids.length === 0) return [];

  const { data: files, error: fileErr } = await svc
    .from('files').select('id, kind, title, original_name, document_type, primary_category, storage_bucket, storage_path')
    .in('id', ids);
  if (fileErr) { console.error('[aiSendProject] files lookup failed:', fileErr.message); return []; }

  type FileRow = SendableFile & { storage_bucket: string; storage_path: string };
  const rows = ((files ?? []) as FileRow[]).filter((f) => !isUnitPlanFile(f));
  // Reuse the SAME pure grouping/selection/ordering the rep's bulk picker uses.
  const items = buildPickerItems(rows.map((file) => ({ file })), []);
  const selected = defaultBulkSelection(items);
  const orderedIds = orderSelectedRefsBulk(items, selected); // documents → photos → videos

  const byId = new Map(rows.map((f) => [f.id, f]));
  const out: Array<{ fileId?: string; url?: string; caption: string | null }> = [];
  for (const id of orderedIds) {
    const f = byId.get(id);
    if (!f?.storage_bucket || !f?.storage_path) continue;
    try {
      let ref: string;
      if (f.storage_bucket === WA_TEMP_BUCKET) {
        // Private CRM file — hand the worker a re-signable ref (signed URLs expire
        // long before a staggered scheduled delivery).
        ref = `wt_${f.storage_path}`;
      } else {
        const { data } = svc.storage.from(f.storage_bucket).getPublicUrl(f.storage_path);
        if (!data?.publicUrl) continue;
        ref = data.publicUrl;
      }
      out.push(scheduledMediaItem(ref, null));
    } catch (err) {
      console.error(`[aiSendProject] skipping un-sendable file ${id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/** Resolve the device to send from — a requested ACTIVE device, else the default.
 *  A stale/inactive device dies at the gateway, so we validate it's active. */
async function resolveDevice(svc: SupabaseClient, requested?: string | null): Promise<string | null> {
  const want = requested?.trim() || null;
  if (want) {
    const { data } = await svc
      .from('whatsapp_numbers').select('device_id').eq('device_id', want).eq('is_active', true).maybeSingle();
    if (data?.device_id) return data.device_id as string;
  }
  return resolveDefaultDeviceId();
}

/**
 * The "our flow" send: message + brochure + top photos into one WhatsApp chat.
 *
 * `svc` must be a service-role client. Provide `projectId` OR `projectName`
 * (resolved via the deterministic sheet builder, which also gives the current
 * facts + the sheet-fallback body in one read).
 */
export async function sendProjectViaAiFlow(
  svc: SupabaseClient,
  input: { chatWid: string; projectId?: string; projectName?: string; deviceId?: string | null; jobId?: string | null; force?: boolean },
): Promise<AiSendProjectResult> {
  const chatWid = (input.chatWid ?? '').trim();
  if (!chatWid) return { queued: false, error: 'chat_wid is required' };
  const digits = chatWid.split('@')[0] ?? '';
  if (!/^\d{8,15}$/.test(digits)) return { queued: false, error: `unsupported chat_wid: ${chatWid}` };
  if (!input.projectId && !input.projectName) return { queued: false, error: 'project_id or project_name is required' };

  // Resolve the project + its current facts + the deterministic sheet body in one
  // read. This is also the fallback message when the AI is unavailable, and it is
  // what guards against an empty-shell "project" (no sellable data → not_found).
  const sheet = await resolveProjectSheet(svc, svc, { projectId: input.projectId, projectName: input.projectName });
  if (!sheet.ok) {
    if (sheet.reason === 'not_found') return { queued: false, error: 'project not found (or has no sellable data)' };
    if (sheet.reason === 'ambiguous') return { queued: false, error: 'project name matched several projects — pass the id' };
    return { queued: false, error: sheet.message ?? 'could not resolve the project' };
  }
  const projectId = sheet.project_id;

  // all_projects model id — for the file_links lookup.
  const { data: apModel } = await svc.from('models').select('id').eq('name', 'all_projects').maybeSingle();
  const allProjectsModelId = apModel?.id as string | undefined;

  const { text, source } = await resolveMessageText(
    svc, projectId, sheet.body_ar, sheet.facts as unknown as ProjectMessageFacts,
  );
  if (!text.trim()) return { queued: false, error: 'resolved an empty message', project_id: projectId };

  const deviceId = await resolveDevice(svc, input.deviceId);
  if (!deviceId) return { queued: false, error: 'no active WhatsApp device configured', project_id: projectId };

  // ── 1) TEXT — gate re-check + audit, delivered ~now. If the gate blocks (a
  //        human took over), send NOTHING further. ──
  const textRes = await enqueueAiReply(svc, {
    chatWid, text, deviceId, jobId: input.jobId, force: input.force,
  });
  if (textRes.blocked) return { queued: false, blocked: true, reason: textRes.reason, message_source: source, project_id: projectId };
  if (textRes.error) return { queued: false, error: textRes.error, message_source: source, project_id: projectId };

  // ── 2) MEDIA — brochure + top photos, staggered after the text. Best-effort:
  //        a failed item is tallied, the rest still queue (matches send-media-batch). ──
  let mediaQueued = 0;
  let mediaFailed = 0;
  if (allProjectsModelId) {
    const mediaItems = await resolveMediaRefs(svc, allProjectsModelId, projectId);
    const base = Date.now();
    for (const [i, media] of mediaItems.entries()) {
      const deliverAt = new Date(base + (i + 1) * SPACING_MS).toISOString();
      const { error } = await svc.rpc('scheduled_whatsapp_enqueue', {
        p_device_id: deviceId,
        p_chat_wid: chatWid,
        p_phone: `+${digits}`,
        p_body: null,
        p_media: [media],
        p_reference: `ai-project:${input.jobId ?? 'flow'}:${projectId}:${i}`,
        p_deliver_at: deliverAt,
        p_user_id: null,
      });
      if (error) { mediaFailed++; console.error(`[aiSendProject] media enqueue ${i} failed:`, error.message); }
      else mediaQueued++;
    }
  }

  return {
    queued: true,
    message_source: source,
    project_id: projectId,
    media_queued: mediaQueued,
    media_failed: mediaFailed,
    wid: textRes.wid,
  };
}
