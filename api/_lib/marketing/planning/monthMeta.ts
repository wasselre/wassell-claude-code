/**
 * Build item E6 — the month's paid campaigns exist in Meta from confirmation.
 *
 * The month model (docs/plans/monthly-operating-model.md §2, build item E6):
 * ONE paid campaign per project for the month, at the standing budget, with
 * ONE feed/story ad-set pair built from the standing template. Every weekly
 * batch of creatives becomes new ads inside that same pair — no campaign or ad
 * set per batch. A creative's final approval (`auto_meta_ad`) then creates its
 * ad in that pair.
 *
 * Until 2026-09-17 the confirm created the three paid campaigns and their Meta
 * executions as DRAFTS only — no Meta plan, no ad set, no Meta campaign — so a
 * final approval resolved `not_linked` and the ad was silently skipped.
 *
 * What this does, per month-model paid execution not yet linked to Meta:
 *   1. fills the Meta plan from `mos_month_template` when the execution has
 *      none — objective / destination / optimisation from `meta_template`
 *      (defaults = the settings of C-042, the campaign the operator ran), daily
 *      budget = budget_per_project ÷ campaign_length_days;
 *   2. makes sure there is ONE planned ad set (named «واتساب»);
 *   3. builds the campaign + feed/story pair via `ensureMetaSkeleton` — the
 *      same code «إنشاء في ميتا» runs — PAUSED, on the saved audience.
 *
 * Idempotent: a linked execution is skipped. A failure is recorded on the
 * execution (`platform_settings.meta_build_error` + `_at`) and retried at most
 * hourly by the planning sweep, so a persistent Meta refusal cannot turn into a
 * create-and-roll-back loop every ten minutes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureMetaSkeleton, metaErr } from '../metaSkeleton.js';
import { loadMetaConfig, MetaMarketingClient } from '../metaMarketingApi.js';
import { parseMonthStarts, parseMonthTemplate, budgetPerProjectFor } from './monthCompiler.js';

/** The plan C-042 ran on (2026-08-28): Click-to-WhatsApp conversations. */
const META_PLAN_DEFAULTS = Object.freeze({
  objective: 'OUTCOME_LEADS',
  budget_mode: 'DAILY',
  destination_type: 'WHATSAPP',
  optimization_goal: 'CONVERSATIONS',
});
const RETRY_AFTER_MS = 60 * 60 * 1000;

export interface MonthMetaResult {
  execution_id: string;
  campaign: string | null;
  outcome: 'built' | 'already_linked' | 'retry_later' | 'failed';
  error?: string;
  error_ar?: string;
  platform_campaign_id?: string | null;
}

