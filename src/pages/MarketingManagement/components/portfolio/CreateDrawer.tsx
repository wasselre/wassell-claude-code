/**
 * Creating one portfolio object.
 *
 * There are exactly FOUR things you can create — an initiative, a program, an
 * organic campaign, a paid campaign. "Unclassified" is not one of them; it is
 * the state legacy records are in, and offering it as a creatable type is what
 * produced a campaign with no code and no class and a raw Postgres error on the
 * screen.
 *
 * Every type starts from the SAME context step — plan, primary goal, optional
 * initiative, owner — because that is the part that decides whether the thing
 * you are about to make is connected to anything. The type-specific fields come
 * after, and they differ on purpose: a program has a recurring commitment and
 * no end date; a campaign has a date range; a paid campaign has a budget.
 *
 * Changing the plan clears a goal or initiative belonging to a different plan,
 * rather than leaving a stale selection that the database would then reject.
 */
import { useEffect, useMemo, useState } from 'react';
import { Target, Repeat, Megaphone, Coins } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { CaveatStrip } from '@/pages/MarketingIntelligence/components/shared';
import { lbl, PRIORITY_LABEL } from '@/lib/marketingMgmt/labels';
import {
  saveInitiative, saveProgram, setCampaignProjects,
  CADENCE_UNIT_LABEL, FUNNEL_STAGE_LABEL, BUDGET_KIND_LABEL, GOAL_CLASS_LABEL,
  CAMPAIGN_PURPOSE_LABEL,
  commitmentSentence,
  type PlanRef, type MktGoal, type Initiative,
} from '@/lib/marketingMgmt/v2';
import { saveCampaign } from '@/lib/marketingMgmt/client';
import { useOurProjectOptions } from '@/lib/marketingMgmt/projects';
import { Drawer, Field, FIELD, err } from './shared';
import { ProjectPicker } from './ProjectPicker';

export type CreateKind = 'initiative' | 'program' | 'organic' | 'paid';

export const CREATE_KINDS: Array<[CreateKind, string, string, typeof Target]> = [
  ['initiative', 'مبادرة', 'Initiative', Target],
  ['program', 'برنامج', 'Program', Repeat],
  ['organic', 'حملة عضوية', 'Organic campaign', Megaphone],
  ['paid', 'حملة مدفوعة', 'Paid campaign', Coins],
];

