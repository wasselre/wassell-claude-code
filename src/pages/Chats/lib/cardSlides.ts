import { PREF_SLUG_ORDER } from '@/lib/clientPrefs/mergePrefs';
import { num } from '@/pages/Marketing/lib/format';
import type { CallGeoDTO, CallProposalDTO, PrefsCardDTO } from '../components/PrefSuggestionsSection';
import { buildGeoRows, GEO_OPEN, type GeoCardDTO } from './geoRows';
import { groupCallBlocks } from './callBlocks';

/**
 * The «تفضيلات العميل» card as a slider: ONE slide per topic the rep can still
 * act on — the chat's open places, the chat's pending preferences, and per call
 * (newest first) the audit's open places and pending preferences. Decided,
 * superseded and empty things are NOT slides. PURE.
 */

export type CardSlide =
  | { kind: 'chat-places'; key: 'chat-places'; proposalId: string; count: number; callAt: null }
  | { kind: 'chat-specs'; key: 'chat-specs'; proposalId: string; count: number; callAt: null }
  | { kind: 'call-places'; key: string; callId: string; callAt: string | null; proposalId: string; count: number; geo: CallGeoDTO }
  | { kind: 'call-specs'; key: string; callId: string; callAt: string | null; proposalId: string; count: number; proposal: CallProposalDTO };

export type CardSlideKind = CardSlide['kind'];

/** The card DTO the slides are built from (api/geo-preference/chat-card). */
export interface SlideSourceDTO extends GeoCardDTO {
  prefs: PrefsCardDTO | null | undefined;
}

/** How many preference lines a proposal carries (the ones the card renders). */
export function prefLineCount(suggestions: Record<string, unknown> | null | undefined): number {
  if (!suggestions) return 0;
  return PREF_SLUG_ORDER.filter((slug) => suggestions[slug]).length;
}

/** The call's own place proposal, only when the audit minted it and it is still open. */
function openCallGeo(g: CallGeoDTO): { id: string; rows: number } | null {
  const p = g.card.proposal;
  if (!p || p.id !== g.proposal_id || !GEO_OPEN.has(p.status)) return null;
  const rows = buildGeoRows(g.card, false).length;
  return rows > 0 ? { id: p.id, rows } : null;
}

export function buildCardSlides(card: SlideSourceDTO | null): CardSlide[] {
  if (!card) return [];
  const out: CardSlide[] = [];

  if (card.proposal && GEO_OPEN.has(card.status)) {
    const rows = buildGeoRows(card, false).length;
    if (rows > 0) out.push({ kind: 'chat-places', key: 'chat-places', proposalId: card.proposal.id, count: rows, callAt: null });
  }

  const pref = card.prefs?.proposal;
  if (pref && pref.status === 'pending') {
    const n = prefLineCount(pref.suggestions);
    if (n > 0) out.push({ kind: 'chat-specs', key: 'chat-specs', proposalId: pref.id, count: n, callAt: null });
  }

  for (const b of groupCallBlocks(card.prefs?.call_proposals ?? [], card.prefs?.call_geo ?? [])) {
    if (b.geo) {
      const g = openCallGeo(b.geo);
      if (g) out.push({ kind: 'call-places', key: `call-places:${b.key}`, callId: b.key, callAt: b.callAt, proposalId: g.id, count: g.rows, geo: b.geo });
    }
    if (b.pref && b.pref.status === 'pending') {
      const n = prefLineCount(b.pref.suggestions);
      if (n > 0) out.push({ kind: 'call-specs', key: `call-specs:${b.key}`, callId: b.key, callAt: b.callAt, proposalId: b.pref.id, count: n, proposal: b.pref });
    }
  }
  return out;
}

/** What the rep did to a slide this session — shown in place of its body until the card is re-read. */
export interface SlideDone {
  action: 'saved' | 'dismissed';
  /** Call preferences: fields skipped at save because they were logged since the call. */
  skipped?: string[];
  /** Call preferences: the save added nothing (every field had been logged since the call). */
  nothingAdded?: boolean;
}

export interface DoneEntry { slide: CardSlide; done: SlideDone }
export type VisibleSlide = CardSlide & { done?: SlideDone };

const RANK: Record<CardSlideKind, number> = { 'chat-places': 0, 'chat-specs': 1, 'call-places': 2, 'call-specs': 2 };
const time = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0);

/** The card's slide order: chat places, chat specs, then calls newest first (places before specs). 0 on a tie. */
export function compareSlides(a: CardSlide, b: CardSlide): number {
  if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] - RANK[b.kind];
  if (RANK[a.kind] < 2) return 0;
  const dt = time(b.callAt) - time(a.callAt);
  if (dt !== 0) return dt;
  if ('callId' in a && 'callId' in b && a.callId === b.callId) {
    return (a.kind === 'call-places' ? 0 : 1) - (b.kind === 'call-places' ? 0 : 1);
  }
  return 0;
}

/**
 * The slides to show: the fresh ones, plus the ones the rep decided this
 * session (which the post-decision reload no longer returns) in their old
 * place, rendered as a compact done state. A fresh slide with the same key but
 * a DIFFERENT proposal (a new reading) wins over the done one.
 */
export function mergeDoneSlides(fresh: readonly CardSlide[], done: Readonly<Record<string, DoneEntry>>): VisibleSlide[] {
  const out: VisibleSlide[] = fresh.map((s) => {
    const d = done[s.key];
    return d && d.slide.proposalId === s.proposalId ? { ...s, done: d.done } : s;
  });
  const freshKeys = new Set(fresh.map((s) => s.key));
  for (const [key, d] of Object.entries(done)) {
    if (freshKeys.has(key)) continue;
    out.push({ ...d.slide, done: d.done });
  }
  // Array.prototype.sort is stable, so ties keep the fresh order.
  return out.sort(compareSlides);
}

/** «٣١/٨» / "8/31" — a call's day and month for its pill (Gregorian). */
export function callDayMonth(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return isAr ? `${num(d.getDate(), true)}/${num(d.getMonth() + 1, true)}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
