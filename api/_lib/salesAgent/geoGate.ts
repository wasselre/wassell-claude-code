/**
 * Location understanding for the sales agent — through the EXISTING geography
 * agent (api/_lib/geoPreference), not a second implementation.
 *
 * The same pipeline as the reps' «تفضيلات العميل» card reads the conversation:
 * extract (geo-extract) → company rules → resolve every place (districts, city
 * zones, road sides as bounded bands, districts clipped to a road side,
 * landmarks, refusals) → compile → location_items (the review endpoint's own
 * mapping). The items then pick projects through the Project Finder's matcher
 * (sales_agent_geo_match, under a throwaway key).
 *
 * NOTHING is written: the proposal goes to an in-memory store, no evidence is
 * persisted, no client record or client geometry is touched. A reading is
 * cached per conversation text for the rest of the process's turn.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { makeSupabaseBackfillDeps, hydrateClipGeometry } from '../geoPreference/backfillPorts.js';
import type { Conversation } from '../geoPreference/extractor.js';
import type { ProposalInput, ProposalRecord, ProposalStore } from '../geoPreference/orchestrator.js';
import { geoPreferenceToLocationItems, summarizeGeometry } from '../../geo-preference/review.js';
import { newDistrictItem } from '../../../src/lib/geo/locationItems.js';
import { districtsInText } from './districtNames.js';

export interface GeoReading {
  /** Master project ids inside the area; null = nothing usable was understood. */
  ids: Set<string> | null;
  /** What was understood, as the agent may say it: «غرب طريق الملك فهد» … */
  understood: Array<{ place: string; wanted: boolean; kind: string; radius_m: number | null }>;
  /** Places understood but not resolvable to the map yet. */
  needs_review: number;
}

const NIL_CLIENT = '00000000-0000-0000-0000-000000000000';
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<GeoReading> }>();
let deps: ReturnType<typeof makeSupabaseBackfillDeps> | null = null;

function memoryStore(): ProposalStore {
  return {
    async createProposal(input: ProposalInput): Promise<ProposalRecord> {
      return { ...input, id: `sales-agent-${Date.now()}`, status: 'pending' };
    },
  };
}

