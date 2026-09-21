import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, MarkerF, Polygon, useJsApiLoader } from '@react-google-maps/api';
import { Compass, Eraser, Loader2, Plus, RotateCcw, Save, Search, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import BackToSettings from './components/BackToSettings';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, buildPillIcon } from '@/lib/locationUtils';
import { GRADER_MAP_STYLE } from '@/pages/GeoGrade/components/GeoPrefMap';
import { geojsonToPaths, type GeoJsonGeometry } from '@/lib/geo/geojsonPaths';
import { ZONES, zoneLabel, type Zone } from '@/lib/market/zones';

/**
 * Settings → City Zones (admin).
 *
 * What «شمال الرياض» means is DATA, not a coordinate rule. The resolver
 * (public.wassell_city_zone_districts) already prefers curated
 * geo_zone_overrides rows over the geometric centroid bands; until now those
 * rows could only be written by a migration. This page is their editor.
 *
 * Operator's words (2026-09-21): "what is known as the north district of Riyadh
 * is different from the districts you selected, which are in the north of
 * Riyadh on paper. […] For every city we do NOT define, use the default based
 * on coordinates. For cities we DO define, use those."
 *
 * Every read goes through a STABLE SECURITY DEFINER RPC; the single write goes
 * through wassell_zone_override_set, which is admin-gated server-side (RLS on
 * geo_zone_overrides stays SELECT-only). Saving an EMPTY set clears the
 * curation, i.e. hands the zone back to the coordinate default.
 *
 * ID NOTE: districts.city_id is the SPL city CODE ('3' = الرياض) and is what
 * geo_zone_overrides keys on; districts.city_lookup is the cities record uuid
 * and is what wassell_city_district_shapes wants. They are different values —
 * wassell_zone_cities() returns both, and this page keeps them apart.
 */

const COPPER = '#B8734F';
const CHOCOLATE = '#4A2C2A';
const SAND = '#D4B896';

/** The 3×3 compass grid, laid out visually. Same nine zones as ZONES. */
const COMPASS_GRID: Zone[][] = [
  ['northwest', 'north', 'northeast'],
  ['west', 'center', 'east'],
  ['southwest', 'south', 'southeast'],
];

/** Long-form zone names for the compass buttons (ZONE_LABELS is the short form). */
const ZONE_LONG: Record<Zone, { ar: string; en: string }> = {
  northwest: { ar: 'شمال غربي', en: 'North-west' },
  north: { ar: 'شمال', en: 'North' },
  northeast: { ar: 'شمال شرقي', en: 'North-east' },
  west: { ar: 'غرب', en: 'West' },
  center: { ar: 'الوسط', en: 'Center' },
  east: { ar: 'شرق', en: 'East' },
  southwest: { ar: 'جنوب غربي', en: 'South-west' },
  south: { ar: 'جنوب', en: 'South' },
  southeast: { ar: 'جنوب شرقي', en: 'South-east' },
};

interface ZoneCity {
  city_id: string;
  city_lookup: string;
  city_name_ar: string | null;
  city_name_en: string | null;
  district_count: number;
  curated_zones: string[];
}

interface RosterDistrict {
  id: string;
  name_ar: string | null;
  name_en: string | null;
}

interface ZoneState {
  curated: boolean;
  effective_ids: string[];
  default_ids: string[];
}

