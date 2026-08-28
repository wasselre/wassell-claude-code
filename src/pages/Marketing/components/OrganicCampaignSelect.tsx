/**
 * The organic-campaign picker for a placement (2026-08-28).
 *
 * An organic placement may belong to an organic campaign — existing, created
 * inline, or none. Self-contained: fetches the organic campaigns on mount and
 * creates a new one via `saveCampaign({ kind:'organic' })`. Used by the merged
 * Placements/Publishing editor.
 */
import { useEffect, useState } from 'react';
import { MosCampaign, fetchCampaigns, saveCampaign } from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';

export default function OrganicCampaignSelect({
  value, isAr, onChange,
}: {
  value: string;
  isAr: boolean;
  onChange: (id: string) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchCampaigns()
      .then((r) => { if (alive) setCampaigns(r.campaigns.filter((c) => c.kind === 'organic' && c.status !== 'cancelled')); })
      .catch(() => { /* the picker just shows "no campaign" — non-fatal */ });
    return () => { alive = false; };
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
