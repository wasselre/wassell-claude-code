/**
 * Shared plumbing for the Post Creative Director API handlers
 * (docs/creative-director-contracts.md §4). Every handler in this folder takes
 * the same context and returns a Response; the dispatch blocks in
 * api/marketing-os.ts / api/marketing.ts do the capability gate, then delegate.
 *
 * Also hosts the /wake ping (copy of the fire-and-forget worker wake in
 * api/marketing-os.ts / api/templates/clean-listing-images.ts — the worker's
 * poll loop is the reliable path; the ping only skips poll latency) and the
 * ref/asset preview resolver shared by packages.ts + examples.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonError } from '../../auth.js';

/** The context every creative handler receives from the dispatch block. */
export interface CreativeCtx {
  /** Caller-JWT client (RLS as the caller) — content visibility checks. */
  sb: SupabaseClient;
  /** Service-role client (null when env missing) — mos_creative_* tables have
   *  RLS with NO policies by design, so everything on them goes through svc. */
  svc: SupabaseClient | null;
  body: Record<string, unknown>;
  /** auth.users id of the caller (withAuth's user.userId). */
  userId: string;
}

/** Trimmed non-empty string, else null (same semantics as the endpoints' `str`). */
export const cStr = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * Bilingual failure — emits BOTH error keys so the SPA's MosApiError shows the
 * Arabic message when the UI is Arabic (jsonError alone is English-only).
 */
export function jsonFail(status: number, en: string, ar: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: en, error_ar: ar, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** svc or a 500 — every write path needs the service client. */
export function requireSvc(ctx: CreativeCtx): SupabaseClient | Response {
  if (!ctx.svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');
  return ctx.svc;
}

/** public.users id for an auth uid (null on failure — logged, never silent). */
export async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data, error } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  if (error) {
    console.error('[creative] wassell_app_user_id failed', error.code, error.message, error.details);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Fire-and-forget /wake ping to the Fly worker so a freshly enqueued job skips
 * the poll latency. Missing env or a dead worker is fine — the worker's 3s
 * poll is the reliable path (same posture as /api/generate-deck). Copy of
 * api/templates/clean-listing-images.ts wakeWorker (without the count gate).
 */
export async function wakeWorker(kind: string): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    // Best-effort by design: the ping only saves poll latency; the worker's
    // loop picks the job up regardless. Logged, never thrown.
    console.warn(`[creative] wake failed (non-fatal): ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Preview resolution — competitor media stays PUBLIC (stored_url);    */
/* our files get a 1h signed URL; wassel_content resolves its final    */
/* asset's url (signed when the asset only carries a file).            */
/* ------------------------------------------------------------------ */

async function signFile(svc: SupabaseClient, fileId: string): Promise<string | null> {
  const fr = await svc.from('files').select('storage_bucket, storage_path').eq('id', fileId).maybeSingle();
  if (fr.error) {
    console.error('[creative] files read for preview failed', fileId, fr.error.code, fr.error.message);
    return null;
  }
  const file = fr.data as { storage_bucket: string | null; storage_path: string | null } | null;
  if (!file?.storage_bucket || !file.storage_path) return null;
  const signed = await svc.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 3600);
  if (signed.error || !signed.data?.signedUrl) {
    console.error('[creative] signed-url failed', fileId, signed.error?.message ?? 'no url');
    return null;
  }
  return signed.data.signedUrl;
}

/**
 * The preview URL for one reference/asset id, by ref_kind. null when nothing
 * renderable exists (the UI shows a typed placeholder) — never throws.
 */
export async function resolveRefPreview(
  svc: SupabaseClient,
  refKind: string,
  refId: string,
): Promise<string | null> {
  if (refKind === 'competitor_media') {
    const r = await svc.from('mkt_content_media').select('stored_url').eq('id', refId).maybeSingle();
    if (r.error) console.error('[creative] competitor media preview read failed', refId, r.error.message);
    return (r.data as { stored_url: string | null } | null)?.stored_url ?? null;
  }
  if (refKind === 'competitor_post') {
    const r = await svc.from('mkt_content_media').select('stored_url')
      .eq('content_post_id', refId).eq('media_kind', 'image').eq('download_status', 'stored')
      .not('stored_url', 'is', null)
      .order('carousel_index', { ascending: true }).limit(1).maybeSingle();
    if (r.error) console.error('[creative] competitor post preview read failed', refId, r.error.message);
    return (r.data as { stored_url: string | null } | null)?.stored_url ?? null;
  }
  if (refKind === 'wassel_file' || refKind === 'file') {
    return signFile(svc, refId);
  }
  if (refKind === 'wassel_content') {
    // The content's FINAL asset; fall back to any linked asset with a url.
    const links = await svc.from('mos_asset_links').select('asset_id, role').eq('content_id', refId);
    if (links.error) {
      console.error('[creative] wassel_content links read failed', refId, links.error.message);
      return null;
    }
    const rows = (links.data ?? []) as Array<{ asset_id: string; role: string }>;
    const ordered = [...rows].sort((a, b) => (a.role === 'final' ? 0 : 1) - (b.role === 'final' ? 0 : 1));
    for (const l of ordered) {
      const a = await svc.from('mos_assets').select('url, file_id').eq('id', l.asset_id).maybeSingle();
      if (a.error) {
        console.error('[creative] wassel_content asset read failed', l.asset_id, a.error.message);
        continue;
      }
      const row = a.data as { url: string | null; file_id: string | null } | null;
      if (row?.url) return row.url;
      if (row?.file_id) {
        const signed = await signFile(svc, row.file_id);
        if (signed) return signed;
      }
    }
    return null;
  }
  return null;
}
