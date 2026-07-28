/**
 * The v2 planning surface: Strategy & Planning, Portfolio, Reviews.
 *
 * Forms differ by object type on purpose. A Program asks about cadence and a
 * recurring commitment and has no end date; an Organic Campaign asks about a
 * date range and deliverables; a Paid Campaign asks about budget and conversion;
 * an Initiative asks about the opportunity and hypothesis. One generic form for
 * all four would be the fastest way to make them feel like the same thing, which
 * is exactly the confusion this rebuild exists to remove.
 *
 * Design record: docs/marketing-management-v2.md
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Check, ChevronDown, Target, Repeat, Megaphone, Coins, ClipboardCheck, AlertTriangle,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, Stat, EmptyHint, CaveatStrip, Spinner, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPlanningOverview, saveStrategy, approveStrategy,
  fetchPlanDetail, savePlan, approvePlan, saveGoal, setGoalTargets, fetchGoalPacing,
  fetchPortfolio, saveInitiative, saveProgram, saveReview, decideReview,
  PLAN_TYPE_LABEL, PLAN_STATUS_LABEL, STRATEGY_STATUS_LABEL, GOAL_CATEGORY_LABEL,
  INITIATIVE_STATUS_LABEL, PROGRAM_STATUS_LABEL, DECISION_LABEL, CADENCE_UNIT_LABEL,
  type StrategyVersion, type MktPlan, type MktGoal, type Initiative, type Program,
  type MktReview, type GoalPacing,
} from '@/lib/marketingMgmt/v2';
import { saveCampaign, type Campaign } from '@/lib/marketingMgmt/client';
import { PaidTreePanel } from './PaidTreePanel';
import { StrategyEditor, StrategyCompleteness } from './StrategyEditor';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Field({ label, children, span = '' }: {
  label: string; children: React.ReactNode; span?: string;
}) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{label}</span>
      {children}
    </label>
  );
}

/** A status pill that reads in the user's language, never a raw slug. */
function Pill({ map, value, isAr, tone = 'neutral' }: {
  map: Record<string, { ar: string; en: string }>; value: string | null;
  isAr: boolean; tone?: 'neutral' | 'good' | 'warn';
}) {
  if (!value) return <span className="text-charcoal/35">—</span>;
  const cls = tone === 'good' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-sand/60 bg-white text-charcoal/60';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10.5px] ${cls}`}>
      {lbl(map, value, isAr)}
    </span>
  );
}

