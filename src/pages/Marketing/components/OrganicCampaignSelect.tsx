/**
 * The organic-campaign picker for a placement (2026-08-28).
 *
 * An organic placement may belong to an organic campaign — existing, created
 * inline, or none. Self-contained: fetches the organic campaigns on mount and
 * creates a new one via `saveCampaign({ kind:'organic' })`. Used by the merged
 * Placements/Publishing editor.
 *
 * `defaultCampaignId` pre-selects the creative's own organic campaign for a NEW
 * placement (its provenance — "where it was born"), so a post created inside an
 * organic campaign starts linked to it instead of blank. It is applied ONLY when
 * the field is still empty AND the id resolves to a loaded organic campaign — a
 * creative born in a PAID campaign therefore stays "no campaign", never mis-filled.
 * The user can still change it to any other organic campaign or none.
 */
import { useEffect, useRef, useState } from 'react';
import { MosCampaign, fetchCampaigns, saveCampaign } from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';

export default function OrganicCampaignSelect({
  value, isAr, onChange, defaultCampaignId,
}: {
  value: string;
  isAr: boolean;
  onChange: (id: string) => void;
  /** The creative's provenance campaign — pre-selected for a new placement. */
  defaultCampaignId?: string | null;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // The default is a one-shot: apply it at most once, so once the user clears
  // the field back to "no campaign" it does not snap back to the default.
  const defaultAppliedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetchCampaigns()
      .then((r) => {
        if (!alive) return;
        const organic = r.campaigns.filter((c) => c.kind === 'organic' && c.status !== 'cancelled');
        setCampaigns(organic);
        // Pre-select the provenance campaign, but only if it is a real organic
        // one and the field has not been touched yet.
        if (
          !defaultAppliedRef.current && !value && defaultCampaignId
          && organic.some((c) => c.id === defaultCampaignId)
        ) {
          defaultAppliedRef.current = true;
          onChange(defaultCampaignId);
        }
      })
      .catch(() => { /* the picker just shows "no campaign" — non-fatal */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await saveCampaign({ name: name.trim(), kind: 'organic' });
      setCampaigns((prev) => [res.item, ...prev]);
      onChange(res.item.id);
      setCreating(false);
      setName('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };

  if (creating) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="inp"
          style={{ fontSize: 12.5 }}
          value={name}
          placeholder={isAr ? 'اسم الحملة العضوية' : 'Organic campaign name'}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button type="button" className="btn btn-p btn-sm" onClick={() => void create()} disabled={busy}>
          {busy ? '…' : (isAr ? 'إنشاء' : 'Create')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setCreating(false)} disabled={busy}>×</button>
      </div>
    );
  }

  return (
    <select
      className="inp"
      value={value}
      onChange={(e) => { if (e.target.value === '__new__') setCreating(true); else onChange(e.target.value); }}
    >
      <option value="">{isAr ? 'بدون حملة' : 'No campaign'}</option>
      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value="__new__">{isAr ? '＋ حملة عضوية جديدة' : '＋ New organic campaign'}</option>
    </select>
  );
}
