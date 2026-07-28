/**
 * A plan's own fields.
 *
 * This existed nowhere. A plan was created from four boxes — name, type, from,
 * to — and could never be edited again: no owner, no budget, no summary, no
 * review cadence, no parent, not even a typo fix on the name. Meanwhile the
 * approval gate told the user the plan was missing المسؤول, which was true and
 * unfixable. A screen that names a blocker and offers no way to clear it is
 * worse than one that says nothing.
 *
 * Per-field save, same as the goal definition form: one global `busy` flag
 * disables every other input while a save is in flight and silently drops the
 * keystrokes typed into them. That bug has been fixed twice in this module
 * already; do not reintroduce it.
 */
import { useState } from 'react';
import { ChevronDown, Archive } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  savePlan, PLAN_TYPE_LABEL, REVIEW_FREQUENCY_LABEL,
  type MktPlan,
} from '@/lib/marketingMgmt/v2';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

export function PlanDefinitionForm({
  plan, siblings, missing, isAr, onError, onToast, onChanged,
}: {
  plan: MktPlan;
  /** Other plans, offered as a parent. A plan may nest under a LONGER one. */
  siblings: MktPlan[];
  missing: string[];
  isAr: boolean;
  onError: (m: string) => void; onToast: (m: string) => void; onChanged: () => void;
}) {
  // Open by default when something is missing, so an incomplete plan shows the
  // fields that fix it instead of hiding them behind a disclosure.
  const [open, setOpen] = useState(missing.length > 0);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);
  const users = useAppStore((s) => s.users);

  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try { await savePlan(patch, plan.id); onChanged(); }
    catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };
  const dis = (k: string) => saving.has(k);
  const needs = (k: string) => missing.includes(k);

  /** Amber ring on a field the approval gate is actually waiting for. */
  const ring = (k: string) => (needs(k) ? `${FIELD} border-amber-300 bg-amber-50/40` : FIELD);

  const txt = (
    key: string, label: string, value: string | number | null,
    type = 'text', span = '', hint?: string, missingKey?: string,
  ) => (
    <Field label={label} span={span} hint={hint}>
      <input type={type} defaultValue={value ?? ''} disabled={dis(key)}
        className={ring(missingKey ?? key)}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if ((v || null) === (value == null ? null : String(value))) return;
          void save({ [key]: type === 'number' ? (v === '' ? null : Number(v)) : (v || null) }, key);
        }} />
    </Field>
  );

  const sel = (
    key: string, label: string, value: string | null,
    map: Record<string, { ar: string; en: string }>, allowEmpty = true, missingKey?: string,
  ) => (
    <Field label={label}>
      <select defaultValue={value ?? ''} disabled={dis(key)} className={ring(missingKey ?? key)}
        onChange={(e) => void save({ [key]: e.target.value || null }, key)}>
        {allowEmpty && <option value="">{isAr ? '— اختر —' : '— select —'}</option>}
        {Object.keys(map).map((k) => (
          <option key={k} value={k}>{lbl(map, k, isAr)}</option>))}
      </select>
    </Field>
  );

  return (
    <div className="rounded-xl border border-sand/50 bg-white">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start">
        <span className="text-[12px] font-semibold text-charcoal/70">
          {isAr ? 'تفاصيل الخطة' : 'Plan details'}
          {missing.length > 0 && (
            <span className="ms-2 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800">
              {isAr ? `${missing.length} ناقص` : `${missing.length} missing`}
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-sand/40 p-3">
          <div className="grid gap-2.5 sm:grid-cols-3">
            {txt('name_ar', isAr ? 'الاسم (عربي)' : 'Name (Arabic)', plan.name_ar, 'text', 'sm:col-span-2')}
            {sel('plan_type', isAr ? 'النوع' : 'Type', plan.plan_type, PLAN_TYPE_LABEL, false)}

            <Field label={isAr ? 'المسؤول' : 'Owner'}
              hint={needs('owner')
                ? (isAr ? 'مطلوب قبل اعتماد الخطة.' : 'Required before the plan can be approved.')
                : undefined}>
              <select defaultValue={plan.owner_user_id ?? ''} disabled={dis('owner_user_id')}
                className={ring('owner')}
                onChange={(e) => void save({ owner_user_id: e.target.value || null }, 'owner_user_id')}>
                <option value="">{isAr ? '— بلا مسؤول —' : '— unassigned —'}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
              </select>
            </Field>
            {txt('period_start', isAr ? 'من' : 'From', plan.period_start, 'date')}
            {txt('period_end', isAr ? 'إلى' : 'To', plan.period_end, 'date')}

            {txt('budget', isAr ? 'الميزانية (ر.س)' : 'Budget (SAR)', plan.budget, 'number')}
            {sel('review_frequency', isAr ? 'دورية المراجعة' : 'Review cadence',
              plan.review_frequency, REVIEW_FREQUENCY_LABEL)}
            <Field label={isAr ? 'تندرج تحت' : 'Nested under'}
              hint={isAr ? 'الخطة الأب يجب أن تغطي فترة أطول.'
                         : 'A parent plan must cover a longer period.'}>
              <select defaultValue={plan.parent_plan_id ?? ''} disabled={dis('parent_plan_id')}
                className={FIELD}
                onChange={(e) => void save({ parent_plan_id: e.target.value || null }, 'parent_plan_id')}>
                <option value="">{isAr ? '— خطة مستقلة —' : '— standalone —'}</option>
                {siblings.filter((s) => s.id !== plan.id).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name_ar} · {lbl(PLAN_TYPE_LABEL, s.plan_type, isAr)}
                  </option>))}
              </select>
            </Field>

            {txt('name_en', isAr ? 'الاسم (إنجليزي، اختياري)' : 'Name (English, optional)',
              plan.name_en, 'text', 'sm:col-span-3')}

            <Field label={isAr ? 'ملخص الخطة' : 'Summary'} span="sm:col-span-3"
              hint={isAr ? 'ما الذي تحاول هذه الخطة تحقيقه، بجملة أو جملتين.'
                         : 'What this plan is trying to achieve, in a sentence or two.'}>
              <textarea defaultValue={plan.summary_ar ?? ''} rows={2} disabled={dis('summary_ar')}
                className={FIELD}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if ((v || null) === (plan.summary_ar ?? null)) return;
                  void save({ summary_ar: v || null }, 'summary_ar');
                }} />
            </Field>
          </div>

          {/* Archive, not delete. A plan may already carry goals, campaigns and
              reviews; removing it would orphan them, and the database refuses. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-sand/40 pt-2.5">
            {confirmArchive ? (
              <>
                <span className="text-[11.5px] text-charcoal/70">
                  {isAr ? `أرشفة «${plan.name_ar}»؟ تختفي من القائمة ولا تُحذف.`
                        : `Archive “${plan.name_ar}”? It leaves the list; nothing is deleted.`}
                </span>
                <button type="button" disabled={dis('archived_at')}
                  onClick={() => {
                    void save({ archived_at: new Date().toISOString() }, 'archived_at')
                      .then(() => onToast(isAr ? 'أُرشفت الخطة' : 'Plan archived'));
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
                <Archive className="h-3.5 w-3.5" />{isAr ? 'أرشفة الخطة' : 'Archive plan'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
