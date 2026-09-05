/**
 * POST /api/careers/upload-url — PUBLIC (no auth). Mint a one-shot signed URL so
 * a job applicant uploads their CV or voice recording DIRECTLY to the private
 * `job-applications` bucket, bypassing Vercel's ~4.5 MB body cap (same pattern as
 * api/whatsapp/upload-url, but unauthenticated + rate-limited).
 *
 * The token authorizes exactly ONE upload to one path, so the bucket needs no
 * anon RLS grant. Files are keyed by the browser-generated submissionId so they
 * are grouped with the eventual application row and are cheap to prune if the
 * form is abandoned.
 *
 * Body: { submissionId, kind: 'cv'|'audio', filename?, mime?, size? }
 * →  { path, token }   (upload with supabase.storage.uploadToSignedUrl(path, token, file))
 */

import { jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import {
  JOB_APP_BUCKET, CV_MAX_BYTES, AUDIO_MAX_BYTES,
  CV_MIME_ALLOW, AUDIO_MIME_ALLOW, CV_EXT_ALLOW, AUDIO_EXT_ALLOW,
  safeExt, clientIp, hashIp,
} from '../_lib/careers.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous but abuse-bounded: a form has 2 uploads (CV + audio) and users may
// re-record/replace a few times → 40 signed urls / 10 min / IP.
const RATE_MAX = 40;
const RATE_WINDOW_SECONDS = 600;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  const svc = makeServiceClient('api:careers-upload-url');
  if (!svc) return jsonError(500, 'service client unavailable');

  // Rate-limit by salted IP hash before doing any work.
  const ipHash = await hashIp(clientIp(req));
  const { data: allowed, error: rlErr } = await svc.rpc('job_application_rate_hit', {
    p_ip_hash: ipHash, p_kind: 'upload', p_max: RATE_MAX, p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (rlErr) return jsonError(500, 'rate check failed');
  if (allowed === false) return jsonError(429, 'too many requests');

  const body = (await req.json().catch(() => ({}))) as {
    submissionId?: string; kind?: string; filename?: string; mime?: string; size?: number;
  };
  const submissionId = typeof body.submissionId === 'string' ? body.submissionId : '';
  const kind = body.kind === 'cv' || body.kind === 'audio' ? body.kind : '';
  const filename = typeof body.filename === 'string' ? body.filename : '';
  // Strip any codec/parameter suffix — MediaRecorder emits e.g.
  // "audio/webm;codecs=opus", and the allowlist keys on the base type.
  const mime = ((typeof body.mime === 'string' ? body.mime : '').toLowerCase().split(';')[0] ?? '').trim();
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? body.size : 0;

  if (!UUID_RE.test(submissionId)) return jsonError(400, 'invalid submissionId');
  if (!kind) return jsonError(400, 'invalid kind');

  const maxBytes = kind === 'cv' ? CV_MAX_BYTES : AUDIO_MAX_BYTES;
  const mimeAllow = kind === 'cv' ? CV_MIME_ALLOW : AUDIO_MIME_ALLOW;
  const extAllow = kind === 'cv' ? CV_EXT_ALLOW : AUDIO_EXT_ALLOW;

  if (size > maxBytes) return jsonError(413, `file too large (limit ${maxBytes} bytes)`);
  if (!mimeAllow.has(mime)) return jsonError(415, 'unsupported file type');

  // Derive a safe extension: from the filename, else the mime subtype, else a
  // kind-appropriate default. Extension is validated but never the sole gate —
  // the /submit endpoint re-checks the real bytes.
  let ext = safeExt(filename);
  if (!extAllow.has(ext)) ext = (mime.split('/')[1] ?? '').replace('x-', '').toLowerCase();
  if (!extAllow.has(ext)) ext = kind === 'cv' ? 'pdf' : 'webm';

  const uid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const path = `${kind}/${submissionId}/${uid}.${ext}`;

  const { data, error } = await svc.storage.from(JOB_APP_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.token) return jsonError(502, `signed upload url failed: ${error?.message ?? 'no token'}`);

  return jsonOk({ path: data.path ?? path, token: data.token });
}