export async function readLocation(
  svc: SupabaseClient,
  turns: Array<{ who: 'customer' | 'us'; text: string }>,
  clientId: string | null,
): Promise<GeoReading> {
  const conv: Conversation = {
    channel: 'chat',
    id: 'sales-agent',
    turns: turns.slice(-60).map((t) => ({ speaker: t.who === 'customer' ? 'client' : 'agent', text: t.text })),
  };
  const key = createHash('sha1').update(`${clientId ?? ''}|${JSON.stringify(conv.turns)}`).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = run(svc, conv, clientId);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** What the geography agent understood, as location_items + plain labels. */
export interface PlaceItemsReading {
  items: import('../../../src/lib/geo/locationItems.js').LocationItem[];
  understood: GeoReading['understood'];
}

/**
 * Text → the client's places as location_items, through the SAME geography
 * pipeline as {@link readLocation} (extract → company rules → resolve → compile),
 * without matching projects. Used by the rep's free-text preference box
 * (api/client-prefs/from-text.ts): the rep's note is read as the client's words.
 * Writes nothing.
 */
export async function readPlaceItems(svc: SupabaseClient, text: string, clientId: string | null): Promise<PlaceItemsReading> {
  const conv: Conversation = { channel: 'chat', id: 'rep-note', turns: [{ speaker: 'client', text }] };
  return compilePlaces(svc, conv, clientId);
}

async function compilePlaces(svc: SupabaseClient, conv: Conversation, clientId: string | null): Promise<PlaceItemsReading> {
  deps ??= makeSupabaseBackfillDeps(svc, 'sales-agent');
  const extracted = await deps.extract(conv);
  const ctx = await deps.buildRunContext(clientId ?? NIL_CLIENT, extracted.evidence.length);
  // The customer's own turns join each mention's texts, exactly as the places
  // card does (chatCard.ts). Without them the «او» before a road side is
  // invisible (offeredAsAlternative reads the turn), so «النرجس او شمال طريق
  // الملك سلمان» was distributed into "Narjis north of the road" and the
  // alternative was lost (found 2026-10-04).
  ctx.conversation = conv;
  // «قريب من X» with no distance: assume 3 km for a landmark, 1 km for a metro
  // station (operator, 2026-10-04) — the same numbers as the near tool (brain
  // rule 6e). The agent says it back. A copy, never a mutation: the places card
  // must keep asking.
  ctx.resolution = { ...ctx.resolution, default_near_radius_m: { landmark: 3000, metro: 1000 } };
  const result = await deps.runReviewFirst(extracted.evidence, extracted.relations, ctx, { proposals: memoryStore() });
  const compiled = result.compiled;
  await hydrateClipGeometry(svc, compiled);
  const understood = summarizeGeometry(compiled).map((e) => ({
    place: e.label, wanted: e.polarity === 'include', kind: String(e.operation), radius_m: e.radius_m,
  }));
  return { items: geoPreferenceToLocationItems(compiled), understood };
}

async function run(svc: SupabaseClient, conv: Conversation, clientId: string | null): Promise<GeoReading> {
  if (!conv.turns.some((t) => t.speaker === 'client')) return { ids: null, understood: [], needs_review: 0 };
  let { items, understood } = await compilePlaces(svc, conv, clientId);
  if (!items.some((i) => i.polarity !== 'exclude')) {
    // Nothing usable from the reader → plain district names in the customer's
    // own recent messages (districtNames.ts). «المصيف» / «الصفا و الفاروق».
    const recent = conv.turns.filter((t) => t.speaker === 'client').slice(-8).map((t) => t.text);
    const named = await districtsInText(svc, recent);
    if (!named.length) return { ids: null, understood, needs_review: 0 };
    items = [...items, ...named.map((d) => newDistrictItem(d.id, d.label, 'include'))];
    understood = [...new Map(named.map((d) => [d.label, { place: d.label, wanted: true, kind: 'district', radius_m: null }])).values()];
  }
  const { data, error } = await svc.rpc('sales_agent_geo_match', { p_items: items });
  if (error) throw new Error(`geo match failed: ${error.message}`);
  const r = (data ?? {}) as { ids?: string[]; includes?: number; needs_review?: number };
  if (!Number(r.includes ?? 0)) return { ids: null, understood, needs_review: Number(r.needs_review ?? 0) };
  return { ids: new Set((r.ids ?? []).filter(Boolean)), understood, needs_review: Number(r.needs_review ?? 0) };
}

/** Which side of a road each point is on (the matcher's own rule), and how far. */
export async function sideOfRoad(
  svc: SupabaseClient, points: Array<{ id: string; lat: number; lng: number }>, roadIds: string[],
): Promise<Array<{ id: string; side: string; km: number }>> {
  const { data, error } = await svc.rpc('sales_agent_side_of_road', { p_points: points, p_road_ids: roadIds });
  if (error) throw new Error(`side of road failed: ${error.message}`);
  return ((data ?? []) as Array<{ point_id: string; main_side: string; km: number | string }>).map((r) => ({
    id: r.point_id, side: r.main_side, km: typeof r.km === 'number' ? r.km : parseFloat(r.km),
  }));
}

/**
 * The client's SAVED places (location_items) → the projects inside them, through
 * the same matcher as {@link readLocation}. null ids = nothing usable saved.
 */
export async function matchSavedPlaces(
  svc: SupabaseClient, items: import('../../../src/lib/geo/locationItems.js').LocationItem[], labels: string[],
): Promise<GeoReading> {
  const understood = labels.map((l) => ({ place: l, wanted: true, kind: 'saved', radius_m: null }));
  if (!items.some((i) => i.polarity !== 'exclude')) return { ids: null, understood, needs_review: 0 };
  const { data, error } = await svc.rpc('sales_agent_geo_match', { p_items: items });
  if (error) throw new Error(`saved places match failed: ${error.message}`);
  const r = (data ?? {}) as { ids?: string[]; includes?: number; needs_review?: number };
  if (!Number(r.includes ?? 0)) return { ids: null, understood, needs_review: Number(r.needs_review ?? 0) };
  return { ids: new Set((r.ids ?? []).filter(Boolean)), understood, needs_review: Number(r.needs_review ?? 0) };
}
