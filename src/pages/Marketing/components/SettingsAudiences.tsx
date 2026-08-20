/**
 * Settings → Audiences.
 *
 * The managed registry the campaign brief's «الجمهور» is picked from. Each
 * audience is a reusable record — a title (`name`) plus a large `details` field.
 * Anyone with manage_settings can add more here (or inline on a campaign brief —
 * both write the same `mos_audiences` table).
 *
 * Like content types / measures, deactivating is hide-not-erase: is_active flips,
 * the row stays, and campaigns that already reference it keep their name snapshot.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MetaSavedAudienceOption, MosAudience, fetchAudiences, mosMetaSavedAudiences, saveAudience,
} from '@/lib/marketingOS/client';
import { Field, LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';

export default function SettingsAudiences({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [audiences, setAudiences] = useState<MosAudience[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [dName, setDName] = useState('');
  const [dDetails, setDDetails] = useState('');
  const [dMetaId, setDMetaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | 'new' | null>(null);

  // Option B: the Meta Saved Audiences a Wassel audience can be linked to.
  // Loaded lazily on first editor open; self-disables (empty picker) when Meta
  // isn't configured or the caller lacks manage_paid_ads.
  const [metaAudiences, setMetaAudiences] = useState<MetaSavedAudienceOption[]>([]);
  const [metaLoaded, setMetaLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAudiences();
      setAudiences(res.audiences);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Fetch Meta Saved Audiences once, when the editor is first opened.
  useEffect(() => {
    if (editingId === null || metaLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await mosMetaSavedAudiences();
        if (!cancelled) setMetaAudiences(res.audiences);
      } catch {
        // Expected self-disable path: Meta not configured, or the caller lacks
        // manage_paid_ads. The picker renders a "create one in Meta" note instead.
      }
      if (!cancelled) setMetaLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [editingId, metaLoaded]);

  const editing = editingId && editingId !== 'new' ? audiences.find((a) => a.id === editingId) ?? null : null;

  // Load the draft when the edited audience changes (render-guard, atomic with the click).
  if (editingId !== null && loadedFor !== editingId) {
    setLoadedFor(editingId);
    setDName(editing?.name ?? '');
    setDDetails(editing?.details ?? '');
    setDMetaId(editing?.meta_saved_audience_id ?? '');
  }

  const save = async (): Promise<void> => {
    if (!dName.trim()) {
      addToast(isAr ? 'الاسم إلزامي.' : 'A name is required.', 'error');
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: dName.trim(),
        details: dDetails.trim() || null,
      };
      // Only touch the Meta link when the saved-audience list actually loaded —
      // otherwise a save would blank an existing link the user never saw.
      if (metaLoaded) {
        const selected = metaAudiences.find((m) => m.id === dMetaId) ?? null;
        payload.meta_saved_audience_id = dMetaId || null;
        payload.meta_targeting = dMetaId
          ? selected?.targeting
            ?? (dMetaId === (editing?.meta_saved_audience_id ?? '') ? editing?.meta_targeting ?? null : null)
          : null;
      }
      if (editing) {
        payload.id = editing.id;
      } else {
        payload.sort_order = Math.max(0, ...audiences.map((a) => a.sort_order)) + 10;
        payload.is_active = true;
      }
      const res = await saveAudience(payload);
      setAudiences(res.audiences);
      addToast(isAr ? 'حُفظ الجمهور.' : 'Audience saved.', 'success');
      setEditingId(null);
      setLoadedFor(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (a: MosAudience): Promise<void> => {
    try {
      const res = await saveAudience({ id: a.id, is_active: !a.is_active });
      setAudiences(res.audiences);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'الجماهير' : 'Audiences'}
        sub={isAr
          ? `${num(audiences.length, true)} جمهور · تُختار في موجز الحملة`
          : `${audiences.length} audiences · picked in the campaign brief`}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" onClick={() => { setEditingId('new'); setLoadedFor(null); }}>
            {isAr ? 'إضافة جمهور' : 'Add an audience'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={4} />}

        {!loading && audiences.length === 0 && (
          <div className="notice" style={{ marginBottom: 16 }}>
            {isAr
              ? 'لا توجد جماهير محفوظة بعد. أضف واحدًا هنا أو مباشرةً من موجز أي حملة.'
              : 'No saved audiences yet. Add one here or straight from any campaign brief.'}
          </div>
        )}

        {!loading && audiences.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{isAr ? 'الجمهور' : 'Audience'}</th>
                    <th>{isAr ? 'التفاصيل' : 'Details'}</th>
                    <th style={{ width: 60 }}>{isAr ? 'نشط' : 'Active'}</th>
                    <th style={{ width: 70 }} />
                  </tr>
                </thead>
                <tbody>
                  {audiences.map((a) => (
                    <tr key={a.id} style={a.is_active ? undefined : { opacity: 0.55 }}>
                      <td className="ttl">
                        {a.name}
                        {a.meta_saved_audience_id && (
                          <span className="tag" style={{ marginInlineStart: 6, fontSize: 10 }}>
                            {isAr ? 'ميتا' : 'Meta'}
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--mute)', maxWidth: 420 }}>
                        {a.details && a.details.trim() !== ''
                          ? (a.details.length > 140 ? `${a.details.slice(0, 140)}…` : a.details)
                          : '—'}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`sw${a.is_active ? ' on' : ''}`}
                          disabled={!canManage}
                          aria-label={isAr ? 'تفعيل الجمهور' : 'Toggle the audience'}
                          onClick={() => void toggleActive(a)}
                        />
                      </td>
                      <td>
                        {canManage && (
                          <button type="button" className="btn btn-sm" onClick={() => { setEditingId(a.id); setLoadedFor(null); }}>
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
                ? `${isAr ? 'تعديل' : 'Edit'} · ${editing.name}`
                : (isAr ? 'جمهور جديد' : 'New audience')}</h4>
            </div>
            <div className="card-b" style={{ display: 'grid', gap: 13 }}>
              <Field label={isAr ? 'الاسم' : 'Name'}>
                <input className="inp" value={dName} onChange={(e) => setDName(e.target.value)} />
              </Field>
              <Field label={isAr ? 'التفاصيل' : 'Details'}>
                <textarea
                  className="inp"
                  rows={6}
                  placeholder={isAr ? 'من هم، وما الذي يحرّكهم، وأين نجدهم…' : 'Who they are, what moves them, where to find them…'}
                  value={dDetails}
                  onChange={(e) => setDDetails(e.target.value)}
                />
              </Field>
              {metaLoaded && (
                <Field
                  label={isAr ? 'جمهور ميتا (اختياري)' : 'Meta audience (optional)'}
                  hint={isAr
                    ? 'عند «الإنشاء في ميتا» يُرسَل استهداف هذا الجمهور للمجموعة الإعلانية'
                    : 'on "Create in Meta", this audience’s targeting is sent to the ad set'}
                >
                  {metaAudiences.length > 0 ? (
                    <select className="inp" value={dMetaId} onChange={(e) => setDMetaId(e.target.value)}>
                      <option value="">{isAr ? 'بدون ربط — استهداف افتراضي (السعودية)' : 'Not linked — default targeting (KSA)'}</option>
                      {metaAudiences.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.85 }}>
                      {isAr
                        ? 'لا توجد جماهير محفوظة في ميتا بعد. أنشئ «Saved Audience» في مدير إعلانات ميتا لتظهر هنا وتُربط.'
                        : 'No Saved Audiences in Meta yet. Create one in Ads Manager to link it here.'}
                    </div>
                  )}
                </Field>
              )}
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
