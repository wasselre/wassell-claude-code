import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, History, X, AlertTriangle, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import { useSv, SectionCard, PageHeader } from './components/shared';

export default function SettingsPage() {
  const { isAr, m, rows, users } = useSv();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const record = rows(m.settings)[0] ?? null;
  const [d, setD] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [includeFlags, setIncludeFlags] = useState(false);
  const [confirm, setConfirm] = useState<{ count: number; includeFlags: boolean } | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneConfirm, setPruneConfirm] = useState<{ count: number; includeFlags: boolean } | null>(null);
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (record && seededRef.current !== record.id) { seededRef.current = record.id; setD({ ...record.data }); }
  }, [record]);

  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));

  // Available call-result outcomes come from the live followups model so they
  // never drift from what reps actually pick on a follow-up.
  const callResultOptions = useMemo(
    () => m.followups?.schema.sections.flatMap((s) => s.fields).find((x) => x.name === 'call_result')?.options ?? [],
    [m.followups],
  );
  const selectedResults = Array.isArray(d.review_call_results) ? (d.review_call_results as string[]) : [];
  const toggleResult = (val: string) =>
    set('review_call_results', selectedResults.includes(val)
      ? selectedResults.filter((v) => v !== val)
      : [...selectedResults, val]);

  if (!record) {
    return (
      <div className="mx-auto max-w-[900px] p-4 sm:p-6">
        <PageHeader title={isAr ? 'إعدادات تقييم المبيعات' : 'Sales Valuation Settings'} />
        <div className="card p-10 text-center text-charcoal/50">{isAr ? 'لا يوجد سجل إعدادات' : 'No settings record'}</div>
      </div>
    );
  }

  // Persist the current criteria. Returns true on success (used both by the
  // Save button and the retroactive backfill, which must run against the saved
  // criteria, not the unsaved draft).
  async function persist(): Promise<boolean> {
    if (!record) return false;
    setSaving(true);
    const res = await saveRecord({ ...record, data: d, updated_at: new Date().toISOString() }, { expectedVersion: record.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر — حدّث الصفحة' : 'Edited elsewhere — reload', 'error'); return false; }
    return true;
  }

  async function save() {
    if (await persist()) addToast(isAr ? 'تم حفظ الإعدادات' : 'Settings saved', 'success');
  }

  // Retroactive backfill: save the criteria first (so the DB rules match what's
  // on screen), preview how many reviews WOULD be created, then — on confirm —
  // create them. The DB function applies ONLY the configured criteria to past
  // completed follow-ups (no auto-flags, no random sample) and never duplicates.
  async function startBackfill() {
    if (!isSupabaseConfigured() || !supabase) {
      addToast(isAr ? 'غير متاح بدون اتصال' : 'Unavailable offline', 'error');
      return;
    }
    setBackfilling(true);
    const saved = await persist();
    if (!saved) { setBackfilling(false); return; }
    const { data: count, error } = await supabase.rpc('svr_backfill_reviews', { p_dry_run: true, p_include_flags: includeFlags });
    setBackfilling(false);
    if (error) { addToast(isAr ? `تعذّر حساب المتابعات: ${error.message}` : `Preview failed: ${error.message}`, 'error'); return; }
    setConfirm({ count: Number(count) || 0, includeFlags });
  }

  async function runBackfill() {
    if (!supabase || !confirm) return;
    const flags = confirm.includeFlags;
    setConfirm(null);
    setBackfilling(true);
    const { data: count, error } = await supabase.rpc('svr_backfill_reviews', { p_dry_run: false, p_include_flags: flags });
    setBackfilling(false);
    if (error) { addToast(isAr ? `تعذّر إنشاء المراجعات: ${error.message}` : `Backfill failed: ${error.message}`, 'error'); return; }
    const n = Number(count) || 0;
    addToast(
      n > 0
        ? (isAr ? `تم إنشاء ${n} مراجعة للمتابعات السابقة` : `Created ${n} review(s) for previous follow-ups`)
        : (isAr ? 'لا توجد متابعات سابقة جديدة مطابقة' : 'No new matching previous follow-ups'),
      'success',
    );
  }

  // Prune: delete reviews whose follow-up no longer matches the current criteria.
  // Only UNTOUCHED (still-pending, no manager work) reviews are removed —
  // already-evaluated reviews are always kept. Deleted rows are backed up
  // server-side. Saves the criteria first so the prune matches what's on screen.
  async function startPrune() {
    if (!isSupabaseConfigured() || !supabase) {
      addToast(isAr ? 'غير متاح بدون اتصال' : 'Unavailable offline', 'error');
      return;
    }
    setPruning(true);
    const saved = await persist();
    if (!saved) { setPruning(false); return; }
    const { data: count, error } = await supabase.rpc('svr_prune_unmatched_reviews', { p_dry_run: true, p_include_flags: includeFlags });
    setPruning(false);
    if (error) { addToast(isAr ? `تعذّر حساب المراجعات: ${error.message}` : `Preview failed: ${error.message}`, 'error'); return; }
    setPruneConfirm({ count: Number(count) || 0, includeFlags });
  }

  async function runPrune() {
    if (!supabase || !pruneConfirm) return;
    const flags = pruneConfirm.includeFlags;
    setPruneConfirm(null);
    setPruning(true);
    const { data: count, error } = await supabase.rpc('svr_prune_unmatched_reviews', { p_dry_run: false, p_include_flags: flags });
    setPruning(false);
    if (error) { addToast(isAr ? `تعذّر حذف المراجعات: ${error.message}` : `Prune failed: ${error.message}`, 'error'); return; }
    const n = Number(count) || 0;
    addToast(
      n > 0
        ? (isAr ? `تم حذف ${n} مراجعة غير مطابقة` : `Deleted ${n} non-matching review(s)`)
        : (isAr ? 'لا توجد مراجعات غير مطابقة للحذف' : 'No non-matching reviews to delete'),
      'success',
    );
  }

  return (
    <div className="mx-auto max-w-[900px] p-4 sm:p-6 space-y-5">
      <PageHeader title={isAr ? 'إعدادات تقييم المبيعات' : 'Sales Valuation Settings'}
        subtitle={isAr ? 'التحكم في عملية التقييم والمراجعة' : 'Control the valuation operation'}
        right={<Button onClick={save} disabled={saving}>{saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ الإعدادات' : 'Save')}</Button>} />

      <SectionCard title={isAr ? 'تشغيل العملية' : 'Operation'}>
        <Toggle label={isAr ? 'مفعل' : 'Enabled'} hint={isAr ? 'تشغيل/إيقاف عملية التقييم بالكامل' : 'Turn the whole operation on/off'} checked={d.is_enabled !== false} onChange={(v) => set('is_enabled', v)} />
        <Toggle label={isAr ? 'مراجعة كل المتابعات' : 'Review all follow-ups'} hint={isAr ? 'إنشاء تقييم لكل متابعة مكتملة' : 'Create a review for every completed follow-up'} checked={Boolean(d.review_all_followups)} onChange={(v) => set('review_all_followups', v)} />
      </SectionCard>

      <SectionCard title={isAr ? 'قواعد اختيار المتابعات للمراجعة' : 'Selection Rules'}>
        <Toggle label={isAr ? 'مراجعة العملاء غير المهتمين' : 'Not interested'} checked={Boolean(d.review_not_interested)} onChange={(v) => set('review_not_interested', v)} />
        <Toggle label={isAr ? 'مراجعة العملاء المفقودين' : 'Lost clients'} checked={Boolean(d.review_lost_clients)} onChange={(v) => set('review_lost_clients', v)} />
        <Toggle label={isAr ? 'مراجعة طلبات العروض' : 'Offer requests'} checked={Boolean(d.review_offer_requests)} onChange={(v) => set('review_offer_requests', v)} />
        <Toggle label={isAr ? 'مراجعة الزيارات' : 'Visits'} checked={Boolean(d.review_visits)} onChange={(v) => set('review_visits', v)} />
        <Toggle label={isAr ? 'مراجعة المتابعات بدون خطوة تالية' : 'Missing next step'} checked={Boolean(d.review_missing_next_step)} onChange={(v) => set('review_missing_next_step', v)} />
        <Toggle label={isAr ? 'مراجعة مندوبي التدريب' : 'New reps'} checked={Boolean(d.review_new_reps)} onChange={(v) => set('review_new_reps', v)} />
      </SectionCard>

      <SectionCard title={isAr ? 'نتائج المكالمات التي تستوجب مراجعة' : 'Call results that require a review'}>
        <p className="text-xs text-charcoal/55 -mt-1">
          {isAr
            ? 'اختر نتائج المكالمة التي إذا تحققت في متابعة مكتملة يتم إنشاء سجل مراجعة تلقائيًا لها.'
            : 'Pick the call results that, when they occur on a completed follow-up, automatically create a review record.'}
        </p>
        {callResultOptions.length === 0 ? (
          <p className="text-sm text-charcoal/50">{isAr ? 'لا توجد نتائج مكالمات متاحة' : 'No call results available'}</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {callResultOptions.map((o) => {
              const active = selectedResults.includes(o.value);
              const color = o.color || '#B8734F';
              return (
                <button key={o.id} type="button" onClick={() => toggleResult(o.value)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-start text-sm transition-colors ${active ? 'font-semibold' : 'border-sand/50 hover:border-copper/40 text-charcoal/80'}`}
                  style={active ? { borderColor: color, backgroundColor: `${color}14`, color } : undefined}>
                  <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded ${active ? '' : 'border border-charcoal/25'}`}
                    style={active ? { backgroundColor: color } : undefined}>
                    {active && <Check size={12} className="text-white" />}
                  </span>
                  <span className="truncate">{(isAr ? o.label_ar : o.label_en) || o.value}</span>
                </button>
              );
            })}
          </div>
        )}
        {selectedResults.length > 0 && (
          <button type="button" onClick={() => set('review_call_results', [])}
            className="text-xs font-medium text-copper hover:underline">
            {isAr ? `مسح التحديد (${selectedResults.length})` : `Clear selection (${selectedResults.length})`}
          </button>
        )}
      </SectionCard>

      <SectionCard title={isAr ? 'نسب العينات' : 'Sample Percentages'}>
        <div className="grid sm:grid-cols-2 gap-4">
          <NumberField label={isAr ? 'نسبة العينة العادية (%)' : 'Normal sample (%)'} value={d.normal_sample_percentage} onChange={(v) => set('normal_sample_percentage', v)} />
          <NumberField label={isAr ? 'نسبة عينة المندوب الجديد (%)' : 'New-rep sample (%)'} value={d.new_rep_sample_percentage} onChange={(v) => set('new_rep_sample_percentage', v)} />
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'الملخص اليومي' : 'Daily Summary'}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-charcoal/60 mb-1">{isAr ? 'وقت إنشاء الملخص اليومي' : 'Daily summary time'}</label>
            <input type="time" className="form-input w-40" value={(d.daily_summary_time as string) ?? ''} onChange={(e) => set('daily_summary_time', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal/60 mb-1">{isAr ? 'مدير المبيعات الافتراضي' : 'Default sales manager'}</label>
            <select className="form-input w-full" value={(d.default_sales_manager as string) ?? ''} onChange={(e) => set('default_sales_manager', e.target.value)}>
              <option value="">—</option>
              {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
            </select>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'تطبيق المعايير على المتابعات السابقة' : 'Apply criteria to previous follow-ups'}>
        <p className="text-sm text-charcoal/70">
          {isAr
            ? 'المعايير أعلاه تُطبَّق تلقائيًا على المتابعات الجديدة فقط. يمكنك أيضًا تطبيقها بأثر رجعي لإنشاء مراجعات للمتابعات المكتملة السابقة المطابقة للمعايير الحالية (تُطبَّق المعايير المحددة فقط، دون إشارات النظام أو العينة العشوائية، ولا يتم تكرار أي مراجعة موجودة).'
            : 'The criteria above apply automatically to new follow-ups only. You can also apply them retroactively to create reviews for already-completed follow-ups that match the current criteria (only the configured criteria are applied — no system flags or random sample — and existing reviews are never duplicated).'}
        </p>
        <div className="rounded-xl border border-sand/40 bg-cream/40 px-4 py-2">
          <Toggle
            label={isAr ? 'تضمين المتابعات ذات الإشارات التلقائية' : 'Include auto-flagged follow-ups'}
            hint={isAr ? 'يعتبرها مطابقة أيضًا — فتُنشأ لها مراجعات، ولا تُحذف. (مثل: ملاحظات ضعيفة، تأخّر، نتيجة غير متطابقة، زيارة غير مسجلة)' : 'Treats them as matching too — so they get reviews and are NOT deleted. (e.g. weak notes, late, result mismatch, unregistered visit)'}
            checked={includeFlags} onChange={setIncludeFlags} />
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button variant="secondary" onClick={startBackfill} disabled={backfilling || pruning || saving}>
            <History size={16} /> {backfilling
              ? (isAr ? 'جارٍ الحساب…' : 'Calculating…')
              : (isAr ? 'إنشاء مراجعات للمتابعات المطابقة' : 'Create reviews for matching')}
          </Button>
          <Button variant="secondary" onClick={startPrune} disabled={pruning || backfilling || saving}
            className="!text-terracotta !border-terracotta/40 hover:!bg-terracotta/10">
            <Trash2 size={16} /> {pruning
              ? (isAr ? 'جارٍ الحساب…' : 'Calculating…')
              : (isAr ? 'حذف المراجعات غير المطابقة' : 'Delete non-matching reviews')}
          </Button>
        </div>
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'تُحفظ المعايير الحالية أولًا ثم يُعرض العدد قبل التنفيذ. الحذف يطال المراجعات غير المطابقة التي لم تُقيَّم بعد فقط — المراجعات المُقيَّمة تبقى دائمًا، والمحذوفة يُحتفظ بنسخة منها.'
            : 'The current criteria are saved first, then a count is shown before anything happens. Delete only removes non-matching reviews that haven’t been evaluated yet — evaluated reviews are always kept, and deleted rows are backed up.'}
        </p>
      </SectionCard>

      <SectionCard title={isAr ? 'شرح الأتمتة' : 'How the automation works'}>
        <ul className="space-y-1.5 text-sm text-charcoal/80 list-disc ps-5">
          <li>{isAr ? 'عند اكتمال المتابعة يتم إنشاء تقييم تلقائي.' : 'When a follow-up completes, a review is created automatically.'}</li>
          <li>{isAr ? 'عند وجود خطأ يتم احتساب الدرجة.' : 'When there is a mistake, the score is computed.'}</li>
          <li>{isAr ? 'عند الحاجة للتصحيح يتم إنشاء مهمة تصحيح.' : 'When correction is needed, a correction task is created.'}</li>
          <li>{isAr ? 'يتم إنشاء ملخص يومي للمندوب.' : 'A daily summary is created for each rep.'}</li>
          <li>{isAr ? 'الاعتراضات تعود للمدير للحسم.' : 'Disputes return to the manager for a final decision.'}</li>
        </ul>
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-copper/10 px-4 py-3 text-sm text-chocolate">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <p className="font-semibold">{isAr
            ? 'هذه الأتمتة تعمل من جهة الخادم لضمان عدم فقدان أي متابعة، ولا تظهر كمسار مرئي في صفحة سير العمل.'
            : 'This automation runs server-side so no follow-up is ever missed, and it does not appear as a visible flow in the Workflows page.'}</p>
        </div>
      </SectionCard>

      {confirm && (
        <BackfillConfirm isAr={isAr} count={confirm.count} includeFlags={confirm.includeFlags} busy={backfilling}
          onCancel={() => setConfirm(null)} onConfirm={runBackfill} />
      )}
      {pruneConfirm && (
        <PruneConfirm isAr={isAr} count={pruneConfirm.count} busy={pruning}
          onCancel={() => setPruneConfirm(null)} onConfirm={runPrune} />
      )}
    </div>
  );
}

function PruneConfirm({ isAr, count, busy, onCancel, onConfirm }: {
  isAr: boolean; count: number; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }} dir={isAr ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md rounded-2xl bg-cream shadow-xl">
        <header className="flex items-center justify-between border-b border-sand/40 px-5 py-3">
          <h3 className="text-base font-bold text-charcoal">{isAr ? 'حذف المراجعات غير المطابقة' : 'Delete non-matching reviews'}</h3>
          <button type="button" onClick={onCancel} className="text-charcoal/50 hover:text-charcoal"><X size={20} /></button>
        </header>
        <div className="p-5 space-y-4">
          {count > 0 ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-terracotta/10 px-4 py-3 text-sm text-terracotta">
                <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
                <p>{isAr
                  ? <>سيتم حذف <span className="font-extrabold">{count}</span> مراجعة غير مطابقة للمعايير الحالية ولم تُقيَّم بعد. المراجعات التي قُيِّمت تبقى. يُحتفظ بنسخة من المحذوف. لا يمكن التراجع من الواجهة. هل تريد المتابعة؟</>
                  : <>This will permanently delete <span className="font-extrabold">{count}</span> non-matching review(s) that haven’t been evaluated yet. Evaluated reviews are kept. Deleted rows are backed up. This can’t be undone from the UI. Continue?</>}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onCancel} disabled={busy}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
                <Button onClick={onConfirm} disabled={busy}
                  className="!bg-terracotta hover:!bg-terracotta/90">
                  {busy ? (isAr ? 'جارٍ الحذف…' : 'Deleting…') : (isAr ? `حذف ${count} مراجعة` : `Delete ${count}`)}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-charcoal/70">{isAr
                ? 'لا توجد مراجعات غير مطابقة وغير مُقيَّمة لحذفها.'
                : 'There are no non-matching, un-evaluated reviews to delete.'}</p>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={onCancel}>{isAr ? 'حسناً' : 'OK'}</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BackfillConfirm({ isAr, count, includeFlags, busy, onCancel, onConfirm }: {
  isAr: boolean; count: number; includeFlags: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }} dir={isAr ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md rounded-2xl bg-cream shadow-xl">
        <header className="flex items-center justify-between border-b border-sand/40 px-5 py-3">
          <h3 className="text-base font-bold text-charcoal">{isAr ? 'تطبيق على المتابعات السابقة' : 'Apply to previous follow-ups'}</h3>
          <button type="button" onClick={onCancel} className="text-charcoal/50 hover:text-charcoal"><X size={20} /></button>
        </header>
        <div className="p-5 space-y-4">
          {count > 0 ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-copper/10 px-4 py-3 text-sm text-chocolate">
                <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
                <p>{isAr
                  ? <>سيتم إنشاء <span className="font-extrabold">{count}</span> مراجعة للمتابعات المكتملة السابقة المطابقة {includeFlags ? 'للمعايير الحالية وإشارات النظام' : 'للمعايير الحالية'}. لن تتكرر المراجعات الموجودة. هل تريد المتابعة؟</>
                  : <>This will create <span className="font-extrabold">{count}</span> review(s) for previous completed follow-ups matching {includeFlags ? 'the current criteria and system flags' : 'the current criteria'}. Existing reviews won’t be duplicated. Continue?</>}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onCancel} disabled={busy}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
                <Button onClick={onConfirm} disabled={busy}>
                  {busy ? (isAr ? 'جارٍ الإنشاء…' : 'Creating…') : (isAr ? `إنشاء ${count} مراجعة` : `Create ${count}`)}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-charcoal/70">{isAr
                ? 'لا توجد متابعات سابقة مطابقة للمعايير الحالية بحاجة إلى مراجعة جديدة.'
                : 'No previous follow-ups match the current criteria that need a new review.'}</p>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={onCancel}>{isAr ? 'حسناً' : 'OK'}</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-1 cursor-pointer">
      <span>
        <span className="text-sm font-semibold text-charcoal">{label}</span>
        {hint && <span className="block text-xs text-charcoal/50">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-copper' : 'bg-charcoal/20'}`}>
        <span className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-0.5' : 'translate-x-5'}`} />
      </button>
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: number | '') => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-charcoal/60 mb-1">{label}</label>
      <input type="number" className="form-input w-32" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  );
}
