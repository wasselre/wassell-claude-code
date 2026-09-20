/**
 * The month page's five actions — F1 + F2 of the monthly operating model.
 *
 *   month_get       the month in either tense: template, geometry, the three
 *                   slots (chosen, or the ranking's suggestion), notes,
 *                   exceptions.
 *   month_compile   a PREVIEW. Compiles the whole month against the live
 *                   workload and writes NOTHING.
 *   month_confirm   the one button. Creates the month's campaigns, stores the
 *                   four plans and commits them.
 *   month_report    the same page with live numbers: `mos_month_metrics` (spend
 *                   / impressions / qualified clients) joined to OUR WhatsApp
 *                   leads from `ourLeads.ts`.
 *   month_note_set  one note on the month, a project column, a row cell or a
 *                   paid batch cell (§3.7, D7).
 *
 * THREE THINGS WORTH KNOWING BEFORE EDITING THIS FILE
 *
 * 1. **`mos_month_template`, `mos_month_notes` and `mos_content_rows` have RLS
 *    ENABLED and ZERO POLICIES.** Measured 2026-09-15. A browser session reads
 *    them as EMPTY — not as an error. So every touch of those three tables here
 *    goes through the SERVICE client, and the capability gate is the `requireCap`
 *    in `api/marketing-os.ts` that routes to these functions. Reading them with
 *    `ctx.sb` would produce a month page that is silently blank for everyone.
 *
 * 2. **The two lead grains are never mixed.** A LEAD is a conversation
 *    (`ourLeads.ts`, from `chat_messages.meta.ad.resolved.ad_id`) and it is what
 *    cost per lead divides by. A QUALIFIED lead is a CLIENT RECORD that an
 *    ad-attributed conversation created (`client_attributions`, via the RPC),
 *    and the count pair «١٣ مؤهل من ١٧» takes BOTH its numbers from that grain
 *    so the pair is internally consistent. D5's note is explicit that the
 *    qualified measure must not be rendered as a second riyal figure.
 *
 * 3. **`month_confirm` is gated on `mos_month_template.enabled`.** The template
 *    ships `enabled = false`; until an operator turns it on, the month page is a
 *    read-only preview. That is the kill switch for a one-phase cutover, and it
 *    is data, not code.
 *
 * Plan: docs/plans/monthly-operating-model-build.md §4 Group F (F1, F2).
 */
import { ensureMonthMetaCampaigns } from './monthMeta.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import {
  DEFAULT_RULES,
  type PlanInput, type PlanResult, type RuleSet,
} from '../../../../src/lib/marketingOS/scheduling/index.js';
import { terminalLostStages } from '../../../../src/lib/salesProcess/qualifiedStages.js';
import { ourLeadsByProject, type ProjectLeadTotals } from '../ourLeads.js';
import {
  compileMonth, parseMonthTemplate, monthGeometry, monthStartFrom, monthCoveredBy,
  MONTH_TEMPLATE_DEFAULTS,
  type CompiledMonth, type MonthProject, type MonthTemplate,
} from './monthCompiler.js';
import {
  materialisePayload, reservationsPayload, planSignature, parsePlanInput, toSnake,
  type PlanCtx,
} from './actions.js';
import { loadPlanningSettings, loadRuleSet, loadWorkloadSnapshot, riyadhToday } from './snapshot.js';

/* ------------------------------------------------------------------ */
/* small shared helpers                                                */
/* ------------------------------------------------------------------ */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function fail(where: string, e: { code?: string; message: string; details?: string } | null): Response {
  console.error(`[month] ${where} failed`, e?.code, e?.message, e?.details);
  return jsonError(500, e?.message ?? `${where} failed`);
}

