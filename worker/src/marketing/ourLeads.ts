/**
 * OUR leads per ad — the number the weekly paid rule actually turns on.
 *
 * §3.6: "Cost per lead is spend divided by **our** leads: WhatsApp
 * conversations whose opening message carried the ad, counted over the same
 * days as the spend." Today the app shows Meta's `actions` lead count, which
 * is Meta's own attribution of its own success. This module is the other
 * number — the conversations that actually reached us.
 *
 * WHERE IT COMES FROM. The WhatsApp webhook stamps a click-to-WhatsApp
 * conversation's opening message with `chat_messages.meta.ad`, and the
 * attribution resolver fills `meta.ad.resolved` with OUR ids. The shape, as
 * measured on 2026-09-15 over all 278 attributed messages:
 *
 *   meta.ad.ad_id              — the PLATFORM ad id (Meta's), 278/278
 *   meta.ad.resolved.ad_id     — the INTERNAL `mos_execution_ads` id, 278/278
 *   meta.ad.resolved.content_id— 73/278 only
 *   meta.ad.source_id          — does not exist (0/278)
 *
 * Two consequences, both load-bearing:
 *
 *   • **Group on `resolved.ad_id`.** Grouping on `resolved.content_id` — which
 *     an earlier draft proposed, because it reads like the natural join — is
 *     present on 73 of 278 messages and would silently drop **74 %** of our
 *     leads. A cost-per-lead computed on a quarter of the leads is four times
 *     too expensive, and it would look plausible.
 *   • **Derive the project through execution → campaign**, never through
 *     content. `ourLeadsByProject` does exactly that.
 *
 * ONE LEAD IS ONE CONVERSATION, not one message: 278 messages are 241
 * conversations. A conversation is counted on the day of its FIRST attributed
 * message — its opening — so the count lines up with the spend of the days it
 * was bought on. A person who clicked two different ads counts once for each
 * ad (per-ad truth) but once in a project total (`ourLeadsByProject` dedups).
 *
 * Days are RIYADH civil days, matching `mos_ad_metrics_daily.day`, which comes
 * from Meta's `date_start` in the ad account's timezone. Windowing a
 * UTC-stamped message by a Riyadh-dated spend row is a three-hour shear that
 * moves late-evening leads into the wrong day.
 *
 * NOTE: this file is a VERBATIM COPY of `api/_lib/marketing/ourLeads.ts` —
 * the Fly worker is a standalone npm package (`rootDir: src`) and cannot
 * import from `api/_lib` (same posture as `worker/src/imageGen.ts` and
 * `worker/src/migrateAgent.ts`). Change both together.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** One conversation that arrived from one ad. */
export interface OurLead {
  /** `mos_execution_ads.id` — OUR ad row, not Meta's ad id. */
  adRowId: string;
  /** The conversation: `chat_wid` when present, else the chat record id. */
  conversationKey: string;
  /** Riyadh civil date (YYYY-MM-DD) of the opening attributed message. */
  day: string;
  /** ISO timestamp of that message. */
  at: string;
  /** Meta's own ad id, carried through for auditing a disagreement. */
  platformAdId: string | null;
}

export interface OurLeadsWindow {
  /** Inclusive YYYY-MM-DD. */
  since?: string | null;
  /** Inclusive YYYY-MM-DD. */
  until?: string | null;
}

/** PostgREST `in.()` lists get unwieldy past a couple of hundred ids. */
const CHUNK = 150;

/** Riyadh civil date of an ISO timestamp — the calendar Meta's days use. */
export function riyadhDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