export function CreateDrawer({
  kind, isAr, plans, goals, initiatives, defaultPlanId, onClose, onCreated, onError,
}: {
  kind: CreateKind | null; isAr: boolean;
  plans: PlanRef[]; goals: MktGoal[]; initiatives: Initiative[];
  defaultPlanId: string; onClose: () => void;
  onCreated: (kind: CreateKind, id: string) => void;
  onError: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const projects = useOurProjectOptions();
  const [f, setF] = useState<Record<string, string>>({});
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // A fresh drawer starts from the plan the portfolio is already showing, so
  // the common case is one fewer decision.
  useEffect(() => {
    if (kind) { setF({ plan_id: defaultPlanId }); setProjectIds([]); }
  }, [kind, defaultPlanId]);

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  /** Changing the plan invalidates anything chosen under the old one. Keeping
   *  a stale goal here would produce a rejection from the database on submit,
   *  with the user having no idea which field was wrong. */
  const setPlan = (planId: string) => setF((p) => {
    const goalOk = goals.some((g) => g.id === p.primary_goal_id && g.plan_id === planId);
    const initOk = initiatives.some((i) => i.id === p.initiative_id && i.plan_id === planId);
    return {
      ...p, plan_id: planId,
      primary_goal_id: goalOk ? p.primary_goal_id ?? '' : '',
      initiative_id: initOk ? p.initiative_id ?? '' : '',
    };
  });

  const planGoals = useMemo(
    () => goals.filter((g) => g.plan_id === f.plan_id), [goals, f.plan_id]);
  const planInits = useMemo(
    () => initiatives.filter((i) => i.plan_id === f.plan_id), [initiatives, f.plan_id]);
  const plan = plans.find((p) => p.id === f.plan_id) ?? null;

  const isCampaign = kind === 'organic' || kind === 'paid';
  const datesOutside = Boolean(
    isCampaign && plan && f.start_date && f.end_date
    && (f.start_date < plan.period_start || f.end_date > plan.period_end));
  const datesBackwards = Boolean(f.start_date && f.end_date && f.end_date < f.start_date);
  const budgetNegative = Boolean(f.budget && Number(f.budget) < 0);
  const countNotPositive = Boolean(kind === 'program' && f.commitment_count && Number(f.commitment_count) <= 0);
  const everyNotPositive = Boolean(kind === 'program' && f.every_n_periods && Number(f.every_n_periods) <= 0);

  const blocked = !f.name_ar?.trim() || !f.plan_id || !f.primary_goal_id
    || datesBackwards || budgetNegative || countNotPositive || everyNotPositive
    || (datesOutside && !f.period_override_reason?.trim());

  const submit = async () => {
    if (!kind || blocked) return;
    setBusy(true);
    try {
      if (kind === 'initiative') {
        const r = await saveInitiative({
          plan_id: f.plan_id, primary_goal_id: f.primary_goal_id,
          name_ar: (f.name_ar ?? "").trim(), problem_or_opportunity: f.problem || null,
          hypothesis: f.hypothesis || null, expected_contribution: f.expected || null,
          start_date: f.start_date || null, review_date: f.review_date || null,
          budget: f.budget ? Number(f.budget) : null,
          owner_user_id: f.owner || null, status: 'proposed',
        });
        onCreated(kind, r.initiative.id);
      } else if (kind === 'program') {
        const r = await saveProgram({
          plan_id: f.plan_id, initiative_id: f.initiative_id || null,
          primary_goal_id: f.primary_goal_id, name_ar: (f.name_ar ?? "").trim(),
          purpose: f.purpose || null, target_audience: f.audience || null,
          commitment_count: f.commitment_count ? Number(f.commitment_count) : null,
          commitment_unit: f.commitment_unit || null,
          every_n_periods: f.every_n_periods ? Number(f.every_n_periods) : (f.commitment_unit ? 1 : null),
          output_type: f.output_type || null,
          review_frequency: f.review_frequency || null,
          start_date: f.start_date || null,
          owner_user_id: f.owner || null, status: 'draft',
        });
        onCreated(kind, r.program.id);
      } else {
        const cls = kind === 'paid' ? 'paid' : 'organic';
        const r = await saveCampaign({
          // No code: the database issues it. A form that asked for one was
          // asking the user to invent an identifier.
          name_ar: (f.name_ar ?? "").trim(),
          // campaign_class is the organic/paid operating structure, which the
          // drawer already knows from the kind the user picked. Writing that
          // into campaign_type was wrong on its own terms, and since the
          // campaign-lifecycle migration the CHECK constraint refuses
          // 'organic'/'paid' there, which made every create from this drawer
          // fail with 23514. channel_mix is derived from the class by trigger;
          // sending it too would be a second place for the same fact to go stale.
          campaign_class: cls,
          // PURPOSE — a genuinely different question (a launch, an offer,
          // retargeting), now asked as its own field above.
          campaign_type: f.campaign_type || null,
          priority: f.priority || 'normal',
          // status is not sent: it is not in the API's save allow-list (it moves
          // only through campaign_transition) and the column already defaults to
          // 'draft'. Every new campaign therefore starts as a draft.
          plan_id: f.plan_id, primary_goal_id: f.primary_goal_id,
          initiative_id: f.initiative_id || null, program_id: f.program_id || null,
          start_date: f.start_date || null, end_date: f.end_date || null,
          period_override_reason: f.period_override_reason?.trim() || null,
          objective: f.objective || null, funnel_stage: f.funnel_stage || null,
          target_audience: f.audience || null, main_message: f.message || null,
          offer: f.offer || null, cta: f.cta || null, landing_url: f.landing_url || null,
          budget: f.budget ? Number(f.budget) : null,
          budget_kind: f.budget_kind || null,
          conversion_objective: f.conversion || null,
          owner_user_id: f.owner || null,
        });
        if (projectIds.length) await setCampaignProjects(r.campaign.id, projectIds);
        onCreated(kind, r.campaign.id);
      }
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  if (!kind) return null;
  const meta = CREATE_KINDS.find(([k]) => k === kind)!;
  const sentence = kind === 'program'
    ? commitmentSentence({
        commitment_count: f.commitment_count ? Number(f.commitment_count) : null,
        commitment_unit: f.commitment_unit || null,
        output_type: f.output_type || null,
        every_n_periods: f.every_n_periods ? Number(f.every_n_periods) : 1,
      }, isAr)
    : null;

  return (
    <Drawer open isAr={isAr} onClose={onClose}
      title={isAr ? `${meta[1]} جديدة` : `New ${meta[2].toLowerCase()}`}
      subtitle={isAr
        ? 'الخطة والهدف الرئيسي مطلوبان — لا يُنشأ عنصر معلّق بلا سياق'
        : 'A plan and a primary goal are required — nothing is created unattached'}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={busy || blocked}>{isAr ? 'إنشاء' : 'Create'}</Button>
          <button type="button" onClick={onClose} className="text-[12px] text-charcoal/50 hover:text-charcoal">
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          {isCampaign && (
            <span className="text-[11px] text-charcoal/45">
              {isAr ? 'الرمز يُولَّد تلقائياً' : 'The code is generated automatically'}
            </span>
          )}
        </div>
      }>
      <div className="space-y-4">
        {/* ── shared context step ── */}
        <section className="space-y-2 rounded-xl border border-copper/25 bg-copper/5 p-3">
          <h4 className="text-[12px] font-semibold text-charcoal/70">
            {isAr ? 'السياق' : 'Context'}
          </h4>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label={isAr ? 'الاسم' : 'Name'} span="sm:col-span-2">
              <input value={f.name_ar ?? ''} onChange={(e) => set('name_ar', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'الخطة' : 'Plan'}>
              <select value={f.plan_id ?? ''} onChange={(e) => setPlan(e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
              </select>
            </Field>
            <Field label={isAr ? 'الهدف الرئيسي' : 'Primary goal'}
              hint={!f.plan_id ? (isAr ? 'اختر الخطة أولاً' : 'Choose a plan first') : undefined}>
              <select value={f.primary_goal_id ?? ''} disabled={!f.plan_id}
                onChange={(e) => set('primary_goal_id', e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                {planGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name_ar} · {lbl(GOAL_CLASS_LABEL, g.goal_class, isAr)}
                  </option>))}
              </select>
            </Field>
            {kind !== 'initiative' && (
              <Field label={isAr ? 'المبادرة (اختياري)' : 'Initiative (optional)'}>
                <select value={f.initiative_id ?? ''} disabled={!f.plan_id}
                  onChange={(e) => set('initiative_id', e.target.value)} className={FIELD}>
                  <option value="">{isAr ? '— بلا مبادرة —' : '— none —'}</option>
                  {planInits.map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}
                </select>
              </Field>
            )}
            <Field label={isAr ? 'المسؤول' : 'Owner'}>
              <select value={f.owner ?? ''} onChange={(e) => set('owner', e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
              </select>
            </Field>
          </div>
          {f.plan_id && planGoals.length === 0 && (
            <CaveatStrip>
              {isAr ? 'هذه الخطة بلا أهداف. أضف هدفاً من "الاستراتيجية والتخطيط" أولاً.'
                    : 'This plan has no goals yet. Add one from Strategy & Planning first.'}
            </CaveatStrip>
          )}
        </section>

        {/* ── type-specific ── */}
        {kind === 'initiative' && (
          <section className="grid gap-2.5 sm:grid-cols-2">
            <Field label={isAr ? 'الفرصة أو المشكلة' : 'Opportunity or problem'} span="sm:col-span-2">
              <textarea rows={2} value={f.problem ?? ''} onChange={(e) => set('problem', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'الفرضية' : 'Hypothesis'} span="sm:col-span-2">
              <textarea rows={2} value={f.hypothesis ?? ''} onChange={(e) => set('hypothesis', e.target.value)} className={FIELD}
                placeholder={isAr ? 'نعتقد أن… وسنعرف أننا محقّون عندما…' : 'We believe that… and we will know we are right when…'} />
            </Field>
            <Field label={isAr ? 'المساهمة المتوقعة' : 'Expected contribution'} span="sm:col-span-2">
              <input value={f.expected ?? ''} onChange={(e) => set('expected', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'البداية' : 'Start'}>
              <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'موعد المراجعة' : 'Review date'}>
              <input type="date" value={f.review_date ?? ''} onChange={(e) => set('review_date', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'الميزانية' : 'Budget'}>
              <input type="number" min="0" value={f.budget ?? ''} onChange={(e) => set('budget', e.target.value)} className={FIELD} />
            </Field>
          </section>
        )}

        {kind === 'program' && (
          <section className="grid gap-2.5 sm:grid-cols-2">
            <Field label={isAr ? 'الغرض' : 'Purpose'} span="sm:col-span-2">
              <textarea rows={2} value={f.purpose ?? ''} onChange={(e) => set('purpose', e.target.value)} className={FIELD} />
            </Field>
            <div className="sm:col-span-2">
              <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
                {isAr ? 'الالتزام المتكرر' : 'Recurring commitment'}
              </span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Field label={isAr ? 'العدد' : 'How many'}>
                  <input type="number" min="1" value={f.commitment_count ?? ''}
                    onChange={(e) => set('commitment_count', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'نوع المخرج' : 'Of what'}>
                  <input value={f.output_type ?? ''} onChange={(e) => set('output_type', e.target.value)} className={FIELD}
                    placeholder={isAr ? 'تقرير تحليلي' : 'analytics report'} />
                </Field>
                <Field label={isAr ? 'كل كم' : 'Every'}>
                  <input type="number" min="1" value={f.every_n_periods ?? ''}
                    onChange={(e) => set('every_n_periods', e.target.value)} className={FIELD} placeholder="1" />
                </Field>
                <Field label={isAr ? 'الفترة' : 'Period'}>
                  <select value={f.commitment_unit ?? ''} onChange={(e) => set('commitment_unit', e.target.value)} className={FIELD}>
                    <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                    {Object.keys(CADENCE_UNIT_LABEL).map((u) => (
                      <option key={u} value={u}>{lbl(CADENCE_UNIT_LABEL, u, isAr)}</option>))}
                  </select>
                </Field>
              </div>
              {sentence && (
                <p className="mt-1 text-[11.5px] text-copper">
                  {isAr ? `يلتزم البرنامج بـ ${sentence}` : `This program commits to ${sentence}`}
                </p>
              )}
              {(countNotPositive || everyNotPositive) && (
                <p className="mt-1 text-[11.5px] text-red-600">
                  {isAr ? 'العدد وعدد الفترات يجب أن يكونا أكبر من صفر.'
                        : 'Both the count and the interval must be greater than zero.'}
                </p>
              )}
            </div>
            <Field label={isAr ? 'الجمهور' : 'Audience'}>
              <input value={f.audience ?? ''} onChange={(e) => set('audience', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'دورية المراجعة' : 'Review frequency'}>
              <input value={f.review_frequency ?? ''} onChange={(e) => set('review_frequency', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'البداية' : 'Start'}>
              <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
            </Field>
            <p className="self-end text-[11px] text-charcoal/45">
              {isAr ? 'البرنامج مستمر — لا يُطلب تاريخ انتهاء.' : 'A program is ongoing — no end date is asked for.'}
            </p>
          </section>
        )}

        {isCampaign && (
          <section className="grid gap-2.5 sm:grid-cols-2">
            <Field label={isAr ? 'من' : 'From'}>
              <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'إلى' : 'To'}>
              <input type="date" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value)} className={FIELD} />
            </Field>
            {datesBackwards && (
              <p className="text-[11.5px] text-red-600 sm:col-span-2">
                {isAr ? 'تاريخ النهاية لا يمكن أن يسبق تاريخ البداية.' : 'The end date cannot come before the start date.'}
              </p>
            )}
            {datesOutside && plan && (
              <div className="sm:col-span-2">
                <Field label={isAr ? 'سبب الخروج عن فترة الخطة' : 'Reason for running outside the plan period'}
                  hint={isAr
                    ? `فترة الخطة ${plan.period_start} → ${plan.period_end}. يُسجَّل السبب مع اسم من سجّله.`
                    : `The plan runs ${plan.period_start} → ${plan.period_end}. The reason is recorded with who set it.`}>
                  <input value={f.period_override_reason ?? ''}
                    onChange={(e) => set('period_override_reason', e.target.value)} className={FIELD} />
                </Field>
              </div>
            )}
            {/* PURPOSE — what the campaign is for. A separate question from the
                organic/paid class the drawer already knows, and never mixed
                into the same list again. */}
            <Field label={isAr ? 'غرض الحملة' : 'Campaign purpose'}
              hint={isAr ? 'ما الذي تخدمه الحملة — غير كونها عضوية أو مدفوعة.'
                         : 'What the campaign is for — separate from organic vs paid.'}>
              <select value={f.campaign_type ?? ''} onChange={(e) => set('campaign_type', e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                {Object.keys(CAMPAIGN_PURPOSE_LABEL).map((p) => (
                  <option key={p} value={p}>{lbl(CAMPAIGN_PURPOSE_LABEL, p, isAr)}</option>))}
              </select>
            </Field>
            <Field label={isAr ? 'الأولوية' : 'Priority'}>
              <select value={f.priority ?? 'normal'} onChange={(e) => set('priority', e.target.value)} className={FIELD}>
                {Object.keys(PRIORITY_LABEL).map((p) => (
                  <option key={p} value={p}>{lbl(PRIORITY_LABEL, p, isAr)}</option>))}
              </select>
            </Field>
            <Field label={isAr ? 'الهدف التجاري' : 'Business objective'} span="sm:col-span-2"
              hint={isAr ? 'النتيجة المتوقعة، مثل: جذب عملاء مؤهلين لمشروع مينا 52.'
                         : 'The expected result, e.g. generate qualified leads for Mina 52.'}>
              <input value={f.objective ?? ''} onChange={(e) => set('objective', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'مرحلة القمع' : 'Funnel stage'}>
              <select value={f.funnel_stage ?? ''} onChange={(e) => set('funnel_stage', e.target.value)} className={FIELD}>
                <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                {Object.keys(FUNNEL_STAGE_LABEL).map((s) => (
                  <option key={s} value={s}>{lbl(FUNNEL_STAGE_LABEL, s, isAr)}</option>))}
              </select>
            </Field>
            <Field label={isAr ? 'الجمهور' : 'Audience'}>
              <input value={f.audience ?? ''} onChange={(e) => set('audience', e.target.value)} className={FIELD} />
            </Field>
            <Field label={isAr ? 'المشاريع' : 'Projects'} span="sm:col-span-2"
              hint={isAr ? 'من «مشاريعنا» فقط — والمطوّر يُشتق من المشروع'
                         : 'From Our Projects only — the developer is derived from the project'}>
              <ProjectPicker options={projects} value={projectIds} onChange={setProjectIds} isAr={isAr} />
            </Field>

            {kind === 'organic' ? (
              <>
                <Field label={isAr ? 'الرسالة الرئيسية' : 'Main message'} span="sm:col-span-2">
                  <textarea rows={2} value={f.message ?? ''} onChange={(e) => set('message', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'العرض' : 'Offer'}>
                  <input value={f.offer ?? ''} onChange={(e) => set('offer', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'دعوة الإجراء' : 'CTA'}>
                  <input value={f.cta ?? ''} onChange={(e) => set('cta', e.target.value)} className={FIELD} />
                </Field>
              </>
            ) : (
              <>
                <Field label={isAr ? 'الميزانية' : 'Budget'}>
                  <input type="number" min="0" value={f.budget ?? ''} onChange={(e) => set('budget', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'نوع الميزانية' : 'Budget type'}>
                  <select value={f.budget_kind ?? ''} onChange={(e) => set('budget_kind', e.target.value)} className={FIELD}>
                    <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                    {Object.keys(BUDGET_KIND_LABEL).map((b) => (
                      <option key={b} value={b}>{lbl(BUDGET_KIND_LABEL, b, isAr)}</option>))}
                  </select>
                </Field>
                {budgetNegative && (
                  <p className="text-[11.5px] text-red-600 sm:col-span-2">
                    {isAr ? 'الميزانية لا يمكن أن تكون بالسالب.' : 'A budget cannot be negative.'}
                  </p>
                )}
                <Field label={isAr ? 'هدف التحويل' : 'Conversion objective'}>
                  <input value={f.conversion ?? ''} onChange={(e) => set('conversion', e.target.value)} className={FIELD} />
                </Field>
                <Field label={isAr ? 'الوجهة' : 'Destination'}>
                  <input value={f.landing_url ?? ''} onChange={(e) => set('landing_url', e.target.value)} className={FIELD} />
                </Field>
                <p className="text-[11px] text-charcoal/45 sm:col-span-2">
                  {isAr ? 'حملات المنصات والمجموعات الإعلانية تُضاف تحت الحملة بعد إنشائها.'
                        : 'Platform campaigns and ad groups are added under the campaign once it exists.'}
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}
