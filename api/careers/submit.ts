/**
 * POST /api/careers/submit — PUBLIC (no auth). Final submission of a job
 * application. The CV + audio were already uploaded to the private bucket via
 * /api/careers/upload-url; this endpoint receives the ANSWERS + the storage
 * paths, validates EVERYTHING server-side (never trusting the client), verifies
 * the referenced objects really exist and are the right type/size by sniffing
 * their real bytes, dedupes, and inserts the row via service-role.
 *
 * Idempotent on `submissionId`: a double-click / refresh re-POST returns the
 * same row instead of creating a duplicate. Also soft-dedupes by phone within a
 * 24h window (an accidental fresh submission from the same person is treated as
 * a success without inserting again).
 *
 * Body: see `Payload` below.  →  { ok: true, id, duplicate? }
 */

import { jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import {
  JOB_APP_BUCKET, CV_MAX_BYTES, AUDIO_MAX_BYTES,
  SITUATION_VALUES, EXPERIENCE_VALUES, YES_NO, hasSalesExperience,
  canonKsaPhone, sniffCvKind, looksLikeAudio, clientIp, hashIp,
} from '../_lib/careers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RATE_MAX = 8; // submissions
const RATE_WINDOW_SECONDS = 3600; // per hour per IP

interface Payload {
  submissionId?: string;
  fullName?: string;
  phone?: string;
  currentSituation?: string;
  experienceLevel?: string;
  experienceResults?: string;
  canCommit?: string;
  expectedSalary?: number | string;
  expectedCommission?: string;
  additionalNotes?: string;
  cvPath?: string;
  cvName?: string;
  audioPath?: string;
  audioDurationSec?: number;
  sourceUrl?: string;
  utm?: Record<string, string>;
  clickIds?: Record<string, string>;
}

const s = (v: unknown, max = 4000): string =>
  (typeof v === 'string' ? v : '').trim().slice(0, max);

/** Read the first `headBytes` of a private object + its AUTHORITATIVE size, or
 *  null if it doesn't exist. The size comes from storage metadata (via `list`)
 *  so the cap can't be defeated by a lying client; the head bytes come from a
 *  RANGED GET so we never pull a whole 25 MB audio into the function just to read
 *  its magic number. */
async function inspectObject(
  svc: SupabaseClient, path: string, headBytes: number,
): Promise<{ head: Uint8Array; size: number } | null> {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { data: listed } = await svc.storage.from(JOB_APP_BUCKET).list(dir, { search: name, limit: 1 });
  const entry = listed?.find((o) => o.name === name);
  if (!entry) return null;
  const size = Number((entry.metadata as { size?: number } | null)?.size ?? 0);

  const { data: signed } = await svc.storage.from(JOB_APP_BUCKET).createSignedUrl(path, 60);
  if (!signed?.signedUrl) return null;
  const resp = await fetch(signed.signedUrl, { headers: { Range: `bytes=0-${headBytes - 1}` } });
  if (!resp.ok) return null;
  const head = new Uint8Array(await resp.arrayBuffer());
  return { head, size: size || head.length };
}

/** A storage path must live under this submission's own folder (no traversal,
 *  no reaching into another applicant's files). */
function pathOwnedBy(path: string, kind: 'cv' | 'audio', submissionId: string): boolean {
  return path.startsWith(`${kind}/${submissionId}/`) && !path.includes('..');
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  const svc = makeServiceClient('api:careers-submit');
  if (!svc) return jsonError(500, 'service client unavailable');

  const ipHashPromise = hashIp(clientIp(req));

  const body = (await req.json().catch(() => null)) as Payload | null;
  if (!body) return jsonError(400, 'invalid JSON body');

  const submissionId = s(body.submissionId, 64);
  if (!UUID_RE.test(submissionId)) return jsonError(400, 'invalid submissionId');

  // Idempotency: if this submission already landed, return it unchanged.
  {
    const { data: existing } = await svc
      .from('job_applications').select('id').eq('submission_id', submissionId).maybeSingle();
    if (existing?.id) return jsonOk({ ok: true, id: existing.id, duplicate: true });
  }

  // Rate-limit AFTER the idempotency check (a retry of an accepted submission
  // shouldn't burn quota) but before doing real work.
  const ipHash = await ipHashPromise;
  const { data: allowed, error: rlErr } = await svc.rpc('job_application_rate_hit', {
    p_ip_hash: ipHash, p_kind: 'submit', p_max: RATE_MAX, p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (rlErr) return jsonError(500, 'rate check failed');
  if (allowed === false) return jsonError(429, 'too many requests');

  // ── Field validation (server-authoritative) ──────────────────────────────
  const fullName = s(body.fullName, 200);
  if (fullName.length < 2) return jsonError(422, 'invalid full_name');

  const phone = canonKsaPhone(s(body.phone, 40));
  if (!phone) return jsonError(422, 'invalid phone');

  const currentSituation = s(body.currentSituation, 40);
  if (!SITUATION_VALUES.has(currentSituation as never)) return jsonError(422, 'invalid current_situation');

  const experienceLevel = s(body.experienceLevel, 40);
  if (!EXPERIENCE_VALUES.has(experienceLevel as never)) return jsonError(422, 'invalid experience_level');

  const canCommit = s(body.canCommit, 8);
  if (!YES_NO.has(canCommit)) return jsonError(422, 'invalid can_commit');

  const experienced = hasSalesExperience(experienceLevel);
  const experienceResults = experienced ? s(body.experienceResults, 4000) : '';

  const expectedSalaryRaw = body.expectedSalary;
  const expectedSalary =
    expectedSalaryRaw === '' || expectedSalaryRaw == null
      ? null
      : Number(String(expectedSalaryRaw).replace(/[^0-9.]/g, ''));
  if (expectedSalary != null && (!Number.isFinite(expectedSalary) || expectedSalary < 0 || expectedSalary > 10_000_000))
    return jsonError(422, 'invalid expected_salary');

  const expectedCommission = s(body.expectedCommission, 40);
  const additionalNotes = s(body.additionalNotes, 4000);

  const cvPath = s(body.cvPath, 400);
  const audioPath = s(body.audioPath, 400);
  if (!pathOwnedBy(cvPath, 'cv', submissionId)) return jsonError(422, 'invalid cv upload');
  if (!pathOwnedBy(audioPath, 'audio', submissionId)) return jsonError(422, 'invalid audio upload');

  // ── Verify the uploaded artefacts by their REAL bytes ─────────────────────
  const [cvObj, audioObj] = await Promise.all([
    inspectObject(svc, cvPath, 16),
    inspectObject(svc, audioPath, 16),
  ]);
  if (!cvObj) return jsonError(422, 'cv file missing');
  if (!audioObj) return jsonError(422, 'audio file missing');
  if (cvObj.size > CV_MAX_BYTES) return jsonError(413, 'cv too large');
  if (audioObj.size > AUDIO_MAX_BYTES) return jsonError(413, 'audio too large');

  const cvKind = sniffCvKind(cvObj.head);
  if (!cvKind) return jsonError(415, 'cv is not a valid PDF/DOC/DOCX');
  if (!looksLikeAudio(audioObj.head)) return jsonError(415, 'audio is not a recognised audio file');

  const cvMime =
    cvKind === 'pdf' ? 'application/pdf'
    : cvKind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/msword';

  // ── Soft phone dedupe (24h window) ────────────────────────────────────────
  {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recent } = await svc
      .from('job_applications').select('id')
      .eq('phone', phone).gte('created_at', cutoff).limit(1).maybeSingle();
    if (recent?.id) return jsonOk({ ok: true, id: recent.id, duplicate: true });
  }

  const audioDurationSec =
    typeof body.audioDurationSec === 'number' && Number.isFinite(body.audioDurationSec)
      ? Math.round(body.audioDurationSec) : null;

  const utm = sanitizeMap(body.utm);
  const clickIds = sanitizeMap(body.clickIds);

  const { data: inserted, error: insErr } = await svc
    .from('job_applications')
    .insert({
      submission_id: submissionId,
      status: 'new',
      full_name: fullName,
      phone,
      phone_raw: s(body.phone, 40),
      current_situation: currentSituation,
      experience_level: experienceLevel,
      experience_results: experienceResults || null,
      can_commit: canCommit,
      expected_salary: expectedSalary,
      expected_commission: expectedCommission || null,
      additional_notes: additionalNotes || null,
      cv_path: cvPath,
      cv_name: s(body.cvName, 300) || null,
      cv_mime: cvMime,
      cv_size: cvObj.size,
      audio_path: audioPath,
      audio_mime: 'audio/*',
      audio_size: audioObj.size,
      audio_duration_sec: audioDurationSec,
      source_url: s(body.sourceUrl, 2000) || null,
      utm,
      click_ids: clickIds,
      client_meta: {
        ua: s(req.headers.get('user-agent') ?? '', 500),
        referrer: s(req.headers.get('referer') ?? '', 2000),
        ip_hash: ipHash,
        submitted_at: new Date().toISOString(),
      },
    })
    .select('id')
    .single();

  // Unique-violation on submission_id = a race with a concurrent retry; treat
  // as success by reading the winning row back.
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') {
      const { data: row } = await svc
        .from('job_applications').select('id').eq('submission_id', submissionId).maybeSingle();
      if (row?.id) return jsonOk({ ok: true, id: row.id, duplicate: true });
    }
    return jsonError(500, `could not save application: ${insErr.message}`);
  }

  return jsonOk({ ok: true, id: inserted.id });
}

/** Keep only short string entries from a client-supplied attribution map. */
function sanitizeMap(m: unknown): Record<string, string> {
  if (!m || typeof m !== 'object') return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (n >= 30) break;
    if (typeof v !== 'string') continue;
    const key = k.slice(0, 60);
    if (!/^[a-z0-9_.-]+$/i.test(key)) continue;
    out[key] = v.slice(0, 500);
    n++;
  }
  return out;
}
