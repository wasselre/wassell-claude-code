/**
 * The success-criteria editor — a campaign is judged by ONE OR MORE measures,
 * each with its own target number. You pick a measure from the managed registry
 * (`mos_measure_types`, seeded with the four presets), OR define a NEW type
 * inline — which persists to the registry so it is reusable next time and
 * appears in Settings → Success measures.
 *
 * The chosen type's label/direction/unit are snapshotted onto each row so the
 * campaign keeps what it was set with even if the type is later renamed.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useBilingualLabelAutofill } from '@/hooks/useBilingualLabelAutofill';
import {
  MosMeasureType,
  MosMeasureUnit,
  MosMeasureSource,
  MosSuccessMeasure,
  fetchMeasureTypes,
  saveMeasureType,
  successMeasureSuffix,
} from '@/lib/marketingOS/client';

/** What each source tracks — labels for the new-type picker. */
const SOURCE_LABELS: Record<MosMeasureSource, { ar: string; en: string }> = {
  impressions: { ar: 'المشاهدات', en: 'Impressions' },
  clicks: { ar: 'النقرات', en: 'Clicks' },
  leads: { ar: 'العملاء المحتملون', en: 'Leads' },
  qualified: { ar: 'العملاء المؤهلون', en: 'Qualified' },
  spend: { ar: 'الإنفاق', en: 'Spend' },
  cpl: { ar: 'تكلفة العميل المحتمل', en: 'Cost per lead' },
  cpl_qualified: { ar: 'تكلفة العميل المؤهل', en: 'Cost per qualified' },
  ctr: { ar: 'نسبة النقر', en: 'Click-through rate' },
  none: { ar: 'بدون تتبّع (هدف فقط)', en: 'No tracking (target only)' },
};
const SOURCE_ORDER: MosMeasureSource[] = [
  'impressions', 'clicks', 'leads', 'qualified', 'spend', 'cpl', 'cpl_qualified', 'ctr', 'none',
];

/** The in-form row — threshold is a string while it is being typed. */
export interface MeasureDraft {
  type_key: string;
  label_ar: string;
  label_en: string;
  direction: 'higher' | 'lower';
  unit: MosMeasureUnit;
  source: MosMeasureSource;
  threshold: string;
}

export function measuresToDrafts(measures: MosSuccessMeasure[] | undefined): MeasureDraft[] {
  return (measures ?? []).map((m) => ({
    type_key: m.type_key,
    label_ar: m.label_ar,
    label_en: m.label_en,
    direction: m.direction,
    unit: m.unit,
    source: m.source ?? 'none',
    threshold: m.threshold === null || m.threshold === undefined ? '' : String(m.threshold),
  }));
}

/** Drop rows with no chosen type; convert the threshold to a number (or null). */
export function draftsToMeasures(drafts: MeasureDraft[]): MosSuccessMeasure[] {
  return drafts
    .filter((d) => d.type_key.trim() !== '')
    .map((d) => ({
      type_key: d.type_key,
      label_ar: d.label_ar,
      label_en: d.label_en,
      direction: d.direction,
      unit: d.unit,
      source: d.source,
      threshold: d.threshold.trim() === '' ? null : Number(d.threshold),
    }));
}

/** Paid campaigns need at least one measure that carries a real target number. */
export function hasMeasureTarget(drafts: MeasureDraft[]): boolean {
  return drafts.some((d) => d.type_key.trim() !== '' && d.threshold.trim() !== '');
}

const NEW = '__new__';

const draftFromType = (t: MosMeasureType, threshold = ''): MeasureDraft => ({
  type_key: t.key,
  label_ar: t.label_ar,
  label_en: t.label_en,
  direction: t.direction,
  unit: t.unit,
  source: t.source ?? 'none',
  threshold,
});

