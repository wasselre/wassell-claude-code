import type { CallGeoDTO, CallProposalDTO } from '../components/PrefSuggestionsSection';

/** One call in the call-audit section: its preference proposal and / or its places. */
export interface CallBlockData {
  key: string;
  callAt: string | null;
  pref: CallProposalDTO | null;
  geo: CallGeoDTO | null;
}

/**
 * PURE: group the call audit's preference proposals and place proposals by
 * call, newest call first. A superseded preference proposal is dropped (as
 * before); a call with neither left is not shown.
 */
export function groupCallBlocks(proposals: readonly CallProposalDTO[], geo: readonly CallGeoDTO[]): CallBlockData[] {
  const byKey = new Map<string, CallBlockData>();
  const get = (key: string): CallBlockData => {
    let b = byKey.get(key);
    if (!b) { b = { key, callAt: null, pref: null, geo: null }; byKey.set(key, b); }
    return b;
  };
  for (const p of proposals) {
    if (p.status === 'superseded') continue;
    const b = get(p.call_id ?? `proposal:${p.id}`);
    if (!b.pref) { b.pref = p; b.callAt = b.callAt ?? p.call_at ?? p.created_at; }
  }
  for (const g of geo) {
    const b = get(g.call_id);
    if (!b.geo) { b.geo = g; b.callAt = b.callAt ?? g.call_at; }
  }
  const t = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0);
  return [...byKey.values()].sort((a, b) => t(b.callAt) - t(a.callAt));
}