// ══ Strategy & Planning ═══════════════════════════════════════════════════
export function StrategyPlanningTab({ isAr, onError, onToast }: {
  isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [current, setCurrent] = useState<StrategyVersion | null>(null);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [plans, setPlans] = useState<MktPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const [creatingStrategy, setCreatingStrategy] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [sName, setSName] = useState(''); const [sPos, setSPos] = useState('');
  const [pName, setPName] = useState(''); const [pType, setPType] = useState('annual');
  const [pFrom, setPFrom] = useState(''); const [pTo, setPTo] = useState('');

  /** `spinner` is opt-in and only the FIRST load asks for it. A refetch that
   *  flips `loading` replaces this whole section with a spinner, which remounts
   *  everything inside it — including an open editor, whose uncontrolled inputs
   *  then reset and lose focus. Structural changes (create, approve, archive)
   *  refetch quietly; field edits do not refetch at all. */
  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    fetchPlanningOverview()
      .then((r) => { setCurrent(r.current_strategy); setVersions(r.strategies); setPlans(r.plans); })
      .catch((e) => onError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, [onError]);
  useEffect(() => { load(true); }, [load]);

  /** Field saves return the updated row; merge it and re-render nothing else.
   *  This is what keeps the completeness badge live without a round trip. */
  const patchVersion = useCallback((updated: StrategyVersion) => {
    setVersions((vs) => vs.map((v) => (v.id === updated.id ? updated : v)));
    setCurrent((c) => (c && c.id === updated.id ? updated : c));
  }, []);

  const createStrategy = async () => {
    if (!sName.trim()) return;
    setBusy(true);
    try {
      await saveStrategy({ name_ar: sName.trim(), positioning: sPos.trim() || null });
      setSName(''); setSPos(''); setCreatingStrategy(false);
      onToast(isAr ? 'أُنشئت مسودة استراتيجية' : 'Strategy draft created'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      const r = await approveStrategy(id);
      onToast(r.superseded
        ? (isAr ? 'اعتُمدت، واستُبدلت النسخة السابقة' : 'Approved; the previous version was superseded')
        : (isAr ? 'اعتُمدت الاستراتيجية' : 'Strategy approved'));
      load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  /** Archiving a draft hides it from the version list. Only drafts: the
   *  immutability trigger refuses to touch an approved or superseded version,
   *  and it should — plans were executed under it. */
  const archive = async (id: string) => {
    setBusy(true);
    try {
      await saveStrategy({ archived_at: new Date().toISOString() }, id);
      setOpenVersion(null);
      onToast(isAr ? 'أُرشفت المسودة' : 'Draft archived'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const createPlan = async () => {
    if (!pName.trim() || !pFrom || !pTo) return;
    setBusy(true);
    try {
      await savePlan({
        name_ar: pName.trim(), plan_type: pType, period_start: pFrom, period_end: pTo,
        // A draft plan may exist before the strategy is settled, but linking it
        // now is what lets it become active later without a second edit.
        strategy_version_id: current?.id ?? null,
      });
      setPName(''); setPFrom(''); setPTo(''); setCreatingPlan(false);
      onToast(isAr ? 'أُنشئت الخطة' : 'Plan created'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  return (
    <div className="space-y-4">
      <Section title={isAr ? 'الاستراتيجية الحالية' : 'Current strategy'}
        subtitle={isAr ? 'نسخة معتمدة واحدة في كل وقت — التعديل يعني نسخة جديدة'
                       : 'Exactly one approved version at a time — a change means a new version'}
        right={<Button variant="secondary" onClick={() => setCreatingStrategy((v) => !v)}>
          <Plus className="h-4 w-4" />{isAr ? 'مسودة جديدة' : 'New draft'}</Button>}>
        {creatingStrategy && (
          <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-2">
            <Field label={isAr ? 'الاسم' : 'Name'}>
              <input value={sName} onChange={(e) => setSName(e.target.value)} className={FIELD}
                placeholder={isAr ? 'استراتيجية وصل التسويقية' : 'Wassel marketing strategy'} /></Field>
            <Field label={isAr ? 'التموضع' : 'Positioning'}>
              <input value={sPos} onChange={(e) => setSPos(e.target.value)} className={FIELD} /></Field>
            <div className="sm:col-span-2">
              <Button onClick={createStrategy} disabled={busy || !sName.trim()}>
                {isAr ? 'إنشاء مسودة' : 'Create draft'}</Button>
            </div>
          </div>
        )}

        {!current && (
          <CaveatStrip>
            {isAr ? 'لا توجد استراتيجية معتمدة. الخطط يمكن أن تُكتب كمسودات، لكنها لا تصبح نشطة بلا استراتيجية معتمدة.'
                  : 'No approved strategy. Plans can be drafted, but none can become active without one.'}
          </CaveatStrip>
        )}

        {versions.length === 0 ? (
          <EmptyHint>{isAr ? 'لا نسخ بعد' : 'No versions yet'}</EmptyHint>
        ) : (
          <ul className="mt-2 space-y-2">
            {versions.map((v) => {
              const isCurrent = v.id === current?.id;
              const open = openVersion === v.id;
              return (
                <li key={v.id} className={`rounded-xl border ${isCurrent
                  ? 'border-copper/30 bg-copper/5' : 'border-sand/50 bg-white'}`}>
                  <button type="button" onClick={() => setOpenVersion(open ? null : v.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-start">
                    <span className="min-w-0">
                      <span className={`block truncate text-[13px] ${isCurrent ? 'font-semibold text-charcoal' : 'text-charcoal/80'}`}>
                        {isAr ? 'النسخة' : 'Version'} {v.version_number} · {v.name_ar}
                      </span>
                      <StrategyCompleteness version={v} isAr={isAr} />
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {isCurrent && v.approved_at && (
                        <span className="text-[10.5px] text-charcoal/45">
                          {isAr ? 'اعتُمدت' : 'approved'} {fmtDate(v.approved_at, isAr)}
                        </span>)}
                      <Pill map={STRATEGY_STATUS_LABEL} value={v.status} isAr={isAr}
                        tone={isCurrent ? 'good' : 'neutral'} />
                      <ChevronDown className={`h-4 w-4 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </span>
                  </button>

                  {open && (
                    <div className="border-t border-sand/40 p-3">
                      <StrategyEditor version={v} isAr={isAr} onSaved={patchVersion} onError={onError} />

                      {/* Approve lives HERE, inside the opened version — not on the
                          collapsed row. Approving supersedes the incumbent, and
                          doing that from a row you never opened is approving
                          something you have not read. */}
                      {(v.status === 'draft' || v.status === 'in_review') && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-sand/40 pt-3">
                          <Button onClick={() => void approve(v.id)} disabled={busy}>
                            <Check className="h-4 w-4" />
                            {current
                              ? (isAr ? 'اعتماد واستبدال الحالية' : 'Approve and supersede the current one')
                              : (isAr ? 'اعتماد هذه النسخة' : 'Approve this version')}
                          </Button>
                          <button type="button" disabled={busy} onClick={() => void archive(v.id)}
                            className="text-[11.5px] text-charcoal/45 hover:text-red-600 disabled:opacity-40">
                            {isAr ? 'أرشفة المسودة' : 'Archive draft'}
                          </button>
                          {current && (
                            <span className="text-[11px] text-charcoal/45">
                              {isAr ? `ستصبح النسخة ${current.version_number} مُستبدلة`
                                    : `Version ${current.version_number} becomes superseded`}
                            </span>)}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={isAr ? 'الخطط' : 'Plans'}
        right={<Button variant="secondary" onClick={() => setCreatingPlan((v) => !v)}>
          <Plus className="h-4 w-4" />{isAr ? 'خطة جديدة' : 'New plan'}</Button>}>
        {creatingPlan && (
          <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-4">
            <Field label={isAr ? 'الاسم' : 'Name'} span="sm:col-span-2">
              <input value={pName} onChange={(e) => setPName(e.target.value)} className={FIELD} /></Field>
            <Field label={isAr ? 'النوع' : 'Type'}>
              <select value={pType} onChange={(e) => setPType(e.target.value)} className={FIELD}>
                {Object.keys(PLAN_TYPE_LABEL).map((t) => (
                  <option key={t} value={t}>{lbl(PLAN_TYPE_LABEL, t, isAr)}</option>))}
              </select></Field>
            <Field label={isAr ? 'من' : 'From'}>
              <input type="date" value={pFrom} onChange={(e) => setPFrom(e.target.value)} className={FIELD} /></Field>
            <Field label={isAr ? 'إلى' : 'To'}>
              <input type="date" value={pTo} onChange={(e) => setPTo(e.target.value)} className={FIELD} /></Field>
            <div className="sm:col-span-4">
              <Button onClick={createPlan} disabled={busy || !pName.trim() || !pFrom || !pTo}>
                {isAr ? 'إنشاء' : 'Create'}</Button>
            </div>
          </div>
        )}

        {plans.length === 0 ? (
          <EmptyHint>{isAr ? 'لا خطط بعد' : 'No plans yet'}</EmptyHint>
        ) : (
          <ul className="divide-y divide-sand/40">
            {plans.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 py-2.5 text-start">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-charcoal">{p.name_ar}</span>
                    <span className="text-[11px] text-charcoal/45">
                      {lbl(PLAN_TYPE_LABEL, p.plan_type, isAr)} · {fmtDate(p.period_start, isAr)} → {fmtDate(p.period_end, isAr)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] tabular-nums text-charcoal/45">
                      {(p.mkt_goals ?? []).length} {isAr ? 'هدف' : 'goals'}
                    </span>
                    <Pill map={PLAN_STATUS_LABEL} value={p.status} isAr={isAr}
                      tone={p.status === 'active' ? 'good' : 'neutral'} />
                    <ChevronDown className={`h-4 w-4 text-charcoal/30 transition-transform ${openPlan === p.id ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {openPlan === p.id && (
                  <PlanDetail planId={p.id} isAr={isAr} onError={onError} onToast={onToast} onChanged={load} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── one plan: goals, seasonality, approval ────────────────────────────────
function PlanDetail({ planId, isAr, onError, onToast, onChanged }: {
  planId: string; isAr: boolean; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPlanDetail>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [gName, setGName] = useState(''); const [gCat, setGCat] = useState('outcome');
  const [gMetric, setGMetric] = useState(''); const [gTarget, setGTarget] = useState('');
  const [gSource, setGSource] = useState('');

  const load = useCallback(() => {
    fetchPlanDetail(planId).then(setData).catch((e) => onError(err(e)));
  }, [planId, onError]);
  useEffect(load, [load]);

  const addGoal = async () => {
    if (!gName.trim()) return;
    setBusy(true);
    try {
      await saveGoal({
        plan_id: planId, goal_category: gCat, name_ar: gName.trim(),
        metric: gMetric.trim() || null, source_of_truth: gSource.trim() || null,
        target_value: gTarget ? Number(gTarget) : null, status: 'active',
      });
      setGName(''); setGMetric(''); setGTarget(''); setGSource(''); setAdding(false);
      onToast(isAr ? 'أُضيف الهدف' : 'Goal added'); load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const activate = async () => {
    setBusy(true);
    try { await approvePlan(planId); onToast(isAr ? 'اعتُمدت الخطة' : 'Plan approved'); load(); onChanged(); }
    catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (!data) return <div className="py-3"><Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /></div>;

  return (
    <div className="mb-3 space-y-3 rounded-xl border border-sand/50 bg-cream-light/50 p-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'الأهداف' : 'Goals'} value={data.goals.length || null} />
        <Stat label={isAr ? 'المبادرات' : 'Initiatives'} value={data.initiatives.length || null} />
        <Stat label={isAr ? 'البرامج' : 'Programs'} value={data.programs.length || null} />
        <Stat label={isAr ? 'الحملات' : 'Campaigns'} value={data.campaigns.length || null} />
      </div>

      {data.plan.status === 'draft' && (
        <Button variant="secondary" onClick={activate} disabled={busy}>
          <Check className="h-4 w-4" />{isAr ? 'اعتماد الخطة' : 'Approve plan'}
        </Button>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-charcoal/70">{isAr ? 'الأهداف' : 'Goals'}</h4>
          <button type="button" onClick={() => setAdding((v) => !v)}
            className="text-[11.5px] font-medium text-copper hover:underline">
            {isAr ? '+ هدف' : '+ goal'}
          </button>
        </div>

        {adding && (
          <div className="mb-2 grid gap-2 rounded-lg border border-copper/30 bg-white p-2.5 sm:grid-cols-5">
            <Field label={isAr ? 'الاسم' : 'Name'} span="sm:col-span-2">
              <input value={gName} onChange={(e) => setGName(e.target.value)} className={FIELD} /></Field>
            <Field label={isAr ? 'النوع' : 'Kind'}>
              <select value={gCat} onChange={(e) => setGCat(e.target.value)} className={FIELD}>
                {Object.keys(GOAL_CATEGORY_LABEL).map((c) => (
                  <option key={c} value={c}>{lbl(GOAL_CATEGORY_LABEL, c, isAr)}</option>))}
              </select></Field>
            <Field label={isAr ? 'المستهدف' : 'Target'}>
              <input type="number" value={gTarget} onChange={(e) => setGTarget(e.target.value)} className={FIELD} /></Field>
            <Field label={isAr ? 'المقياس' : 'Metric'}>
              <input value={gMetric} onChange={(e) => setGMetric(e.target.value)} className={FIELD} /></Field>
            <Field label={isAr ? 'مصدر القياس' : 'Source of truth'} span="sm:col-span-3">
              <input value={gSource} onChange={(e) => setGSource(e.target.value)} className={FIELD}
                placeholder={isAr ? 'من أين يأتي الرقم؟' : 'Where does the number come from?'} /></Field>
            <div className="sm:col-span-2 sm:self-end">
              <Button onClick={addGoal} disabled={busy || !gName.trim()}>{isAr ? 'إضافة' : 'Add'}</Button>
            </div>
          </div>
        )}

        {data.goals.length === 0 ? (
          <EmptyHint>{isAr ? 'لا أهداف — خطة بلا أهداف لا يمكن قياسها' : 'No goals — a plan without goals cannot be measured'}</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {data.goals.map((g) => (
              <GoalRow key={g.id} goal={g} isAr={isAr} onError={onError} onToast={onToast} onChanged={load} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One goal, with the per-period allocation editor. Seasonality is the point:
 *  nothing here divides an annual target by twelve. */
function GoalRow({ goal, isAr, onError, onToast, onChanged }: {
  goal: MktGoal; isAr: boolean; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(() =>
    (goal.mkt_goal_target_periods ?? []).map((p) => ({
      label: p.label ?? '', period_start: p.period_start, period_end: p.period_end,
      target_value: String(p.target_value),
    })));
  const [busy, setBusy] = useState(false);
  const [pacing, setPacing] = useState<GoalPacing | null>(null);

  const allocated = rows.reduce((a, r) => a + (Number(r.target_value) || 0), 0);
  const target = goal.target_value ?? 0;
  const diff = target ? allocated - target : 0;

  const openRow = async () => {
    setOpen((v) => !v);
    if (!pacing) {
      try { const r = await fetchGoalPacing(goal.id); setPacing(r.pacing); }
      catch (e) { onError(err(e)); }
    }
  };

  const addMonths = () => {
    // Seed twelve equal months as a STARTING POINT the planner then edits.
    // Explicitly labelled as a starting point in the UI so nobody mistakes an
    // untouched even split for a deliberate plan.
    if (!goal.start_date && !goal.end_date && rows.length) return;
    const y = new Date(goal.start_date ?? `${new Date().getFullYear()}-01-01`).getFullYear();
    setRows(Array.from({ length: 12 }, (_, i) => {
      const from = new Date(Date.UTC(y, i, 1));
      const to = new Date(Date.UTC(y, i + 1, 0));
      return {
        label: from.toLocaleDateString(isAr ? 'ar-SA' : 'en-US', { month: 'long' }),
        period_start: from.toISOString().slice(0, 10),
        period_end: to.toISOString().slice(0, 10),
        target_value: '',
      };
    }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await setGoalTargets(goal.id, rows
        .filter((r) => r.period_start && r.period_end && r.target_value !== '')
        .map((r) => ({ ...r, target_value: Number(r.target_value) })));
      onToast(isAr ? 'حُفظت المستهدفات' : 'Targets saved'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <li className="rounded-lg border border-sand/50 bg-white">
      <button type="button" onClick={openRow}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start">
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-charcoal">{goal.name_ar}</span>
          <span className="text-[10.5px] text-charcoal/45">
            {lbl(GOAL_CATEGORY_LABEL, goal.goal_category, isAr)}
            {goal.metric ? ` · ${goal.metric}` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[11.5px]">
          <span className="tabular-nums text-charcoal/70">
            {goal.target_value != null ? goal.target_value.toLocaleString() : '—'}
          </span>
          {!goal.source_of_truth && (
            <span title={isAr ? 'بلا مصدر قياس' : 'no source of truth'}>
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            </span>
          )}
          <ChevronDown className={`h-4 w-4 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-sand/40 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={isAr ? 'المستهدف' : 'Target'} value={goal.target_value ?? null} />
            <Stat label={isAr ? 'الفعلي' : 'Actual'} value={goal.actual_value ?? null} />
            <Stat label={isAr ? 'التوقع' : 'Forecast'} value={goal.forecast_value ?? null} />
            <Stat label={isAr ? 'الفترات المقيسة' : 'Measured periods'}
              value={pacing?.coverage ? `${pacing.coverage.measured}/${pacing.coverage.total}` : null} />
          </div>

          {!goal.source_of_truth && (
            <CaveatStrip>
              {isAr ? 'هذا الهدف بلا مصدر قياس — لا يمكن التحقق من رقمه.'
                    : 'This goal has no source of truth — its number cannot be verified.'}
            </CaveatStrip>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11.5px] font-medium text-charcoal/60">
              {isAr ? 'التوزيع على الفترات' : 'Per-period allocation'}
            </span>
            <button type="button" onClick={addMonths}
              className="text-[11px] text-copper hover:underline">
              {isAr ? 'ابدأ بـ12 شهراً (نقطة بداية تُعدَّل)' : 'Seed 12 months (a starting point to edit)'}
            </button>
          </div>

          {rows.length === 0 ? (
            <EmptyHint>
              {isAr ? 'لا توزيع — بلا فترات لا يمكن حساب الإيقاع' : 'No allocation — without periods there is no pacing'}
            </EmptyHint>
          ) : (
            <>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-[12px]">
                  <tbody className="divide-y divide-sand/30">
                    {rows.map((r, i) => (
                      <tr key={`${r.period_start}-${i}`}>
                        <td className="py-1 pe-2 text-charcoal/70">{r.label || r.period_start}</td>
                        <td className="py-1 w-28">
                          <input type="number" value={r.target_value} className={FIELD}
                            onChange={(e) => setRows(rows.map((x, j) =>
                              j === i ? { ...x, target_value: e.target.value } : x))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={save} disabled={busy}>{isAr ? 'حفظ التوزيع' : 'Save allocation'}</Button>
                <span className={`text-[11.5px] tabular-nums ${diff === 0 ? 'text-charcoal/50' : 'text-amber-700'}`}>
                  {isAr ? 'المجموع' : 'Allocated'} {allocated.toLocaleString()}
                  {target ? ` / ${target.toLocaleString()}` : ''}
                  {target && diff !== 0
                    ? ` (${diff > 0 ? '+' : ''}${diff.toLocaleString()})` : ''}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ══ Portfolio ═════════════════════════════════════════════════════════════
type PortfolioKind = 'initiatives' | 'programs' | 'organic' | 'paid' | 'unclassified';

export function PortfolioTab({ isAr, onError, onToast }: {
  isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [kind, setKind] = useState<PortfolioKind>('initiatives');
  const [plans, setPlans] = useState<MktPlan[]>([]);
  const [planId, setPlanId] = useState('');
  const [inits, setInits] = useState<Initiative[]>([]);
  const [progs, setProgs] = useState<Program[]>([]);
  const [camps, setCamps] = useState<Campaign[]>([]);
  const [goals, setGoals] = useState<MktGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openPaid, setOpenPaid] = useState<string | null>(null);

  /** Spinner on the first load only — see the note on the strategy tab's load.
   *  A refresh after creating something must not unmount an open ad structure. */
  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    Promise.all([fetchPortfolio(planId || undefined), fetchPlanningOverview()])
      .then(([p, o]) => {
        setInits(p.initiatives); setProgs(p.programs); setCamps(p.campaigns);
        setPlans(o.plans);
        setGoals(o.plans.flatMap((pl) => pl.mkt_goals ?? []));
      })
      .catch((e) => onError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, [planId, onError]);
  // Must call load(true): useEffect(load, [load]) would pass React's own
  // argument-less invocation, leaving `loading` stuck true forever.
  useEffect(() => { load(true); }, [load]);

  // Three buckets, not two. A campaign with campaign_class = null is NOT
  // organic — it is unclassified, which is exactly what the legacy rows are.
  // Folding them into "organic" would assert a classification nobody made, and
  // dropping them would hide real campaigns, so they get their own bucket.
  const cls = (c: Campaign) => (c as Campaign & { campaign_class?: string | null }).campaign_class ?? null;
  const organic = useMemo(() => camps.filter((c) => cls(c) === 'organic'), [camps]);
  const paid = useMemo(() => camps.filter((c) => cls(c) === 'paid'), [camps]);
  const unclassified = useMemo(() => camps.filter((c) => cls(c) === null), [camps]);

  const TABS: Array<[PortfolioKind, string, string, number]> = [
    ['initiatives', 'المبادرات', 'Initiatives', inits.length],
    ['programs',    'البرامج',   'Programs',    progs.length],
    ['organic',     'حملات عضوية','Organic campaigns', organic.length],
    ['paid',        'حملات مدفوعة','Paid campaigns',   paid.length],
    ['unclassified','غير مصنّفة','Unclassified',      unclassified.length],
  ];

  return (
    <div className="space-y-4">
      <Section title={isAr ? 'المحفظة التسويقية' : 'Marketing portfolio'}
        subtitle={isAr ? 'المبادرة مظلة؛ البرنامج متكرر بلا نهاية؛ الحملة مؤقتة بمدى زمني'
                       : 'An initiative is an umbrella; a program recurs with no end; a campaign is time-bound'}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={`${FIELD} max-w-[240px]`}>
            <option value="">{isAr ? 'كل الخطط' : 'All plans'}</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
          <Button variant="secondary" onClick={() => setCreating((v) => !v)}>
            <Plus className="h-4 w-4" />{isAr ? 'جديد' : 'New'}
          </Button>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {TABS.map(([k, ar, en, n]) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] ${
                kind === k ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream-light'}`}>
              {k === 'initiatives' && <Target className="h-3.5 w-3.5" />}
              {k === 'programs' && <Repeat className="h-3.5 w-3.5" />}
              {k === 'organic' && <Megaphone className="h-3.5 w-3.5" />}
              {k === 'paid' && <Coins className="h-3.5 w-3.5" />}
              {k === 'unclassified' && <AlertTriangle className="h-3.5 w-3.5" />}
              {isAr ? ar : en}
              <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                kind === k ? 'bg-white/25' : 'bg-charcoal/10'}`}>{n}</span>
            </button>
          ))}
        </div>

        {creating && (
          <PortfolioCreateForm kind={kind} isAr={isAr} plans={plans} goals={goals}
            initiatives={inits} onError={onError}
            onDone={() => { setCreating(false); onToast(isAr ? 'أُنشئ' : 'Created'); load(); }} />
        )}

        {loading ? <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /> : (
          <>
            {kind === 'initiatives' && (inits.length === 0
              ? <EmptyHint>{isAr ? 'لا مبادرات' : 'No initiatives'}</EmptyHint>
              : <ul className="divide-y divide-sand/40">{inits.map((i) => (
                  <li key={i.id} className="py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] text-charcoal">{i.name_ar}</span>
                      <span className="flex items-center gap-2">
                        {i.decision && <Pill map={DECISION_LABEL} value={i.decision} isAr={isAr} tone="warn" />}
                        <Pill map={INITIATIVE_STATUS_LABEL} value={i.status} isAr={isAr}
                          tone={i.status === 'active' ? 'good' : 'neutral'} />
                      </span>
                    </div>
                    {i.hypothesis && <p className="mt-0.5 text-[11.5px] text-charcoal/55">{i.hypothesis}</p>}
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px]">
                      {(i.mkt_programs ?? []).map((p) => (
                        <span key={p.id} className="rounded bg-cream px-1.5 py-0.5 text-charcoal/60">
                          <Repeat className="me-1 inline h-3 w-3" />{p.name_ar}</span>))}
                      {(i.mkt_internal_campaigns ?? []).map((c) => (
                        <span key={c.id} className={`rounded px-1.5 py-0.5 ${
                          c.campaign_class === 'paid' ? 'bg-amber-50 text-amber-800' : 'bg-cream text-charcoal/60'}`}>
                          {c.campaign_class === 'paid' ? <Coins className="me-1 inline h-3 w-3" />
                                                       : <Megaphone className="me-1 inline h-3 w-3" />}
                          {c.name_ar}</span>))}
                      {(i.mkt_programs ?? []).length === 0 && (i.mkt_internal_campaigns ?? []).length === 0 && (
                        <span className="text-amber-700">
                          {isAr ? 'بلا برامج أو حملات' : 'no programs or campaigns yet'}</span>)}
                    </div>
                  </li>))}</ul>)}

            {kind === 'programs' && (progs.length === 0
              ? <EmptyHint>{isAr ? 'لا برامج' : 'No programs'}</EmptyHint>
              : <ul className="divide-y divide-sand/40">{progs.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-charcoal">{p.name_ar}</span>
                      <span className="text-[11px] text-charcoal/45">
                        {p.commitment_count != null
                          ? `${p.commitment_count} ${lbl(CADENCE_UNIT_LABEL, p.commitment_unit ?? '', isAr)}`
                          : (isAr ? 'بلا التزام متكرر' : 'no recurring commitment')}
                        {p.purpose ? ` · ${p.purpose}` : ''}
                      </span>
                    </span>
                    <Pill map={PROGRAM_STATUS_LABEL} value={p.status} isAr={isAr}
                      tone={p.status === 'active' ? 'good' : 'neutral'} />
                  </li>))}</ul>)}

            {(kind === 'organic' || kind === 'paid' || kind === 'unclassified') && (
              (kind === 'organic' ? organic : kind === 'paid' ? paid : unclassified).length === 0
                ? <EmptyHint>{isAr ? 'لا حملات' : 'No campaigns'}</EmptyHint>
                : <ul className="divide-y divide-sand/40">
                    {(kind === 'organic' ? organic : kind === 'paid' ? paid : unclassified).map((c) => (
                      <li key={c.id} className="py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-charcoal">{c.code} · {c.name_ar}</span>
                            <span className="text-[11px] text-charcoal/45">
                              {c.start_date ? fmtDate(c.start_date, isAr) : '—'} → {c.end_date ? fmtDate(c.end_date, isAr) : '—'}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {(c as Campaign & { needs_classification?: boolean }).needs_classification && (
                              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] text-amber-800">
                                {isAr ? 'يحتاج تصنيفاً' : 'needs classification'}
                              </span>)}
                            {/* The ad structure hangs off a PAID campaign only — the
                                database refuses a platform campaign under an organic
                                parent, so offering it elsewhere would only produce a
                                rejection. */}
                            {kind === 'paid' && (
                              <button type="button" onClick={() => setOpenPaid(openPaid === c.id ? null : c.id)}
                                className="text-[11.5px] font-medium text-copper hover:underline">
                                {openPaid === c.id
                                  ? (isAr ? 'إخفاء الإعلانات' : 'Hide ads')
                                  : (isAr ? 'بنية الإعلانات' : 'Ad structure')}
                              </button>)}
                          </span>
                        </div>
                        {kind === 'paid' && openPaid === c.id && (
                          <PaidTreePanel campaignId={c.id} isAr={isAr} onError={onError} onToast={onToast} />
                        )}
                      </li>))}
                  </ul>)}
          </>
        )}
      </Section>
    </div>
  );
}

/** Distinct form per object type — see the file header for why. */
function PortfolioCreateForm({ kind, isAr, plans, goals, initiatives, onError, onDone }: {
  kind: PortfolioKind; isAr: boolean; plans: MktPlan[]; goals: MktGoal[];
  initiatives: Initiative[]; onError: (m: string) => void; onDone: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const planGoals = goals.filter((g) => !f.plan_id || g.plan_id === f.plan_id);

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'initiatives') {
        await saveInitiative({
          plan_id: f.plan_id || null, primary_goal_id: f.primary_goal_id || null,
          name_ar: f.name_ar, problem_or_opportunity: f.problem || null,
          hypothesis: f.hypothesis || null, expected_contribution: f.expected || null,
          owner_user_id: f.owner || null, status: 'proposed',
        });
      } else if (kind === 'programs') {
        await saveProgram({
          plan_id: f.plan_id || null, initiative_id: f.initiative_id || null,
          primary_goal_id: f.primary_goal_id || null, name_ar: f.name_ar,
          purpose: f.purpose || null, target_audience: f.audience || null,
          cadence: f.commitment_unit ? `${f.commitment_count} / ${f.commitment_unit}` : null,
          commitment_count: f.commitment_count ? Number(f.commitment_count) : null,
          commitment_unit: f.commitment_unit || null,
          review_frequency: f.review_frequency || null,
          owner_user_id: f.owner || null, status: 'draft',
        });
      } else {
        await saveCampaign({
          code: f.code, name_ar: f.name_ar,
          campaign_type: kind === 'paid' ? 'paid' : 'organic',
          campaign_class: kind === 'paid' ? 'paid' : 'organic',
          channel_mix: kind === 'paid' ? 'paid' : 'organic',
          status: 'planned', start_date: f.start_date || null, end_date: f.end_date || null,
          plan_id: f.plan_id || null, initiative_id: f.initiative_id || null,
          primary_goal_id: f.primary_goal_id || null,
          target_audience: f.audience || null, main_message: f.message || null,
          budget: f.budget ? Number(f.budget) : null,
          objective: f.objective || null, owner_user_id: f.owner || null,
        });
      }
      onDone();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const planSel = (
    <Field label={isAr ? 'الخطة' : 'Plan'}>
      <select value={f.plan_id ?? ''} onChange={(e) => set('plan_id', e.target.value)} className={FIELD}>
        <option value="">{isAr ? '— اختر —' : '— select —'}</option>
        {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
      </select></Field>);
  const goalSel = (
    <Field label={isAr ? 'الهدف الرئيسي' : 'Primary goal'}>
      <select value={f.primary_goal_id ?? ''} onChange={(e) => set('primary_goal_id', e.target.value)} className={FIELD}>
        <option value="">{isAr ? '— اختر —' : '— select —'}</option>
        {planGoals.map((g) => (
          <option key={g.id} value={g.id}>{g.name_ar} · {lbl(GOAL_CATEGORY_LABEL, g.goal_category, isAr)}</option>))}
      </select></Field>);
  const initSel = (
    <Field label={isAr ? 'المبادرة (اختياري)' : 'Initiative (optional)'}>
      <select value={f.initiative_id ?? ''} onChange={(e) => set('initiative_id', e.target.value)} className={FIELD}>
        <option value="">{isAr ? '— بلا مبادرة —' : '— none —'}</option>
        {initiatives.map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}
      </select></Field>);
  const ownerSel = (
    <Field label={isAr ? 'المسؤول' : 'Owner'}>
      <select value={f.owner ?? ''} onChange={(e) => set('owner', e.target.value)} className={FIELD}>
        <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
        {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
      </select></Field>);

  return (
    <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-3">
      <Field label={isAr ? 'الاسم' : 'Name'} span="sm:col-span-2">
        <input value={f.name_ar ?? ''} onChange={(e) => set('name_ar', e.target.value)} className={FIELD} /></Field>

      {kind === 'initiatives' && (<>
        {planSel}{goalSel}{ownerSel}
        <Field label={isAr ? 'الفرصة أو المشكلة' : 'Opportunity or problem'} span="sm:col-span-3">
          <textarea rows={2} value={f.problem ?? ''} onChange={(e) => set('problem', e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'الفرضية' : 'Hypothesis'} span="sm:col-span-3">
          <textarea rows={2} value={f.hypothesis ?? ''} onChange={(e) => set('hypothesis', e.target.value)} className={FIELD}
            placeholder={isAr ? 'نعتقد أن… وسنعرف أننا محقّون عندما…' : 'We believe that… and we will know we are right when…'} /></Field>
        <Field label={isAr ? 'المساهمة المتوقعة' : 'Expected contribution'} span="sm:col-span-3">
          <input value={f.expected ?? ''} onChange={(e) => set('expected', e.target.value)} className={FIELD} /></Field>
      </>)}

      {kind === 'programs' && (<>
        {planSel}{initSel}{goalSel}
        <Field label={isAr ? 'الغرض' : 'Purpose'} span="sm:col-span-3">
          <textarea rows={2} value={f.purpose ?? ''} onChange={(e) => set('purpose', e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'عدد المخرجات' : 'Commitment'}>
          <input type="number" value={f.commitment_count ?? ''} onChange={(e) => set('commitment_count', e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'التكرار' : 'Cadence'}>
          <select value={f.commitment_unit ?? ''} onChange={(e) => set('commitment_unit', e.target.value)} className={FIELD}>
            <option value="">{isAr ? '— اختر —' : '— select —'}</option>
            {Object.keys(CADENCE_UNIT_LABEL).map((u) => (
              <option key={u} value={u}>{lbl(CADENCE_UNIT_LABEL, u, isAr)}</option>))}
          </select></Field>
        <Field label={isAr ? 'دورية المراجعة' : 'Review frequency'}>
          <input value={f.review_frequency ?? ''} onChange={(e) => set('review_frequency', e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'الجمهور' : 'Audience'} span="sm:col-span-2">
          <input value={f.audience ?? ''} onChange={(e) => set('audience', e.target.value)} className={FIELD} /></Field>
        {ownerSel}
        <p className="text-[11px] text-charcoal/45 sm:col-span-3">
          {isAr ? 'البرنامج مستمر — لا يُطلب تاريخ انتهاء.' : 'A program is ongoing — no end date is asked for.'}
        </p>
      </>)}

      {(kind === 'organic' || kind === 'paid') && (<>
        <Field label={isAr ? 'الرمز' : 'Code'}>
          <input value={f.code ?? ''} onChange={(e) => set('code', e.target.value)} className={FIELD}
            placeholder="CMP-001" /></Field>
        {planSel}{initSel}{goalSel}
        <Field label={isAr ? 'من' : 'From'}>
          <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'إلى' : 'To'}>
          <input type="date" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value)} className={FIELD} /></Field>
        {kind === 'organic' ? (<>
          <Field label={isAr ? 'الرسالة' : 'Message'} span="sm:col-span-3">
            <textarea rows={2} value={f.message ?? ''} onChange={(e) => set('message', e.target.value)} className={FIELD} /></Field>
          <Field label={isAr ? 'الجمهور' : 'Audience'} span="sm:col-span-2">
            <input value={f.audience ?? ''} onChange={(e) => set('audience', e.target.value)} className={FIELD} /></Field>
        </>) : (<>
          <Field label={isAr ? 'هدف الأعمال' : 'Business objective'} span="sm:col-span-2">
            <input value={f.objective ?? ''} onChange={(e) => set('objective', e.target.value)} className={FIELD}
              placeholder={isAr ? 'مثال: عملاء محتملون' : 'e.g. lead generation'} /></Field>
          <Field label={isAr ? 'الميزانية' : 'Budget'}>
            <input type="number" value={f.budget ?? ''} onChange={(e) => set('budget', e.target.value)} className={FIELD} /></Field>
          <p className="text-[11px] text-charcoal/45 sm:col-span-3">
            {isAr ? 'حملات المنصات والمجموعات الإعلانية تُضاف بعد الإنشاء.'
                  : 'Platform campaigns and ad groups are added after the campaign exists.'}
          </p>
        </>)}
        {ownerSel}
      </>)}

      <div className="sm:col-span-3">
        <Button onClick={submit} disabled={busy || !f.name_ar}>{isAr ? 'إنشاء' : 'Create'}</Button>
      </div>
    </div>
  );
}

// ══ Reviews ═══════════════════════════════════════════════════════════════
export function ReviewsTab({ isAr, onError, onToast }: {
  isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [plans, setPlans] = useState<MktPlan[]>([]);
  const [planId, setPlanId] = useState('');
  const [reviews, setReviews] = useState<MktReview[]>([]);
  const [progs, setProgs] = useState<Program[]>([]);
  const [inits, setInits] = useState<Initiative[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rType, setRType] = useState('monthly');
  const [rFrom, setRFrom] = useState(''); const [rTo, setRTo] = useState('');

  useEffect(() => {
    fetchPlanningOverview().then((o) => {
      setPlans(o.plans);
      if (!planId && o.plans[0]) setPlanId(o.plans[0].id);
    }).catch((e) => onError(err(e))).finally(() => setLoading(false));
  }, [onError, planId]);

  const load = useCallback(() => {
    if (!planId) { setReviews([]); return; }
    Promise.all([fetchPlanDetail(planId), fetchPortfolio(planId)])
      .then(([d, p]) => { setReviews(d.reviews); setProgs(p.programs); setInits(p.initiatives); })
      .catch((e) => onError(err(e)));
  }, [planId, onError]);
  useEffect(load, [load]);

  const create = async () => {
    if (!planId || !rFrom || !rTo) return;
    setBusy(true);
    try {
      await saveReview({ plan_id: planId, review_type: rType, period_start: rFrom, period_end: rTo, status: 'held' });
      setRFrom(''); setRTo(''); onToast(isAr ? 'أُنشئت المراجعة' : 'Review created'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  return (
    <Section title={isAr ? 'المراجعات والقرارات' : 'Reviews & decisions'}
      subtitle={isAr ? 'استمرار · تعديل · توسيع · إيقاف مؤقت · إيقاف — قرار مسجَّل، لا جملة في تقرير'
                     : 'Continue · change · scale · pause · stop — a recorded decision, not a sentence in a report'}>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label={isAr ? 'الخطة' : 'Plan'}>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={`${FIELD} min-w-[180px]`}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select></Field>
        <Field label={isAr ? 'النوع' : 'Type'}>
          <select value={rType} onChange={(e) => setRType(e.target.value)} className={FIELD}>
            {['weekly','monthly','quarterly','annual','ad_hoc'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select></Field>
        <Field label={isAr ? 'من' : 'From'}>
          <input type="date" value={rFrom} onChange={(e) => setRFrom(e.target.value)} className={FIELD} /></Field>
        <Field label={isAr ? 'إلى' : 'To'}>
          <input type="date" value={rTo} onChange={(e) => setRTo(e.target.value)} className={FIELD} /></Field>
        <Button onClick={create} disabled={busy || !planId || !rFrom || !rTo}>
          <ClipboardCheck className="h-4 w-4" />{isAr ? 'مراجعة جديدة' : 'New review'}
        </Button>
      </div>

      {reviews.length === 0 ? (
        <EmptyHint>{isAr ? 'لا مراجعات لهذه الخطة' : 'No reviews for this plan'}</EmptyHint>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-xl border border-sand/50 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-charcoal">
                  {r.review_type} · {fmtDate(r.period_start, isAr)} → {fmtDate(r.period_end, isAr)}
                </span>
                <span className="text-[11px] text-charcoal/45">
                  {(r.mkt_review_decisions ?? []).length} {isAr ? 'قرار' : 'decisions'}
                </span>
              </div>
              {(r.mkt_review_decisions ?? []).length > 0 && (
                <ul className="mt-2 divide-y divide-sand/30">
                  {(r.mkt_review_decisions ?? []).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12px]">
                      <span className="text-charcoal/75">
                        {progs.find((p) => p.id === d.program_id)?.name_ar
                          ?? inits.find((i) => i.id === d.initiative_id)?.name_ar
                          ?? (isAr ? 'عنصر' : 'subject')}
                        {d.rationale ? ` — ${d.rationale}` : ''}
                      </span>
                      <Pill map={DECISION_LABEL} value={d.decision} isAr={isAr} tone="warn" />
                    </li>))}
                </ul>
              )}
              <DecideRow reviewId={r.id} isAr={isAr} programs={progs} initiatives={inits}
                onError={onError} onDone={() => { onToast(isAr ? 'سُجِّل القرار' : 'Decision recorded'); load(); }} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DecideRow({ reviewId, isAr, programs, initiatives, onError, onDone }: {
  reviewId: string; isAr: boolean; programs: Program[]; initiatives: Initiative[];
  onError: (m: string) => void; onDone: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [decision, setDecision] = useState('continue');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!subject) return;
    const [kind, id] = subject.split(':');
    setBusy(true);
    try {
      await decideReview({
        review_id: reviewId,
        program_id: kind === 'prog' ? id : null,
        initiative_id: kind === 'init' ? id : null,
        decision, rationale: why.trim() || null,
      });
      setWhy(''); setSubject(''); onDone();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-sand/30 pt-2">
      <select value={subject} onChange={(e) => setSubject(e.target.value)} className={`${FIELD} max-w-[200px]`}>
        <option value="">{isAr ? '— العنصر —' : '— subject —'}</option>
        {initiatives.map((i) => <option key={i.id} value={`init:${i.id}`}>{i.name_ar}</option>)}
        {programs.map((p) => <option key={p.id} value={`prog:${p.id}`}>{p.name_ar}</option>)}
      </select>
      <select value={decision} onChange={(e) => setDecision(e.target.value)} className={`${FIELD} max-w-[140px]`}>
        {['continue','change','scale','pause','stop'].map((d) => (
          <option key={d} value={d}>{lbl(DECISION_LABEL, d, isAr)}</option>))}
      </select>
      <input value={why} onChange={(e) => setWhy(e.target.value)} className={`${FIELD} min-w-[160px] flex-1`}
        placeholder={isAr ? 'المبرر' : 'Rationale'} />
      <Button variant="secondary" onClick={submit} disabled={busy || !subject}>
        {isAr ? 'تسجيل' : 'Record'}
      </Button>
    </div>
  );
}
