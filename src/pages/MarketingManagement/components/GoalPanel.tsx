/**
 * One goal, rendered as what it actually is.
 *
 * The three classes are not three labels on one card. An outcome goal is judged
 * by a result against a target over a period. A KPI is a reading you watch — it
 * has a current value and a direction, and no finish line. An output commitment
 * is an amount of work: required, done, left. Showing all three with the same
 * "target / actual / forecast" row is what made every goal look identical and
 * let a production target of "900" sit in the system with no unit attached.
 *
 * Two rules the UI enforces alongside the database:
 *
 *  1. An actual value is never typed into a field. It is the cached result of
 *     mkt_goal_actual() over append-only measurements, so the only way the
 *     number moves is by recording evidence. `actual_value` is not in the API's
 *     editable list; there is deliberately no input for it here.
 *
 *  2. A missing baseline is not zero and a missing measurement is not zero.
 *     Both render as "غير مقيس" with the reason, never as 0.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, AlertTriangle, Plus, Lock, TrendingUp, TrendingDown, Minus, Archive } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Stat, EmptyHint, CaveatStrip, Spinner, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchGoalDetail, saveGoal, setGoalTargets, recordGoalMeasurement,
  GOAL_CLASS_LABEL, GOAL_CLASS_HINT, GOAL_CATEGORY_LABEL, BASELINE_STATE_LABEL,
  AGGREGATION_LABEL, AGGREGATION_HINT, MEASUREMENT_FREQUENCY_LABEL, SOURCE_OF_TRUTH_LABEL,
  GOAL_MISSING_LABEL,
  type MktGoal, type GoalMeasurement, type GoalActual, type GoalAllocation,
  type GoalEffectiveDates, type GoalTargetPeriod,
} from '@/lib/marketingMgmt/v2';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const num = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString();

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sand/30 py-1.5 last:border-0">
      <span className="shrink-0 text-[11.5px] text-charcoal/50">{label}</span>
      <span className="min-w-0 text-end">{children}</span>
    </div>
  );
}

function Field({ label, children, span = '', hint }: {
  label: string; children: React.ReactNode; span?: string; hint?: string;
}) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[10.5px] leading-snug text-charcoal/40">{hint}</span>}
    </label>
  );
}

/** What this goal still needs before it can be activated. The list comes from
 *  mkt_goal_missing_requirements() — the same function the activation trigger
 *  uses — so the screen can never disagree with what the database will allow. */
