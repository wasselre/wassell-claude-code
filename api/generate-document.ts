/**
 * POST /api/generate-document
 *
 * Body: { recordId: string, modelId: string, templateId: string }
 *
 * Enqueues a document_jobs row that turns a CRM record into a branded A4 PDF
 * generated from an authored template (a wassel_doc bound to the record's model
 * via document_templates). The actual render runs on the Fly worker
 * (runDocumentJob.ts → DOCX → LibreOffice PDF) — this endpoint NEVER waits on
 * it (no held HTTP for long work, same hard rule as decks / office-preview).
 *
 * Returns 202 { job_id } — the SPA polls /api/document-status.
 *
 * Ownership: the caller's JWT gates the SOURCE RECORD via RLS (unified_records).
 * The template itself is a shared company asset, so we validate it via
 * service-role (existence + active + bound to this model), not file-access.
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { getJwtClient, getServiceClient, wakePreviewWorker } from './_lib/files.js';

export const config = { runtime: 'edge' };
export const maxDuration = 30;

interface Body {
  recordId?: string;
  modelId?: string;
  templateId?: string;
  /** Render language for the generated PDF (W4). Anything but 'en' → 'ar'. */
  language?: string;
}

/** Pull a single linked-record id out of a lookup / unit_picker field value
 *  (string | string[] | { id } | { recordId }). */
function asLinkId(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = asLinkId(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand = o.id ?? o.recordId ?? o.record_id;
    return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const recordId = (body.recordId ?? '').trim();
    const modelId = (body.modelId ?? '').trim();
    const templateId = (body.templateId ?? '').trim();
    const language = body.language === 'en' ? 'en' : 'ar';
    if (!recordId) return jsonError(400, 'recordId is required');
    if (!modelId) return jsonError(400, 'modelId is required');
    if (!templateId) return jsonError(400, 'templateId is required');

    const jwtClient = getJwtClient(req);
    const svc = getServiceClient();

    // 1. Validate the template binding (shared asset — service-role lookup).
    const { data: tmpl, error: tErr } = await svc
      .from('document_templates')
      .select('id, file_id, model_id, is_active')
      .eq('id', templateId)
      .maybeSingle();
    if (tErr) return jsonError(500, `template lookup failed: ${tErr.message}`);
    if (!tmpl) return jsonError(404, 'template not found');
    if (tmpl.is_active === false) return jsonError(400, 'template is archived');
    if (tmpl.model_id !== modelId) return jsonError(400, 'template is not bound to this model');

    // 2. Ownership gate — the caller must be able to SEE the source record (RLS).
    const { data: rec, error: rErr } = await jwtClient
      .from('unified_records')
      .select('id, model_id, data')
      .eq('id', recordId)
      .maybeSingle();
    if (rErr) return jsonError(500, `record lookup failed: ${rErr.message}`);
    if (!rec) return jsonError(404, 'record not found or not accessible');
    if (rec.model_id !== modelId) return jsonError(400, 'record does not belong to the given model');

    const data = (rec.data as Record<string, unknown>) ?? {};
    const clientRecordId = asLinkId(data.client_id);
    const unitRecordId = asLinkId(data.unit_id);
    const projectRecordId = asLinkId(data.project_id);

    // 3. Resolve the owner (public.users id for files.uploaded_by_user_id;
    //    auth.uid() for the storage-path prefix — BOTH are needed).
    const { data: appUser, error: auErr } = await jwtClient
      .from('users')
      .select('id')
      .eq('auth_uid', user.userId)
      .maybeSingle();
    if (auErr || !appUser?.id) return jsonError(500, 'app user lookup failed');

    // 4. Enqueue (atomic; collapses concurrent clicks into one active job).
    const { data: jobId, error: enqErr } = await svc.rpc('document_job_enqueue', {
      p_source_record_id: recordId,
      p_source_model_id: modelId,
      p_template_id: templateId,
      p_template_file_id: tmpl.file_id,
      p_target_folder_id: null,
      p_owner_user_id: appUser.id,
      p_owner_auth_uid: user.userId,
      p_client_record_id: clientRecordId,
      p_unit_record_id: unitRecordId,
      p_project_record_id: projectRecordId,
      p_language: language,
    });
    if (enqErr) return jsonError(500, `enqueue failed: ${enqErr.message}`);
    if (!jobId) return jsonError(500, 'enqueue returned no job id');

    wakePreviewWorker(); // fire-and-forget; wakes all worker loops
    return jsonOk({ job_id: jobId, status: 'pending' }, 202);
  });
}
