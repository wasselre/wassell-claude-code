/**
 * The publication task — the second of the two task types (2026-09-14).
 *
 * A publication task carries THREE things and deliberately nothing else:
 *
 *   1. the final ready content   — the approved material and its caption;
 *   2. where it is going          — platform, account, date and time;
 *   3. what that platform demands — the shared rulebook's verdict.
 *
 * No brief, no references, no revision history, no approval controls. Those
 * belong to the content task, which is a different job done by different people
 * at a different time. Mixing them is what produced a single `publish_check`
 * step that had to stand for every destination a creative would ever have.
 *
 * Requirement checking reuses `preflightPublishSet` — the SAME pure rulebook the
 * Publish tab and the authoritative publish gate already use, so a task can
 * never claim a post is fine that the publish path would then refuse.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { preflightPublishSet, CAPTION_MAX } from '../../../../src/lib/marketingOS/platformRules.js';
import type { PlanCtx } from './actions.js';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (b: Record<string, unknown>): Response => json({ ok: true, ...b }, 200);
const err = (status: number, e: string, extra?: Record<string, unknown>): Response =>
  json({ error: e, ...(extra ?? {}) }, status);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

interface ReleaseRow {
  release_id: string;
  kind: string;
  content_id: string;
  content_ref: string | null;
  content_title: string | null;
  project_id: string | null;
  campaign_id: string | null;
  platform: string;
  account_id: string | null;
  account_handle: string | null;
  account_connected: boolean | null;
  account_can_publish: boolean | null;
  due_at: string | null;
  scheduled_timezone: string | null;
  status: string;
  published_at: string | null;
  external_url: string | null;
  bundle_post_id: string | null;
  bundle_status: string | null;
  bundle_error: string | null;
  caption: string | null;
  asset_ids: string[] | null;
  file_id: string | null;
  automatable: boolean;
  open_task_id: string | null;
}

interface AssetRow {
  id: string; url: string | null; file_id: string | null; kind: string;
  mime_type: string | null; size_bytes: number | null;
  duration_seconds: number | null; aspect_ratio: string | null;
}

/** Section 3: what this destination demands of this material. */
async function requirements(sb: SupabaseClient, rel: ReleaseRow): Promise<{
  ok: boolean;
  caption_max: number | null;
  caption_length: number;
  issues: Array<{ level: string; ar: string; en: string }>;
  assets: AssetRow[];
}> {
  const ids = (rel.asset_ids ?? []).filter((x): x is string => typeof x === 'string' && x !== '');
  let assets: AssetRow[] = [];
  if (ids.length) {
    const res = await sb.from('mos_assets')
      .select('id, url, file_id, kind, mime_type, size_bytes, duration_seconds, aspect_ratio')
      .in('id', ids);
    const byId = new Map(((res.data as AssetRow[] | null) ?? []).map((a) => [a.id, a]));
    // Preserve the carousel order — `.in()` returns rows in an arbitrary one.
    assets = ids.map((i) => byId.get(i)).filter((a): a is AssetRow => Boolean(a));
  }
  const caption = rel.caption ?? '';
  // No material yet is a BLOCKER, stated plainly. Running the rulebook over an
  // empty set and reporting "fine" would be the silent pass this repo keeps
  // getting burned by.
  if (assets.length === 0) {
    return {
      ok: false,
      caption_max: CAPTION_MAX[rel.platform] ?? null,
      caption_length: caption.length,
      issues: [{
        level: 'block',
        ar: 'لا يوجد ملف معتمد لهذا النشر.',
        en: 'This release has no approved file to publish.',
      }],
      assets,
    };
  }
  const flight = preflightPublishSet(rel.platform, assets, caption);
  return {
    ok: flight.issues.every((i) => i.level !== 'block'),
    caption_max: flight.captionMax ?? CAPTION_MAX[rel.platform] ?? null,
    caption_length: caption.length,
    issues: flight.issues,
    assets,
  };
}