function MissingChecklist({ missing, isAr }: { missing: string[]; isAr: boolean }) {
  if (missing.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-700">
        {isAr ? 'مكتمل — يمكن تفعيل هذا الهدف.' : 'Complete — this goal can be activated.'}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <div className="mb-1 text-[11.5px] font-semibold text-amber-800">
        {isAr ? `ناقص (${missing.length})` : `Missing (${missing.length})`}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {missing.map((m) => (
          <li key={m} className="text-[11.5px] text-amber-800">
            · {lbl(GOAL_MISSING_LABEL, m, isAr)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Append a reading. There is no edit and no delete — the database refuses both
 *  on this table, so offering either here would only produce a failed request. */
function MeasurementForm({ goal, onDone, onError, isAr }: {
  goal: MktGoal; onDone: () => void; onError: (m: string) => void; isAr: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [value, setValue] = useState('');
  const [at, setAt] = useState(today);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (value === '') return;
    setBusy(true);
    try {
      await recordGoalMeasurement({
        goal_id: goal.id, value: Number(value), measured_at: at,
        period_start: from || null, period_end: to || null,
        source_key: goal.source_of_truth, evidence: evidence.trim() || null,
      });
      setValue(''); setFrom(''); setTo(''); setEvidence('');
      onDone();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-copper/30 bg-white p-2.5 sm:grid-cols-4">
      <Field label={`${isAr ? 'القيمة' : 'Value'}${goal.unit ? ` (${goal.unit})` : ''}`}>
        <input type="number" value={value} onChange={(e) => setValue(e.target.value)} className={FIELD} />
      </Field>
      <Field label={isAr ? 'تاريخ القراءة' : 'Measured on'}>
        <input type="date" value={at} onChange={(e) => setAt(e.target.value)} className={FIELD} />
      </Field>
      <Field label={isAr ? 'من' : 'Period from'}>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
      </Field>
      <Field label={isAr ? 'إلى' : 'Period to'}>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
      </Field>
      <Field label={isAr ? 'الدليل / الملاحظة' : 'Evidence / note'} span="sm:col-span-3"
        hint={isAr ? 'من أين قُرئ هذا الرقم بالضبط؟ لقطة، تقرير، رابط.'
                   : 'Exactly where this number was read: a screenshot, report or link.'}>
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} className={FIELD} />
      </Field>
      <div className="sm:self-end">
        <Button onClick={submit} disabled={busy || value === ''}>
          <Plus className="h-4 w-4" />{isAr ? 'تسجيل' : 'Record'}
        </Button>
      </div>
      {goal.aggregation_method === 'sum' && (
        <p className="text-[10.5px] leading-snug text-charcoal/45 sm:col-span-4">
          {isAr ? 'هذا الهدف يُجمع — لا تُسجّل فترات متداخلة وإلا احتُسب الرقم مرتين.'
                : 'This goal sums its readings — do not record overlapping periods or the total double counts.'}
        </p>
      )}
    </div>
  );
}

function MeasurementHistory({ rows, unit, isAr }: {
  rows: GoalMeasurement[]; unit: string | null; isAr: boolean;
}) {
  const users = useAppStore((s) => s.users);
  if (rows.length === 0) {
    return (
      <EmptyHint>
        {isAr ? 'لا قراءات — الهدف بلا قياس، وليس عند صفر.'
              : 'No readings — this goal is unmeasured, not at zero.'}
      </EmptyHint>
    );
  }
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-sand/50">
      <table className="w-full text-[11.5px]">
        <tbody className="divide-y divide-sand/30">
          {rows.map((m) => {
            const u = users.find((x) => x.id === m.entered_by_user_id);
            return (
              <tr key={m.id}>
                <td className="px-2 py-1 tabular-nums text-charcoal">
                  {num(m.value)}{unit ? <span className="text-charcoal/40"> {unit}</span> : null}
                </td>
                <td className="px-2 py-1 text-charcoal/55">{fmtDate(m.measured_at, isAr)}</td>
                <td className="px-2 py-1 text-charcoal/40">
                  {m.period_start && m.period_end
                    ? `${fmtDate(m.period_start, isAr)} → ${fmtDate(m.period_end, isAr)}` : '—'}
                </td>
                <td className="max-w-[14rem] truncate px-2 py-1 text-charcoal/45" title={m.evidence ?? ''}>
                  {m.evidence || '—'}
                </td>
                <td className="px-2 py-1 text-charcoal/40">
                  {u ? ((isAr ? u.name_ar : u.name_en) || u.name_en) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Per-period targets, validated ONLY when the metric adds up.
 *  Requiring monthly conversion rates to sum to the annual conversion rate is
 *  the classic spreadsheet error; for a non-additive metric the periods are
 *  independent targets and no total is shown at all. */
function AllocationEditor({ goal, periods, allocation, onSaved, onError, isAr }: {
  goal: MktGoal; periods: GoalTargetPeriod[]; allocation: GoalAllocation | null;
  onSaved: () => void; onError: (m: string) => void; isAr: boolean;
}) {
  const [rows, setRows] = useState(() => periods.map((p) => ({
    label: p.label ?? '', period_start: p.period_start, period_end: p.period_end,
    target_value: String(p.target_value),
  })));
  const [busy, setBusy] = useState(false);
  const additive = allocation?.is_additive ?? (goal.aggregation_method === 'sum');

  const allocated = rows.reduce((a, r) => a + (Number(r.target_value) || 0), 0);
  const target = goal.target_value;
  const diff = additive && target != null ? allocated - target : null;

  const seedMonths = () => {
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
      onSaved();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium text-charcoal/60">
          {isAr ? 'التوزيع على الفترات' : 'Per-period allocation'}
        </span>
        <button type="button" onClick={seedMonths} className="text-[11px] text-copper hover:underline">
          {isAr ? 'ابدأ بـ12 شهراً (نقطة بداية تُعدَّل)' : 'Seed 12 months (a starting point to edit)'}
        </button>
      </div>

      {!additive && (
        <p className="rounded-lg border border-sand/50 bg-cream-light px-2.5 py-1.5 text-[11px] leading-snug text-charcoal/55">
          {isAr
            ? `مقياس لا يُجمع (${lbl(AGGREGATION_LABEL, goal.aggregation_method, isAr)}) — كل فترة مستهدف مستقل، ولا معنى لمجموعها.`
            : `Non-additive metric (${lbl(AGGREGATION_LABEL, goal.aggregation_method, isAr)}) — each period is its own target; their sum means nothing.`}
        </p>
      )}

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
                    <td className="w-28 py-1">
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
            {additive ? (
              <span className={`text-[11.5px] tabular-nums ${diff === 0 ? 'text-charcoal/50' : 'text-amber-700'}`}>
                {isAr ? 'المجموع' : 'Allocated'} {allocated.toLocaleString()}
                {target != null ? ` / ${target.toLocaleString()}` : ''}
                {diff != null && diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff.toLocaleString()})` : ''}
              </span>
            ) : (
              <span className="text-[11.5px] text-charcoal/40">
                {isAr ? 'لا يُطلب تطابق المجموع' : 'no sum check for this metric'}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The definition every class needs: what is measured, in what unit, from where,
 *  how readings combine, and what the baseline was. Metric and unit are separate
 *  boxes so "900" can never stand alone as a target. */
function GoalDefinitionForm({ goal, onSaved, onError, isAr }: {
  goal: MktGoal; onSaved: () => void; onError: (m: string) => void; isAr: boolean;
}) {
  const users = useAppStore((s) => s.users);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  /** Per-field busy state. A single global flag disables every other input
   *  while one save is in flight and silently drops the keystrokes typed into
   *  them — that bug has already been fixed once in this module. */
  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try { await saveGoal(patch, goal.id); onSaved(); }
    catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };
  const dis = (k: string) => saving.has(k);

  const sel = (
    key: string, label: string, value: string | null,
    map: Record<string, { ar: string; en: string }>, hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <select defaultValue={value ?? ''} disabled={dis(key)} className={FIELD}
        onChange={(e) => void save({ [key]: e.target.value || null }, key)}>
        <option value="">{isAr ? '— اختر —' : '— select —'}</option>
        {Object.keys(map).map((k) => (
          <option key={k} value={k}>{lbl(map, k, isAr)}</option>))}
      </select>
    </Field>
  );

  const txt = (key: string, label: string, value: string | null, hint?: string, type = 'text') => (
    <Field label={label} hint={hint}>
      <input type={type} defaultValue={value ?? ''} disabled={dis(key)} className={FIELD}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if ((v || null) === (value ?? null)) return;
          void save({ [key]: type === 'number' ? (v === '' ? null : Number(v)) : (v || null) }, key);
        }} />
    </Field>
  );

  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      {sel('goal_class', isAr ? 'تصنيف الهدف' : 'Goal classification', goal.goal_class,
        GOAL_CLASS_LABEL, lbl(GOAL_CLASS_HINT, goal.goal_class, isAr))}
      {sel('goal_category', isAr ? 'المجال' : 'Theme', goal.goal_category, GOAL_CATEGORY_LABEL,
        isAr ? 'ما موضوع الهدف — غير تصنيفه.' : 'What the goal is about — separate from its class.')}
      {sel('measurement_frequency', isAr ? 'دورية القياس' : 'Measurement frequency',
        goal.measurement_frequency, MEASUREMENT_FREQUENCY_LABEL)}

      {txt('metric', isAr ? 'المقياس' : 'Metric', goal.metric,
        isAr ? 'ما الذي يُعد بالضبط؟ مثال: عملاء محتملون مؤهلون'
             : 'What exactly is counted? e.g. qualified leads')}
      {txt('unit', isAr ? 'الوحدة' : 'Unit', goal.unit,
        isAr ? 'عميل، مشاهدة، ريال، ٪ … رقم بلا وحدة لا يعني شيئاً.'
             : 'lead, view, SAR, % … a number without a unit says nothing.')}
      {txt('target_value', isAr ? 'المستهدف' : 'Target', goal.target_value?.toString() ?? null,
        undefined, 'number')}

      {sel('aggregation_method', isAr ? 'طريقة التجميع' : 'Aggregation method',
        goal.aggregation_method, AGGREGATION_LABEL, lbl(AGGREGATION_HINT, goal.aggregation_method, isAr))}
      {sel('source_of_truth', isAr ? 'مصدر القياس' : 'Source of truth',
        goal.source_of_truth, SOURCE_OF_TRUTH_LABEL,
        isAr ? 'من أين يُقرأ الرقم فعلياً.' : 'Where the number is actually read from.')}
      <Field label={isAr ? 'المسؤول' : 'Owner'}>
        <select defaultValue={goal.owner_user_id ?? ''} disabled={dis('owner_user_id')} className={FIELD}
          onChange={(e) => void save({ owner_user_id: e.target.value || null }, 'owner_user_id')}>
          <option value="">{isAr ? '— بلا مسؤول —' : '— unassigned —'}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
        </select>
      </Field>

      {sel('baseline_state', isAr ? 'حالة خط الأساس' : 'Baseline state', goal.baseline_state,
        BASELINE_STATE_LABEL,
        isAr ? 'خط أساس مجهول يبقى مجهولاً — لا يُحوَّل إلى صفر.'
             : 'An unknown baseline stays unknown — it is never turned into zero.')}
      {goal.baseline_state === 'known' && (
        <>
          {txt('baseline_value', isAr ? 'قيمة خط الأساس' : 'Baseline value',
            goal.baseline_value?.toString() ?? null, undefined, 'number')}
          {txt('baseline_date', isAr ? 'تاريخ خط الأساس' : 'Baseline date', goal.baseline_date,
            undefined, 'date')}
        </>
      )}

      {txt('start_date', isAr ? 'البداية (اختياري)' : 'Start (optional)', goal.start_date,
        isAr ? 'يُورث من الخطة إن تُرك فارغاً.' : 'Inherited from the plan when left empty.', 'date')}
      {txt('end_date', isAr ? 'النهاية (اختياري)' : 'End (optional)', goal.end_date,
        isAr ? 'يُورث من الخطة إن تُرك فارغاً.' : 'Inherited from the plan when left empty.', 'date')}

      {goal.source_of_truth_note && (
        <div className="sm:col-span-3 rounded-lg border border-sand/50 bg-cream-light px-2.5 py-1.5">
          <span className="text-[10.5px] font-medium text-charcoal/45">
            {isAr ? 'ما كان مكتوباً سابقاً كمصدر' : 'Previously written as the source'}
          </span>
          <p className="text-[11.5px] text-charcoal/70">{goal.source_of_truth_note}</p>
        </div>
      )}
    </div>
  );
}

// ── the three class-specific summaries ────────────────────────────────────

function OutcomeSummary({ goal, actual, allocation, dates, isAr }: {
  goal: MktGoal; actual: GoalActual | null; allocation: GoalAllocation | null;
  dates: GoalEffectiveDates | null; isAr: boolean;
}) {
  const users = useAppStore((s) => s.users);
  const owner = users.find((u) => u.id === goal.owner_user_id);
  const measured = actual?.is_measured ? Number(actual.value) : null;
  const pct = measured != null && goal.target_value ? (measured / goal.target_value) * 100 : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'المستهدف' : 'Target'}
          value={goal.target_value != null ? `${num(goal.target_value)}${goal.unit ? ` ${goal.unit}` : ''}` : null} />
        <Stat label={isAr ? 'المحقق' : 'Achieved'}
          value={measured != null ? `${num(measured)}${goal.unit ? ` ${goal.unit}` : ''}` : null}
          hint={actual?.is_measured ? undefined : (isAr ? 'لا قراءات مسجّلة' : 'no readings recorded')} />
        <Stat label={isAr ? 'نسبة الإنجاز' : 'Progress'}
          value={pct != null ? `${pct.toFixed(0)}%` : null} />
        <Stat label={isAr ? 'التوقع' : 'Forecast'} value={goal.forecast_value ?? null} />
      </div>
      <div className="rounded-lg border border-sand/50 bg-white px-3 py-1">
        <Row label={isAr ? 'الفترة' : 'Period'}>
          <span className="text-[12px] text-charcoal/70">
            {dates ? `${fmtDate(dates.start, isAr)} → ${fmtDate(dates.end, isAr)}` : '—'}
            {dates && !dates.start_overridden && !dates.end_overridden && (
              <span className="text-charcoal/35"> · {isAr ? 'من الخطة' : 'from the plan'}</span>)}
          </span>
        </Row>
        <Row label={isAr ? 'المسؤول' : 'Owner'}>
          <span className={`text-[12px] ${owner ? 'text-charcoal/70' : 'text-amber-700'}`}>
            {owner ? ((isAr ? owner.name_ar : owner.name_en) || owner.name_en)
                   : (isAr ? 'بلا مسؤول' : 'unassigned')}
          </span>
        </Row>
        <Row label={isAr ? 'تغطية القياس' : 'Measurement coverage'}>
          <span className="text-[12px] text-charcoal/70">
            {actual ? (isAr ? `${actual.measurements} قراءة` : `${actual.measurements} reading(s)`) : '—'}
            {actual?.last_measured_at
              ? <span className="text-charcoal/40"> · {fmtDate(actual.last_measured_at, isAr)}</span> : null}
          </span>
        </Row>
        <Row label={isAr ? 'التوزيع' : 'Allocation'}>
          <span className="text-[12px] text-charcoal/70">
            {!allocation || !allocation.has_allocation
              ? <span className="text-charcoal/40">{isAr ? 'بلا توزيع' : 'none'}</span>
              : allocation.is_additive
                ? (allocation.consistent
                    ? <span className="text-emerald-700">{isAr ? 'مطابق للمستهدف' : 'matches the target'}</span>
                    : <span className="text-amber-700">
                        {isAr ? 'الفرق' : 'off by'} {num(allocation.difference)}
                      </span>)
                : <span className="text-charcoal/50">
                    {isAr ? `${allocation.periods} فترة · لا يُجمع` : `${allocation.periods} periods · non-additive`}
                  </span>}
          </span>
        </Row>
      </div>
    </div>
  );
}

function KpiSummary({ goal, actual, measurements, isAr }: {
  goal: MktGoal; actual: GoalActual | null; measurements: GoalMeasurement[]; isAr: boolean;
}) {
  // A trend needs two readings. With one, the honest answer is "no trend yet",
  // not an arrow pointing up from an imagined zero.
  const [latest, prev] = measurements;
  const delta = latest && prev ? Number(latest.value) - Number(prev.value) : null;
  const TrendIcon = delta === null ? Minus : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const trendTone = delta === null ? 'text-charcoal/35'
    : delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-amber-600' : 'text-charcoal/40';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'القراءة الحالية' : 'Current reading'}
          value={actual?.is_measured ? `${num(actual.value)}${goal.unit ? ` ${goal.unit}` : ''}` : null}
          hint={actual?.last_measured_at ? fmtDate(actual.last_measured_at, isAr)
                                         : (isAr ? 'لم تُقرأ بعد' : 'not read yet')} />
        <Stat label={isAr ? 'المستهدف' : 'Target'}
          value={goal.target_value != null ? `${num(goal.target_value)}${goal.unit ? ` ${goal.unit}` : ''}` : null} />
        <Stat label={isAr ? 'خط الأساس' : 'Baseline'}
          value={goal.baseline_state === 'known' ? num(goal.baseline_value)
               : goal.baseline_state ? lbl(BASELINE_STATE_LABEL, goal.baseline_state, isAr) : null}
          hint={goal.baseline_state === 'known' && goal.baseline_date
                ? fmtDate(goal.baseline_date, isAr) : undefined}
          tone={goal.baseline_state === 'unknown' ? 'muted' : 'default'} />
        <Stat label={isAr ? 'عدد القراءات' : 'Readings'} value={actual?.measurements ?? null} />
      </div>
      <div className="rounded-lg border border-sand/50 bg-white px-3 py-1">
        <Row label={isAr ? 'الاتجاه' : 'Trend'}>
          <span className={`inline-flex items-center gap-1 text-[12px] ${trendTone}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            {delta === null
              ? (isAr ? 'قراءة واحدة أو أقل — لا اتجاه بعد' : 'one reading or fewer — no trend yet')
              : `${delta > 0 ? '+' : ''}${num(delta)} ${isAr ? 'عن القراءة السابقة' : 'vs previous reading'}`}
          </span>
        </Row>
        <Row label={isAr ? 'دورية القياس' : 'Measurement frequency'}>
          <span className={`text-[12px] ${goal.measurement_frequency ? 'text-charcoal/70' : 'text-amber-700'}`}>
            {goal.measurement_frequency
              ? lbl(MEASUREMENT_FREQUENCY_LABEL, goal.measurement_frequency, isAr)
              : (isAr ? 'غير محددة' : 'not set')}
          </span>
        </Row>
        <Row label={isAr ? 'مصدر القياس' : 'Source of truth'}>
          <span className={`text-[12px] ${goal.source_of_truth ? 'text-charcoal/70' : 'text-amber-700'}`}>
            {goal.source_of_truth
              ? lbl(SOURCE_OF_TRUTH_LABEL, goal.source_of_truth, isAr)
              : (isAr ? 'غير محدد' : 'not set')}
          </span>
        </Row>
      </div>
    </div>
  );
}

function OutputSummary({ goal, actual, allocation, dates, isAr }: {
  goal: MktGoal; actual: GoalActual | null; allocation: GoalAllocation | null;
  dates: GoalEffectiveDates | null; isAr: boolean;
}) {
  const done = actual?.is_measured ? Number(actual.value) : null;
  const required = goal.target_value;
  const left = done != null && required != null ? required - done : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'المطلوب' : 'Required'}
          value={required != null ? `${num(required)}${goal.unit ? ` ${goal.unit}` : ''}` : null} />
        <Stat label={isAr ? 'المنجز' : 'Completed'}
          value={done != null ? num(done) : null}
          hint={done == null ? (isAr ? 'لم يُسجَّل إنجاز' : 'nothing recorded yet') : undefined} />
        <Stat label={isAr ? 'المتبقي' : 'Remaining'}
          value={left != null ? num(left) : null}
          tone={left != null && left > 0 ? 'warn' : 'default'}
          hint={left == null ? (isAr ? 'يحتاج قراءة أولاً' : 'needs a reading first') : undefined} />
        <Stat label={isAr ? 'الفترة' : 'Due period'}
          value={dates ? `${fmtDate(dates.start, isAr)} → ${fmtDate(dates.end, isAr)}` : null} />
      </div>
      {allocation?.has_allocation && allocation.is_additive && !allocation.consistent && (
        <CaveatStrip>
          {isAr
            ? `مجموع الفترات (${num(allocation.allocated)}) لا يساوي الالتزام (${num(allocation.target)}).`
            : `The periods add up to ${num(allocation.allocated)}, not the committed ${num(allocation.target)}.`}
        </CaveatStrip>
      )}
      {goal.aggregation_method !== 'sum' && goal.aggregation_method && (
        <p className="text-[11px] leading-snug text-charcoal/45">
          {isAr
            ? 'التزام تنفيذي يُجمع عادةً عبر الفترات. طريقة التجميع الحالية ليست "مجموع الفترات" — تأكد أن ذلك مقصود.'
            : 'An output commitment usually sums across periods. This one does not — check that is deliberate.'}
        </p>
      )}
    </div>
  );
}

// ── the row ───────────────────────────────────────────────────────────────

export function GoalRow({ goal: seed, isAr, onError, onToast, onChanged }: {
  goal: MktGoal; isAr: boolean; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'summary' | 'definition' | 'measure' | 'allocation'>('summary');
  const [d, setD] = useState<Awaited<ReturnType<typeof fetchGoalDetail>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setD(await fetchGoalDetail(seed.id)); }
    catch (e) { onError(err(e)); }
    finally { setLoading(false); }
  }, [seed.id, onError]);

  useEffect(() => { if (open && !d) void load(); }, [open, d, load]);

  const goal = d?.goal ?? seed;
  const cls = goal.goal_class ?? 'outcome';
  // A KPI's headline is its current reading, an outcome's is what it is aiming
  // at. When a KPI has been opened and has no readings, say "not measured" —
  // an em dash there is indistinguishable from "no target set".
  const headline = cls === 'kpi'
    ? (d?.actual?.is_measured ? num(d.actual.value)
       : d ? (isAr ? 'غير مقيس' : 'not measured') : '—')
    : goal.target_value != null ? num(goal.target_value) : '—';

  return (
    <li className="rounded-lg border border-sand/50 bg-white">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start">
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-charcoal">{goal.name_ar}</span>
          <span className="text-[10.5px] text-charcoal/45">
            {lbl(GOAL_CLASS_LABEL, cls, isAr)}
            {goal.metric ? ` · ${goal.metric}` : ''}
            {goal.unit ? ` (${goal.unit})` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[11.5px]">
          <span className="tabular-nums text-charcoal/70">{headline}</span>
          {goal.needs_classification && (
            <span title={isAr ? 'يحتاج استكمال تعريف' : 'needs its definition completed'}>
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            </span>
          )}
          <ChevronDown className={`h-4 w-4 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 border-t border-sand/40 p-3">
          {loading && !d ? <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /> : d && (
            <>
              <p className="text-[11px] leading-snug text-charcoal/45">
                {lbl(GOAL_CLASS_HINT, cls, isAr)}
              </p>

              <MissingChecklist missing={d.missing} isAr={isAr} />

              <div className="flex flex-wrap gap-1">
                {([
                  ['summary', isAr ? 'الحالة' : 'Status'],
                  ['definition', isAr ? 'التعريف' : 'Definition'],
                  ['measure', isAr ? 'القراءات' : 'Readings'],
                  ['allocation', isAr ? 'التوزيع' : 'Allocation'],
                ] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ${
                      tab === k ? 'bg-copper text-white' : 'bg-cream-light text-charcoal/60 hover:bg-sand/30'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'summary' && (
                cls === 'kpi'
                  ? <KpiSummary goal={goal} actual={d.actual} measurements={d.measurements} isAr={isAr} />
                  : cls === 'output_commitment'
                    ? <OutputSummary goal={goal} actual={d.actual} allocation={d.allocation}
                        dates={d.dates} isAr={isAr} />
                    : <OutcomeSummary goal={goal} actual={d.actual} allocation={d.allocation}
                        dates={d.dates} isAr={isAr} />
              )}

              {tab === 'definition' && (
                <div className="space-y-3">
                  <GoalDefinitionForm goal={goal} isAr={isAr} onError={onError}
                    onSaved={() => { void load(); onChanged(); }} />
                  {/* A goal created by mistake was permanent: GOAL_EDITABLE has
                      always accepted archived_at and no screen ever offered it.
                      Archive, not delete — measurements and target periods hang
                      off this row and deleting would take the evidence with it. */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-sand/40 pt-2.5">
                    {confirmArchive ? (
                      <>
                        <span className="text-[11.5px] text-charcoal/70">
                          {isAr ? `أرشفة «${goal.name_ar}»؟ تختفي من الخطة وتبقى قراءاتها.`
                                : `Archive “${goal.name_ar}”? It leaves the plan; its readings are kept.`}
                        </span>
                        <button type="button" disabled={archiving}
                          onClick={async () => {
                            setArchiving(true);
                            try {
                              await saveGoal({ archived_at: new Date().toISOString() }, goal.id);
                              onToast(isAr ? 'أُرشف الهدف' : 'Goal archived');
                              onChanged();
                            } catch (e) { onError(err(e)); } finally { setArchiving(false); }
                          }}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11.5px] font-medium text-amber-800">
                          {isAr ? 'تأكيد الأرشفة' : 'Confirm archive'}
                        </button>
                        <button type="button" onClick={() => setConfirmArchive(false)}
                          className="text-[11.5px] text-charcoal/50 hover:underline">
                          {isAr ? 'إلغاء' : 'Cancel'}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirmArchive(true)}
                        className="inline-flex items-center gap-1.5 text-[11.5px] text-charcoal/45 hover:text-amber-700 hover:underline">
                        <Archive className="h-3.5 w-3.5" />{isAr ? 'أرشفة الهدف' : 'Archive goal'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {tab === 'measure' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-charcoal/45">
                    <Lock className="h-3 w-3" />
                    {isAr ? 'القراءات لا تُعدَّل ولا تُحذف — تُضاف قراءة جديدة تصحّح السابقة.'
                          : 'Readings cannot be edited or deleted — add a new one to correct an old one.'}
                  </div>
                  <MeasurementForm goal={goal} isAr={isAr} onError={onError}
                    onDone={() => { onToast(isAr ? 'سُجّلت القراءة' : 'Reading recorded');
                                    void load(); onChanged(); }} />
                  <MeasurementHistory rows={d.measurements} unit={goal.unit} isAr={isAr} />
                </div>
              )}

              {tab === 'allocation' && (
                <AllocationEditor key={d.periods.length} goal={goal} periods={d.periods}
                  allocation={d.allocation} isAr={isAr} onError={onError}
                  onSaved={() => { onToast(isAr ? 'حُفظ التوزيع' : 'Allocation saved');
                                   void load(); onChanged(); }} />
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
