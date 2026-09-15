/**
 * The organic-campaign picker for a placement (2026-08-28).
 *
 * An organic placement may belong to an organic campaign — an existing one, or
 * none. Self-contained: it fetches the organic campaigns on mount.
 *
 * CHANGED 2026-09-15 — **the inline "＋ new organic campaign" text field is
 * gone.** It was one input that created a live campaign record straight from a
 * placement editor: no brief, no projects, no dates, no budget, no plan, no
 * capacity reservation, nothing the rest of the system expects a campaign to
 * carry. Every rule the month model enforces was bypassed by typing a name
 * here and pressing Create. A campaign is now made where campaigns are made —
 * the month page, or the campaigns screen under «متقدّم» — and this control
 * only ever points at one that already exists.
 *
 * `defaultCampaignId` pre-selects the creative's own organic campaign for a NEW
 * placement (its provenance — "where it was born"), so a post created inside an
 * organic campaign starts linked to it instead of blank. It is applied ONLY when
 * the field is still empty AND the id resolves to a loaded organic campaign — a
 * creative born in a PAID campaign therefore stays "no campaign", never mis-filled.
 * The user can still change it to any other organic campaign or none.
 */
import { useEffect, useRef, useState } from 'react';
import { MosCampaign, fetchCampaigns } from '@/lib/marketingOS/client';

export default function OrganicCampaignSelect({
  value, isAr, onChange, defaultCampaignId,
}: {
  value: string;
  isAr: boolean;
  onChange: (id: string) => void;
  /** The creative's provenance campaign — pre-selected for a new placement. */
  defaultCampaignId?: string | null;
}) {
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
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

  return (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{isAr ? 'بدون حملة' : 'No campaign'}</option>
      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