export async function ensureMonthMetaCampaigns(
  svc: SupabaseClient,
  opts: { month?: string; force?: boolean } = {},
): Promise<{ results: MonthMetaResult[]; error?: string }> {
  const tplRes = await svc.from('mos_month_template')
    .select('enabled, budget_per_project, campaign_length_days, meta_template, month_starts').limit(1).maybeSingle();
  if (tplRes.error) {
    console.error('[month-meta] template read failed', tplRes.error.code, tplRes.error.message);
    return { results: [], error: tplRes.error.message };
  }
  const tpl = tplRes.data as {
    enabled: boolean; budget_per_project: number | string | null;
    campaign_length_days: number | null; meta_template: Record<string, unknown> | null;
    month_starts: unknown;
  } | null;
  if (!tpl || tpl.enabled !== true) return { results: [] };

  const refLike = opts.month ? `${opts.month}:paid:%` : '%:paid:%';
  const campRes = await svc.from('mos_campaigns').select('id, ref, name, starts_on, ends_on').like('ref', refLike);
  if (campRes.error) {
    console.error('[month-meta] campaigns read failed', campRes.error.code, campRes.error.message);
    return { results: [], error: campRes.error.message };
  }
  const campaigns = (campRes.data ?? []) as Array<{
    id: string; ref: string; name: string | null; starts_on: string | null; ends_on: string | null;
  }>;
  if (campaigns.length === 0) return { results: [] };
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const today = new Date().toISOString().slice(0, 10);
  const execRes = await svc.from('mos_campaign_executions')
    .select('id, campaign_id, platform, platform_campaign_id, platform_settings, budget, ends_on, archived_at')
    .in('campaign_id', campaigns.map((c) => c.id))
    .in('platform', ['meta', 'instagram'])
    .is('archived_at', null);
  if (execRes.error) {
    console.error('[month-meta] executions read failed', execRes.error.code, execRes.error.message);
    return { results: [], error: execRes.error.message };
  }
  type Exec = {
    id: string; campaign_id: string; platform: string; platform_campaign_id: string | null;
    platform_settings: Record<string, unknown> | null; budget: number | string | null; ends_on: string | null;
  };
  const execs = (execRes.data ?? []) as Exec[];

  // The MONTH's budget, not the template's — a stretched month runs longer and
  // carries its own figure so the pace stays normal (see `budgetPerProjectFor`).
  const parsedTemplate = parseMonthTemplate(tpl as unknown as Record<string, unknown>);
  const templateDays = Number(tpl.campaign_length_days ?? 0);
  /*
   * The daily budget spreads `budget_per_project` over the campaign's OWN
   * window, and only falls back to `campaign_length_days` when the campaign
   * has no dates.
   *
   * A stretched month (`month_starts.through`) runs its ads to the end of the
   * window — 22 Sep → 31 Oct is 40 days — while the length column still says
   * 30. Dividing by 30 and then running for 40 days would spend a third more
   * per project than the operator set, silently.
   */
  const windowDays = (c: { starts_on: string | null; ends_on: string | null }): number => {
    if (!c.starts_on || !c.ends_on) return templateDays;
    const span = Math.round(
      (Date.parse(`${c.ends_on}T00:00:00Z`) - Date.parse(`${c.starts_on}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    return Number.isFinite(span) && span > 0 ? span : templateDays;
  };

  const results: MonthMetaResult[] = [];
  for (const e of execs) {
    const camp = campaignById.get(e.campaign_id);
    const label = camp?.name ?? null;
    if (e.platform_campaign_id) { results.push({ execution_id: e.id, campaign: label, outcome: 'already_linked' }); continue; }
    if (e.ends_on && e.ends_on < today) continue; // a finished month is not built after the fact

    const days = camp ? windowDays(camp) : templateDays;
    const budget = budgetPerProjectFor(parsedTemplate, (camp?.ref ?? '').slice(0, 7));
    const dailyBudget = budget > 0 && days > 0 ? Math.round((budget / days) * 100) / 100 : null;
    const ps = e.platform_settings ?? {};
    const lastFail = typeof ps.meta_build_error_at === 'string' ? Date.parse(ps.meta_build_error_at) : NaN;
    if (!opts.force && Number.isFinite(lastFail) && Date.now() - lastFail < RETRY_AFTER_MS) {
      results.push({ execution_id: e.id, campaign: label, outcome: 'retry_later', error: String(ps.meta_build_error ?? '') });
      continue;
    }

    // 1 — the Meta plan, from the template, only where none was set.
    const hasPlan = typeof ps.objective === 'string' && ps.objective.length > 0;
    if (!hasPlan) {
      if (dailyBudget == null) {
        results.push({ execution_id: e.id, campaign: label, outcome: 'failed',
          error: 'month template has no budget_per_project / campaign_length_days',
          error_ar: 'قالب الشهر بلا ميزانية للمشروع أو مدة للحملة.' });
        continue;
      }
      const plan = {
        ...META_PLAN_DEFAULTS,
        ...(tpl.meta_template ?? {}),
        daily_budget: dailyBudget,
      };
      const up = await svc.from('mos_campaign_executions')
        .update({ platform_settings: plan, budget, updated_at: new Date().toISOString() })
        .eq('id', e.id).is('platform_campaign_id', null);
      if (up.error) {
        console.error('[month-meta] plan write failed', e.id, up.error.message);
        results.push({ execution_id: e.id, campaign: label, outcome: 'failed', error: up.error.message });
        continue;
      }
    }

    // 2 — one planned ad set: the pair is built from it.
    const setRes = await svc.from('mos_ad_sets').select('id').eq('execution_id', e.id).is('archived_at', null).limit(1);
    if (setRes.error) {
      results.push({ execution_id: e.id, campaign: label, outcome: 'failed', error: setRes.error.message });
      continue;
    }
    if ((setRes.data ?? []).length === 0) {
      const ins = await svc.from('mos_ad_sets')
        .insert({ execution_id: e.id, name: 'واتساب', status: 'paused', sort_order: 0 });
      if (ins.error) {
        console.error('[month-meta] ad set insert failed', e.id, ins.error.message);
        results.push({ execution_id: e.id, campaign: label, outcome: 'failed', error: ins.error.message });
        continue;
      }
    }

    // 3 — the campaign + feed/story pair in Meta (PAUSED, saved audience).
    const built = await ensureMetaSkeleton(svc, e.id, { campaignNameOverride: { ref: null, name: label } });
    if (built.ok) {
      const fresh = await svc.from('mos_campaign_executions').select('platform_settings').eq('id', e.id).maybeSingle();
      const cur = ((fresh.data as { platform_settings?: Record<string, unknown> | null } | null)?.platform_settings) ?? {};
      if ('meta_build_error' in cur || 'meta_build_error_at' in cur) {
        const { meta_build_error: _e, meta_build_error_at: _a, ...clean } = cur;
        const clr = await svc.from('mos_campaign_executions').update({ platform_settings: clean }).eq('id', e.id);
        if (clr.error) console.error('[month-meta] clearing the build error failed', e.id, clr.error.message);
      }
      // A month whose ads run the moment each is ready (month_starts): switch
      // the campaign + both ad sets ON now. Meta still delivers nothing before
      // the ad sets' start date (the month's first paid day), and each ad is
      // created ACTIVE on its final approval — so it goes live when it is ready.
      const monthKey = (camp?.ref ?? '').slice(0, 7);
      const liveNow = parseMonthStarts(tpl.month_starts)[monthKey]?.adsLiveWhenReady === true;
      let activation: string | null = null;
      if (liveNow && built.campaign.platform_campaign_id) {
        const cfg = loadMetaConfig();
        if (!cfg) activation = 'Meta not configured';
        else {
          const client = new MetaMarketingClient(cfg);
          try {
            await client.setStatus(built.campaign.platform_campaign_id, 'ACTIVE');
            const setIds = built.ad_sets.map((s) => s.platform_adset_id).filter((id) => id && id !== '(validated)');
            for (const id of setIds) await client.setStatus(id, 'ACTIVE');
            const now = new Date().toISOString();
            const ex = await svc.from('mos_campaign_executions').update({ status: 'running', updated_at: now }).eq('id', e.id);
            if (ex.error) console.error('[month-meta] execution status write failed', e.id, ex.error.message);
            const st = await svc.from('mos_ad_sets').update({ status: 'active', updated_at: now }).in('platform_adset_id', setIds);
            if (st.error) console.error('[month-meta] ad set status write failed', e.id, st.error.message);
          } catch (err) {
            activation = metaErr(err);
            console.error('[month-meta] activating the month campaign failed', e.id, activation);
          }
        }
      }
      results.push(activation
        ? { execution_id: e.id, campaign: label, outcome: 'failed', platform_campaign_id: built.campaign.platform_campaign_id,
            error: `built but not switched on: ${activation}`, error_ar: `أُنشئت الحملة لكن تعذّر تشغيلها: ${activation}` }
        : { execution_id: e.id, campaign: label, outcome: 'built', platform_campaign_id: built.campaign.platform_campaign_id });
    } else {
      console.error('[month-meta] Meta build failed', e.id, built.status, built.error);
      const fresh = await svc.from('mos_campaign_executions').select('platform_settings').eq('id', e.id).maybeSingle();
      const cur = ((fresh.data as { platform_settings?: Record<string, unknown> | null } | null)?.platform_settings) ?? {};
      const mark = await svc.from('mos_campaign_executions')
        .update({ platform_settings: { ...cur, meta_build_error: built.error, meta_build_error_at: new Date().toISOString() } })
        .eq('id', e.id);
      if (mark.error) console.error('[month-meta] recording the build error failed', e.id, mark.error.message);
      results.push({ execution_id: e.id, campaign: label, outcome: 'failed', error: built.error, error_ar: built.error_ar });
    }
  }
  return { results };
}