/** The three sections for ONE release. */
export async function releaseGet(ctx: PlanCtx): Promise<Response> {
  const id = str(ctx.body.release_id) ?? str(ctx.body.publication_id);
  if (!id) return err(400, 'release_id is required');

  const res = await ctx.sb.from('mos_release_v').select('*').eq('release_id', id).maybeSingle();
  if (res.error) return err(500, res.error.message);
  const rel = res.data as ReleaseRow | null;
  if (!rel) return err(404, 'release not found');

  const req = await requirements(ctx.sb, rel);
  return ok({
    release: {
      id: rel.release_id,
      kind: rel.kind,
      status: rel.status,
      automatable: rel.automatable,
      open_task_id: rel.open_task_id,
      // 1 — the final ready content
      content: {
        id: rel.content_id,
        ref: rel.content_ref,
        title: rel.content_title,
        caption: rel.caption,
        assets: req.assets,
      },
      // 2 — where it is going
      destination: {
        platform: rel.platform,
        account_id: rel.account_id,
        account_handle: rel.account_handle,
        account_connected: rel.account_connected,
        account_can_publish: rel.account_can_publish,
        due_at: rel.due_at,
        timezone: rel.scheduled_timezone,
        published_at: rel.published_at,
        external_url: rel.external_url,
        bundle_status: rel.bundle_status,
        bundle_error: rel.bundle_error,
      },
      // 3 — what the platform demands
      requirements: {
        ok: req.ok,
        caption_max: req.caption_max,
        caption_length: req.caption_length,
        issues: req.issues,
      },
    },
  });
}

/** Releases for one content record, one campaign, or the caller's open tasks. */
export async function releaseList(ctx: PlanCtx): Promise<Response> {
  const contentId = str(ctx.body.content_id);
  const campaignId = str(ctx.body.campaign_id);
  const mine = ctx.body.mine === true;

  let q = ctx.sb.from('mos_release_v').select('*');
  if (contentId) q = q.eq('content_id', contentId);
  if (campaignId) q = q.eq('campaign_id', campaignId);
  if (mine) q = q.not('open_task_id', 'is', null);
  const res = await q.order('due_at', { ascending: true, nullsFirst: false }).limit(500);
  if (res.error) return err(500, res.error.message);
  return ok({ releases: res.data ?? [] });
}

/**
 * Record a release that a PERSON published by hand.
 *
 * For a platform with no integration this is the completion: the person posts
 * it, pastes the link, and the release is done. The task closes itself through
 * the publications trigger, so the two can never disagree.
 *
 * Refused when the destination could have published by itself — that path must
 * go through the real publish so bundle.social owns the post and its metrics,
 * rather than a hand-typed link that nothing can reconcile.
 */
export async function releaseMarkPublished(ctx: PlanCtx): Promise<Response> {
  const id = str(ctx.body.release_id) ?? str(ctx.body.publication_id);
  if (!id) return err(400, 'release_id is required');
  const url = str(ctx.body.external_url);

  const res = await ctx.sb.from('mos_release_v').select('*').eq('release_id', id).maybeSingle();
  if (res.error) return err(500, res.error.message);
  const rel = res.data as ReleaseRow | null;
  if (!rel) return err(404, 'release not found');

  if (rel.status === 'published') {
    return err(409, 'هذا النشر مُسجَّل منشورًا بالفعل. / This release is already recorded as published.');
  }
  if (rel.automatable && !rel.bundle_post_id) {
    return err(400,
      'هذه المنصة تنشر آليًا — استخدم «انشر الآن» بدل التسجيل اليدوي. / '
      + 'This destination publishes automatically — use publish instead of recording it by hand.');
  }

  const upd = await ctx.sb.from('mos_publications')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      external_url: url,
    })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (upd.error) return err(500, upd.error.message);
  if (!upd.data) return err(404, 'release not found');

  return ok({ release_id: id, status: 'published', external_url: url });
}

/**
 * Raise the publication task for one release on demand.
 *
 * The sweep does this on its own schedule; this is for a person who wants the
 * work in the queue NOW (a failed post they want to retry by hand, say).
 */
export async function releaseOpenTask(ctx: PlanCtx): Promise<Response> {
  const id = str(ctx.body.release_id) ?? str(ctx.body.publication_id);
  if (!id) return err(400, 'release_id is required');
  const reason = str(ctx.body.reason) ?? 'manual';
  const sb = ctx.svc ?? ctx.sb;
  const res = await sb.rpc('mos_release_open_task', {
    p_publication_id: id, p_reason: reason, p_detail: str(ctx.body.detail),
  });
  if (res.error) return err(500, res.error.message);
  return ok({ task_id: res.data ?? null });
}