export default function SuccessMeasuresEditor({
  measures, onChange, isAr,
}: {
  measures: MeasureDraft[];
  onChange: (next: MeasureDraft[]) => void;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [types, setTypes] = useState<MosMeasureType[]>([]);
  const [loaded, setLoaded] = useState(false);

  // The row index whose "+ new type" form is open (-1 = none), plus its draft.
  const [newForIndex, setNewForIndex] = useState<number>(-1);
  const [nAr, setNAr] = useState('');
  const [nEn, setNEn] = useState('');
  const [nDir, setNDir] = useState<'higher' | 'lower'>('higher');
  const [nUnit, setNUnit] = useState<MosMeasureUnit>('count');
  const [nSource, setNSource] = useState<MosMeasureSource>('none');
  const [savingType, setSavingType] = useState(false);

  // Live auto-translate between the two name fields, like the rest of the app:
  // type Arabic → English fills, and vice-versa.
  const nameFill = useBilingualLabelAutofill({
    ar: nAr, en: nEn, setAr: setNAr, setEn: setNEn, enabled: newForIndex !== -1,
  });

  const active = types.filter((t) => t.is_active);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchMeasureTypes();
        if (!cancelled) setTypes(res.measure_types);
      } catch (e) {
        // Non-fatal: the campaign still saves; the picker just falls back to
        // whatever rows already exist. Surfaced, not swallowed.
        console.error('[marketing] measure types unavailable', e);
        if (!cancelled) {
          addToast(
            isAr ? 'تعذّر تحميل أنواع المعايير.' : 'Could not load the measure types.',
            'error',
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [addToast, isAr]);

  // Seed a first row once the types have loaded and the campaign has none yet.
  useEffect(() => {
    const first = active[0];
    if (loaded && measures.length === 0 && first) {
      onChange([draftFromType(first)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, active.length]);

  const patchRow = (i: number, patch: Partial<MeasureDraft>): void =>
    onChange(measures.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  const removeRow = (i: number): void =>
    onChange(measures.filter((_, idx) => idx !== i));

  // The MAIN measure is the one the campaign card headlines. It is stored FIRST
  // (the server derives the back-compat primary from `success_measures[0]`), so
  // "make main" just moves the picked row to the front.
  const setMain = (i: number): void => {
    if (i <= 0) return;
    const row = measures[i];
    if (!row) return;
    onChange([row, ...measures.filter((_, idx) => idx !== i)]);
  };

  const addRow = (): void => {
    // Prefer a type not already chosen; else the first active type.
    const used = new Set(measures.map((m) => m.type_key));
    const next = active.find((t) => !used.has(t.key)) ?? active[0];
    onChange([...measures, next ? draftFromType(next) : {
      type_key: '', label_ar: '', label_en: '', direction: 'higher', unit: 'count', source: 'none', threshold: '',
    }]);
  };

  const onSelect = (i: number, value: string): void => {
    if (value === NEW) {
      setNewForIndex(i);
      setNAr(''); setNEn(''); setNDir('higher'); setNUnit('count'); setNSource('none');
      nameFill.reset('', '');
      return;
    }
    const t = active.find((x) => x.key === value);
    if (t) patchRow(i, { type_key: t.key, label_ar: t.label_ar, label_en: t.label_en, direction: t.direction, unit: t.unit, source: t.source ?? 'none' });
  };

  const createType = async (i: number): Promise<void> => {
    if (!nAr.trim() || !nEn.trim()) {
      addToast(isAr ? 'اكتب الاسمين للمعيار الجديد.' : 'Give the new measure both names.', 'error');
      return;
    }
    setSavingType(true);
    try {
      const base = nEn.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'measure';
      const key = `${base}_${crypto.randomUUID().slice(0, 4)}`;
      const res = await saveMeasureType({
        key,
        label_ar: nAr.trim(),
        label_en: nEn.trim(),
        direction: nDir,
        unit: nUnit,
        source: nSource,
        sort_order: types.length + 10,
        is_active: true,
      });
      setTypes(res.measure_types);
      const created = res.measure_types.find((t) => t.key === key);
      if (created) patchRow(i, {
        type_key: created.key, label_ar: created.label_ar, label_en: created.label_en,
        direction: created.direction, unit: created.unit, source: created.source ?? 'none',
      });
      setNewForIndex(-1);
      addToast(isAr ? 'أُضيف نوع المعيار.' : 'Measure type added.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSavingType(false);
    }
  };

  return (
    <div>
      <div className="lbl" style={{ marginBottom: 6 }}>
        {isAr ? 'معايير النجاح' : 'Success criteria'}
      </div>
      {measures.length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 8 }}>
          {isAr
            ? 'المعيار الرئيسي (★) هو ما يظهر على بطاقة الحملة ويُقاس التقدّم مقابله.'
            : 'The main measure (★) is what the campaign card shows and pace is measured against.'}
        </div>
      )}
      <div style={{ display: 'grid', gap: 9 }}>
        {measures.map((m, i) => (
          <div key={i} style={{ display: 'grid', gap: 9 }}>
            <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', alignItems: 'center' }}>
              {measures.length > 1 && (
                <button
                  type="button"
                  className={`btn btn-sm${i === 0 ? ' btn-p' : ''}`}
                  onClick={() => setMain(i)}
                  aria-pressed={i === 0}
                  title={isAr ? 'المعيار الرئيسي — يظهر على البطاقة' : 'Main measure — shown on the card'}
                >
                  {i === 0
                    ? (isAr ? '★ الرئيسي' : '★ Main')
                    : (isAr ? '☆ اجعله الرئيسي' : '☆ Make main')}
                </button>
              )}
              <select
                className="inp"
                style={{ flex: 1, minWidth: 180 }}
                value={m.type_key || (active[0]?.key ?? '')}
                onChange={(e) => onSelect(i, e.target.value)}
              >
                {active.map((t) => (
                  <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
                ))}
                {/* A snapshotted type that is no longer active still shows so the
                    row keeps its meaning. */}
                {m.type_key && !active.some((t) => t.key === m.type_key) && (
                  <option value={m.type_key}>{isAr ? m.label_ar : m.label_en}</option>
                )}
                <option value={NEW}>{isAr ? '＋ نوع جديد…' : '＋ New type…'}</option>
              </select>
              <div className="inp inp-row" style={{ width: 190, padding: 0 }}>
                <input
                  className="inp"
                  style={{ border: 0, flex: 1 }}
                  inputMode="numeric"
                  value={m.threshold}
                  onChange={(e) => patchRow(i, { threshold: e.target.value })}
                  aria-label={isAr ? 'الرقم المستهدف' : 'Target number'}
                />
                <span style={{ fontSize: 11, color: 'var(--mute)', paddingInlineEnd: 11, whiteSpace: 'nowrap' }}>
                  {successMeasureSuffix(m.direction, m.unit, isAr)}
                </span>
              </div>
              {measures.length > 1 && (
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  onClick={() => removeRow(i)}
                  aria-label={isAr ? 'حذف المعيار' : 'Remove measure'}
                >
                  {isAr ? 'حذف' : 'Remove'}
                </button>
              )}
            </div>

            {newForIndex === i && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '11px 13px', display: 'grid', gap: 9, background: 'var(--sand-2)' }}>
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                  <input
                    className="inp"
                    style={{ flex: 1, minWidth: 150 }}
                    placeholder={isAr ? 'اسم المعيار' : 'Measure name'}
                    value={nAr}
                    onChange={(e) => nameFill.onArChange(e.target.value)}
                    onBlur={nameFill.onBlur}
                  />
                  <div style={{ flex: 1, minWidth: 150, position: 'relative', display: 'flex' }}>
                    <input
                      className="inp ltr"
                      style={{ flex: 1 }}
                      placeholder="English name"
                      value={nEn}
                      onChange={(e) => nameFill.onEnChange(e.target.value)}
                      onBlur={nameFill.onBlur}
                    />
                    {nameFill.pending && (
                      <span style={{ position: 'absolute', insetInlineEnd: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--mute)', pointerEvents: 'none' }}>
                        {isAr ? 'ترجمة…' : 'Translating…'}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div className="seg">
                    <button type="button" className={nDir === 'higher' ? 'on' : ''} onClick={() => setNDir('higher')}>
                      {isAr ? 'الأكثر أفضل' : 'Higher is better'}
                    </button>
                    <button type="button" className={nDir === 'lower' ? 'on' : ''} onClick={() => setNDir('lower')}>
                      {isAr ? 'الأقل أفضل' : 'Lower is better'}
                    </button>
                  </div>
                  <div className="seg">
                    <button type="button" className={nUnit === 'count' ? 'on' : ''} onClick={() => setNUnit('count')}>
                      {isAr ? 'عدد' : 'Count'}
                    </button>
                    <button type="button" className={nUnit === 'currency' ? 'on' : ''} onClick={() => setNUnit('currency')}>
                      {isAr ? 'ريال' : 'SAR'}
                    </button>
                    <button type="button" className={nUnit === 'percent' ? 'on' : ''} onClick={() => setNUnit('percent')}>
                      {isAr ? 'نسبة' : 'Percent'}
                    </button>
                  </div>
                </div>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span className="lbl" style={{ fontSize: 11 }}>
                    {isAr ? 'يتتبّع (المصدر الفعلي للأرقام)' : 'Tracks (the live actual)'}
                  </span>
                  <select
                    className="inp"
                    value={nSource}
                    onChange={(e) => setNSource(e.target.value as MosMeasureSource)}
                  >
                    {SOURCE_ORDER.map((s) => (
                      <option key={s} value={s}>{isAr ? SOURCE_LABELS[s].ar : SOURCE_LABELS[s].en}</option>
                    ))}
                  </select>
                </label>
                <div style={{ display: 'flex', gap: 9 }}>
                  <button type="button" className="btn btn-p btn-sm" onClick={() => void createType(i)} disabled={savingType}>
                    {savingType ? (isAr ? 'جارٍ الإضافة…' : 'Adding…') : (isAr ? 'إضافة النوع' : 'Add type')}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setNewForIndex(-1)} disabled={savingType}>
                    {isAr ? 'إلغاء' : 'Cancel'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-sm" style={{ marginTop: 9 }} onClick={addRow}>
        {isAr ? '＋ إضافة معيار' : '＋ Add measure'}
      </button>
    </div>
  );
}
