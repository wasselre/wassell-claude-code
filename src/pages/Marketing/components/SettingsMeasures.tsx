/**
 * Settings → Success measures.
 *
 * The managed registry a campaign's success criteria are picked from. The four
 * presets ship seeded; anyone with manage_settings can add more here (or inline
 * on a campaign — both write the same `mos_measure_types` table). A measure
 * carries a DIRECTION (higher/lower is better) and a UNIT (count vs riyal),
 * which decide the "or more" / "SAR or less" wording everywhere it is shown.
 *
 * Like content types, deactivating is hide-not-erase: is_active flips, the row
 * stays, and campaigns that already reference it keep their snapshot.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { useBilingualLabelAutofill } from '@/hooks/useBilingualLabelAutofill';
import {
  MosMeasureType, MosMeasureUnit, fetchMeasureTypes, saveMeasureType, successMeasureSuffix,
} from '@/lib/marketingOS/client';
import { Field, LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';

export default function SettingsMeasures({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [types, setTypes] = useState<MosMeasureType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [dAr, setDAr] = useState('');
  const [dEn, setDEn] = useState('');
  const [dDir, setDDir] = useState<'higher' | 'lower'>('higher');
  const [dUnit, setDUnit] = useState<MosMeasureUnit>('count');
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | 'new' | null>(null);

  // Live auto-translate between the two name fields, like the rest of the app.
  const nameFill = useBilingualLabelAutofill({
    ar: dAr, en: dEn, setAr: setDAr, setEn: setDEn, enabled: editingId !== null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMeasureTypes();
      setTypes(res.measure_types);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const editing = editingId && editingId !== 'new' ? types.find((t) => t.id === editingId) ?? null : null;

  // Load the draft when the edited type changes (render-guard, atomic with the click).
  if (editingId !== null && loadedFor !== editingId) {
    setLoadedFor(editingId);
    setDAr(editing?.label_ar ?? '');
    setDEn(editing?.label_en ?? '');
    setDDir(editing?.direction ?? 'higher');
    setDUnit(editing?.unit ?? 'count');
    // Re-seed the auto-translate touched state so an existing pair isn't
    // re-translated and a fresh "new measure" form starts clean.
    nameFill.reset(editing?.label_ar ?? '', editing?.label_en ?? '');
  }

  const save = async (): Promise<void> => {
    if (!dAr.trim() || !dEn.trim()) {
      addToast(isAr ? 'الاسمان إلزاميان.' : 'Both names are required.', 'error');
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        label_ar: dAr.trim(),
        label_en: dEn.trim(),
        direction: dDir,
        unit: dUnit,
      };
      if (editing) {
        payload.id = editing.id;
      } else {
        const base = dEn.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'measure';
        payload.key = `${base}_${crypto.randomUUID().slice(0, 4)}`;
        payload.sort_order = Math.max(0, ...types.map((t) => t.sort_order)) + 10;
        payload.is_active = true;
      }
      const res = await saveMeasureType(payload);
      setTypes(res.measure_types);
      addToast(isAr ? 'حُفظ المعيار.' : 'Measure saved.', 'success');
      setEditingId(null);
      setLoadedFor(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (t: MosMeasureType): Promise<void> => {
    try {
      const res = await saveMeasureType({ id: t.id, is_active: !t.is_active });
      setTypes(res.measure_types);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const dirLabel = (d: 'higher' | 'lower'): string =>
    d === 'higher' ? (isAr ? 'الأكثر أفضل' : 'Higher is better') : (isAr ? 'الأقل أفضل' : 'Lower is better');

  return (
    <>
      <PageHead
        title={isAr ? 'معايير النجاح' : 'Success measures'}
        sub={isAr
          ? `${num(types.length, true)} معايير · تُختار في موجز الحملة`
          : `${types.length} measures · picked in the campaign brief`}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" onClick={() => { setEditingId('new'); setLoadedFor(null); }}>
            {isAr ? 'إضافة معيار' : 'Add a measure'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={4} />}

        {!loading && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{isAr ? 'المعيار' : 'Measure'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'الاتجاه' : 'Direction'}</th>
                    <th style={{ width: 90 }}>{isAr ? 'الوحدة' : 'Unit'}</th>
                    <th style={{ width: 120 }}>{isAr ? 'مثال' : 'Reads as'}</th>
                    <th style={{ width: 60 }}>{isAr ? 'نشط' : 'Active'}</th>
                    <th style={{ width: 70 }} />
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
                      <td className="ttl">
                        {isAr ? t.label_ar : t.label_en}
                        <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400 }}>
                          {isAr ? t.label_en : t.label_ar}
                          {t.is_preset && <span className="tag" style={{ marginInlineStart: 6 }}>{isAr ? 'افتراضي' : 'preset'}</span>}
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>{dirLabel(t.direction)}</td>
                      <td style={{ fontSize: 12 }}>{t.unit === 'currency' ? (isAr ? 'ريال' : 'SAR') : t.unit === 'percent' ? (isAr ? 'نسبة' : 'Percent') : (isAr ? 'عدد' : 'Count')}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                        {num(100, isAr)} {successMeasureSuffix(t.direction, t.unit, isAr)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`sw${t.is_active ? ' on' : ''}`}
                          disabled={!canManage}
                          aria-label={isAr ? 'تفعيل المعيار' : 'Toggle the measure'}
                          onClick={() => void toggleActive(t)}
                        />
                      </td>
                      <td>
                        {canManage && (
                          <button type="button" className="btn btn-sm" onClick={() => { setEditingId(t.id); setLoadedFor(null); }}>
                            {isAr ? 'تعديل' : 'Edit'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {editingId !== null && (
          <div className="card">
            <div className="card-h">
              <h4>{editing
                ? `${isAr ? 'تعديل' : 'Edit'} · ${isAr ? editing.label_ar : editing.label_en}`
                : (isAr ? 'معيار جديد' : 'New measure')}</h4>
            </div>
            <div className="card-b" style={{ display: 'grid', gap: 13 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
                <Field label={isAr ? 'الاسم' : 'Name'}>
                  <input className="inp" value={dAr} onChange={(e) => nameFill.onArChange(e.target.value)} onBlur={nameFill.onBlur} />
                </Field>
                <Field label={isAr ? 'الاسم بالإنجليزية' : 'English name'}>
                  <div style={{ position: 'relative', display: 'flex' }}>
                    <input className="inp ltr" style={{ flex: 1 }} value={dEn} onChange={(e) => nameFill.onEnChange(e.target.value)} onBlur={nameFill.onBlur} />
                    {nameFill.pending && (
                      <span style={{ position: 'absolute', insetInlineEnd: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--mute)', pointerEvents: 'none' }}>
                        {isAr ? 'ترجمة…' : 'Translating…'}
                      </span>
                    )}
                  </div>
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 13, flexWrap: 'wrap' }}>
                <div>
                  <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الاتجاه' : 'Direction'}</div>
                  <div className="seg">
                    <button type="button" className={dDir === 'higher' ? 'on' : ''} onClick={() => setDDir('higher')}>
                      {isAr ? 'الأكثر أفضل' : 'Higher is better'}
                    </button>
                    <button type="button" className={dDir === 'lower' ? 'on' : ''} onClick={() => setDDir('lower')}>
                      {isAr ? 'الأقل أفضل' : 'Lower is better'}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الوحدة' : 'Unit'}</div>
                  <div className="seg">
                    <button type="button" className={dUnit === 'count' ? 'on' : ''} onClick={() => setDUnit('count')}>
                      {isAr ? 'عدد' : 'Count'}
                    </button>
                    <button type="button" className={dUnit === 'currency' ? 'on' : ''} onClick={() => setDUnit('currency')}>
                      {isAr ? 'ريال' : 'SAR'}
                    </button>
                    <button type="button" className={dUnit === 'percent' ? 'on' : ''} onClick={() => setDUnit('percent')}>
                      {isAr ? 'نسبة' : 'Percent'}
                    </button>
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr ? 'سيظهر كـ ' : 'Will read as '}
                <b style={{ color: 'var(--ink)' }}>{num(100, isAr)} {successMeasureSuffix(dDir, dUnit, isAr)}</b>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy || !canManage}>
                  {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
                </button>
                <button type="button" className="btn" onClick={() => { setEditingId(null); setLoadedFor(null); }} disabled={busy}>
                  {isAr ? 'إغلاق' : 'Close'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
