/**
 * One portfolio record, open and editable.
 *
 * The portfolio used to be create-only: you could make an initiative and then
 * never see it again except as a line of text. Everything here is the same
 * record the Campaigns section edits, through the same API actions and the same
 * validation — there is no second copy of a campaign anywhere.
 *
 * Three things this screen refuses to do:
 *
 *  - It does not offer a code field. Codes are issued by the database.
 *  - It does not offer Delete. The database refuses to delete a record that
 *    still carries content, ads, publications or measurements, so offering the
 *    button would only produce a rejection; Archive is the honest action.
 *  - It does not fabricate a status transition the database would reject. The
 *    completion checklist is shown from mkt_*_missing_requirements, which is the
 *    same list the CHECK constraints enforce.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Check, ExternalLink, AlertTriangle } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Spinner, EmptyHint, Stat, CaveatStrip, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPortfolioDetail, saveInitiative, saveProgram, classifyCampaign,
  setSecondaryGoals, setCampaignProjects, commitmentSentence,
  CADENCE_UNIT_LABEL, FUNNEL_STAGE_LABEL, BUDGET_KIND_LABEL, CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_CLASS_LABEL, INITIATIVE_STATUS_LABEL, PROGRAM_STATUS_LABEL, DECISION_LABEL,
  GOAL_CLASS_LABEL,
  type PortfolioKind, type PortfolioDetail, type PlanRef, type MktGoal, type Initiative,
} from '@/lib/marketingMgmt/v2';
import {
  saveCampaign, fetchCampaignNextStatuses, STATUS_LABEL,
  type ContentStatus, type NextStatus,
} from '@/lib/marketingMgmt/client';
import { useProjectOptions } from '@/lib/marketingMgmt/projects';
import { PaidTreePanel } from '../PaidTreePanel';
import { CampaignStatusBar } from './StatusBar';
import {
  Drawer, Field, FIELD, MissingChips, Pill, ClassMissingBadge, err, dash, ownerName,
} from './shared';

/** Statuses an INITIATIVE or PROGRAM may move to. Neither has a transition
 *  table, so this is a UI convention; the CHECK constraints still decide whether
 *  'active' is reachable, and a rejection is surfaced as the completion
 *  checklist rather than a raw error.
 *
 *  Campaigns are NOT driven from here — they have a real machine
 *  (mkt_campaign_status_allowed) and go through CampaignStatusBar. The campaign
 *  row below is dead but kept because PortfolioKind requires all three keys. */
