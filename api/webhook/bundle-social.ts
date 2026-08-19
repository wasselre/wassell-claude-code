/**
 * POST /api/webhook/bundle-social — bundle.social event receiver.
 *
 * Makes organic-post status INSTANT: instead of waiting for the on-open auto-poll
 * or the daily cron, bundle.social calls us the moment a post finishes
 * processing. We flip the matching mos_publications row to `published` (+ store
 * the permalink) on POSTED, or record the platform's error on ERROR.
 *
 * Registration is DASHBOARD-ONLY (bundle exposes no webhook API): add this URL in
 * the bundle.social Webhooks dashboard, copy the Signing Secret, and set
 * BUNDLE_SOCIAL_WEBHOOK_SECRET. Until the secret is set this endpoint is a safe
 * no-op (it never processes an unverified event).
 *
 * Security: every delivery carries `x-signature` = HMAC-SHA256 of the RAW body
 * with the signing secret. We recompute it and compare constant-time, tolerating
 * hex or base64 encoding and an optional `sha256=` prefix (the exact encoding is
 * not documented; all forms derive from the same secret+body, so accepting any of
 * them cannot admit a forgery). A mismatch is rejected 401 — loud, and the poll
 * paths still keep status correct, so a wrong secret degrades, never breaks.
 *
 * This is purely ADDITIVE to publication_sync — it applies the SAME mapping.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { extractPermalink, mapBundleStatus, type BundlePost } from '../_lib/marketing/bundleSocial.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** HMAC-SHA256 of `raw` with `secret`, returned as both hex and base64. */
async function hmacSha256(raw: string, secret: string): Promise<{ hex: string; b64: string }> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  const bytes = new Uint8Array(sigBuf);
  let hex = '';
  let bin = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
    bin += String.fromCharCode(b);
  }
  return { hex, b64: btoa(bin) };
}

/** Constant-time string compare (equal length required). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i += 1) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const raw = await req.text();
  const secret = process.env.BUNDLE_SOCIAL_WEBHOOK_SECRET?.trim();

  // Not configured yet — accept but do nothing (never process unverified data).
  if (!secret) {
    console.warn('[bundle-webhook] BUNDLE_SOCIAL_WEBHOOK_SECRET unset — ignoring event');
    return json({ skipped: 'not_configured' }, 200);
  }

  // Verify the signature. Tolerate hex/base64 + an optional sha256= prefix.
  const sent = (req.headers.get('x-signature') ?? '').trim().replace(/^sha256=/i, '');
  const { hex, b64 } = await hmacSha256(raw, secret);
  if (!sent || (!safeEqual(sent, hex) && !safeEqual(sent, b64))) {
    console.error('[bundle-webhook] signature mismatch — rejecting');
    return json({ error: 'invalid signature' }, 401);
  }

  let event: { type?: string; data?: BundlePost & { id?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  // We only act on post results; everything else is acknowledged and ignored.
  if (event.type !== 'post.published' || !event.data?.id) {
    return json({ ok: true, ignored: event.type ?? 'unknown' }, 200);
  }

  const post = event.data;
  const sb = getServiceSupabase();

  // Find the publication this bundle post belongs to. A foreign/unknown post
  // (e.g. one not created by us) is acknowledged, not retried.
  const found = await sb.from('mos_publications')
    .select('id, external_url, published_by_user_id')
    .eq('bundle_post_id', post.id).maybeSingle();
  if (found.error) {
    console.error('[bundle-webhook] lookup failed', found.error.message);
    return json({ error: 'lookup failed' }, 500);
  }
  if (!found.data) return json({ ok: true, unmatched: post.id }, 200);
  const row = found.data as { id: string; external_url: string | null; published_by_user_id: string | null };

  const coarse = mapBundleStatus(post.status);
  const patch: Record<string, unknown> = {
    bundle_status: post.status,
    bundle_error: typeof post.error === 'string' ? post.error : null,
    bundle_synced_at: new Date().toISOString(),
  };
  if (coarse === 'published') {
    patch.status = 'published';
    patch.published_at = post.postedDate ?? new Date().toISOString();
    const link = extractPermalink(post);
    if (link && !row.external_url) patch.external_url = link;
  }

  const upd = await sb.from('mos_publications').update(patch).eq('id', row.id);
  if (upd.error) {
    console.error('[bundle-webhook] update failed', row.id, upd.error.message);
    return json({ error: 'update failed' }, 500);
  }
  return json({ ok: true, id: row.id, status: post.status }, 200);
}