interface AttributedMessageRow {
  id: string;
  chat_wid: string | null;
  conversation_record_id: string | null;
  date: string | null;
  created_at: string | null;
  meta: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `meta.ad` → the two ids and nothing else. Unknown shapes yield nulls. */
function readAd(meta: Record<string, unknown> | null): { adRowId: string | null; platformAdId: string | null } {
  const ad = (meta?.ad ?? null) as Record<string, unknown> | null;
  if (!ad || typeof ad !== 'object') return { adRowId: null, platformAdId: null };
  const resolved = (ad.resolved ?? null) as Record<string, unknown> | null;
  return {
    adRowId: resolved && typeof resolved === 'object' ? str(resolved.ad_id) : null,
    platformAdId: str(ad.ad_id),
  };
}

/**
 * Every conversation that arrived from one of `adRowIds`, one row per
 * (ad, conversation) at the conversation's opening message.
 *
 * `window` narrows the DATABASE read, not the result — a caller judging each
 * ad on its own seven days passes the union of those windows here and slices
 * per ad with `leadsInWindow`. Pass nothing to read the whole history.
 *
 * Errors are RETURNED, never swallowed: a lead count that silently reads zero
 * would make every creative look infinitely expensive and pause the lot.
 */
export async function ourLeadsForAds(
  sb: SupabaseClient, adRowIds: string[], window: OurLeadsWindow = {},
): Promise<{ leads: OurLead[]; error: string | null }> {
  const ids = [...new Set(adRowIds.filter(Boolean))];
  if (ids.length === 0) return { leads: [], error: null };

  // Riyadh days → a UTC instant range, widened by a day on each side so a
  // message at 01:00 Riyadh on the first day (22:00 UTC the day before) is not
  // cut off. The exact day filtering happens below, on the Riyadh date.
  const since = window.since ? `${window.since}T00:00:00.000Z` : null;
  const until = window.until ? `${window.until}T23:59:59.999Z` : null;

  const rows: AttributedMessageRow[] = [];
  for (const part of chunk(ids, CHUNK)) {
    let q = sb.from('chat_messages')
      .select('id, chat_wid, conversation_record_id, date, created_at, meta')
      .in('meta->ad->resolved->>ad_id', part);
    if (since) q = q.gte('date', new Date(Date.parse(since) - 86_400_000).toISOString());
    if (until) q = q.lte('date', new Date(Date.parse(until) + 86_400_000).toISOString());
    const res = await q;
    if (res.error) {
      return { leads: [], error: `chat_messages ad-attribution read failed: ${res.error.code ?? ''} ${res.error.message}`.trim() };
    }
    rows.push(...((res.data ?? []) as AttributedMessageRow[]));
  }

  // One row per (ad, conversation), kept at the EARLIEST attributed message.
  const first = new Map<string, OurLead>();
  for (const r of rows) {
    const { adRowId, platformAdId } = readAd(r.meta);
    if (!adRowId || !ids.includes(adRowId)) continue;
    const at = str(r.date) ?? str(r.created_at);
    if (!at) continue;
    const conversationKey = str(r.chat_wid) ?? str(r.conversation_record_id) ?? r.id;
    const key = `${adRowId}::${conversationKey}`;
    const lead: OurLead = { adRowId, conversationKey, day: riyadhDay(at), at, platformAdId };
    const prev = first.get(key);
    if (!prev || Date.parse(lead.at) < Date.parse(prev.at)) first.set(key, lead);
  }

  const leads = [...first.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { leads, error: null };
}

/** Group by ad row — the shape the ranking feeder wants. */
export function leadsByAd(leads: OurLead[]): Map<string, OurLead[]> {
  const out = new Map<string, OurLead[]>();
  for (const l of leads) {
    const list = out.get(l.adRowId);
    if (list) list.push(l);
    else out.set(l.adRowId, [l]);
  }
  return out;
}

/**
 * How many of `leads` opened inside `[since, until]` (inclusive, Riyadh days).
 *
 * De-duplicated by conversation, so summing the feed ad's leads and its story
 * shadow's leads counts one person once — which is what "the feed and story
 * ads of one creative summed" has to mean.
 */
export function leadsInWindow(leads: OurLead[], since: string, until: string): number {
  const seen = new Set<string>();
  for (const l of leads) {
    if (l.day < since || l.day > until) continue;
    seen.add(l.conversationKey);
  }
  return seen.size;
}

export interface ProjectLeadTotals {
  projectId: string | null;
  campaignId: string | null;
  leads: number;
  adRowIds: string[];
}

/**
 * Our leads per PROJECT, derived ad → execution → campaign → project.
 *
 * Deliberately NOT through `resolved.content_id` (73/278) or
 * `resolved.project_id` (a snapshot taken at attribution time, so it is stale
 * for any execution linked to its campaign afterwards — which is exactly what
 * `meta_link_execution` does). The chain below is re-derived on every read.
 *
 * A `projectId` of null is the fail-loud bucket: spend whose campaign carries
 * no project. It is returned, never dropped.
 */
export async function ourLeadsByProject(
  sb: SupabaseClient, window: OurLeadsWindow = {},
): Promise<{ totals: ProjectLeadTotals[]; error: string | null }> {
  const adsRes = await sb.from('mos_execution_ads').select('id, execution_id').is('archived_at', null);
  if (adsRes.error) return { totals: [], error: `mos_execution_ads read failed: ${adsRes.error.message}` };
  const ads = (adsRes.data ?? []) as Array<{ id: string; execution_id: string }>;
  if (ads.length === 0) return { totals: [], error: null };

  const execIds = [...new Set(ads.map((a) => a.execution_id).filter(Boolean))];
  const execRes = await sb.from('mos_campaign_executions').select('id, campaign_id').in('id', execIds);
  if (execRes.error) return { totals: [], error: `mos_campaign_executions read failed: ${execRes.error.message}` };
  const execs = (execRes.data ?? []) as Array<{ id: string; campaign_id: string | null }>;
  const campaignOfExec = new Map(execs.map((e) => [e.id, e.campaign_id]));

  const campaignIds = [...new Set(execs.map((e) => e.campaign_id).filter((x): x is string => !!x))];
  const projectOfCampaign = new Map<string, string | null>();
  if (campaignIds.length > 0) {
    const cRes = await sb.from('mos_campaigns').select('id, project_id').in('id', campaignIds);
    if (cRes.error) return { totals: [], error: `mos_campaigns read failed: ${cRes.error.message}` };
    for (const c of (cRes.data ?? []) as Array<{ id: string; project_id: string | null }>) {
      projectOfCampaign.set(c.id, c.project_id);
    }
  }

  const { leads, error } = await ourLeadsForAds(sb, ads.map((a) => a.id), window);
  if (error) return { totals: [], error };

  const execOfAd = new Map(ads.map((a) => [a.id, a.execution_id]));
  const buckets = new Map<string, { projectId: string | null; campaignId: string | null; convs: Set<string>; ads: Set<string> }>();
  for (const l of leads) {
    if (window.since && l.day < window.since) continue;
    if (window.until && l.day > window.until) continue;
    const execId = execOfAd.get(l.adRowId) ?? null;
    const campaignId = execId ? campaignOfExec.get(execId) ?? null : null;
    const projectId = campaignId ? projectOfCampaign.get(campaignId) ?? null : null;
    const key = `${projectId ?? ''}::${campaignId ?? ''}`;
    let b = buckets.get(key);
    if (!b) { b = { projectId, campaignId, convs: new Set(), ads: new Set() }; buckets.set(key, b); }
    b.convs.add(l.conversationKey);
    b.ads.add(l.adRowId);
  }

  const totals = [...buckets.values()]
    .map((b) => ({ projectId: b.projectId, campaignId: b.campaignId, leads: b.convs.size, adRowIds: [...b.ads] }))
    .sort((a, b) => b.leads - a.leads);
  return { totals, error: null };
}