const NEXT_STATUS: Record<PortfolioKind, string[]> = {
  campaign:   [],
  initiative: ['proposed', 'active', 'paused', 'completed', 'cancelled'],
  program:    ['draft', 'active', 'paused', 'retired'],
};
const STATUS_MAP: Record<PortfolioKind, Record<string, { ar: string; en: string }>> = {
  campaign: CAMPAIGN_STATUS_LABEL,
  initiative: INITIATIVE_STATUS_LABEL,
  program: PROGRAM_STATUS_LABEL,
};

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function RecordDrawer({
  target, isAr, plans, goals, initiatives, onClose, onChanged, onError, onToast,
}: {
  target: { kind: PortfolioKind; id: string } | null;
  isAr: boolean; plans: PlanRef[]; goals: MktGoal[]; initiatives: Initiative[];
  onClose: () => void; onChanged: () => void;
  onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const projects = useProjectOptions();
  const [d, setD] = useState<PortfolioDetail | null>(null);
  const [f, setF] = useState<Record<string, unknown>>({});
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [secondary, setSecondary] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showPaid, setShowPaid] = useState(false);
  const [classifyTo, setClassifyTo] = useState<'organic' | 'paid' | ''>('');

  const load = useCallback(() => {
    if (!target) { setD(null); return; }
    setD(null);
    fetchPortfolioDetail(target.kind, target.id)
      .then((r) => {
        setD(r); setF({ ...r.row });
        setProjectIds(r.projects ?? []);
        setSecondary((r.secondary_goals ?? []).map((s) => s.goal_id));
      })
      .catch((e) => onError(err(e)));
  }, [target, onError]);
  useEffect(load, [load]);

  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  /** Changing the plan clears a goal or initiative that belongs elsewhere —
   *  the same rule the create drawer applies, because the database applies it
   *  to an edit exactly as it does to an insert. */
  const setPlan = (planId: string) => setF((p) => {
    const goalOk = goals.some((g) => g.id === p.primary_goal_id && g.plan_id === planId);
    const initOk = initiatives.some((i) => i.id === p.initiative_id && i.plan_id === planId);
    return {
      ...p, plan_id: planId || null,
      primary_goal_id: goalOk ? p.primary_goal_id : null,
      initiative_id: initOk ? p.initiative_id : null,
    };
  });

  const planId = typeof f.plan_id === 'string' ? f.plan_id : '';
  const planGoals = useMemo(() => goals.filter((g) => g.plan_id === planId), [goals, planId]);
  const planInits = useMemo(() => initiatives.filter((i) => i.plan_id === planId), [initiatives, planId]);
  const plan = plans.find((p) => p.id === planId) ?? null;

  const kind = target?.kind ?? 'campaign';
  const saveFn = kind === 'initiative' ? saveInitiative : kind === 'program' ? saveProgram : saveCampaign;

  /** The campaign status machine's legal moves, from the database. Fetched
   *  separately because portfolio_detail is shared by all three kinds and only
   *  campaigns have a transition table. */
  const [nextStatuses, setNextStatuses] = useState<NextStatus[]>([]);
  useEffect(() => {
    if (!target || target.kind !== 'campaign') { setNextStatuses([]); return; }
    let live = true;
    fetchCampaignNextStatuses(target.id)
      .then((r) => { if (live) setNextStatuses(r.next_statuses); })
      .catch((e) => onError(err(e)));
    return () => { live = false; };
  }, [target, onError]);

  const persist = async (patch: Record<string, unknown>, toast: string) => {
    if (!target) return;
    setBusy(true);
    try {
      await saveFn(patch, target.id);
      onToast(toast); load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const saveEdits = () => {
    const base = kind === 'campaign' ? {
      name_ar: f.name_ar, name_en: f.name_en ?? null,
      plan_id: f.plan_id ?? null, primary_goal_id: f.primary_goal_id ?? null,
      initiative_id: f.initiative_id ?? null, program_id: f.program_id ?? null,
      start_date: f.start_date ?? null, end_date: f.end_date ?? null,
      period_override_reason: f.period_override_reason ?? null,
      objective: f.objective ?? null, funnel_stage: f.funnel_stage ?? null,
      target_audience: f.target_audience ?? null, main_message: f.main_message ?? null,
      offer: f.offer ?? null, cta: f.cta ?? null, landing_url: f.landing_url ?? null,
      positioning: f.positioning ?? null,
      budget: num(f.budget), budget_kind: f.budget_kind ?? null,
      conversion_objective: f.conversion_objective ?? null,
      tracking_template: f.tracking_template ?? null,
      priority: f.priority, owner_user_id: f.owner_user_id ?? null,
      target_leads: num(f.target_leads), target_appointments: num(f.target_appointments),
      target_sales: num(f.target_sales), target_revenue: num(f.target_revenue),
      lessons: f.lessons ?? null,
    } : kind === 'program' ? {
      name_ar: f.name_ar, name_en: f.name_en ?? null,
      plan_id: f.plan_id ?? null, initiative_id: f.initiative_id ?? null,
      primary_goal_id: f.primary_goal_id ?? null,
      purpose: f.purpose ?? null, target_audience: f.target_audience ?? null,
      commitment_count: num(f.commitment_count), commitment_unit: f.commitment_unit ?? null,
      output_type: f.output_type ?? null, every_n_periods: num(f.every_n_periods),
      review_frequency: f.review_frequency ?? null, start_date: f.start_date ?? null,
      owner_user_id: f.owner_user_id ?? null, lessons: f.lessons ?? null,
    } : {
      name_ar: f.name_ar, name_en: f.name_en ?? null,
      plan_id: f.plan_id ?? null, primary_goal_id: f.primary_goal_id ?? null,
      problem_or_opportunity: f.problem_or_opportunity ?? null,
      hypothesis: f.hypothesis ?? null,
      expected_contribution: f.expected_contribution ?? null,
      actual_contribution: f.actual_contribution ?? null,
      scope: f.scope ?? null,
      start_date: f.start_date ?? null, review_date: f.review_date ?? null,
      end_date: f.end_date ?? null, budget: num(f.budget),
      owner_user_id: f.owner_user_id ?? null, lessons: f.lessons ?? null,
    };
    void persist(base, isAr ? 'حُفظت التعديلات' : 'Saved');
  };

  const move = (status: string) =>
    void persist({ status }, isAr ? 'حُدّثت الحالة' : 'Status updated');

  const archive = () =>
    void persist({ archived_at: new Date().toISOString() }, isAr ? 'أُرشف السجل' : 'Archived');

  const classify = async () => {
    if (!target || !classifyTo) return;
    setBusy(true);
    try {
      await classifyCampaign(target.id, classifyTo, {
        plan_id: planId || undefined,
        goal_id: typeof f.primary_goal_id === 'string' ? f.primary_goal_id : undefined,
      });
      onToast(isAr ? 'صُنِّفت الحملة' : 'Campaign classified');
      setClassifyTo(''); load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const saveLinks = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await setSecondaryGoals(target.kind, target.id, secondary);
      if (target.kind === 'campaign') await setCampaignProjects(target.id, projectIds);
      onToast(isAr ? 'حُفظت الروابط' : 'Links saved'); load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (!target) return null;

  const title = d ? `${kind === 'campaign' ? `${text(d.row.code)} · ` : ''}${text(d.row.name_ar)}`
                  : (isAr ? 'جارٍ التحميل…' : 'Loading…');
  const status = text(f.status);
  const classNow = kind === 'campaign' ? (d?.row.campaign_class as string | null ?? null) : null;
  const commitment = kind === 'program' ? commitmentSentence({
    commitment_count: num(f.commitment_count), commitment_unit: text(f.commitment_unit) || null,
    output_type: text(f.output_type) || null, every_n_periods: num(f.every_n_periods),
  }, isAr) : null;

  return (
    <Drawer open isAr={isAr} onClose={onClose} title={title}
      subtitle={plan ? `${plan.name_ar} · ${fmtDate(plan.period_start, isAr)} → ${fmtDate(plan.period_end, isAr)}`
                     : (isAr ? 'بلا خطة' : 'No plan')}
      footer={d && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={saveEdits} disabled={busy}>{isAr ? 'حفظ' : 'Save'}</Button>
          <button type="button" onClick={archive} disabled={busy}
            className="inline-flex items-center gap-1 text-[12px] text-charcoal/50 hover:text-red-600 disabled:opacity-40">
            <Archive className="h-3.5 w-3.5" />{isAr ? 'أرشفة' : 'Archive'}
          </button>
          <span className="text-[11px] text-charcoal/40">
            {isAr ? 'الحذف غير متاح لسجل مرتبط بمحتوى أو إعلانات' : 'Records with content or ads cannot be deleted'}
          </span>
        </div>
      )}>
      {!d ? <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /> : (
        <div className="space-y-4">
          <MissingChips missing={d.missing} isAr={isAr} />

          {/* ── classification: the two states, kept apart ── */}
          {kind === 'campaign' && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sand/50 bg-white p-2.5">
              <span className="text-[11.5px] font-medium text-charcoal/55">
                {isAr ? 'النوع' : 'Type'}
              </span>
              {classNow
                ? <Pill map={CAMPAIGN_CLASS_LABEL} value={classNow} isAr={isAr}
                    tone={classNow === 'paid' ? 'warn' : 'neutral'} />
                : <ClassMissingBadge isAr={isAr} />}
              {!classNow && (
                <>
                  <select value={classifyTo} onChange={(e) => setClassifyTo(e.target.value as 'organic' | 'paid' | '')}
                    className={`${FIELD} max-w-[160px]`}>
                    <option value="">{isAr ? '— حدّد النوع —' : '— set the type —'}</option>
                    <option value="organic">{lbl(CAMPAIGN_CLASS_LABEL, 'organic', isAr)}</option>
                    <option value="paid">{lbl(CAMPAIGN_CLASS_LABEL, 'paid', isAr)}</option>
                  </select>
                  <Button variant="secondary" onClick={classify} disabled={busy || !classifyTo}>
                    <Check className="h-4 w-4" />{isAr ? 'تصنيف' : 'Classify'}
                  </Button>
                </>
              )}
            </div>
          )}

          {/* ── status ── */}
          <div className="rounded-xl border border-sand/50 bg-white p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11.5px] font-medium text-charcoal/55">{isAr ? 'الحالة' : 'Status'}</span>
              <Pill map={STATUS_MAP[kind]} value={status} isAr={isAr}
                tone={status === 'active' ? 'good' : 'neutral'} />
            </div>
            {/* A campaign's status is a MACHINE, and the legal moves come from
                the same function the rejecting trigger consults — so this cannot
                offer draft → completed, and cannot route through the generic
                save (which no longer accepts `status` at all, and would have
                made every one of these buttons a silent no-op with a success
                toast). Initiatives and programs still have no transition table,
                so they keep the UI convention below. */}
            {kind === 'campaign' ? (
              <CampaignStatusBar campaignId={target.id} status={status} next={nextStatuses}
                isAr={isAr} onChanged={() => { load(); onChanged(); }}
                onError={onError} onToast={onToast} />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {NEXT_STATUS[kind].filter((s) => s !== status).map((s) => (
                  <button key={s} type="button" disabled={busy} onClick={() => move(s)}
                    className="rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] text-charcoal/70 hover:border-copper/50 disabled:opacity-40">
                    → {lbl(STATUS_MAP[kind], s, isAr)}
                  </button>))}
              </div>
            )}
            {kind !== 'campaign' && d.missing.length > 0 && (
              <p className="mt-1.5 text-[11px] text-amber-700">
                {isAr ? 'التفعيل مرفوض من قاعدة البيانات حتى تكتمل القائمة أعلاه.'
                      : 'The database will refuse activation until the checklist above is complete.'}
              </p>
            )}
          </div>

          {/* ── context ── */}
          <section className="grid gap-2.5 sm:grid-cols-2">
            <Field label={isAr ? 'الاسم' : 'Name'} span="sm:col-span-2">
              <input value={text(f.name_ar)} onChange={(e) => set('name_ar', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'الخطة' : 'Plan'}>
              <select value={planId} onChange={(e) => setPlan(e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— بلا خطة —' : '— none —'}</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
              </select>
            </Field>
            <Field label={isAr ? 'الهدف الرئيسي' : 'Primary goal'}>
              <select value={text(f.primary_goal_id)} disabled={!planId}
                onChange={(e) => set('primary_goal_id', e.target.value || null)} className={FIELD}>
                <option value="">{isAr ? '— بلا هدف —' : '— none —'}</option>
                {planGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name_ar} · {lbl(GOAL_CLASS_LABEL, g.goal_class, isAr)}
                  </option>))}
              </select>
            </Field>
            {kind !== 'initiative' && (
              <Field label={isAr ? 'المبادرة' : 'Initiative'}>
                <select value={text(f.initiative_id)} disabled={!planId}
                  onChange={(e) => set('initiative_id', e.target.value || null)} className={FIELD}>
                  <option value="">{isAr ? '— بلا مبادرة —' : '— none —'}</option>
                  {planInits.map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}
                </select>
              </Field>
            )}
            <Field label={isAr ? 'المسؤول' : 'Owner'}>
              <select value={text(f.owner_user_id)} onChange={(e) => set('owner_user_id', e.target.value || null)} className={FIELD}>
                <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
              </select>
            </Field>
          </section>

          {/* ── kind-specific body ── */}
          {kind === 'initiative' && (
            <section className="grid gap-2.5 sm:grid-cols-2">
              <Field label={isAr ? 'الفرصة أو المشكلة' : 'Opportunity or problem'} span="sm:col-span-2">
                <textarea rows={2} value={text(f.problem_or_opportunity)}
                  onChange={(e) => set('problem_or_opportunity', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'الفرضية' : 'Hypothesis'} span="sm:col-span-2">
                <textarea rows={2} value={text(f.hypothesis)} onChange={(e) => set('hypothesis', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'النطاق' : 'Scope'} span="sm:col-span-2">
                <input value={text(f.scope)} onChange={(e) => set('scope', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'المساهمة المتوقعة' : 'Expected contribution'}>
                <input value={text(f.expected_contribution)} onChange={(e) => set('expected_contribution', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'المساهمة الفعلية' : 'Actual contribution'}>
                <input value={text(f.actual_contribution)} onChange={(e) => set('actual_contribution', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'البداية' : 'Start'}>
                <input type="date" value={text(f.start_date)} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'موعد المراجعة' : 'Review date'}>
                <input type="date" value={text(f.review_date)} onChange={(e) => set('review_date', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'النهاية (اختياري)' : 'End (optional)'}>
                <input type="date" value={text(f.end_date)} onChange={(e) => set('end_date', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'الميزانية' : 'Budget'}>
                <input type="number" min="0" value={text(f.budget)} onChange={(e) => set('budget', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
              </Field>
            </section>
          )}

          {kind === 'program' && (
            <section className="grid gap-2.5 sm:grid-cols-2">
              <Field label={isAr ? 'الغرض' : 'Purpose'} span="sm:col-span-2">
                <textarea rows={2} value={text(f.purpose)} onChange={(e) => set('purpose', e.target.value)} className={FIELD} />
              </Field>
              <div className="sm:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
                  {isAr ? 'الالتزام المتكرر' : 'Recurring commitment'}
                </span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field label={isAr ? 'العدد' : 'How many'}>
                    <input type="number" min="1" value={text(f.commitment_count)}
                      onChange={(e) => set('commitment_count', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'نوع المخرج' : 'Of what'}>
                    <input value={text(f.output_type)} onChange={(e) => set('output_type', e.target.value)} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'كل كم' : 'Every'}>
                    <input type="number" min="1" value={text(f.every_n_periods)}
                      onChange={(e) => set('every_n_periods', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'الفترة' : 'Period'}>
                    <select value={text(f.commitment_unit)} onChange={(e) => set('commitment_unit', e.target.value || null)} className={FIELD}>
                      <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                      {Object.keys(CADENCE_UNIT_LABEL).map((u) => (
                        <option key={u} value={u}>{lbl(CADENCE_UNIT_LABEL, u, isAr)}</option>))}
                    </select>
                  </Field>
                </div>
                {commitment && <p className="mt-1 text-[11.5px] text-copper">{commitment}</p>}
              </div>
              <Field label={isAr ? 'الجمهور' : 'Audience'}>
                <input value={text(f.target_audience)} onChange={(e) => set('target_audience', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'دورية المراجعة' : 'Review frequency'}>
                <input value={text(f.review_frequency)} onChange={(e) => set('review_frequency', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'البداية' : 'Start'}>
                <input type="date" value={text(f.start_date)} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
              </Field>
              <p className="self-end text-[11px] text-charcoal/45">
                {isAr ? 'لا تاريخ انتهاء — البرنامج مستمر.' : 'No end date — a program is ongoing.'}
              </p>
              <ProgramDelivery detail={d} isAr={isAr} />
            </section>
          )}

          {kind === 'campaign' && (
            <section className="grid gap-2.5 sm:grid-cols-2">
              <Field label={isAr ? 'من' : 'From'}>
                <input type="date" value={text(f.start_date)} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'إلى' : 'To'}>
                <input type="date" value={text(f.end_date)} onChange={(e) => set('end_date', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'سبب الخروج عن فترة الخطة' : 'Reason for running outside the plan period'} span="sm:col-span-2"
                hint={text(d.row.period_override_at)
                  ? `${isAr ? 'سُجِّل' : 'recorded'} ${fmtDate(text(d.row.period_override_at), isAr)}`
                  : undefined}>
                <input value={text(f.period_override_reason)}
                  onChange={(e) => set('period_override_reason', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'الهدف من الحملة' : 'Objective'} span="sm:col-span-2">
                <input value={text(f.objective)} onChange={(e) => set('objective', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'مرحلة القمع' : 'Funnel stage'}>
                <select value={text(f.funnel_stage)} onChange={(e) => set('funnel_stage', e.target.value || null)} className={FIELD}>
                  <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                  {Object.keys(FUNNEL_STAGE_LABEL).map((s) => (
                    <option key={s} value={s}>{lbl(FUNNEL_STAGE_LABEL, s, isAr)}</option>))}
                </select>
              </Field>
              <Field label={isAr ? 'الجمهور' : 'Audience'}>
                <input value={text(f.target_audience)} onChange={(e) => set('target_audience', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'الرسالة الرئيسية' : 'Main message'} span="sm:col-span-2">
                <textarea rows={2} value={text(f.main_message)} onChange={(e) => set('main_message', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'العرض' : 'Offer'}>
                <input value={text(f.offer)} onChange={(e) => set('offer', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'دعوة الإجراء' : 'CTA'}>
                <input value={text(f.cta)} onChange={(e) => set('cta', e.target.value)} className={FIELD} />
              </Field>
              <Field label={isAr ? 'الوجهة' : 'Destination'} span="sm:col-span-2">
                <input value={text(f.landing_url)} onChange={(e) => set('landing_url', e.target.value)} className={FIELD} />
              </Field>

              {classNow === 'paid' && (<>
                <Field label={isAr ? 'الميزانية' : 'Budget'}>
                  <input type="number" min="0" value={text(f.budget)}
                    onChange={(e) => set('budget', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                </Field>
                <Field label={isAr ? 'نوع الميزانية' : 'Budget type'}>
                  <select value={text(f.budget_kind)} onChange={(e) => set('budget_kind', e.target.value || null)} className={FIELD}>
                    <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                    {Object.keys(BUDGET_KIND_LABEL).map((b) => (
                      <option key={b} value={b}>{lbl(BUDGET_KIND_LABEL, b, isAr)}</option>))}
                  </select>
                </Field>
                <Field label={isAr ? 'هدف التحويل' : 'Conversion objective'}>
                  <input value={text(f.conversion_objective)} onChange={(e) => set('conversion_objective', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'التتبّع' : 'Tracking'}>
                  <input value={text(f.tracking_template)} onChange={(e) => set('tracking_template', e.target.value)} className={FIELD} />
                </Field>
              </>)}

              <div className="sm:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
                  {isAr ? 'النتائج المستهدفة' : 'Target results'}
                </span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field label={isAr ? 'عملاء' : 'Leads'}>
                    <input type="number" min="0" value={text(f.target_leads)}
                      onChange={(e) => set('target_leads', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'مواعيد' : 'Appointments'}>
                    <input type="number" min="0" value={text(f.target_appointments)}
                      onChange={(e) => set('target_appointments', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'مبيعات' : 'Sales'}>
                    <input type="number" min="0" value={text(f.target_sales)}
                      onChange={(e) => set('target_sales', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                  <Field label={isAr ? 'إيراد' : 'Revenue'}>
                    <input type="number" min="0" value={text(f.target_revenue)}
                      onChange={(e) => set('target_revenue', e.target.value === '' ? null : Number(e.target.value))} className={FIELD} />
                  </Field>
                </div>
              </div>

              <Field label={isAr ? 'المشاريع' : 'Projects'} span="sm:col-span-2"
                hint={isAr ? 'المطوّر يُشتق من المشروع' : 'The developer is derived from the project'}>
                <select multiple value={projectIds} size={Math.min(5, Math.max(3, projects.length))}
                  onChange={(e) => setProjectIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                  className={`${FIELD} h-auto`}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.developer ? ` — ${p.developer}` : ''}</option>))}
                </select>
              </Field>
            </section>
          )}

          {/* ── secondary goals + links ── */}
          <section className="rounded-xl border border-sand/50 bg-white p-2.5">
            <Field label={isAr ? 'أهداف ثانوية' : 'Secondary goals'}
              hint={isAr ? 'أهداف تساهم فيها هذه العملية دون أن تكون هدفها الرئيسي'
                         : 'Goals this work contributes to without being its primary goal'}>
              <select multiple value={secondary} size={Math.min(5, Math.max(3, planGoals.length || 3))}
                onChange={(e) => setSecondary(Array.from(e.target.selectedOptions, (o) => o.value))}
                className={`${FIELD} h-auto`} disabled={!planId}>
                {planGoals.filter((g) => g.id !== f.primary_goal_id).map((g) => (
                  <option key={g.id} value={g.id}>{g.name_ar}</option>))}
              </select>
            </Field>
            <div className="mt-2">
              <Button variant="secondary" onClick={saveLinks} disabled={busy}>
                {isAr ? 'حفظ الروابط' : 'Save links'}
              </Button>
            </div>
          </section>

          {/* ── related records ── */}
          {(d.programs?.length || d.campaigns?.length || d.content?.length) ? (
            <section className="rounded-xl border border-sand/50 bg-white p-2.5">
              <h4 className="mb-1.5 text-[12px] font-semibold text-charcoal/70">
                {isAr ? 'سجلات مرتبطة' : 'Related records'}
              </h4>
              <ul className="space-y-1 text-[12px]">
                {(d.programs ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-charcoal/75">{p.name_ar}</span>
                    <Pill map={PROGRAM_STATUS_LABEL} value={p.status} isAr={isAr} />
                  </li>))}
                {(d.campaigns ?? []).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-charcoal/75">{c.code} · {c.name_ar}</span>
                    <Pill map={CAMPAIGN_STATUS_LABEL} value={c.status} isAr={isAr} />
                  </li>))}
                {(d.content ?? []).slice(0, 12).map((c) => (
                  <li key={String(c.id)} className="flex items-center justify-between gap-2">
                    <span className="truncate text-charcoal/75">
                      {text(c.content_number)} {text(c.title)}
                    </span>
                    <span className="shrink-0 text-[11px] text-charcoal/45">
                      {lbl(STATUS_LABEL as Record<string, { ar: string; en: string }>, text(c.status) as ContentStatus, isAr)}
                    </span>
                  </li>))}
              </ul>
              {(d.content?.length ?? 0) > 12 && (
                <p className="mt-1 text-[11px] text-charcoal/45">
                  {isAr ? `و${(d.content!.length - 12)} أخرى` : `and ${d.content!.length - 12} more`}
                </p>
              )}
            </section>
          ) : null}

          {/* ── results ── */}
          {kind === 'campaign' && (
            <section className="rounded-xl border border-sand/50 bg-white p-2.5">
              <h4 className="mb-1.5 text-[12px] font-semibold text-charcoal/70">
                {isAr ? 'النتائج' : 'Results'}
              </h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label={isAr ? 'محتوى مرتبط' : 'Linked content'} value={d.content?.length ?? null} />
                <Stat label={isAr ? 'قراءات الأداء' : 'Performance readings'} value={d.performance?.length ?? null} />
                <Stat label={isAr ? 'مستهدف العملاء' : 'Lead target'} value={num(d.row.target_leads)} />
                <Stat label={isAr ? 'الميزانية' : 'Budget'}
                  value={num(d.row.budget) === null ? null : Math.round(num(d.row.budget)!).toLocaleString()} />
              </div>
              {(d.performance?.length ?? 0) === 0 && (
                <p className="mt-1.5 text-[11px] text-charcoal/45">
                  {isAr ? 'لم تُسجَّل أي قراءة أداء بعد — لا يوجد "صفر" هنا، بل لا يوجد قياس.'
                        : 'No performance reading recorded yet — that is not a zero, it is an absence.'}
                </p>
              )}
              {classNow === 'paid' && (
                <div className="mt-2">
                  <button type="button" onClick={() => setShowPaid((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium text-copper hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {showPaid ? (isAr ? 'إخفاء بنية الإعلانات' : 'Hide ad structure')
                              : (isAr ? 'بنية الإعلانات' : 'Ad structure')}
                  </button>
                  {showPaid && (
                    <PaidTreePanel campaignId={target.id} isAr={isAr} onError={onError} onToast={onToast} />
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── reviews and decisions ── */}
          <section className="rounded-xl border border-sand/50 bg-white p-2.5">
            <h4 className="mb-1.5 text-[12px] font-semibold text-charcoal/70">
              {isAr ? 'قرارات المراجعة' : 'Review decisions'}
            </h4>
            {d.decisions.length === 0
              ? <EmptyHint>{isAr ? 'لا قرارات مسجّلة' : 'No decisions recorded'}</EmptyHint>
              : (
                <ul className="divide-y divide-sand/30">
                  {d.decisions.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12px]">
                      <span className="text-charcoal/75">{r.rationale || dash}</span>
                      <Pill map={DECISION_LABEL} value={r.decision} isAr={isAr} tone="warn" />
                    </li>))}
                </ul>
              )}
            <Field label={isAr ? 'الدروس المستفادة' : 'Lessons'}>
              <textarea rows={2} value={text(f.lessons)} onChange={(e) => set('lessons', e.target.value)} className={FIELD} />
            </Field>
          </section>

          <p className="text-[11px] text-charcoal/40">
            {isAr ? 'المسؤول الحالي: ' : 'Current owner: '}
            {ownerName(users, text(d.row.owner_user_id) || null, isAr)}
          </p>
        </div>
      )}
    </Drawer>
  );
}

/** Delivery against the recurring commitment, counted from the content this
 *  program originated in the CURRENT period. A program with no commitment shows
 *  the absence, not a comfortable 0 / 0. */
function ProgramDelivery({ detail, isAr }: { detail: PortfolioDetail; isAr: boolean }) {
  const row = detail.row as Record<string, unknown>;
  const count = num(row.commitment_count);
  const unit = text(row.commitment_unit);
  const every = num(row.every_n_periods) ?? 1;
  if (count == null || !unit) {
    return (
      <div className="sm:col-span-2">
        <CaveatStrip>
          {isAr ? 'بلا التزام متكرر — لا يمكن قياس الإنجاز مقابل شيء.'
                : 'No recurring commitment — there is nothing to measure delivery against.'}
        </CaveatStrip>
      </div>
    );
  }
  const days = { day: 1, week: 7, month: 30, quarter: 91 }[unit] ?? 7;
  const since = new Date(Date.now() - days * every * 24 * 3600 * 1000).toISOString();
  const produced = (detail.content ?? []).filter((c) => String(c.created_at ?? '') >= since).length;
  const short = Math.max(0, count - produced);
  return (
    <div className="sm:col-span-2 grid grid-cols-3 gap-2">
      <Stat label={isAr ? 'المطلوب هذه الفترة' : 'Required this period'} value={count} />
      <Stat label={isAr ? 'أُنجز' : 'Delivered'} value={produced} />
      <Stat label={isAr ? 'المتبقي' : 'Remaining'} value={short}
        tone={short > 0 ? 'muted' : 'default'} />
      {short > 0 && (
        <p className="col-span-3 flex items-center gap-1 text-[11px] text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          {isAr ? 'البرنامج متأخر عن التزامه في هذه الفترة.' : 'This program is behind its commitment this period.'}
        </p>
      )}
    </div>
  );
}
