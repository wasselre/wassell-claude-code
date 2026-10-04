/**
 * The client's SAVED profile, for the WhatsApp sales agent (2026-10-04).
 *
 * Before this the agent rebuilt the customer from scratch every conversation
 * and never looked at what was already on the client — preferences a rep
 * typed, or that the chat/call readers saved (autoSave.ts). Now each turn starts
 * from the profile: it is shown to the agent as state, and `saved_area` lets a
 * search use the client's saved places (location_items) through the same
 * matcher the area reader uses (`sales_agent_geo_match`).
 *
 * Read-only. One client read per turn. A chat with no linked client ⇒ null.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseLocationItems, type LocationItem } from '../../../src/lib/geo/locationItems.js';
import { asRangeValue, asSetValue } from '../../../src/lib/clientPrefs/mergePrefs.js';

export interface SavedProfile {
  clientId: string;
  /** One English state line for the agent (empty profile ⇒ null). */
  line: string | null;
  items: LocationItem[];
  placeLabels: string[];
}

const PURPOSE_AR: Record<string, string> = { residential: 'سكن', investment: 'استثمار' };

const itemLabel = (it: LocationItem): string => {
  const o = it as LocationItem & { district_label?: string; element_label?: string; label?: string };
  return (o.district_label || o.label || o.element_label || '').trim();
};

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
function rangeText(v: unknown, unit = ''): string | null {
  const r = asRangeValue(v);
  if (!r) return null;
  if (r.min && r.max) return `${fmt(r.min)}–${fmt(r.max)}${unit}`;
  if (r.max) return `up to ${fmt(r.max)}${unit}`;
  return `from ${fmt(r.min!)}${unit}`;
}

/** PURE — the profile line from a client's data (exported for tests). */
export function profileLine(d: Record<string, unknown>): { line: string | null; items: LocationItem[]; placeLabels: string[] } {
  const items = parseLocationItems(d.location_items);
  const wanted = items.filter((i) => i.polarity !== 'exclude').map(itemLabel).filter(Boolean);
  const avoided = items.filter((i) => i.polarity === 'exclude').map(itemLabel).filter(Boolean);
  const parts = [
    asSetValue(d.preferred_unit_type).length ? `unit type: ${asSetValue(d.preferred_unit_type).join('/')}` : null,
    rangeText(d.budget) ? `budget: ${rangeText(d.budget)} SAR` : null,
    rangeText(d.preferred_bedrooms) ? `bedrooms: ${rangeText(d.preferred_bedrooms)}` : null,
    rangeText(d.preferred_area) ? `size: ${rangeText(d.preferred_area, ' m²')}` : null,
    asSetValue(d.purchase_objective).length ? `purpose: ${asSetValue(d.purchase_objective).map((p) => PURPOSE_AR[p] ?? p).join('/')}` : null,
    asSetValue(d.preferred_amenities).length ? `wants: ${asSetValue(d.preferred_amenities).join('، ')}` : null,
    wanted.length ? `places: ${wanted.slice(0, 8).join('، ')}` : null,
    avoided.length ? `avoids: ${avoided.slice(0, 5).join('، ')}` : null,
  ].filter(Boolean);
  if (!parts.length) return { line: null, items, placeLabels: wanted };
  return {
    line: `SAVED CLIENT PROFILE (from the CRM — reps and our chat/call readers fill it; it may be older than this conversation): ${parts.join(' · ')}. Use it: search with it when they haven't said otherwise (saved_area=true searches the saved places), don't ask what it already answers, and follow what they say NOW when it differs.`,
    items,
    placeLabels: wanted,
  };
}

/** The saved profile of the chat's client. A read error throws. */
export async function loadSavedProfile(svc: SupabaseClient, clientId: string | null): Promise<SavedProfile | null> {
  if (!clientId) return null;
  const { data, error } = await svc.from('records').select('data').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`saved profile read failed: ${error.message}`);
  if (!data) return null;
  const p = profileLine(((data as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>);
  return { clientId, ...p };
}
