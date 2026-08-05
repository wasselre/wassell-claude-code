/**
 * The campaign brief's «الجمهور» picker.
 *
 * An audience is a SAVED, reusable record — a title (`name`) plus a large details
 * field — kept in the managed registry (`mos_audiences`). On the brief you PICK an
 * existing audience OR define a NEW one inline; the new one persists to the
 * registry so it is reusable next time and appears in Settings → Audiences.
 *
 * Same "managed registry + inline create" posture as SuccessMeasuresEditor, minus
 * the bilingual name (an audience is single-language free text, like goal/offer).
 * The chosen record's NAME is snapshotted onto the campaign server-side so every
 * read surface renders a concise label without a join.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { MosAudience, fetchAudiences, saveAudience } from '@/lib/marketingOS/client';

const NEW = '__new__';
const NONE = '';

export default function AudiencePicker({
  audienceId, legacyText, onChange, isAr,
}: {
  /** The currently chosen saved audience, or null when none / legacy free text. */
  audienceId: string | null;
  /** The campaign's snapshotted `audience` text — shown as a hint for legacy
   *  campaigns that predate saved audiences (audienceId is null but text exists). */
  legacyText: string | null;
  onChange: (id: string | null) => void;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [audiences, setAudiences] = useState<MosAudience[]>([]);

  // The inline "new audience" form.
  const [creating, setCreating] = useState(false);
  const [nName, setNName] = useState('');
  const [nDetails, setNDetails] = useState('');
  const [saving, setSaving] = useState(false);

  const active = audiences.filter((a) => a.is_active);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchAudiences();
        if (!cancelled) setAudiences(res.audiences);
      } catch (e) {
        // Non-fatal: the campaign still saves; the picker just can't list yet.
        // Surfaced, not swallowed.
        console.error('[marketing] audiences unavailable', e);
        if (!cancelled) {
          addToast(isAr ? 'تعذّر تحميل الجماهير المحفوظة.' : 'Could not load the saved audiences.', 'error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [addToast, isAr]);

  const selected = audienceId ? audiences.find((a) => a.id === audienceId) ?? null : null;

  const onSelect = (value: string): void => {
    if (value === NEW) {
      setCreating(true);
      setNName('');
      setNDetails('');
      return;
    }
    setCreating(false);
    onChange(value === NONE ? null : value);
  };

  const createAudience = async (): Promise<void> => {
    if (!nName.trim()) {
      addToast(isAr ? 'اكتب اسم الجمهور.' : 'Give the audience a name.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await saveAudience({
        name: nName.trim(),
        details: nDetails.trim() || null,
        sort_order: Math.max(0, ...audiences.map((a) => a.sort_order)) + 10,
        is_active: true,
      });
      setAudiences(res.audiences);
      // The new record is the one not present before — match by name+details, or
      // fall back to the newest active row the list just returned.
      const created = res.audiences.find((a) => a.name === nName.trim()
        && (a.details ?? '') === (nDetails.trim() || '')) ?? null;
      if (created) onChange(created.id);
      setCreating(false);
      addToast(isAr ? 'أُضيف الجمهور.' : 'Audience added.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 9 }}>
      <select
        className="inp"
        value={creating ? NEW : (audienceId ?? NONE)}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value={NONE}>{isAr ? '— بدون —' : '— None —'}</option>
        {active.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
        {/* A chosen audience that is no longer active still shows so the campaign
            keeps its selection. */}
        {selected && !active.some((a) => a.id === selected.id) && (
          <option value={selected.id}>{selected.name}</option>
        )}
        <option value={NEW}>{isAr ? '＋ جمهور جديد…' : '＋ New audience…'}</option>
      </select>

      {/* Legacy free-text audience (predates saved audiences): show it so it is
          not silently lost, and nudge the user to pick or create a saved one. */}
      {!creating && !selected && legacyText && legacyText.trim() !== '' && (
        <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.6 }}>
          {isAr ? 'النص الحالي: ' : 'Current text: '}
          <span style={{ color: 'var(--ink)' }}>{legacyText}</span>
          <br />
          {isAr
            ? 'اختر جمهورًا محفوظًا أو أنشئ واحدًا جديدًا لحفظه للحملات القادمة.'
            : 'Pick a saved audience or create a new one to reuse it next time.'}
        </div>
      )}

      {/* The chosen audience's details, read-only. */}
      {!creating && selected && selected.details && selected.details.trim() !== '' && (
        <div
          style={{
            fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.7, whiteSpace: 'pre-wrap',
            background: 'var(--sand-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px',
          }}
        >
          {selected.details}
        </div>
      )}

      {/* The inline "new audience" form. */}
      {creating && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '11px 13px', display: 'grid', gap: 9, background: 'var(--sand-2)' }}>
          <input
            className="inp"
            placeholder={isAr ? 'اسم الجمهور' : 'Audience name'}
            value={nName}
            onChange={(e) => setNName(e.target.value)}
          />
          <textarea
            className="inp"
            rows={4}
            placeholder={isAr ? 'تفاصيل الجمهور — من هم، وما الذي يحرّكهم…' : 'Audience details — who they are, what moves them…'}
            value={nDetails}
            onChange={(e) => setNDetails(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 9 }}>
            <button type="button" className="btn btn-p btn-sm" onClick={() => void createAudience()} disabled={saving}>
              {saving ? (isAr ? 'جارٍ الإضافة…' : 'Adding…') : (isAr ? 'إضافة الجمهور' : 'Add audience')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setCreating(false)} disabled={saving}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
