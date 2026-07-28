/**
 * The Marketing Portfolio.
 *
 * The old screen was five filter tabs over three flat lists, and one of those
 * tabs — "Unclassified" — offered a New button that produced a raw Postgres
 * error, because unclassified is a STATE legacy records are in, not a kind of
 * thing you can make. The filters were also the whole experience, which meant
 * you could see every campaign and still not see how any of it laddered up.
 *
 * Three views replace that:
 *
 *   خريطة المحفظة  the hierarchy — plan → goal → initiative → programs and
 *                  campaigns, with the ones attached straight to a goal shown
 *                  there rather than hidden
 *   القائمة        flat lists with the old filters, kept because scanning one
 *                  kind at a time is genuinely useful
 *   بحاجة للاستكمال every record that is missing something, with a separate
 *                  filter per thing it could be missing
 *
 * The plan header is the anchor: everything below it is scoped to one plan, and
 * the counts in the header are computed from the same arrays the views render,
 * so a "0 campaigns" heading can never sit above a list of campaigns.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Map as MapIcon, List as ListIcon, AlertTriangle, ChevronDown, ChevronRight,
  Target, Repeat, Megaphone, Coins,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, Stat, EmptyHint, CaveatStrip, Spinner, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPortfolioMap,
  PLAN_STATUS_LABEL, PLAN_TYPE_LABEL, STRATEGY_STATUS_LABEL, GOAL_CLASS_LABEL,
  ATTENTION_FILTER_LABEL,
  type PlanRef, type MktGoal, type Initiative, type Program,
  type StrategyVersionRef, type PortfolioKind,
} from '@/lib/marketingMgmt/v2';
import type { Campaign } from '@/lib/marketingMgmt/client';
import { Pill, dash, err, attentionFlags, type AttentionKey } from './shared';
import { InitiativeCard, ProgramCard, CampaignCard, type CardCtx } from './cards';
import { CreateDrawer, CREATE_KINDS, type CreateKind } from './CreateDrawer';
import { RecordDrawer } from './RecordDrawer';

type View = 'map' | 'list' | 'attention';
type ListFilter = 'initiatives' | 'programs' | 'organic' | 'paid';

const ALL_PLANS = '';

export function PortfolioView({ isAr, onError, onToast }: {
  isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const [view, setView] = useState<View>('map');
  const [listFilter, setListFilter] = useState<ListFilter>('initiatives');
  const [planId, setPlanId] = useState<string | null>(null);   // null = not decided yet
  const [loading, setLoading] = useState(true);

  const [plans, setPlans] = useState<PlanRef[]>([]);
  const [strategies, setStrategies] = useState<StrategyVersionRef[]>([]);
  const [goals, setGoals] = useState<MktGoal[]>([]);
  const [inits, setInits] = useState<Initiative[]>([]);
  const [progs, setProgs] = useState<Program[]>([]);
  const [camps, setCamps] = useState<Campaign[]>([]);
  const [output, setOutput] = useState<Array<{ origin_program_id: string | null; created_at: string }>>([]);

  const [creating, setCreating] = useState<CreateKind | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [open, setOpen] = useState<{ kind: PortfolioKind; id: string } | null>(null);
  const [attention, setAttention] = useState<AttentionKey | 'all'>('all');

  /** Spinner on the FIRST load only. A refetch that flips `loading` replaces
   *  the whole section with a spinner, which unmounts an open drawer. */
  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    fetchPortfolioMap(planId || undefined)
      .then((r) => {
        setPlans(r.plans); setStrategies(r.strategies); setGoals(r.goals);
        setInits(r.initiatives); setProgs(r.programs); setCamps(r.campaigns);
        setOutput(r.program_output ?? []);
        // Default to the plan the operation is actually running: the active one
        // if there is one, then the approved one. "All plans" stays reachable as
        // an explicit historical view, but it is not where you land while a plan
        // is live.
        if (planId === null) {
          const active = r.plans.find((p) => p.status === 'active')
            ?? r.plans.find((p) => p.status === 'approved');
          setPlanId(active?.id ?? ALL_PLANS);
        }
      })
      .catch((e) => onError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, [planId, onError]);
  useEffect(() => { load(true); }, [load]);

  const plan = plans.find((p) => p.id === planId) ?? null;
  const strategy = plan?.strategy_version_id
    ? strategies.find((s) => s.id === plan.strategy_version_id) ?? null : null;

  const organic = useMemo(() => camps.filter((c) => c.campaign_class === 'organic'), [camps]);
  const paid = useMemo(() => camps.filter((c) => c.campaign_class === 'paid'), [camps]);

  const outputByProgram = useMemo(() => {
    const m = new Map<string, Array<{ created_at: string }>>();
    for (const o of output) {
      if (!o.origin_program_id) continue;
      const arr = m.get(o.origin_program_id) ?? [];
      arr.push({ created_at: o.created_at });
      m.set(o.origin_program_id, arr);
    }
    return m;
  }, [output]);

  /** Every record with its flags, computed once. The header count, the filter
   *  chips and the cards all read this, so they cannot disagree. */
  const flagged = useMemo(() => {
    const rows: Array<{ kind: PortfolioKind; id: string; flags: AttentionKey[] }> = [];
    for (const i of inits) {
      rows.push({
        kind: 'initiative', id: i.id,
        flags: attentionFlags('initiative', i, {
          programs: progs.filter((p) => p.initiative_id === i.id).length,
          campaigns: camps.filter((c) => c.initiative_id === i.id).length,
        }),
      });
    }
    for (const p of progs) rows.push({ kind: 'program', id: p.id, flags: attentionFlags('program', p) });
    for (const c of camps) rows.push({ kind: 'campaign', id: c.id, flags: attentionFlags('campaign', c) });
    return rows;
  }, [inits, progs, camps]);

  const needingCount = flagged.filter((r) => r.flags.length > 0).length;
  const attentionCounts = useMemo(() => {
    const m = new Map<AttentionKey, number>();
    for (const r of flagged) for (const f of r.flags) m.set(f, (m.get(f) ?? 0) + 1);
    return m;
  }, [flagged]);

  const ctx: CardCtx = { isAr, users, goals, plans, initiatives: inits, onOpen: (k, id) => setOpen({ kind: k, id }) };

  const afterCreate = (k: CreateKind, id: string) => {
    setCreating(null);
    onToast(isAr ? 'أُنشئ السجل' : 'Created');
    load();
    setOpen({ kind: k === 'organic' || k === 'paid' ? 'campaign' : k, id });
  };

  return (
    <div className="space-y-4">
      <Section title={isAr ? 'المحفظة التسويقية' : 'Marketing portfolio'}
        subtitle={isAr ? 'المبادرة مظلة؛ البرنامج متكرر بلا نهاية؛ الحملة مؤقتة بمدى زمني'
                       : 'An initiative is an umbrella; a program recurs with no end; a campaign is time-bound'}>

        {/* ── plan context ── */}
        <div className="mb-3 rounded-xl border border-sand/50 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={planId ?? ''} onChange={(e) => setPlanId(e.target.value)}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none">
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
              <option value={ALL_PLANS}>{isAr ? 'كل الخطط (عرض تاريخي)' : 'All plans (historical view)'}</option>
            </select>
            {plan ? (
              <>
                <Pill map={PLAN_STATUS_LABEL} value={plan.status} isAr={isAr}
                  tone={plan.status === 'active' ? 'good' : 'neutral'} />
                <span className="text-[11.5px] text-charcoal/50">
                  {lbl(PLAN_TYPE_LABEL, plan.plan_type, isAr)} · {fmtDate(plan.period_start, isAr)} → {fmtDate(plan.period_end, isAr)}
                </span>
              </>
            ) : (
              <span className="text-[11.5px] text-charcoal/50">
                {isAr ? 'عرض كل الخطط — الأرقام أدناه تشمل كل الفترات'
                      : 'Showing every plan — the numbers below span all periods'}
              </span>
            )}
          </div>

          {plan && (
            <div className="mt-1.5 text-[11.5px]">
              {strategy ? (
                <span className="text-charcoal/60">
                  {isAr ? 'مبنية على ' : 'Written against '}
                  <span className="font-medium text-charcoal">
                    {isAr ? 'النسخة' : 'version'} {strategy.version_number} · {strategy.name_ar}
                  </span>{' '}
                  <Pill map={STRATEGY_STATUS_LABEL} value={strategy.status} isAr={isAr}
                    tone={strategy.status === 'approved' ? 'good' : 'warn'} />
                  {strategy.effective_date && (
                    <span className="ms-1 text-charcoal/45">
                      {isAr ? 'سارية من ' : 'effective '}{fmtDate(strategy.effective_date, isAr)}
                    </span>)}
                </span>
              ) : (
                <span className="text-amber-700">
                  {isAr ? 'هذه الخطة غير مرتبطة بأي نسخة استراتيجية.'
                        : 'This plan is not bound to any strategy version.'}
                </span>
              )}
            </div>
          )}

          {/* These are COUNTS of rows we just fetched, so zero is a fact and is
              shown as zero. The em-dash convention is for values that were never
              recorded — it would be wrong here, because "no campaigns" and "we
              never counted the campaigns" are different statements. */}
          <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat label={isAr ? 'الأهداف' : 'Goals'} value={goals.length} />
            <Stat label={isAr ? 'المبادرات' : 'Initiatives'} value={inits.length} />
            <Stat label={isAr ? 'البرامج' : 'Programs'} value={progs.length} />
            <Stat label={isAr ? 'حملات عضوية' : 'Organic'} value={organic.length} />
            <Stat label={isAr ? 'حملات مدفوعة' : 'Paid'} value={paid.length} />
            <Stat label={isAr ? 'بحاجة للاستكمال' : 'Need completion'} value={needingCount}
              tone={needingCount ? 'warn' : 'muted'} />
          </div>
        </div>

        {/* ── views + create ── */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {([['map', MapIcon, 'خريطة المحفظة', 'Portfolio map'],
               ['list', ListIcon, 'القائمة', 'List'],
               ['attention', AlertTriangle, 'بحاجة للاستكمال', 'Needs attention']] as const).map(([v, Icon, ar, en]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] ${
                  view === v ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream-light'}`}>
                <Icon className="h-3.5 w-3.5" />{isAr ? ar : en}
                {v === 'attention' && needingCount > 0 && (
                  <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                    view === v ? 'bg-white/25' : 'bg-amber-100 text-amber-800'}`}>{needingCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* One creation menu. Four things, and "unclassified" is not one. */}
          <div className="relative">
            <Button variant="secondary" onClick={() => setCreateMenu((v) => !v)}>
              <Plus className="h-4 w-4" />{isAr ? 'إنشاء' : 'Create'}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            {createMenu && (
              <>
                <button type="button" aria-hidden className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setCreateMenu(false)} />
                <ul className="absolute z-20 mt-1 min-w-[200px] overflow-hidden rounded-xl border border-sand/60 bg-white py-1 shadow-lg"
                  style={{ [isAr ? 'left' : 'right']: 0 }}>
                  {CREATE_KINDS.map(([k, ar, en, Icon]) => (
                    <li key={k}>
                      <button type="button"
                        onClick={() => { setCreateMenu(false); setCreating(k); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-start text-[12.5px] text-charcoal/80 hover:bg-cream-light">
                        <Icon className="h-3.5 w-3.5 text-charcoal/40" />{isAr ? ar : en}
                      </button>
                    </li>))}
                </ul>
              </>
            )}
          </div>
        </div>

        {loading ? <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /> : (
          <>
            {view === 'map' && (
              <PortfolioMap isAr={isAr} plans={plans} planId={planId ?? ALL_PLANS}
                goals={goals} inits={inits} progs={progs} camps={camps}
                outputByProgram={outputByProgram} ctx={ctx} />
            )}

            {view === 'list' && (
              <>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {([['initiatives', Target, 'المبادرات', 'Initiatives', inits.length],
                     ['programs', Repeat, 'البرامج', 'Programs', progs.length],
                     ['organic', Megaphone, 'حملات عضوية', 'Organic campaigns', organic.length],
                     ['paid', Coins, 'حملات مدفوعة', 'Paid campaigns', paid.length]] as const).map(
                    ([k, Icon, ar, en, n]) => (
                      <button key={k} type="button" onClick={() => setListFilter(k)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] ${
                          listFilter === k ? 'bg-charcoal/85 text-white' : 'text-charcoal/60 hover:bg-cream-light'}`}>
                        <Icon className="h-3.5 w-3.5" />{isAr ? ar : en}
                        <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                          listFilter === k ? 'bg-white/25' : 'bg-charcoal/10'}`}>{n}</span>
                      </button>))}
                </div>
                <ListView filter={listFilter} isAr={isAr} ctx={ctx}
                  inits={inits} progs={progs} organic={organic} paid={paid}
                  camps={camps} outputByProgram={outputByProgram} />
              </>
            )}

            {view === 'attention' && (
              <NeedsAttention isAr={isAr} ctx={ctx} flagged={flagged} counts={attentionCounts}
                selected={attention} onSelect={setAttention}
                inits={inits} progs={progs} camps={camps} outputByProgram={outputByProgram} />
            )}
          </>
        )}
      </Section>

      <CreateDrawer kind={creating} isAr={isAr} plans={plans} goals={goals} initiatives={inits}
        defaultPlanId={planId ?? ''} onClose={() => setCreating(null)}
        onCreated={afterCreate} onError={onError} />

      <RecordDrawer target={open} isAr={isAr} plans={plans} goals={goals} initiatives={inits}
        onClose={() => setOpen(null)} onChanged={load} onError={onError} onToast={onToast} />
    </div>
  );
}

// ── Portfolio map ──────────────────────────────────────────────────────────

function Node({ children, depth = 0 }: { children: React.ReactNode; depth?: number }) {
  return <div style={{ marginInlineStart: depth * 16 }}>{children}</div>;
}

function PortfolioMap({
  isAr, plans, planId, goals, inits, progs, camps, outputByProgram, ctx,
}: {
  isAr: boolean; plans: PlanRef[]; planId: string;
  goals: MktGoal[]; inits: Initiative[]; progs: Program[]; camps: Campaign[];
  outputByProgram: Map<string, Array<{ created_at: string }>>;
  ctx: CardCtx;
}) {
  const [openGoals, setOpenGoals] = useState<Set<string>>(() => new Set());
  const [openInits, setOpenInits] = useState<Set<string>>(() => new Set());
  const toggle = (s: Set<string>, id: string) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n;
  };

  // Every plan in scope. With one plan selected that is one heading; with "all
  // plans" it is the whole history, which is exactly what that option is for.
  const scope = planId ? plans.filter((p) => p.id === planId) : plans;

  if (goals.length === 0 && inits.length === 0 && progs.length === 0 && camps.length === 0) {
    return (
      <EmptyHint>
        {isAr ? 'لا يوجد شيء في هذه المحفظة بعد — ابدأ بمبادرة أو حملة من زر الإنشاء'
              : 'Nothing in this portfolio yet — start from the Create button'}
      </EmptyHint>
    );
  }

  return (
    <div className="space-y-4">
      {scope.map((p) => {
        const planGoals = goals.filter((g) => g.plan_id === p.id);
        return (
          <div key={p.id} className="rounded-xl border border-sand/50 bg-cream-light/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-charcoal">{p.name_ar}</span>
              <Pill map={PLAN_STATUS_LABEL} value={p.status} isAr={isAr}
                tone={p.status === 'active' ? 'good' : 'neutral'} />
              <span className="text-[11px] text-charcoal/45">
                {fmtDate(p.period_start, isAr)} → {fmtDate(p.period_end, isAr)}
              </span>
            </div>

            {planGoals.length === 0 ? (
              <EmptyHint>
                {isAr ? 'خطة بلا أهداف — لا يمكن تعليق أي عمل تحتها' : 'A plan with no goals — nothing can hang under it'}
              </EmptyHint>
            ) : planGoals.map((g) => {
              const gInits = inits.filter((i) => i.primary_goal_id === g.id);
              const gProgsDirect = progs.filter((x) => x.primary_goal_id === g.id && !x.initiative_id);
              const gCampsDirect = camps.filter((c) => c.primary_goal_id === g.id && !c.initiative_id);
              const total = gInits.length + gProgsDirect.length + gCampsDirect.length;
              const isOpen = openGoals.has(g.id);
              return (
                <div key={g.id} className="mb-2 rounded-lg border border-sand/40 bg-white">
                  <button type="button" onClick={() => setOpenGoals((s) => toggle(s, g.id))}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-2.5 py-2 text-start">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-charcoal/30" />
                              : <ChevronRight className={`h-3.5 w-3.5 text-charcoal/30 ${isAr ? 'rotate-180' : ''}`} />}
                      <span className="truncate text-[12.5px] font-medium text-charcoal">{g.name_ar}</span>
                      <span className="shrink-0 rounded-full border border-sand/60 px-1.5 text-[10px] text-charcoal/50">
                        {lbl(GOAL_CLASS_LABEL, g.goal_class, isAr)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-charcoal/45">
                      {g.target_value != null ? `${isAr ? 'مستهدف' : 'target'} ${g.target_value.toLocaleString()}` : dash}
                      {' · '}{total} {isAr ? 'عنصر' : 'items'}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="space-y-2 border-t border-sand/40 p-2.5">
                      {total === 0 && (
                        <EmptyHint>
                          {isAr ? 'هدف بلا تنفيذ — لا مبادرة ولا برنامج ولا حملة'
                                : 'A goal with no execution — no initiative, program or campaign'}
                        </EmptyHint>
                      )}

                      {gInits.map((i) => {
                        const iProgs = progs.filter((x) => x.initiative_id === i.id);
                        const iCamps = camps.filter((c) => c.initiative_id === i.id);
                        const iOpen = openInits.has(i.id);
                        return (
                          <Node key={i.id}>
                            <div className="rounded-lg border border-sand/40">
                              <div className="flex items-stretch">
                                <button type="button" onClick={() => setOpenInits((s) => toggle(s, i.id))}
                                  className="px-2 text-charcoal/30 hover:text-charcoal/60">
                                  {iOpen ? <ChevronDown className="h-3.5 w-3.5" />
                                         : <ChevronRight className={`h-3.5 w-3.5 ${isAr ? 'rotate-180' : ''}`} />}
                                </button>
                                <div className="flex-1 p-1">
                                  <InitiativeCard i={i} ctx={ctx} programs={iProgs} campaigns={iCamps} />
                                </div>
                              </div>
                              {iOpen && (
                                <div className="space-y-2 border-t border-sand/30 p-2">
                                  {iProgs.length === 0 && iCamps.length === 0 && (
                                    <EmptyHint>
                                      {isAr ? 'مبادرة بلا تنفيذ' : 'An initiative with no execution'}
                                    </EmptyHint>
                                  )}
                                  {iProgs.map((x) => (
                                    <Node key={x.id} depth={1}>
                                      <ProgramCard p={x} ctx={ctx} output={outputByProgram.get(x.id) ?? []} />
                                    </Node>))}
                                  {iCamps.map((c) => (
                                    <Node key={c.id} depth={1}><CampaignCard c={c} ctx={ctx} /></Node>))}
                                </div>
                              )}
                            </div>
                          </Node>
                        );
                      })}

                      {/* Work attached straight to the goal. Hiding it because
                          it has no initiative is how real campaigns disappear. */}
                      {(gProgsDirect.length > 0 || gCampsDirect.length > 0) && (
                        <div className="rounded-lg border border-dashed border-sand/60 p-2">
                          <p className="mb-1.5 text-[11px] text-charcoal/45">
                            {isAr ? 'مرتبط بالهدف مباشرة (بلا مبادرة)' : 'Attached directly to the goal (no initiative)'}
                          </p>
                          <div className="space-y-2">
                            {gProgsDirect.map((x) => (
                              <ProgramCard key={x.id} p={x} ctx={ctx} output={outputByProgram.get(x.id) ?? []} />))}
                            {gCampsDirect.map((c) => <CampaignCard key={c.id} c={c} ctx={ctx} />)}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      <UnattachedGroup isAr={isAr} ctx={ctx} inits={inits} progs={progs} camps={camps}
        outputByProgram={outputByProgram} />
    </div>
  );
}

/** Records with no plan or no goal have nowhere to sit in the hierarchy. They
 *  are shown anyway, in their own group, because a record you cannot see is a
 *  record nobody will ever fix. */
function UnattachedGroup({ isAr, ctx, inits, progs, camps, outputByProgram }: {
  isAr: boolean; ctx: CardCtx; inits: Initiative[]; progs: Program[]; camps: Campaign[];
  outputByProgram: Map<string, Array<{ created_at: string }>>;
}) {
  const loose = {
    inits: inits.filter((i) => !i.plan_id || !i.primary_goal_id),
    progs: progs.filter((p) => !p.plan_id || !p.primary_goal_id),
    camps: camps.filter((c) => !c.plan_id || !c.primary_goal_id),
  };
  const n = loose.inits.length + loose.progs.length + loose.camps.length;
  if (n === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-amber-900">
        <AlertTriangle className="h-3.5 w-3.5" />
        {isAr ? `خارج الهيكل — ${n} سجل بلا خطة أو بلا هدف رئيسي`
              : `Outside the hierarchy — ${n} record(s) with no plan or no primary goal`}
      </p>
      <div className="space-y-2">
        {loose.inits.map((i) => (
          <InitiativeCard key={i.id} i={i} ctx={ctx}
            programs={progs.filter((p) => p.initiative_id === i.id)}
            campaigns={camps.filter((c) => c.initiative_id === i.id)} />))}
        {loose.progs.map((p) => (
          <ProgramCard key={p.id} p={p} ctx={ctx} output={outputByProgram.get(p.id) ?? []} />))}
        {loose.camps.map((c) => <CampaignCard key={c.id} c={c} ctx={ctx} />)}
      </div>
    </div>
  );
}

// ── List ───────────────────────────────────────────────────────────────────

function ListView({ filter, isAr, ctx, inits, progs, organic, paid, camps, outputByProgram }: {
  filter: ListFilter; isAr: boolean; ctx: CardCtx;
  inits: Initiative[]; progs: Program[]; organic: Campaign[]; paid: Campaign[];
  camps: Campaign[]; outputByProgram: Map<string, Array<{ created_at: string }>>;
}) {
  if (filter === 'initiatives') {
    return inits.length === 0 ? <EmptyHint>{isAr ? 'لا مبادرات' : 'No initiatives'}</EmptyHint> : (
      <div className="space-y-2">
        {inits.map((i) => (
          <InitiativeCard key={i.id} i={i} ctx={ctx}
            programs={progs.filter((p) => p.initiative_id === i.id)}
            campaigns={camps.filter((c) => c.initiative_id === i.id)} />))}
      </div>);
  }
  if (filter === 'programs') {
    return progs.length === 0 ? <EmptyHint>{isAr ? 'لا برامج' : 'No programs'}</EmptyHint> : (
      <div className="space-y-2">
        {progs.map((p) => (
          <ProgramCard key={p.id} p={p} ctx={ctx} output={outputByProgram.get(p.id) ?? []} />))}
      </div>);
  }
  const rows = filter === 'organic' ? organic : paid;
  // A campaign whose type was never set belongs to neither list. It is not
  // silently folded into "organic" — that would assert a classification nobody
  // made — so the list says where it went instead.
  const unset = camps.filter((c) => (c.campaign_class ?? null) === null).length;
  return (
    <>
      {rows.length === 0
        ? <EmptyHint>{isAr ? 'لا حملات' : 'No campaigns'}</EmptyHint>
        : <div className="space-y-2">{rows.map((c) => <CampaignCard key={c.id} c={c} ctx={ctx} />)}</div>}
      {unset > 0 && (
        <div className="mt-2">
          <CaveatStrip>
            {isAr ? `${unset} حملة لم يُحدَّد نوعها بعد، فلا تظهر في العضوية ولا المدفوعة — تجدها في "بحاجة للاستكمال".`
                  : `${unset} campaign(s) have no type set, so they appear in neither list — find them under Needs attention.`}
          </CaveatStrip>
        </div>
      )}
    </>
  );
}

// ── Needs attention ────────────────────────────────────────────────────────

const FILTER_ORDER: AttentionKey[] = [
  'class_missing', 'plan_missing', 'goal_missing', 'owner_missing',
  'dates_missing', 'commitment_missing', 'deliverables_missing', 'no_execution',
];

function NeedsAttention({
  isAr, ctx, flagged, counts, selected, onSelect, inits, progs, camps, outputByProgram,
}: {
  isAr: boolean; ctx: CardCtx;
  flagged: Array<{ kind: PortfolioKind; id: string; flags: AttentionKey[] }>;
  counts: Map<AttentionKey, number>;
  selected: AttentionKey | 'all'; onSelect: (k: AttentionKey | 'all') => void;
  inits: Initiative[]; progs: Program[]; camps: Campaign[];
  outputByProgram: Map<string, Array<{ created_at: string }>>;
}) {
  const match = flagged.filter((r) =>
    r.flags.length > 0 && (selected === 'all' || r.flags.includes(selected)));
  const ids = new Set(match.map((r) => `${r.kind}:${r.id}`));
  const total = flagged.filter((r) => r.flags.length > 0).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onSelect('all')}
          className={`rounded-lg px-2.5 py-1 text-[12px] ${
            selected === 'all' ? 'bg-charcoal/85 text-white' : 'text-charcoal/60 hover:bg-cream-light'}`}>
          {isAr ? 'الكل' : 'All'}
          <span className={`ms-1 rounded-full px-1.5 text-[10px] tabular-nums ${
            selected === 'all' ? 'bg-white/25' : 'bg-charcoal/10'}`}>{total}</span>
        </button>
        {FILTER_ORDER.map((k) => {
          const n = counts.get(k) ?? 0;
          return (
            <button key={k} type="button" disabled={n === 0} onClick={() => onSelect(k)}
              className={`rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-35 ${
                selected === k ? 'bg-amber-600 text-white' : 'text-charcoal/60 hover:bg-cream-light'}`}>
              {lbl(ATTENTION_FILTER_LABEL, k, isAr)}
              <span className={`ms-1 rounded-full px-1.5 text-[10px] tabular-nums ${
                selected === k ? 'bg-white/25' : 'bg-charcoal/10'}`}>{n}</span>
            </button>);
        })}
      </div>

      {match.length === 0 ? (
        <EmptyHint>
          {total === 0
            ? (isAr ? 'كل سجلات المحفظة مكتملة' : 'Every portfolio record is complete')
            : (isAr ? 'لا سجلات تطابق هذا الفلتر' : 'No records match this filter')}
        </EmptyHint>
      ) : (
        <div className="space-y-2">
          {inits.filter((i) => ids.has(`initiative:${i.id}`)).map((i) => (
            <InitiativeCard key={i.id} i={i} ctx={ctx}
              programs={progs.filter((p) => p.initiative_id === i.id)}
              campaigns={camps.filter((c) => c.initiative_id === i.id)} />))}
          {progs.filter((p) => ids.has(`program:${p.id}`)).map((p) => (
            <ProgramCard key={p.id} p={p} ctx={ctx} output={outputByProgram.get(p.id) ?? []} />))}
          {camps.filter((c) => ids.has(`campaign:${c.id}`)).map((c) => (
            <CampaignCard key={c.id} c={c} ctx={ctx} />))}
        </div>
      )}
    </div>
  );
}
