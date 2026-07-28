/**
 * The v2 planning surface: Strategy & Planning, and Reviews.
 *
 * The Portfolio used to live in this file. It moved to ./portfolio/ when it
 * grew a hierarchy view, per-type drawers and a needs-attention queue — and
 * when its create flow had to stop treating "unclassified" as a thing you can
 * make. `PortfolioTab` is re-exported at the bottom so the page's import does
 * not have to know where it went.
 *
 * Design record: docs/marketing-management-v2.md
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Check, ChevronDown, ClipboardCheck } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, CaveatStrip, Spinner, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPlanningOverview, saveStrategy, approveStrategy,
  fetchPlanDetail, savePlan, approvePlan, saveGoal, fetchPlanMissing,
  fetchPortfolio, saveReview, decideReview,
  PLAN_TYPE_LABEL, PLAN_STATUS_LABEL, STRATEGY_STATUS_LABEL, GOAL_CLASS_LABEL,
  GOAL_CLASS_HINT, PLAN_MISSING_LABEL, DECISION_LABEL,
  type StrategyVersion, type MktPlan, type Initiative, type Program,
  type MktReview,
} from '@/lib/marketingMgmt/v2';
import { StrategyEditor, StrategyCompleteness } from './StrategyEditor';
import { GoalRow } from './GoalPanel';
import { PlanStrategyBinding } from './PlanStrategyBinding';

export { PortfolioView as PortfolioTab } from './portfolio/PortfolioView';

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
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [gName, setGName] = useState(''); const [gClass, setGClass] = useState('outcome');
  const [gMetric, setGMetric] = useState(''); const [gUnit, setGUnit] = useState('');
  const [gTarget, setGTarget] = useState('');

  const load = useCallback(() => {
    fetchPlanDetail(planId).then(setData).catch((e) => onError(err(e)));
    fetchPlanMissing(planId).then((r) => setMissing(r.missing)).catch((e) => onError(err(e)));
  }, [planId, onError]);
  useEffect(load, [load]);

  /** Created as a DRAFT on purpose. A goal goes active only once it is complete
   *  — the database refuses the transition otherwise — and four boxes in a
   *  quick-add row are not a complete definition. The row then opens on its
   *  Definition tab with a checklist of what is still missing. */
  const addGoal = async () => {
    if (!gName.trim()) return;
    setBusy(true);
    try {
      await saveGoal({
        plan_id: planId, goal_class: gClass, name_ar: gName.trim(),
        metric: gMetric.trim() || null, unit: gUnit.trim() || null,
        target_value: gTarget ? Number(gTarget) : null, status: 'draft',
      });
      setGName(''); setGMetric(''); setGUnit(''); setGTarget(''); setAdding(false);
      onToast(isAr ? 'أُضيف الهدف كمسودة — أكمل تعريفه لتفعيله'
                   : 'Goal added as a draft — complete its definition to activate it');
      load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const activate = async () => {
    setBusy(true);
    try { await approvePlan(planId); onToast(isAr ? 'اعتُمدت الخطة' : 'Plan approved'); load(); onChanged(); }
    catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (!data) return <div className="py-3"><Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /></div>;

  const blocking = missing.filter((m) => m !== 'at_least_one_goal' || data.goals.length === 0);

  return (
    <div className="mb-3 space-y-3 rounded-xl border border-sand/50 bg-cream-light/50 p-3">
      <PlanStrategyBinding plan={data.plan} isAr={isAr} onError={onError} onToast={onToast}
        onChanged={() => { load(); onChanged(); }} />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'الأهداف' : 'Goals'} value={data.goals.length || null} />
        <Stat label={isAr ? 'المبادرات' : 'Initiatives'} value={data.initiatives.length || null} />
        <Stat label={isAr ? 'البرامج' : 'Programs'} value={data.programs.length || null} />
        <Stat label={isAr ? 'الحملات' : 'Campaigns'} value={data.campaigns.length || null} />
      </div>

      {data.plan.status === 'draft' && (
        blocking.length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="mb-1 text-[11.5px] font-semibold text-amber-800">
              {isAr ? 'لا يمكن اعتماد الخطة بعد — ناقص:' : 'Cannot approve this plan yet — missing:'}
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
              {blocking.map((m) => (
                <li key={m} className="text-[11.5px] text-amber-800">
                  · {lbl(PLAN_MISSING_LABEL, m, isAr)}
                </li>))}
            </ul>
          </div>
        ) : (
          <Button variant="secondary" onClick={activate} disabled={busy}>
            <Check className="h-4 w-4" />{isAr ? 'اعتماد الخطة' : 'Approve plan'}
          </Button>
        )
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
            <Field label={isAr ? 'تصنيف الهدف' : 'Classification'}>
              <select value={gClass} onChange={(e) => setGClass(e.target.value)} className={FIELD}>
                {Object.keys(GOAL_CLASS_LABEL).map((c) => (
                  <option key={c} value={c}>{lbl(GOAL_CLASS_LABEL, c, isAr)}</option>))}
              </select></Field>
            <Field label={isAr ? 'المقياس' : 'Metric'}>
              <input value={gMetric} onChange={(e) => setGMetric(e.target.value)} className={FIELD}
                placeholder={isAr ? 'ما الذي يُعد؟' : 'What is counted?'} /></Field>
            <Field label={isAr ? 'الوحدة' : 'Unit'}>
              <input value={gUnit} onChange={(e) => setGUnit(e.target.value)} className={FIELD}
                placeholder={isAr ? 'عميل، ٪، ريال…' : 'lead, %, SAR…'} /></Field>
            <Field label={isAr ? 'المستهدف' : 'Target'}>
              <input type="number" value={gTarget} onChange={(e) => setGTarget(e.target.value)} className={FIELD} /></Field>
            <p className="text-[10.5px] leading-snug text-charcoal/45 sm:col-span-3 sm:self-end">
              {lbl(GOAL_CLASS_HINT, gClass, isAr)}
            </p>
            <div className="sm:self-end">
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
