/**
 * creative_targets — the organic + paid placement pick-list for a content
 * item, with default placement types, which targets already exist (`selected`),
 * and the suggested master aspect for the selection.
 *
 * Organic: the content's `organic_platforms` ∪ its existing publications
 * (publication_id when a row exists). Defaults per contracts §4 / A-API brief:
 * instagram feed|carousel by content type, tiktok photo_mode, snapchat story,
 * x post, website post. Paid: the same campaign→executions→ad sets→ads walk
 * `paid_placement_targets` uses, for the content's campaign and any campaign;
 * meta → ad_feed, google → ad_display. `selected` = the placement row exists.
 */
import { jsonOk, jsonError } from '../../auth.js';
import { masterAspectFor } from '../../../../src/lib/marketingOS/platformRules.js';
import { cStr, type CreativeCtx } from './wake.js';

/** Default organic placement type per platform (post vs carousel by content type). */
export function defaultOrganicPlacement(platform: string, contentTypeKey: string | null): string {
  switch (platform) {
    case 'instagram': return contentTypeKey === 'carousel' ? 'carousel' : 'feed';
    case 'tiktok': return 'photo_mode';
    case 'snapchat': return 'story';
    case 'x': return 'post';
    case 'website': return 'post';
    default: return 'feed';
  }
}

/** Default paid placement type per execution platform. */
export function defaultPaidPlacement(platform: string): string {
  return platform === 'google' ? 'ad_display' : 'ad_feed';
}

export interface OrganicTarget {
  platform: string;
  placement_type: string;
  publication_id: string | null;
  selected: boolean;
}
export interface PaidTarget {
  platform: string;
  placement_type: string;
  execution_id: string;
  ad_set_id: string | null;
  ad_id: string | null;
  campaign_id: string;
  selected: boolean;
}

export async function creativeTargets(ctx: CreativeCtx): Promise<Response> {
  const { sb } = ctx;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');

  // The caller must be able to SEE the content (RLS read) before we plan for it.
  const c = await sb.from('mos_content_v')
    .select('id, content_type_key, organic_platforms, campaign_id')
    .eq('id', contentId).maybeSingle();
  if (c.error) {
    console.error('[creative] targets content read failed', c.error.code, c.error.message);
    return jsonError(500, c.error.message);
  }
  if (!c.data) return jsonError(404, 'content item not found');
  const content = c.data as {
    id: string; content_type_key: string | null;
    organic_platforms: string[] | null; campaign_id: string | null;
  };

  // ── organic ─────────────────────────────────────────────────────────────
  const pubs = await sb.from('mos_publications')
    .select('id, platform').eq('content_id', contentId);
  if (pubs.error) {
    console.error('[creative] targets publications read failed', pubs.error.code, pubs.error.message);
    return jsonError(500, pubs.error.message);
  }
  const pubByPlatform = new Map<string, string>();
  for (const p of (pubs.data ?? []) as Array<{ id: string; platform: string }>) {
    if (!pubByPlatform.has(p.platform)) pubByPlatform.set(p.platform, p.id);
  }
  const platforms = new Set<string>([
    ...(Array.isArray(content.organic_platforms) ? content.organic_platforms : []),
    ...pubByPlatform.keys(),
  ]);
  const organic: OrganicTarget[] = [...platforms].sort().map((platform) => ({
    platform,
    placement_type: defaultOrganicPlacement(platform, content.content_type_key),
    publication_id: pubByPlatform.get(platform) ?? null,
    selected: pubByPlatform.has(platform),
  }));

  // ── paid — campaign → executions → ad sets → ads (any paid campaign) ────
  const camps = await sb.from('mos_campaigns').select('id, name')
    .eq('kind', 'paid').is('archived_at', null).order('created_at', { ascending: false });
  if (camps.error) {
    console.error('[creative] targets campaigns read failed', camps.error.code, camps.error.message);
    return jsonError(500, camps.error.message);
  }
  const campRows = (camps.data ?? []) as Array<{ id: string; name: string }>;

  const paid: PaidTarget[] = [];
  if (campRows.length > 0) {
    const execs = await sb.from('mos_campaign_executions')
      .select('id, campaign_id, platform, label')
      .in('campaign_id', campRows.map((x) => x.id))
      .order('platform', { ascending: true });
    if (execs.error) {
      console.error('[creative] targets executions read failed', execs.error.code, execs.error.message);
      return jsonError(500, execs.error.message);
    }
    const execRows = (execs.data ?? []) as Array<{ id: string; campaign_id: string; platform: string; label: string | null }>;

    const linkedAds = await sb.from('mos_execution_ads')
      .select('id, execution_id, ad_set_id')
      .eq('content_id', contentId).is('archived_at', null);
    if (linkedAds.error) {
      console.error('[creative] targets linked-ads read failed', linkedAds.error.code, linkedAds.error.message);
      return jsonError(500, linkedAds.error.message);
    }
    const adByExec = new Map<string, { id: string; ad_set_id: string | null }>();
    for (const a of (linkedAds.data ?? []) as Array<{ id: string; execution_id: string; ad_set_id: string | null }>) {
      if (!adByExec.has(a.execution_id)) adByExec.set(a.execution_id, { id: a.id, ad_set_id: a.ad_set_id });
    }

    // The content's own campaign sorts first; the rest follow (any campaign).
    const ownCampaign = content.campaign_id;
    const sortedExecs = [...execRows].sort((a, b) => {
      const ao = a.campaign_id === ownCampaign ? 0 : 1;
      const bo = b.campaign_id === ownCampaign ? 0 : 1;
      return ao - bo || a.platform.localeCompare(b.platform);
    });
    for (const e of sortedExecs) {
      const ad = adByExec.get(e.id) ?? null;
      paid.push({
        platform: e.platform,
        placement_type: defaultPaidPlacement(e.platform),
        execution_id: e.id,
        ad_set_id: ad?.ad_set_id ?? null,
        ad_id: ad?.id ?? null,
        campaign_id: e.campaign_id,
        selected: ad !== null,
      });
    }
  }

  // Master aspect from the SELECTED targets; nothing selected yet → all of them.
  const selectedRefs = [
    ...organic.filter((t) => t.selected).map((t) => ({ platform: t.platform, placement_type: t.placement_type })),
    ...paid.filter((t) => t.selected).map((t) => ({ platform: t.platform, placement_type: t.placement_type })),
  ];
  const allRefs = [
    ...organic.map((t) => ({ platform: t.platform, placement_type: t.placement_type })),
    ...paid.map((t) => ({ platform: t.platform, placement_type: t.placement_type })),
  ];
  const suggested_master_aspect = masterAspectFor(selectedRefs.length > 0 ? selectedRefs : allRefs);

  return jsonOk({ organic, paid, suggested_master_aspect });
}