/** `YYYY-MM` from the body, or the current Riyadh month. Never guesses ahead. */
function monthOf(body: Record<string, unknown>): string | null {
  const raw = str(body.month);
  if (!raw) return riyadhToday().slice(0, 7);
  return MONTH_RE.test(raw) ? raw : null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `start_from` — the day the month is compiled FROM.
 *
 * Omitted (the normal case) it is DEFAULTED: today for the current month, the
 * whole cycle for any other. Never backwards: compiling from a past day is what
 * produced a production start a fortnight behind the clock.
 *
 * It does NOT have to be a day the month can start ON. `monthGeometry` advances
 * past every posting day production cannot reach and reports the move, so the
 * operator no longer has to work out that answer and pass it back in. Passing
 * one explicitly still works and means "production begins on this day".
 *
 * `'bad'` is a refusal, distinct from "not given".
 */
function startFromOf(body: Record<string, unknown>, month: string): string | null | 'bad' {
  const raw = str(body.start_from);
  if (!raw) return monthStartFrom(month, riyadhToday());
  if (!DAY_RE.test(raw)) return 'bad';
  const today = riyadhToday();
  return raw < today ? today : raw;
}

/** The `public.users` row id for the caller — every `*_user_id` FK points there. */
async function appUserId(ctx: PlanCtx): Promise<string | null> {
  if (!ctx.userId) return null;
  const { data, error } = await ctx.sb.rpc('wassell_app_user_id', { auth_user_id: ctx.userId });
  if (error) {
    console.error('[month] wassell_app_user_id failed', error.code, error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

export interface MonthTemplateRow extends MonthTemplate {
  id: string | null;
  enabled: boolean;
  /** The weekly ranking's four numbers, carried so the page can show them. */
  minSpendSar: number;
  minImpressions: number;
  minLeaderLeads: number;
  leaderMarginPct: number;
}

/**
 * The one `mos_month_template` row. SERVICE client: the table is RLS-enabled
 * with no policies (see the header), so a browser read returns nothing at all.
 */
async function loadTemplate(svc: SupabaseClient): Promise<{ row: MonthTemplateRow; error: string | null }> {
  const fallback: MonthTemplateRow = {
    ...MONTH_TEMPLATE_DEFAULTS,
    id: null,
    enabled: false,
    minSpendSar: 150,
    minImpressions: 2000,
    minLeaderLeads: 5,
    leaderMarginPct: 20,
  };
  const { data, error } = await svc.from('mos_month_template').select('*').limit(1).maybeSingle();
  if (error) return { row: fallback, error: `mos_month_template read failed: ${error.message}` };
  if (!data) return { row: fallback, error: null };
  const raw = data as Record<string, unknown>;
  return {
    row: {
      ...parseMonthTemplate(raw),
      id: str(raw.id),
      enabled: raw.enabled === true,
      minSpendSar: num(raw.min_spend_sar) || fallback.minSpendSar,
      minImpressions: num(raw.min_impressions) || fallback.minImpressions,
      minLeaderLeads: num(raw.min_leader_leads) || fallback.minLeaderLeads,
      leaderMarginPct: num(raw.leader_margin_pct) || fallback.leaderMarginPct,
    },
    error: null,
  };
}

interface CampaignRow {
  id: string;
  ref: string | null;
  name: string | null;
  kind: string | null;
  status: string | null;
  project_id: string | null;
  plan_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  budget_total: number | null;
  /** The plan input the commit stored — the ONLY record of slot ORDER. */
  requirements: Record<string, unknown> | null;
}

const organicRef = (month: string): string => `${month}:organic`;
const paidRef = (month: string, projectId: string): string => `${month}:paid:${projectId}`;

/** Every campaign this month owns. `mos_campaigns.ref` is UNIQUE — it is the anchor. */
async function loadMonthCampaigns(
  svc: SupabaseClient, month: string,
): Promise<{ campaigns: CampaignRow[]; error: string | null }> {
  const { data, error } = await svc.from('mos_campaigns')
    .select('id, ref, name, kind, status, project_id, plan_id, starts_on, ends_on, budget_total, requirements')
    .like('ref', `${month}:%`)
    .is('archived_at', null)
    .order('ref');
  if (error) return { campaigns: [], error: `mos_campaigns read failed: ${error.message}` };
  return { campaigns: (data ?? []) as CampaignRow[], error: null };
}

/**
 * The month's projects IN SLOT ORDER — أ then ب then ج.
 *
 * Order is not recoverable from the paid campaigns: their refs sort by project
 * UUID, which is arbitrary, and «الأحد أ · الثلاثاء ب · الخميس ج» would then be
 * a different assignment every time the page loaded. The organic commit stores
 * its plan input on the campaign (`mos_campaigns.requirements`), and that
 * input's `projects` array IS the order the operator confirmed. The paid refs
 * are the fallback, and only so a month whose organic campaign lost its
 * requirements still renders something.
 */
function slotOrder(campaigns: CampaignRow[], month: string): string[] {
  const organic = campaigns.find((c) => c.ref === organicRef(month));
  const raw = organic?.requirements?.projects;
  const fromPlan = Array.isArray(raw)
    ? (raw as unknown[])
      .map((p) => str(asRecord(p).projectId) ?? str(asRecord(p).project_id))
      .filter((x): x is string => Boolean(x))
    : [];
  if (fromPlan.length > 0) return fromPlan;
  return campaigns
    .filter((c) => (c.ref ?? '').startsWith(`${month}:paid:`))
    .map((c) => c.project_id)
    .filter((x): x is string => Boolean(x));
}

export interface MonthNote {
  id: string;
  month: string;
  lane: 'organic' | 'paid' | null;
  project_id: string | null;
  batch_date: string | null;
  kind: 'month' | 'project' | 'row' | 'paid_batch';
  body: string;
  author_user_id: string | null;
  updated_at: string;
}

async function loadNotes(
  svc: SupabaseClient, month: string,
): Promise<{ notes: MonthNote[]; error: string | null }> {
  const { data, error } = await svc.from('mos_month_notes')
    .select('id, month, lane, project_id, batch_date, kind, body, author_user_id, updated_at')
    .eq('month', `${month}-01`)
    .order('kind');
  if (error) return { notes: [], error: `mos_month_notes read failed: ${error.message}` };
  return { notes: (data ?? []) as MonthNote[], error: null };
}

/** Project display names for a set of ids, through the caller's own RLS. */
async function projectNames(
  sb: SupabaseClient, ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = [...new Set(ids.filter(Boolean))];
  if (clean.length === 0) return out;
  const { data, error } = await sb.from('v_all_projects').select('id, project_name').in('id', clean);
  if (error) {
    // Names are decoration; ids are the truth. Surfaced in the log, never
    // silently swallowed, but a missing name must not fail the month page.
    console.error('[month] v_all_projects name read failed', error.code, error.message);
    return out;
  }
  for (const r of (data ?? []) as Array<{ id: string; project_name: string | null }>) {
    if (r.project_name) out.set(r.id, r.project_name);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the compiled month, shaped for the grid                             */
/* ------------------------------------------------------------------ */

export interface MonthGridDay {
  day: string;
  weekday: number;
  rowKey: string;
  kind: 'organic_row' | 'general_row';
  projectId: string | null;
  projectName: string | null;
  slot: number | null;
  slotLetter: string | null;
  posts: number;
}

export interface MonthGridPaidCell {
  batchDay: string;
  projectId: string;
  projectName: string | null;
  slot: number;
  slotLetter: string;
  creatives: number;
}

export interface MonthGridWeek {
  index: number;
  start: string;
  end: string;
  days: MonthGridDay[];
  paid: MonthGridPaidCell[];
}

/** أ · ب · ج … for the project slots; the general row has no letter. */
const AR_SLOT_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز'];
const slotLetter = (slot: number | null): string | null =>
  (slot === null || slot < 0 ? null : AR_SLOT_LETTERS[slot] ?? String(slot + 1));

/**
 * Turn a compiled month into the weeks grid the page renders.
 *
 * The PAID pane is four batch days × the projects that actually run — twelve
 * cells for the standing template, matching the 60 creatives. Each carries its
 * own note coordinate (E1/D7), which is why it is a first-class cell here and
 * not a summary line under the organic week.
 *
 * A week whose batch day has PASSED (a month compiled part-way through) gets no
 * paid cells at all. The batch day is matched to the week by DATE — every batch
 * day is a week start — and never by position: `paidBatchDays[w.index]` was
 * right only while that list held one entry per week, and a partial month's
 * shorter list would have dated week 1's cells with week 3's batch and then
 * repeated that same batch further down the grid.
 */
export function monthGrid(compiled: CompiledMonth, projects: MonthProject[]): MonthGridWeek[] {
  const slotOfProject = new Map<string, number>();
  compiled.rows.forEach((r) => {
    if (r.projectId !== null && r.slot !== null && !slotOfProject.has(r.projectId)) {
      slotOfProject.set(r.projectId, r.slot);
    }
  });
  const batchDays = new Set(compiled.geometry.paidBatchDays);
  return compiled.geometry.weeks.map((w) => ({
    index: w.index,
    start: w.start,
    end: w.end,
    days: compiled.rows
      .filter((r) => r.weekIndex === w.index)
      .map((r) => ({
        day: r.day,
        weekday: r.weekday,
        rowKey: r.rowKey,
        kind: r.kind,
        projectId: r.projectId,
        projectName: r.projectName ?? null,
        slot: r.slot,
        slotLetter: slotLetter(r.slot),
        posts: r.posts,
      })),
    paid: batchDays.has(w.start)
      ? projects.map((p) => {
        const slot = slotOfProject.get(p.projectId) ?? null;
        return {
          batchDay: w.start,
          projectId: p.projectId,
          projectName: p.projectName ?? null,
          slot: slot ?? 0,
          slotLetter: slotLetter(slot) ?? '',
          creatives: compiled.template.creativesPerProjectWeek,
        };
      })
      : [],
  }));
}

/** Compile one month against the LIVE workload. Pure read — writes nothing. */
async function compile(
  ctx: PlanCtx, month: string, template: MonthTemplate, projects: MonthProject[],
  startFrom: string | null,
): Promise<{ compiled: CompiledMonth; rules: RuleSet } | { error: Response }> {
  const settings = await loadPlanningSettings(ctx.sb);
  let snapshot; let rules: RuleSet | null;
  try {
    [snapshot, rules] = await Promise.all([
      loadWorkloadSnapshot(ctx.sb, settings),
      loadRuleSet(ctx.sb, settings),
    ]);
  } catch (e) {
    return { error: fail('snapshot/rules', { message: e instanceof Error ? e.message : String(e) }) };
  }
  const base: RuleSet = rules ?? DEFAULT_RULES;
  const compiled = compileMonth({ month, template, projects, snapshot, rules: base, startFrom });
  return { compiled, rules: base };
}

/*
 * THE COMMIT-TIME RE-PLAN IS A SECOND `compile()`, NOT A PER-PLAN `planCampaign`.
 *
 * `monthConfirm` used to re-plan each of the four plans on its own, with a rule
 * set (`monthRules`) hand-built to reproduce what `compileMonth` already does —
 * `rowPublishing` from the template, `searchBudget: 0`. Two derivations of one
 * recipe, and the month's four plans are NOT independent: `compileMonth`
 * compiles them in sequence against a growing ledger so each sees the load the
 * previous ones proposed. Re-planning them one at a time only accumulated
 * because each commit had already landed in the database before the next
 * re-plan read it — which is exactly the four-transaction shape D8 removes.
 *
 * So the re-plan is now one more `compile()` and the signatures are compared
 * pairwise. Same engine, same rules, same accumulation, no second recipe.
 */

/* ------------------------------------------------------------------ */
/* month_get                                                           */
/* ------------------------------------------------------------------ */

/**
 * The one refusal for a month another month already plans.
 *
 * It names the owner rather than saying "not allowed", because the operator's
 * next move is to open THAT month — and because a bare refusal on a month that
 * looks perfectly ordinary is the kind of message people work around.
 */
function monthCoveredRefusal(month: string, owner: string): Response {
  return jsonError(409, JSON.stringify({
    error: 'month_covered',
    error_ar: `${month} مُخطَّط ضمن خطة ${owner} الممتدة — افتح ${owner} لتعديلها. لا تُخطَّط هذه الأسابيع مرتين.`,
    error_en: `${month} is planned inside ${owner}'s stretched plan — open ${owner} to change it. These weeks are not planned twice.`,
    covered_by: owner,
  }));
}

export async function monthGet(ctx: PlanCtx): Promise<Response> {
  const month = monthOf(ctx.body);
  if (!month) return jsonError(400, 'month must be YYYY-MM');
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const tpl = await loadTemplate(svc);
  if (tpl.error) return fail('mos_month_template', { message: tpl.error });
  const template = tpl.row;
  const geometry = monthGeometry(month, template);

  const [camps, notes, excRes, metricsRes] = await Promise.all([
    loadMonthCampaigns(svc, month),
    loadNotes(svc, month),
    ctx.sb.rpc('mos_month_exceptions', { p_month: `${month}-01` }),
    // The ranking — D6's three numbers per candidate project. The window is the
    // month's own cycle so "spend so far" on the same screen means one thing.
    svc.rpc('mos_month_metrics', {
      p_from: geometry.firstPostingDay,
      p_to: geometry.weeks[geometry.weeks.length - 1]?.end ?? geometry.lastPostingDay,
      p_excluded_stages: terminalLostStages(),
      p_month: `${month}-01`,
      p_project_ids: null,
      p_include_ranking: true,
    }),
  ]);
  if (camps.error) return fail('mos_campaigns', { message: camps.error });
  if (notes.error) return fail('mos_month_notes', { message: notes.error });
  if (excRes.error) return fail('mos_month_exceptions', excRes.error);
  if (metricsRes.error) return fail('mos_month_metrics', metricsRes.error);

  const metrics = asRecord(metricsRes.data);
  const ranking = Array.isArray(metrics.ranking) ? metrics.ranking as Array<Record<string, unknown>> : [];

  // Confirmed? The paid campaigns' refs carry the chosen project ids, and
  // `mos_campaigns.ref` is UNIQUE — so the month's own rows are the record of
  // what was chosen. Nothing needs a second "month selection" table.
  const organic = camps.campaigns.find((c) => c.ref === organicRef(month)) ?? null;
  const confirmed = camps.campaigns.length > 0;

  const chosenIds = confirmed
    ? slotOrder(camps.campaigns, month)
    : ranking.slice(0, template.projectsPerMonth).map((r) => String(r.project_id ?? '')).filter(Boolean);

  const names = await projectNames(ctx.sb, chosenIds);
  const rankName = new Map(ranking.map((r) => [String(r.project_id ?? ''), String(r.project_name ?? '')]));

  return jsonOk({
    month,
    today: riyadhToday(),
    template,
    geometry,
    state: confirmed ? 'confirmed' : 'draft',
    // A month a STRETCHED month already runs through is not planned again: the
    // owner's plan books those weeks, and a second plan over them would
    // double-book every designer day without either one seeing the other.
    covered_by: monthCoveredBy(month, template.monthStarts),
    campaigns: camps.campaigns,
    organic_campaign_id: organic?.id ?? null,
    selection: chosenIds.map((id) => ({
      project_id: id,
      project_name: names.get(id) ?? rankName.get(id) ?? null,
      ranking: ranking.find((r) => String(r.project_id ?? '') === id) ?? null,
    })),
    ranking,
    notes: notes.notes,
    exceptions: excRes.data ?? [],
  });
}

/* ------------------------------------------------------------------ */
/* month_compile                                                       */
/* ------------------------------------------------------------------ */

export async function monthCompile(ctx: PlanCtx): Promise<Response> {
  const month = monthOf(ctx.body);
  if (!month) return jsonError(400, 'month must be YYYY-MM');
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const ids = Array.isArray(ctx.body.project_ids)
    ? (ctx.body.project_ids as unknown[]).map((x) => String(x)).filter(Boolean)
    : [];
  if (ids.length === 0) return jsonError(400, 'project_ids is required');
  const startFrom = startFromOf(ctx.body, month);
  if (startFrom === 'bad') return jsonError(400, 'start_from must be YYYY-MM-DD');

  const tpl = await loadTemplate(svc);
  if (tpl.error) return fail('mos_month_template', { message: tpl.error });
  const coveredBy = monthCoveredBy(month, tpl.row.monthStarts);
  if (coveredBy) return monthCoveredRefusal(month, coveredBy);

  const names = await projectNames(ctx.sb, ids);
  const projects: MonthProject[] = ids.map((id) => ({ projectId: id, projectName: names.get(id) }));

  const res = await compile(ctx, month, tpl.row, projects, startFrom);
  if ('error' in res) return res.error;
  const { compiled } = res;

  return jsonOk({
    month,
    template: tpl.row,
    geometry: compiled.geometry,
    summary: compiled.summary,
    weeks: monthGrid(compiled, projects.slice(0, compiled.summary.projectSlots)),
    // The four plan inputs are returned so the confirm can be checked against
    // exactly what the operator saw, and so a support session can read the plan
    // that produced a month without re-running anything.
    plans: compiled.plans.map((p, i) => ({
      campaign_ref: compiled.inputs[i]?.campaignRef ?? null,
      kind: compiled.inputs[i]?.kind ?? 'organic',
      feasible: p.feasible,
      items: p.items.length,
      rows: p.rows.length,
      releases: p.releases.length,
      conflicts: p.conflicts,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* month_confirm                                                       */
/* ------------------------------------------------------------------ */

interface CommitOutcome {
  campaign_ref: string;
  campaign_id: string;
  plan_id: string;
  kind: 'organic' | 'paid';
  created: Record<string, unknown> | null;
  already: boolean;
}

/**
 * Find-or-create the campaign a month plan commits into.
 *
 * `mos_campaign_plan_commit` does NOT create campaigns — it reads
 * `p_materialise.campaign_id` (or the plan's own) and materialises into it. A
 * NULL there produces content with no campaign, which is a month nothing can
 * find afterwards. The ref is the month's anchor and is UNIQUE, so re-running a
 * confirm reuses the same campaign rather than making a second one.
 */
async function ensureCampaign(
  svc: SupabaseClient,
  ref: string,
  fields: {
    name: string; kind: 'organic' | 'paid'; projectId: string | null;
    startsOn: string; endsOn: string; budget: number | null; actor: string | null;
  },
): Promise<{ id: string; error: string | null }> {
  const found = await svc.from('mos_campaigns').select('id').eq('ref', ref).maybeSingle();
  if (found.error) return { id: '', error: `mos_campaigns read failed: ${found.error.message}` };
  if (found.data) return { id: (found.data as { id: string }).id, error: null };

  const ins = await svc.from('mos_campaigns').insert({
    ref,
    name: fields.name,
    kind: fields.kind,
    project_id: fields.projectId,
    status: 'planning',
    objective: 'leads',
    starts_on: fields.startsOn,
    ends_on: fields.endsOn,
    budget_total: fields.budget,
    created_by_user_id: fields.actor,
  }).select('id').single();
  if (ins.error) return { id: '', error: `mos_campaigns insert failed: ${ins.error.message}` };
  return { id: (ins.data as { id: string }).id, error: null };
}

export async function monthConfirm(ctx: PlanCtx): Promise<Response> {
  const month = monthOf(ctx.body);
  if (!month) return jsonError(400, 'month must be YYYY-MM');
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const ids = Array.isArray(ctx.body.project_ids)
    ? (ctx.body.project_ids as unknown[]).map((x) => String(x)).filter(Boolean)
    : [];
  if (ids.length === 0) return jsonError(400, 'project_ids is required');
  const startFrom = startFromOf(ctx.body, month);
  if (startFrom === 'bad') return jsonError(400, 'start_from must be YYYY-MM-DD');

  const tpl = await loadTemplate(svc);
  if (tpl.error) return fail('mos_month_template', { message: tpl.error });
  const template = tpl.row;
  const coveredBy = monthCoveredBy(month, template.monthStarts);
  if (coveredBy) return monthCoveredRefusal(month, coveredBy);
  // The kill switch, and it is DATA. The template ships disabled; a month cannot
  // be confirmed into production until an operator turns the model on.
  if (!template.enabled) {
    return jsonError(409, JSON.stringify({
      error: 'month_template_disabled',
      error_ar: 'قالب الشهر غير مفعَّل بعد، فلا يمكن اعتماد الشهر. فعّله من إعدادات الشهر أولًا.',
      error_en: 'The month template is not enabled yet, so a month cannot be confirmed. Turn it on in the month settings first.',
    }));
  }

  const names = await projectNames(ctx.sb, ids);
  const projects: MonthProject[] = ids.map((id) => ({ projectId: id, projectName: names.get(id) }));

  const res = await compile(ctx, month, template, projects, startFrom);
  if ('error' in res) return res.error;
  const { compiled } = res;

  // A month with nothing reachable left in it. Refused in its OWN words: it is
  // not that the work does not fit — there is no work, because every remaining
  // posting day is closer than production can reach. `month_infeasible` below
  // would send the operator looking for a capacity problem that does not exist.
  if (compiled.summary.exhausted) {
    return jsonError(409, JSON.stringify({
      error: 'month_not_startable',
      error_ar: `لم يعد بالإمكان بدء ${month}: كل أيام النشر المتبقية أقرب مما يستطيع الإنتاج بلوغه (الصف يحتاج ${compiled.summary.minLeadWorkingDays} أيام عمل قبل النشر). ابدأ الشهر التالي.`,
      error_en: `${month} can no longer be started: every remaining posting day is closer than production can reach (a row needs ${compiled.summary.minLeadWorkingDays} working days before it publishes). Start the next month instead.`,
      detail: {
        start_from: compiled.summary.startedFrom,
        min_lead_working_days: compiled.summary.minLeadWorkingDays,
        skipped_posting_days: compiled.summary.skippedPostingDays,
      },
    }));
  }

  if (!compiled.summary.feasible) {
    return jsonError(409, JSON.stringify({
      error: 'month_infeasible',
      error_ar: 'الشهر لا يُجدول بالكامل بالطاقة الحالية. عالج التعارضات قبل الاعتماد.',
      error_en: 'The month does not schedule in full against current capacity. Resolve the conflicts before confirming.',
      conflicts: compiled.summary.conflicts,
    }));
  }

  const actor = await appUserId(ctx);
  const settings = await loadPlanningSettings(ctx.sb);
  const lastWeekEnd = compiled.geometry.weeks[compiled.geometry.weeks.length - 1]?.end
    ?? compiled.geometry.lastPostingDay;

  // ── The re-plan, once, for all four (see the note above `month_get`) ──
  // Refuse if anything the operator saw has moved. This is the same guarantee
  // the per-plan re-plan gave, taken against one snapshot because the commit is
  // now one transaction.
  const again = await compile(ctx, month, template, projects, startFrom);
  if ('error' in again) return again.error;
  const replanned = again.compiled;
  const moved = replanned.plans.length !== compiled.plans.length
    || replanned.plans.some((p, i) => planSignature(p) !== planSignature(compiled.plans[i] as PlanResult));
  if (moved || !replanned.summary.feasible) {
    return jsonError(409, JSON.stringify({
      error: 'plan_changed',
      error_ar: 'تغيّر الحمل أثناء المراجعة. أعد حساب الشهر قبل الاعتماد.',
      error_en: 'The workload changed while you were reviewing. Re-compile the month before confirming.',
      committed: 0,
    }));
  }

  // All four plans come off ONE snapshot, so they carry ONE hash — and the RPC
  // takes that gate once, before it writes anything. Re-checking it per plan
  // inside the transaction would refuse every month on the second plan: the
  // hash covers `mos_work_ledger_v`, which the first plan's reservations move.
  const hashes = Array.from(new Set(replanned.plans.map((p) => (p as PlanResult).snapshotHash)));
  if (hashes.length !== 1) {
    return fail('month snapshot hash', {
      message: `the four plans disagree on the snapshot hash (${hashes.length} distinct)`,
    });
  }

  const committed: CommitOutcome[] = [];
  const batch: Array<Record<string, unknown>> = [];

  for (let i = 0; i < replanned.inputs.length; i += 1) {
    const input = replanned.inputs[i] as PlanInput;
    const plan = replanned.plans[i] as PlanResult;
    const isPaid = input.kind === 'paid';
    const projectId = isPaid ? (input.projects[0]?.projectId ?? null) : null;
    const ref = isPaid && projectId ? paidRef(month, projectId) : organicRef(month);
    const projectLabel = projectId ? (names.get(projectId) ?? projectId.slice(0, 8)) : '';

    const camp = await ensureCampaign(svc, ref, {
      name: isPaid ? `${month} — مدفوع — ${projectLabel}` : `${month} — عضوي`,
      kind: isPaid ? 'paid' : 'organic',
      projectId,
      startsOn: isPaid ? (compiled.geometry.paidBatchDays[0] ?? compiled.geometry.firstPostingDay)
        : compiled.geometry.firstPostingDay,
      endsOn: isPaid ? compiled.geometry.campaignEndsOn : lastWeekEnd,
      budget: isPaid ? template.budgetPerProject : null,
      actor,
    });
    if (camp.error) {
      return fail('ensureCampaign', { message: `${camp.error} — nothing committed` });
    }

    const boundInput: PlanInput = { ...input, campaignId: camp.id };

    // Store the plan, then commit it. Stored first on purpose: if the commit
    // fails, the proposal survives with its feasibility and conflicts attached,
    // so what was attempted is readable afterwards.
    const planIns = await svc.from('mos_campaign_plans').insert({
      campaign_id: camp.id,
      status: 'proposed',
      input: boundInput as unknown as Record<string, unknown>,
      plan: plan as unknown as Record<string, unknown>,
      feasibility: {
        feasible: plan.feasible,
        infeasible_proof: plan.infeasibleProof,
        search_incomplete: plan.searchIncomplete,
        conflicts: plan.conflicts,
        alternatives: plan.alternatives,
      },
      snapshot_hash: plan.snapshotHash,
      engine_version: plan.engineVersion,
      created_by_user_id: actor,
    }).select('id').single();
    if (planIns.error) {
      return fail('mos_campaign_plans insert', {
        message: `${planIns.error.message} — nothing committed`,
      });
    }
    const planId = (planIns.data as { id: string }).id;

    const parsed = parsePlanInput(toSnake(boundInput as unknown as Record<string, unknown>),
      settings.publishBufferDays);
    if (typeof parsed === 'string') return jsonError(400, parsed);

    batch.push({
      plan_id: planId,
      reservations: reservationsPayload(plan),
      materialise: materialisePayload(parsed, plan),
    });
    committed.push({
      campaign_ref: ref,
      campaign_id: camp.id,
      plan_id: planId,
      kind: isPaid ? 'paid' : 'organic',
      created: null,
      already: false,
    });
  }

  // ── D8: FOUR PLANS, ONE TRANSACTION ───────────────────────────────────
  //
  // One call, one advisory ledger lock, all four or none. Four sequential
  // commits could leave a month half-reserved — two campaigns with content,
  // rows, publications and booked capacity, two without, and nothing to roll
  // back to. `committed` is therefore no longer a partial count on failure: it
  // is 0 or 4.
  const rpc = await svc.rpc('mos_campaign_plan_commit_month', {
    p_plans: batch,
    p_expected_hash: hashes[0],
    p_actor: actor,
  });
  if (rpc.error) {
    const msg = rpc.error.message ?? '';
    // Classify by MESSAGE first, code second (repo rule) — and NEVER treat
    // 40001 as retryable here; the commit RPC raises WS409.
    if (/plan_changed|capacity_conflict/.test(msg) || rpc.error.code === 'WS409') {
      return jsonError(409, JSON.stringify({
        error: /capacity_conflict/.test(msg) ? 'capacity_conflict' : 'plan_changed',
        error_ar: /capacity_conflict/.test(msg)
          ? 'الشهر لم يعد يتّسع للطاقة المتاحة. أعد الحساب.'
          : 'تغيّر الحمل أثناء الاعتماد. أعد الحساب.',
        error_en: /capacity_conflict/.test(msg)
          ? 'The month no longer fits the available capacity. Re-compile.'
          : 'The workload changed during the confirmation. Re-compile.',
        detail: msg,
        committed: 0,
      }));
    }
    return fail('mos_campaign_plan_commit_month', {
      ...rpc.error, message: `${msg} — nothing committed`,
    });
  }

  // Attach each plan's own report. The RPC returns them keyed by plan id, in
  // the order it committed them, which is the order they were sent.
  const byPlan = new Map<string, Record<string, unknown>>();
  for (const entry of (asRecord(rpc.data).committed as unknown[] ?? [])) {
    const rec = asRecord(entry);
    const id = str(rec.plan_id);
    if (id) byPlan.set(id, asRecord(rec.result));
  }
  for (const c of committed) {
    const created = byPlan.get(c.plan_id) ?? null;
    c.created = created;
    c.already = created?.already === true;
  }

  // NOTE — there is no `rows_not_materialised` check any more, and its absence
  // is the point. It existed because the commit ignored `rows[]`: a month could
  // land with its content and its reservations but no ROW subjects, so no row
  // task could ever open, and the only honest thing to do was say so in red.
  // The rows are now written by the same transaction as the content, the
  // publications and the reservations — a month with content but no rows is no
  // longer a state the database can be in, and a post-hoc count of a committed
  // transaction could only ever report something impossible.
  /*
   * OPEN TODAY'S WORK NOW, not on the next sweep tick.
   *
   * A confirm writes RESERVATIONS. Turning a reserved first step into an open
   * task is `mos_plan_start_due`, which `/api/cron/planning-sweep` runs every
   * ten minutes. So on 2026-09-16 the operator confirmed September, went
   * straight to «مهامي», and found it empty: the first row's writing was due
   * that very day, but the sweep had not ticked yet. Nothing was broken — and
   * nothing was there. Running the same idempotent function here closes that
   * gap; the cron remains the backstop for every later day.
   *
   * The month is ALREADY committed at this point, so a failure here must not
   * turn into a failed confirm. It is surfaced as a warning (rendered in red,
   * exactly as it arrives) and logged; the next sweep tick opens the work.
   */
  const warnings: string[] = [];
  const opened = await svc.rpc('mos_plan_start_due');
  if (opened.error) {
    console.error('[month_confirm] mos_plan_start_due failed after commit',
      opened.error.code, opened.error.message);
    warnings.push(`اعتُمد الشهر، لكن فتح مهام اليوم فشل (${opened.error.message}). ستُفتح تلقائيًا خلال عشر دقائق.`);
  }

  // E6 — the month's paid campaigns in Meta: campaign + feed/story ad-set pair
  // per project, PAUSED, so a creative's final approval has an ad set to land
  // in. The month is already committed: a Meta refusal is a warning, and the
  // planning sweep retries it (hourly at most).
  const meta = await ensureMonthMetaCampaigns(svc, { month, force: true });
  if (meta.error) warnings.push(`اعتُمد الشهر، لكن تعذّر تجهيز حملات ميتا (${meta.error}). ستُعاد المحاولة تلقائيًا.`);
  for (const r of meta.results) {
    if (r.outcome === 'failed') {
      warnings.push(`لم تُنشأ حملة ميتا لـ«${r.campaign ?? ''}»: ${r.error_ar ?? r.error ?? ''} — ستُعاد المحاولة تلقائيًا.`);
    }
  }

  return jsonOk({
    ok: true,
    month,
    committed,
    summary: replanned.summary,
    opened: opened.error ? null : opened.data,
    meta: meta.results,
    warnings,
  });
}

/* ------------------------------------------------------------------ */
/* month_report                                                        */
/* ------------------------------------------------------------------ */

/** One publication of the month, as the report's grid reads it. */
export interface MonthReportRelease {
  id: string;
  content_id: string | null;
  /** NULL for a general-row post — it belongs to no project (A8b). */
  project_id: string | null;
  platform: string | null;
  status: string;
  /** The day it is due on (or went out on) — Riyadh civil date. */
  day: string | null;
  placement_variant: 'feed' | 'story' | null;
}

export interface MonthReportProject {
  project_id: string;
  project_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  meta_leads: number;
  our_leads: number;
  cost_per_lead: number | null;
  attributed_clients: number;
  qualified_clients: number;
  ungraded_clients: number;
  ads_active: number;
  ads_paused: number;
  posts_published: number;
  releases_published: number;
  posts_planned: number;
  creatives_planned: number;
  budget: number;
}

export async function monthReport(ctx: PlanCtx): Promise<Response> {
  const month = monthOf(ctx.body);
  if (!month) return jsonError(400, 'month must be YYYY-MM');
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const tpl = await loadTemplate(svc);
  if (tpl.error) return fail('mos_month_template', { message: tpl.error });
  const template = tpl.row;
  const geometry = monthGeometry(month, template);
  const from = geometry.firstPostingDay;
  const to = geometry.weeks[geometry.weeks.length - 1]?.end ?? geometry.lastPostingDay;

  const camps = await loadMonthCampaigns(svc, month);
  if (camps.error) return fail('mos_campaigns', { message: camps.error });
  const campaignIds = camps.campaigns.map((c) => c.id);
  // SLOT order, not campaign order — the report's three cards and the grid's
  // columns must stand in the same places they stood on the plan.
  const projectIds = slotOrder(camps.campaigns, month);

  // What the month actually MATERIALISED, per project — read from the content
  // the commit created, never re-derived by compiling the month again. A second
  // compile would answer "what the template would produce today", which is a
  // different question and drifts the moment anything is edited.
  const plannedRows: Array<{ project_id: string | null; purpose: string | null }> = [];
  const releases: MonthReportRelease[] = [];
  if (campaignIds.length > 0) {
    const [planned, pubs] = await Promise.all([
      svc.from('mos_content')
        .select('id, project_id, purpose').in('campaign_id', campaignIds).is('archived_at', null),
      // The report's weeks grid is built from REAL publications, never from a
      // second compile of the template: "what the month actually holds" and
      // "what the template would produce today" are different questions, and
      // the grid must answer the first one.
      svc.from('mos_publications')
        .select('id, content_id, platform, status, planned_at, scheduled_at, published_at, placement_variant')
        .in('campaign_id', campaignIds)
        .order('planned_at', { ascending: true }),
    ]);
    if (planned.error) return fail('mos_content planned read', planned.error);
    if (pubs.error) return fail('mos_publications read', pubs.error);
    const contentRows = (planned.data ?? []) as Array<{
      id: string; project_id: string | null; purpose: string | null;
    }>;
    plannedRows.push(...contentRows);
    const projectOfContent = new Map(contentRows.map((c) => [c.id, c.project_id]));
    for (const p of (pubs.data ?? []) as Array<Record<string, unknown>>) {
      const at = str(p.planned_at) ?? str(p.scheduled_at) ?? str(p.published_at);
      const contentId = str(p.content_id);
      releases.push({
        id: String(p.id ?? ''),
        content_id: contentId,
        // NULL is meaningful: a general-row post belongs to no project (A8b).
        project_id: contentId ? projectOfContent.get(contentId) ?? null : null,
        platform: str(p.platform),
        status: str(p.status) ?? 'planned',
        day: at ? at.slice(0, 10) : null,
        placement_variant: str(p.placement_variant) as 'feed' | 'story' | null,
      });
    }
  }

  const [metricsRes, leadsRes, excRes] = await Promise.all([
    svc.rpc('mos_month_metrics', {
      p_from: from,
      p_to: to,
      // D5, derived — never hand-listed here. The RPC RAISES on an empty array.
      p_excluded_stages: terminalLostStages(),
      p_month: `${month}-01`,
      p_project_ids: projectIds.length ? projectIds : null,
      p_include_ranking: false,
    }),
    // OUR leads — conversations, from the ONE implementation of the attribution.
    // Service client: `chat_messages` is not a marketing-role read, and only
    // aggregate counts leave this function.
    ourLeadsByProject(svc, { since: from, until: to }),
    ctx.sb.rpc('mos_month_exceptions', { p_month: `${month}-01` }),
  ]);
  if (metricsRes.error) return fail('mos_month_metrics', metricsRes.error);
  if (leadsRes.error) return fail('ourLeadsByProject', { message: leadsRes.error });
  if (excRes.error) return fail('mos_month_exceptions', excRes.error);

  const metrics = asRecord(metricsRes.data);
  const metricRows = Array.isArray(metrics.projects)
    ? metrics.projects as Array<Record<string, unknown>> : [];
  const leadTotals: ProjectLeadTotals[] = leadsRes.totals;
  const leadsOf = new Map<string, number>();
  let unattributedLeads = 0;
  for (const t of leadTotals) {
    if (!t.projectId) { unattributedLeads += t.leads; continue; }
    leadsOf.set(t.projectId, (leadsOf.get(t.projectId) ?? 0) + t.leads);
  }

  const plannedPosts = new Map<string, number>();
  const plannedCreatives = new Map<string, number>();
  let generalPlanned = 0;
  for (const r of plannedRows) {
    const key = r.project_id ?? '';
    if (!key) { generalPlanned += 1; continue; }
    if (r.purpose === 'paid') plannedCreatives.set(key, (plannedCreatives.get(key) ?? 0) + 1);
    else plannedPosts.set(key, (plannedPosts.get(key) ?? 0) + 1);
  }

  const ids = [...new Set([
    ...projectIds,
    ...metricRows.map((r) => String(r.project_id ?? '')).filter(Boolean),
    ...[...leadsOf.keys()],
  ])];
  const names = await projectNames(ctx.sb, ids);

  const projects: MonthReportProject[] = ids.map((id) => {
    const m = metricRows.find((r) => String(r.project_id ?? '') === id) ?? {};
    const ourLeads = leadsOf.get(id) ?? 0;
    const spend = num(m.spend);
    return {
      project_id: id,
      project_name: names.get(id) ?? (str(m.project_name) ?? null),
      spend,
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      meta_leads: num(m.meta_leads),
      our_leads: ourLeads,
      // Cost per lead is spend ÷ OUR leads (§3.6), never Meta's own count. With
      // no leads it is NULL, never Infinity and never 0 — both of those read as
      // a number and this is the absence of one.
      cost_per_lead: ourLeads > 0 ? Math.round((spend / ourLeads) * 100) / 100 : null,
      attributed_clients: num(m.attributed_clients),
      qualified_clients: num(m.qualified_clients),
      ungraded_clients: num(m.ungraded_clients),
      ads_active: num(m.ads_active),
      ads_paused: num(m.ads_paused),
      posts_published: num(m.posts_published),
      releases_published: num(m.releases_published),
      posts_planned: plannedPosts.get(id) ?? 0,
      creatives_planned: plannedCreatives.get(id) ?? 0,
      budget: template.budgetPerProject,
    };
  }).sort((a, b) => {
    // SLOT order first — the report's cards must stand where the plan's did.
    // A project that spent but is not one of the month's three (legacy spend
    // still winding down) follows, ordered by spend so the biggest is visible.
    const ia = projectIds.indexOf(a.project_id);
    const ib = projectIds.indexOf(b.project_id);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return b.spend - a.spend;
  });

  const totals = asRecord(metrics.totals);
  const ourLeadsTotal = projects.reduce((a, p) => a + p.our_leads, 0);
  const spendTotal = projects.reduce((a, p) => a + p.spend, 0);

  return jsonOk({
    month,
    today: riyadhToday(),
    window: { from, to },
    state: camps.campaigns.length > 0 ? 'confirmed' : 'draft',
    template,
    geometry,
    campaigns: camps.campaigns,
    /** The month's projects in SLOT order — أ · ب · ج. */
    project_order: projectIds,
    projects,
    releases,
    totals: {
      ...totals,
      our_leads: ourLeadsTotal,
      cost_per_lead: ourLeadsTotal > 0 ? Math.round((spendTotal / ourLeadsTotal) * 100) / 100 : null,
      posts_planned: plannedRows.filter((r) => r.purpose !== 'paid').length,
      creatives_planned: plannedRows.filter((r) => r.purpose === 'paid').length,
      general_planned: generalPlanned,
      budget_total: template.budgetPerProject * Math.max(projectIds.length, 0),
    },
    // Two fail-loud guards, both scoped and both labelled on the page:
    // spend whose campaign names no project, and leads whose ad's campaign does.
    unattributed: { ...asRecord(metrics.unattributed), our_leads: unattributedLeads },
    unattributed_history: asRecord(metrics.unattributed_history),
    excluded_stages: metrics.excluded_stages ?? terminalLostStages(),
    exceptions: excRes.data ?? [],
  });
}

/* ------------------------------------------------------------------ */
/* month_note_set                                                      */
/* ------------------------------------------------------------------ */

const NOTE_KINDS = new Set(['month', 'project', 'row', 'paid_batch']);

/**
 * Write (or clear) one note on the month grid.
 *
 * The coordinate is the template's, not a record's: notes exist BEFORE the
 * content does (§3.7 — "on the plan, not on the records, because the records do
 * not exist until production starts"). `lane` is load-bearing per D7: a project
 * column note belongs to exactly ONE lane, so «تجنّبوا لغة الاستثمار» written on
 * the organic column never reaches that project's twenty ads. `lane IS NULL` is
 * the month note, and it reaches both.
 *
 * An empty body DELETES the note — the same pencil clears what it wrote.
 */
export async function monthNoteSet(ctx: PlanCtx): Promise<Response> {
  const month = monthOf(ctx.body);
  if (!month) return jsonError(400, 'month must be YYYY-MM');
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const kind = str(ctx.body.kind) ?? '';
  if (!NOTE_KINDS.has(kind)) return jsonError(400, 'kind must be month, project, row or paid_batch');
  const laneRaw = str(ctx.body.lane);
  const lane = laneRaw === 'organic' || laneRaw === 'paid' ? laneRaw : null;
  const projectId = str(ctx.body.project_id);
  const batchDate = str(ctx.body.batch_date);
  const body = typeof ctx.body.body === 'string' ? ctx.body.body.trim() : '';

  // The table's CHECK enforces this too; refusing here names WHICH part is wrong
  // instead of returning a constraint string.
  if (kind === 'month' && (lane || projectId || batchDate)) {
    return jsonError(400, 'a month note carries no lane, project or date');
  }
  if (kind === 'project' && (!lane || !projectId || batchDate)) {
    return jsonError(400, 'a project note needs a lane and a project, and no date');
  }
  if (kind === 'row' && (lane !== 'organic' || !batchDate)) {
    return jsonError(400, 'a row note is organic and needs its day');
  }
  if (kind === 'paid_batch' && (lane !== 'paid' || !batchDate || !projectId)) {
    return jsonError(400, 'a paid-batch note needs the paid lane, a project and a batch day');
  }

  const coord = {
    month: `${month}-01`,
    lane,
    project_id: projectId,
    batch_date: batchDate,
    kind,
  };

  if (!body) {
    let del = svc.from('mos_month_notes').delete()
      .eq('month', coord.month).eq('kind', kind);
    del = lane ? del.eq('lane', lane) : del.is('lane', null);
    del = projectId ? del.eq('project_id', projectId) : del.is('project_id', null);
    del = batchDate ? del.eq('batch_date', batchDate) : del.is('batch_date', null);
    const { error } = await del;
    if (error) return fail('mos_month_notes delete', error);
    return jsonOk({ ok: true, cleared: true });
  }

  // NOT `.upsert(..., { onConflict })`: the table's uniqueness is an EXPRESSION
  // index — `(month, COALESCE(lane,''), COALESCE(project_id,'000…'),
  // COALESCE(batch_date,'1900-01-01'), kind)` — because three of the four
  // coordinate columns are nullable and Postgres treats NULLs as distinct.
  // PostgREST can only infer a conflict target from plain columns, so an upsert
  // would either error or quietly insert a second row at the same coordinate.
  let sel = svc.from('mos_month_notes').select('id')
    .eq('month', coord.month).eq('kind', kind);
  sel = lane ? sel.eq('lane', lane) : sel.is('lane', null);
  sel = projectId ? sel.eq('project_id', projectId) : sel.is('project_id', null);
  sel = batchDate ? sel.eq('batch_date', batchDate) : sel.is('batch_date', null);
  const existing = await sel.maybeSingle();
  if (existing.error) return fail('mos_month_notes read', existing.error);

  const author = await appUserId(ctx);
  const written = existing.data
    ? await svc.from('mos_month_notes')
      .update({ body, author_user_id: author, updated_at: new Date().toISOString() })
      .eq('id', (existing.data as { id: string }).id)
      .select('id, month, lane, project_id, batch_date, kind, body, author_user_id, updated_at')
      .maybeSingle()
    : await svc.from('mos_month_notes')
      .insert({ ...coord, body, author_user_id: author })
      .select('id, month, lane, project_id, batch_date, kind, body, author_user_id, updated_at')
      .maybeSingle();
  if (written.error) return fail('mos_month_notes write', written.error);
  return jsonOk({ ok: true, note: written.data });
}