interface DistrictShape {
  district_id: string;
  name: string;
  name_en?: string | null;
  geojson: GeoJsonGeometry;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((v) => b.has(v));

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function GeoZonesPage() {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';

  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));

  const [cities, setCities] = useState<ZoneCity[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [cityId, setCityId] = useState<string>('');
  const [zone, setZone] = useState<Zone>('north');

  const [roster, setRoster] = useState<RosterDistrict[]>([]);
  const [shapes, setShapes] = useState<DistrictShape[]>([]);
  const [shapesLoading, setShapesLoading] = useState(false);

  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const [defaultIds, setDefaultIds] = useState<string[]>([]);
  const [curated, setCurated] = useState(false);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [stateLoading, setStateLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [filter, setFilter] = useState('');
  const [map, setMap] = useState<google.maps.Map | null>(null);

  const city = useMemo(() => cities.find((c) => c.city_id === cityId) ?? null, [cities, cityId]);
  const dirty = useMemo(() => !sameSet(working, baseline), [working, baseline]);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const cityLabel = useCallback(
    (c: ZoneCity) => (isAr ? c.city_name_ar || c.city_name_en || c.city_id : c.city_name_en || c.city_name_ar || c.city_id),
    [isAr],
  );

  // ── Cities ────────────────────────────────────────────────────────────────
  const loadCities = useCallback(async (): Promise<ZoneCity[]> => {
    if (!supabase) return [];
    const { data, error } = await supabase.rpc('wassell_zone_cities');
    if (error) throw new Error(error.message);
    const rows = (Array.isArray(data) ? data : []) as ZoneCity[];
    setCities(rows);
    return rows;
  }, []);

  useEffect(() => {
    if (!supabase) { setCitiesLoading(false); return; }
    let cancelled = false;
    setCitiesLoading(true);
    loadCities()
      .then((rows) => {
        if (cancelled) return;
        // Default to الرياض when present (the city this whole feature exists for),
        // else the largest city.
        const riyadh = rows.find((r) => r.city_name_ar === 'الرياض');
        setCityId(riyadh?.city_id ?? rows[0]?.city_id ?? '');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('[GeoZonesPage] wassell_zone_cities failed:', e);
        addToast(isAr ? `تعذّر تحميل المدن: ${errText(e)}` : `Loading cities failed: ${errText(e)}`, 'error');
      })
      .finally(() => { if (!cancelled) setCitiesLoading(false); });
    return () => { cancelled = true; };
  }, [loadCities, addToast, isAr]);

  // ── District roster + boundary shapes (per city) ──────────────────────────
  useEffect(() => {
    if (!supabase || !city) { setRoster([]); setShapes([]); return; }
    let cancelled = false;
    setShapesLoading(true);
    setShapes([]);
    setRoster([]);
    const rosterP = supabase.rpc('wassell_zone_city_districts', { p_city_id: city.city_id })
      .then(({ data, error }) => {
        if (error) throw new Error(`districts: ${error.message}`);
        return (Array.isArray(data) ? data : []) as RosterDistrict[];
      });
    const shapesP = supabase.rpc('wassell_city_district_shapes', { p_city_id: city.city_lookup })
      .then(({ data, error }) => {
        if (error) throw new Error(`shapes: ${error.message}`);
        return (Array.isArray(data) ? data : []) as DistrictShape[];
      });
    Promise.all([rosterP, shapesP])
      .then(([r, s]) => { if (!cancelled) { setRoster(r); setShapes(s); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Surface, never swallow — an empty map here would look like "this city
        // has no districts", which is a lie the operator would act on.
        console.error('[GeoZonesPage] city load failed:', e);
        addToast(isAr ? `تعذّر تحميل أحياء المدينة: ${errText(e)}` : `Loading city districts failed: ${errText(e)}`, 'error');
      })
      .finally(() => { if (!cancelled) setShapesLoading(false); });
    return () => { cancelled = true; };
  }, [city, addToast, isAr]);

  // ── Zone state (per city+zone) ────────────────────────────────────────────
  const loadZoneState = useCallback(async (cid: string, z: Zone) => {
    if (!supabase) return;
    setStateLoading(true);
    try {
      const { data, error } = await supabase.rpc('wassell_zone_state', { p_city_id: cid, p_zone: z });
      if (error) throw new Error(error.message);
      const st = (data ?? { curated: false, effective_ids: [], default_ids: [] }) as ZoneState;
      const eff = new Set(st.effective_ids ?? []);
      setBaseline(eff);
      setWorking(new Set(eff));
      setDefaultIds(st.default_ids ?? []);
      setCurated(Boolean(st.curated));
    } catch (e: unknown) {
      console.error('[GeoZonesPage] wassell_zone_state failed:', e);
      addToast(isAr ? `تعذّر تحميل حالة المنطقة: ${errText(e)}` : `Loading zone state failed: ${errText(e)}`, 'error');
    } finally {
      setStateLoading(false);
    }
  }, [addToast, isAr]);

  useEffect(() => { if (cityId) void loadZoneState(cityId, zone); }, [cityId, zone, loadZoneState]);

  // ── Guarded city / zone switching ─────────────────────────────────────────
  const confirmDiscard = (): boolean =>
    !dirtyRef.current ||
    window.confirm(isAr
      ? 'لديك تغييرات غير محفوظة في هذه المنطقة. هل تريد تجاهلها؟'
      : 'You have unsaved changes in this zone. Discard them?');

  const pickCity = (next: string) => { if (next !== cityId && confirmDiscard()) setCityId(next); };
  const pickZone = (next: Zone) => { if (next !== zone && confirmDiscard()) setZone(next); };

  // ── Working-set edits ─────────────────────────────────────────────────────
  const toggle = useCallback((id: string) => {
    setWorking((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const startFromDefault = () => setWorking(new Set(defaultIds));
  const clearAll = () => setWorking(new Set());

  const save = async () => {
    if (!supabase || !city) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('wassell_zone_override_set', {
        p_city_id: city.city_id, p_zone: zone, p_district_ids: [...working],
      });
      if (error) throw new Error(error.message);
      await Promise.all([loadZoneState(city.city_id, zone), loadCities()]);
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    } catch (e: unknown) {
      console.error('[GeoZonesPage] wassell_zone_override_set failed:', e);
      addToast(isAr ? `تعذّر الحفظ: ${errText(e)}` : `Save failed: ${errText(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = async () => {
    if (!supabase || !city) return;
    const ok = window.confirm(isAr
      ? 'سيُحذف التحديد اليدوي لهذه المنطقة وتعود إلى الافتراضي حسب الإحداثيات. متابعة؟'
      : 'This clears the curated set for this zone and hands it back to the coordinate default. Continue?');
    if (!ok) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('wassell_zone_override_set', {
        p_city_id: city.city_id, p_zone: zone, p_district_ids: [],
      });
      if (error) throw new Error(error.message);
      await Promise.all([loadZoneState(city.city_id, zone), loadCities()]);
      addToast(isAr ? 'أُعيدت المنطقة إلى الافتراضي' : 'Zone reset to the coordinate default', 'success');
    } catch (e: unknown) {
      console.error('[GeoZonesPage] reset failed:', e);
      addToast(isAr ? `تعذّرت الإعادة: ${errText(e)}` : `Reset failed: ${errText(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Derived view data ─────────────────────────────────────────────────────
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of roster) m.set(d.id, (isAr ? d.name_ar || d.name_en : d.name_en || d.name_ar) || d.id);
    // Districts that exist as a boundary but not in the roster (a metro-group
    // member city) still deserve a readable name on the map.
    for (const s of shapes) if (!m.has(s.district_id)) m.set(s.district_id, (isAr ? s.name : s.name_en || s.name) || s.district_id);
    return m;
  }, [roster, shapes, isAr]);

  /** Only the city's OWN districts may be curated — the shapes RPC also returns
   *  metro-group member cities, and the server rejects foreign ids on save. */
  const cityDistrictIds = useMemo(() => new Set(roster.map((d) => d.id)), [roster]);

  const polygons = useMemo(
    () => shapes.map((s) => ({
      id: s.district_id,
      paths: geojsonToPaths(s.geojson),
      inSet: working.has(s.district_id),
      ownCity: cityDistrictIds.size === 0 || cityDistrictIds.has(s.district_id),
    })),
    [shapes, working, cityDistrictIds],
  );

  // A name pill on every district IN the set, nudged apart when two collide.
  const pills = useMemo(() => {
    if (!isLoaded) return [] as Array<{ key: string; position: google.maps.LatLngLiteral; icon: google.maps.Icon | undefined }>;
    const out: Array<{ key: string; position: google.maps.LatLngLiteral; icon: google.maps.Icon | undefined }> = [];
    for (const pg of polygons) {
      if (!pg.inSet) continue;
      const ring = pg.paths[0];
      if (!ring || ring.length === 0) continue;
      const b = new google.maps.LatLngBounds();
      for (const pt of ring) b.extend(pt);
      const c = b.getCenter();
      out.push({
        key: `p:${pg.id}`,
        position: { lat: c.lat(), lng: c.lng() },
        icon: buildPillIcon(nameById.get(pg.id) ?? '', CHOCOLATE) as google.maps.Icon | undefined,
      });
    }
    for (let i = 1; i < out.length; i += 1) {
      let bumps = 0;
      for (let j = 0; j < i; j += 1) {
        const a = out[i]!.position, b = out[j]!.position;
        if (Math.abs(a.lat - b.lat) < 0.012 && Math.abs(a.lng - b.lng) < 0.02) bumps += 1;
      }
      if (bumps) out[i]!.position = { lat: out[i]!.position.lat - 0.0065 * bumps, lng: out[i]!.position.lng };
    }
    return out;
  }, [polygons, nameById, isLoaded]);

  // Fit to the CITY, on city change only — re-fitting on every toggle would
  // yank the map away while the operator is clicking districts.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !isLoaded || shapes.length === 0) return;
    if (fittedFor.current === cityId) return;
    const b = new google.maps.LatLngBounds();
    let any = false;
    for (const s of shapes) for (const ring of geojsonToPaths(s.geojson)) for (const pt of ring) { b.extend(pt); any = true; }
    if (any) { map.fitBounds(b, 32); fittedFor.current = cityId; }
  }, [map, isLoaded, shapes, cityId]);

  const chips = useMemo(
    () => [...working].map((id) => ({ id, name: nameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name, isAr ? 'ar' : 'en')),
    [working, nameById, isAr],
  );

  const addable = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [] as RosterDistrict[];
    return roster
      .filter((d) => !working.has(d.id))
      .filter((d) => `${d.name_ar ?? ''} ${d.name_en ?? ''}`.toLowerCase().includes(q))
      .slice(0, 30);
  }, [roster, working, filter]);

  const curatedZones = useMemo(() => new Set(city?.curated_zones ?? []), [city]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!supabase) {
    return (
      <div className="space-y-4">
        <BackToSettings className="!mb-0" />
        <p className="rounded-xl border border-dashed border-sand/40 px-4 py-3 text-sm text-charcoal/60">
          {isAr
            ? 'هذه الصفحة تحتاج اتصالًا بقاعدة البيانات (Supabase غير مضبوط في هذه البيئة).'
            : 'This page needs a database connection (Supabase is not configured in this environment).'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackToSettings className="!mb-0" />

      <div className="flex items-start gap-2">
        <Compass size={20} className="mt-0.5 shrink-0 text-copper" />
        <div>
          <h1 className="text-lg font-bold text-chocolate">{isAr ? 'مناطق المدن' : 'City Zones'}</h1>
          <p className="mt-0.5 text-xs text-charcoal/60">
            {isAr
              ? 'حدّد ما يقصده الناس بـ«شمال الرياض» وغيرها. المدن التي لا تُحدَّد هنا تستخدم الافتراضي حسب إحداثيات الأحياء.'
              : 'Define what people actually mean by “north Riyadh” and the rest. Cities you do not define here fall back to the coordinate default.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        {/* ── Left: city + compass ─────────────────────────────────────── */}
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-charcoal/70" htmlFor="zone-city">
              {isAr ? 'المدينة' : 'City'}
            </label>
            {citiesLoading ? (
              <div className="flex items-center gap-2 text-xs text-charcoal/50">
                <Loader2 className="animate-spin" size={14} /> {isAr ? 'تحميل…' : 'loading…'}
              </div>
            ) : (
              <select
                id="zone-city"
                className="form-input w-full text-sm"
                value={cityId}
                onChange={(e) => pickCity(e.target.value)}
              >
                {cities.map((c) => (
                  <option key={c.city_id} value={c.city_id}>
                    {cityLabel(c)} ({c.district_count})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold text-charcoal/70">{isAr ? 'الجهة' : 'Zone'}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {COMPASS_GRID.flat().map((z) => {
                const active = z === zone;
                const isCurated = curatedZones.has(z);
                return (
                  <button
                    key={z}
                    type="button"
                    onClick={() => pickZone(z)}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-1.5 py-2 text-[11px] font-bold transition ${
                      active
                        ? 'border-copper bg-copper text-white shadow-sm shadow-copper/20'
                        : 'border-sand/40 bg-white text-charcoal hover:border-copper/50 hover:bg-cream'
                    }`}
                  >
                    <span className="leading-tight">{isAr ? ZONE_LONG[z].ar : ZONE_LONG[z].en}</span>
                    <span
                      className={`rounded-full px-1.5 py-px text-[9px] font-normal ${
                        active
                          ? 'bg-white/25 text-white'
                          : isCurated
                            ? 'bg-copper/12 text-copper'
                            : 'bg-charcoal/8 text-charcoal/45'
                      }`}
                    >
                      {isCurated ? (isAr ? 'محدَّد' : 'curated') : (isAr ? 'افتراضي' : 'default')}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-charcoal/50">
              {curated
                ? (isAr
                    ? 'هذه الجهة محدَّدة يدويًا — الأحياء أدناه هي ما تعنيه في كل مكان في النظام.'
                    : 'This zone is curated — the districts below are what it means everywhere in the system.')
                : (isAr
                    ? 'هذه الجهة تستخدم الافتراضي حسب الإحداثيات. احفظ أي تحديد لتثبيتها.'
                    : 'This zone uses the coordinate default. Save any selection to pin it down.')}
            </p>
          </div>
        </div>

        {/* ── Right: map ───────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-xl border border-sand/40" style={{ height: 460 }}>
          {!isMapsKeyConfigured() ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-charcoal/50">
              {isAr ? 'مفتاح الخرائط غير مضبوط في هذه البيئة.' : 'Maps key is not configured in this environment.'}
            </div>
          ) : isLoaded ? (
            <GoogleMap
              mapContainerStyle={{ width: '100%', height: '100%' }}
              center={DEFAULT_MAP_CENTER}
              zoom={10}
              onLoad={setMap}
              options={{ styles: GRADER_MAP_STYLE, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false }}
            >
              {polygons.map((pg) => (
                <Polygon
                  key={pg.id}
                  paths={pg.paths}
                  onClick={() => { if (pg.ownCity) toggle(pg.id); }}
                  options={{
                    fillColor: pg.inSet ? COPPER : '#FFFFFF',
                    fillOpacity: pg.inSet ? 0.35 : 0,
                    strokeColor: pg.inSet ? COPPER : SAND,
                    strokeOpacity: pg.inSet ? 0.95 : 0.65,
                    strokeWeight: pg.inSet ? 2 : 1,
                    zIndex: pg.inSet ? 5 : 1,
                    clickable: pg.ownCity,
                  }}
                />
              ))}
              {pills.map((p) => (
                <MarkerF key={p.key} position={p.position} icon={p.icon} clickable={false} zIndex={20} />
              ))}
            </GoogleMap>
          ) : (
            <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-copper" size={22} /></div>
          )}
          {(shapesLoading || stateLoading) && (
            <div className="absolute end-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[11px] text-charcoal/60">
              <Loader2 className="inline animate-spin" size={12} /> {isAr ? 'تحميل…' : 'loading…'}
            </div>
          )}
          {!shapesLoading && shapes.length === 0 && (
            <div className="absolute inset-x-2 bottom-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {isAr ? 'لا توجد حدود مرسومة لأحياء هذه المدينة — استخدم البحث أسفل الخريطة.' : 'No district boundaries for this city — use the search below the map.'}
            </div>
          )}
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sand/40 bg-white p-3">
        <Button variant="secondary" className="!px-3 !py-2 !text-xs" onClick={startFromDefault} disabled={saving}>
          <Compass size={14} /> {isAr ? 'ابدأ من الافتراضي الإحداثي' : 'Start from coordinate default'}
        </Button>
        <Button variant="secondary" className="!px-3 !py-2 !text-xs" onClick={clearAll} disabled={working.size === 0 || saving}>
          <Eraser size={14} /> {isAr ? 'مسح الكل' : 'Clear all'}
        </Button>
        <Button className="!px-3 !py-2 !text-xs" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} {isAr ? 'حفظ' : 'Save'}
        </Button>
        <Button variant="ghost" className="!px-3 !py-2 !text-xs" onClick={() => void resetToDefault()} disabled={!curated || saving}>
          <RotateCcw size={14} /> {isAr ? 'إعادة للافتراضي' : 'Reset to default'}
        </Button>
        <span className="text-xs font-bold text-charcoal/70">
          {isAr ? `${working.size} حيًا` : `${working.size} districts`}
        </span>
        <span className="text-[11px] text-charcoal/45">
          {isAr ? `الافتراضي الإحداثي: ${defaultIds.length}` : `coordinate default: ${defaultIds.length}`}
        </span>
        {dirty && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
            {isAr ? 'تغييرات غير محفوظة' : 'unsaved changes'}
          </span>
        )}
        {dirty && working.size === 0 && (
          <span className="basis-full text-[11px] text-charcoal/60">
            {isAr
              ? 'المجموعة فارغة — الحفظ الآن يلغي التحديد اليدوي ويعيد الجهة إلى الافتراضي الإحداثي.'
              : 'The set is empty — saving now clears the curation and hands the zone back to the coordinate default.'}
          </span>
        )}
      </div>

      {/* ── Chips + add-by-name ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2">
        <div className="rounded-xl border border-sand/40 bg-white p-3">
          <p className="mb-2 text-xs font-bold text-charcoal/70">
            {isAr ? 'الأحياء في هذه الجهة' : 'Districts in this zone'}
          </p>
          {chips.length === 0 ? (
            <p className="text-xs text-charcoal/45">{isAr ? 'لا شيء بعد — اضغط على الأحياء في الخريطة أو ابحث عنها.' : 'Nothing yet — click districts on the map or search for them.'}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2 py-1 text-[11px] text-chocolate">
                  {c.name}
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    className="text-charcoal/40 transition hover:text-red-600"
                    aria-label={isAr ? `إزالة ${c.name}` : `Remove ${c.name}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-sand/40 bg-white p-3">
          <p className="mb-2 text-xs font-bold text-charcoal/70">{isAr ? 'إضافة حي بالاسم' : 'Add a district by name'}</p>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 text-charcoal/30 start-2.5" />
            <input
              className="form-input w-full !ps-8 text-sm"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={isAr ? 'ابحث في أحياء المدينة…' : 'Search this city’s districts…'}
            />
          </div>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {filter.trim() && addable.length === 0 && (
              <p className="text-xs text-charcoal/45">{isAr ? 'لا نتائج (أو كلها مضافة).' : 'No matches (or all already added).'}</p>
            )}
            {addable.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => toggle(d.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-xs text-charcoal transition hover:bg-cream"
              >
                <span>{(isAr ? d.name_ar || d.name_en : d.name_en || d.name_ar) || d.id}</span>
                <span className="inline-flex items-center gap-1 text-copper"><Plus size={12} /> {isAr ? 'إضافة' : 'add'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-charcoal/45">
        {isAr
          ? `الجهات المتاحة: ${ZONES.map((z) => zoneLabel(z, true)).join('، ')}. ما تحفظه هنا يُستخدم فورًا في تفضيلات موقع العميل وفي إيجاد المشاريع.`
          : `Available zones: ${ZONES.map((z) => zoneLabel(z, false)).join(', ')}. What you save here is used immediately by client location preferences and the Project Finder.`}
      </p>
    </div>
  );
}
