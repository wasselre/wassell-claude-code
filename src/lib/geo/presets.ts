/**
 * Reusable, TEAM-SHARED geographical presets — a named bundle of location
 * preferences (`location_items`) that a rep saves once (e.g. «أحياء شرق الرياض»)
 * and applies to any client. Backed by the `preference_presets` table.
 *
 * Presets carry GEOGRAPHY ONLY (the district / drawn-area / element rules), plus
 * the city they belong to, because that is the tedious-to-rebuild part and the
 * only part where city-filtering is meaningful. Budget / unit-type / amenities
 * live on the per-client preference PROFILES, not on a shared preset.
 *
 * This talks to Supabase directly (RLS-gated), mirroring the geo feature's own
 * `searchGeoElements` client rather than routing through the app store — presets
 * are a small ancillary library loaded on demand by the picker, not reactive
 * record data. When Supabase is not configured (offline mode) the library is
 * simply unavailable; failures are surfaced, never swallowed.
 */
import { supabase } from '@/lib/supabase';
import type { LocationItem } from '@/lib/geo/locationItems';
import { parseLocationItems } from '@/lib/geo/locationItems';

export interface GeoPreset {
  id: string;
  name: string;
  /** District city id these items belong to; null for element-only (city-agnostic) presets. */
  city_id: string | null;
  /** ISO-3166-1 alpha-2 country, when known — a secondary scope for the picker. */
  country_code: string | null;
  items: LocationItem[];
  created_by_user_id: string | null;
  created_at: string | null;
}

interface PresetRow {
  id: string;
  name: string;
  city_id: string | null;
  country_code: string | null;
  items: unknown;
  created_by_user_id: string | null;
  created_at: string | null;
}

const rowToPreset = (r: PresetRow): GeoPreset => ({
  id: r.id,
  name: typeof r.name === 'string' ? r.name : '',
  city_id: r.city_id ?? null,
  country_code: r.country_code ?? null,
  items: parseLocationItems(r.items),
  created_by_user_id: r.created_by_user_id ?? null,
  created_at: r.created_at ?? null,
});

/**
 * List saved presets, newest first. The whole shared library is returned; the
 * picker does the city-relevance filtering client-side (so an element-only
 * preset stays visible for any client). Returns [] when Supabase is absent.
 */
export async function listGeoPresets(): Promise<GeoPreset[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('preference_presets')
    .select('id, name, city_id, country_code, items, created_by_user_id, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data as PresetRow[] | null ?? []).map(rowToPreset);
}

export interface SaveGeoPresetArgs {
  name: string;
  cityId: string | null;
  countryCode?: string | null;
  items: LocationItem[];
}

/**
 * Create a shared preset from the given location items. Stamps the current
 * auth user as the creator (owner-only delete). Returns the created preset.
 */
export async function saveGeoPreset(args: SaveGeoPresetArgs): Promise<GeoPreset> {
  if (!supabase) throw new Error('offline: cannot save a preset');
  const name = args.name.trim();
  if (!name) throw new Error('preset name required');
  const uid = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  const { data, error } = await supabase
    .from('preference_presets')
    .insert({
      name,
      city_id: args.cityId,
      country_code: args.countryCode ?? null,
      items: args.items,
      created_by_user_id: uid,
    })
    .select('id, name, city_id, country_code, items, created_by_user_id, created_at')
    .single();
  if (error) throw new Error(error.message);
  return rowToPreset(data as PresetRow);
}

/** Delete a preset (RLS allows the creator or an admin only). */
export async function deleteGeoPreset(id: string): Promise<void> {
  if (!supabase) throw new Error('offline: cannot delete a preset');
  const { error } = await supabase.from('preference_presets').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
