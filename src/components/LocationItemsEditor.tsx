import { useEffect, useMemo, useState } from 'react';
import { MapPin, Plus, X, Search, Loader2, BadgeCheck, TriangleAlert, Check, Ban, Map as MapIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DistrictMapPicker from '@/components/DistrictMapPicker';
import type { AppModel, ModelField } from '@/types';
import {
  type LocationItem,
  type GeoPolarity,
  type ElementCondition,
  type ConditionRule,
  DIRECTION_DEFAULT_M,
  isDirectionRule,
  describeLocationItem,
  newDistrictItem,
  newElementRuleItem,
} from '@/lib/geo/locationItems';
import { searchGeoElements, type GeoElementHit } from '@/lib/geo/client';

type GeomKind = 'point' | 'linestring' | 'polygon';

/** Whether a rule takes a distance input. Direction rules are BOUNDED bands
 *  ("south of the road up to X km") — never half-planes — so they take one too
 *  (user decision 2026-07-18). Only inside_area has no distance. */
const RULE_NEEDS_DISTANCE = (r: ConditionRule): boolean =>
  r === 'within_radius' || r === 'within_distance' || isDirectionRule(r);

/**
 * Which rules a chosen element supports, by its geometry kind. Point anchors take
 * a radius; roads (lines) take a cardinal side or a distance; zones (polygons) take
 * inside-area or a distance. Include/exclude is the separate polarity toggle.
 */
const RULE_OPTIONS = (kind: GeomKind, isAr: boolean): Array<{ rule: ConditionRule; label: string }> => {
  if (kind === 'linestring') {
    return [
      { rule: 'north_of', label: isAr ? 'شمال الطريق' : 'North of road' },
      { rule: 'south_of', label: isAr ? 'جنوب الطريق' : 'South of road' },
      { rule: 'east_of', label: isAr ? 'شرق الطريق' : 'East of road' },
      { rule: 'west_of', label: isAr ? 'غرب الطريق' : 'West of road' },
      { rule: 'within_distance', label: isAr ? 'قريب من الطريق بمسافة' : 'Within distance of road' },
    ];
  }
  if (kind === 'polygon') {
    return [
      { rule: 'inside_area', label: isAr ? 'داخل المنطقة' : 'Inside area' },
      { rule: 'within_distance', label: isAr ? 'قريب من المنطقة بمسافة' : 'Within distance of area' },
    ];
  }
  return [{ rule: 'within_radius', label: isAr ? 'ضمن مسافة' : 'Within distance' }];
};

/** Normalize a hit's geom_kind to one of the three buckets (default point). */
const kindOf = (hit: GeoElementHit | null): GeomKind =>
  hit?.geom_kind === 'linestring' || hit?.geom_kind === 'polygon' ? hit.geom_kind : 'point';

/** Default rule when an element is first picked. */
const defaultRule = (kind: GeomKind): ConditionRule =>
  kind === 'linestring' ? 'north_of' : kind === 'polygon' ? 'inside_area' : 'within_radius';

interface Props {
  items: LocationItem[];
  onChange: (items: LocationItem[]) => void;
  /** The clients `location` field (carries location_levels → district model). */
  locationField?: ModelField;
  /** Current value of the client's location cascade (to read the selected city). */
  locationValue: unknown;
  isAr: boolean;
  disabled?: boolean;
  /**
   * When true, render bare (no outer bordered box, no "Detailed location
   * preferences" header, no explanatory paragraph) — just the chips + add
   * controls. Used when embedded inside the unified location section
   * (`ClientLocationField`), which already provides the box, label, and subtext.
   */
  embedded?: boolean;
}

const flatFields = (m: AppModel | undefined): ModelField[] =>
  (m?.schema?.sections ?? []).flatMap((s) => s.fields ?? []);

const INCLUDE_COLOR = '#B8734F'; // copper
const EXCLUDE_COLOR = '#B91C1C'; // red

/**
 * Authors a client's detailed location preferences (clients.data.location_items):
 * include/exclude districts of the selected city, and within_radius of a
 * geo-intelligence anchor (searched live via /api/geo-elements). Multiple items
 * are an OR-union; excludes subtract — the deterministic Project Finder gate.
 */
export default function LocationItemsEditor({ items, onChange, locationField, locationValue, isAr, disabled, embedded }: Props) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Resolve the district model + its city-lookup field + the selected city id
  // from the location field's level config (same source the cascade uses).
  const { districtModelId, districtCityField, cityId, cityModelId } = useMemo(() => {
    const levels = locationField?.location_levels ?? [];
    const districtLevel = levels[levels.length - 1];
    const cityLevel = levels[levels.length - 2];
    const dModelId = districtLevel?.model_id ?? null;
    const dModel = models.find((m) => m.id === dModelId);
    let cityField: string | null = null;
    if (dModel && cityLevel) {
      const f = flatFields(dModel).find((ff) => ff.type === 'lookup' && ff.lookup_model_id === cityLevel.model_id);
      cityField = f?.name ?? 'city_lookup';
    }
    const compound = locationValue && typeof locationValue === 'object' ? (locationValue as Record<string, unknown>) : {};
    const cv = compound.city;
    const cId = Array.isArray(cv) ? ((cv[0] as string) ?? null) : typeof cv === 'string' ? cv : null;
    return {
      districtModelId: dModelId,
      districtCityField: cityField,
      cityId: cId,
      cityModelId: cityLevel?.model_id ?? null,
    };
  }, [locationField, locationValue, models]);

  /**
   * English city label for the selected city, used to scope the geo-element
   * search. `geo_elements.city` stores the English name ('Riyadh', 'Jeddah'),
   * so we match on name_en rather than the Arabic display_name.
   *
   * Scoping matters now that anchors are nationwide (21 cities): an unscoped
   * search shares one result limit across the whole country, so a Jeddah client
   * would be offered Riyadh landmarks. When no city is picked yet we
   * deliberately search everywhere — that is a browse, not a mis-scope.
   */
  const { cityNameEn, countryCode } = useMemo(() => {
    const rec = cityModelId && cityId
      ? (records[cityModelId] ?? []).find((r) => r.id === cityId)
      : undefined;
    const en = rec?.data?.name_en;
    const cc = rec?.data?.country_code;
    return {
      cityNameEn: typeof en === 'string' && en.trim() ? en.trim() : undefined,
      // geo_elements holds Saudi AND UAE anchors. Without a country the "no city
      // picked yet" browse would offer Dubai landmarks for a Riyadh client. Fall
      // back to the app's home country, matching DEFAULT_GEO_COUNTRY in matchAgent.
      countryCode: typeof cc === 'string' && cc.trim() ? cc.trim() : 'SA',
    };
  }, [cityModelId, cityId, records]);

  const districtName = (data: Record<string, unknown>, id: string): string => {
    const dn = data.display_name ?? (isAr ? data.name_ar : data.name_en) ?? data.name_en ?? data.name_ar;
    return typeof dn === 'string' && dn.trim() ? dn : id;
  };

  const districtOptions = useMemo(() => {
    if (!districtModelId || !cityId) return [];
    const recs = records[districtModelId] ?? [];
    return recs
      .filter((r) => (districtCityField ? r.data[districtCityField] === cityId : true))
      .map((r) => ({ id: r.id, label: districtName(r.data, r.id) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ar'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districtModelId, districtCityField, cityId, records, isAr]);

  // ── add panel state ───────────────────────────────────────────────────────
  const [mode, setMode] = useState<null | 'district' | 'element'>(null);
  // Map-based district picker (tap the real boundary polygons to include).
  const [showMap, setShowMap] = useState(false);
  const [polarity, setPolarity] = useState<GeoPolarity>('include');
  const [districtQuery, setDistrictQuery] = useState('');

  const [elemQuery, setElemQuery] = useState('');
  const [elemResults, setElemResults] = useState<GeoElementHit[]>([]);
  const [elemLoading, setElemLoading] = useState(false);
  const [elemError, setElemError] = useState<string | null>(null);
  const [picked, setPicked] = useState<GeoElementHit | null>(null);
  const [distKm, setDistKm] = useState(5);
  // The condition rule chosen for the picked element (set from its geometry kind).
  const [ruleSel, setRuleSel] = useState<ConditionRule>('within_radius');

  // Pick an element and default its rule to the geometry-appropriate one.
  const pickElement = (hit: GeoElementHit) => {
    setPicked(hit);
    setRuleSel(defaultRule(kindOf(hit)));
  };

  // Debounced live search of geo anchors when the element panel is open.
  useEffect(() => {
    if (mode !== 'element' || picked) return;
    let cancelled = false;
    setElemLoading(true);
    setElemError(null);
    const t = setTimeout(async () => {
      try {
        const hits = await searchGeoElements(elemQuery, { limit: 20, city: cityNameEn, country: countryCode });
        if (!cancelled) setElemResults(hits);
      } catch (e) {
        if (!cancelled) setElemError(e instanceof Error ? e.message : 'search failed');
      } finally {
        if (!cancelled) setElemLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [elemQuery, mode, picked, cityNameEn, countryCode]);

  const resetAdd = () => {
    setMode(null);
    setPolarity('include');
    setDistrictQuery('');
    setElemQuery('');
    setElemResults([]);
    setPicked(null);
    setDistKm(5);
    setRuleSel('within_radius');
  };

  const addDistrict = (opt: { id: string; label: string }) => {
    const wasInclude = polarity === 'include';
    onChange([...items, newDistrictItem(opt.id, opt.label, polarity)]);
    resetAdd();
    // Show the selection immediately: the picker highlights the district WITH
    // edit handles, so the rep can adjust the area right away (user decision
    // 2026-07-18 — same always-see-it flow as element rules). Excludes are
    // managed from the chips, so no map jump for them.
    if (wasInclude && cityId) setShowMap(true);
  };
  const addElement = () => {
    if (!picked) return;
    const label = (isAr ? picked.name_ar || picked.name_en : picked.name_en || picked.name_ar) || picked.display_name || picked.external_id;
    const element_id = picked.external_id;
    const dist = Math.round(distKm * 1000) || DIRECTION_DEFAULT_M;
    let cond: ElementCondition;
    if (ruleSel === 'within_radius') cond = { rule: 'within_radius', element_id, distance_m: dist };
    else if (ruleSel === 'within_distance') cond = { rule: 'within_distance', element_id, distance_m: dist };
    else if (ruleSel === 'inside_area') cond = { rule: 'inside_area', element_id };
    else cond = { rule: ruleSel, element_id, distance_m: dist }; // BOUNDED band on the chosen side
    onChange([...items, newElementRuleItem(label, cond, polarity)]);
    resetAdd();
    // Show the rule's area immediately: the map picker renders every element
    // rule's COMPILED shape and lets the rep resize it there (user decision
    // 2026-07-18 — always SEE what a rule covers, never a blind half-plane).
    if (cityId) setShowMap(true);
  };
  const removeItem = (id: string) => onChange(items.filter((i) => i.id !== id));

  const filteredDistricts = useMemo(() => {
    const q = districtQuery.trim().toLowerCase();
    return (q ? districtOptions.filter((o) => o.label.toLowerCase().includes(q)) : districtOptions).slice(0, 40);
  }, [districtOptions, districtQuery]);

  // Prominent include/exclude chooser shown at the top of the add panel — the
  // first decision when adding a district or element: do you WANT this location
  // (include) or do you want to HIDE projects there (exclude)? Applies to
  // whatever district/element is added below.
  const PolaritySelector = (
    <div className="mb-3">
      <label className="mb-1.5 block text-[11px] font-semibold text-charcoal/60">
        {isAr ? 'هذا الموقع…' : 'This location…'}
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(['include', 'exclude'] as GeoPolarity[]).map((p) => {
          const active = polarity === p;
          const isInc = p === 'include';
          const c = isInc ? INCLUDE_COLOR : EXCLUDE_COLOR;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPolarity(p)}
              className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition"
              style={
                active
                  ? { backgroundColor: c, borderColor: c, color: '#fff' }
                  : { backgroundColor: '#fff', borderColor: `${c}55`, color: c }
              }
            >
              {isInc ? <Check size={14} /> : <Ban size={14} />}
              {isInc ? (isAr ? 'أريده' : 'Include') : isAr ? 'استثناء' : 'Exclude'}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-charcoal/50">
        {polarity === 'exclude'
          ? isAr
            ? 'استثناء: لن تظهر المشاريع في هذا الموقع ضمن النتائج.'
            : "Exclude: projects in this location won't appear in the results."
          : isAr
            ? 'تضمين: أظهر لي المشاريع في هذا الموقع.'
            : 'Include: show me projects in this location.'}
      </p>
    </div>
  );

  const inner = (
    <>
      {!embedded && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <MapPin size={15} className="text-copper" />
            <h4 className="text-xs font-bold text-chocolate">{isAr ? 'تفضيلات الموقع التفصيلية' : 'Detailed location preferences'}</h4>
          </div>
          <p className="mb-3 text-[11px] leading-5 text-charcoal/50">
            {isAr
              ? 'أحياء أو عناصر (مثل: ضمن ٥ كم من معلم). كل عنصر بديل مستقل — تُجمع النتائج (أو)، وتُطرح الاستثناءات.'
              : 'Districts or elements (e.g. within 5 km of a landmark). Each is an independent option — results are unioned (OR); excludes subtract.'}
          </p>
        </>
      )}

      {/* Saved items as chips */}
      {items.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {items.map((it) => {
            const color = it.polarity === 'exclude' ? EXCLUDE_COLOR : INCLUDE_COLOR;
            return (
              <span
                key={it.id}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold"
                style={{ backgroundColor: `${color}1F`, color }}
              >
                {describeLocationItem(it, isAr)}
                {!disabled && (
                  <button type="button" onClick={() => removeItem(it.id)} className="hover:opacity-60" aria-label="remove">
                    <X size={12} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="mb-3 text-xs text-charcoal/40">{isAr ? 'لا توجد تفضيلات موقع بعد.' : 'No location preferences yet.'}</p>
      )}

      {disabled ? null : mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => { resetAdd(); setMode('district'); }}
            className="inline-flex items-center gap-1 rounded-lg border border-sand/50 bg-white px-3 py-1.5 text-xs font-bold text-charcoal/70 transition hover:bg-cream"
          >
            <Plus size={13} /> {isAr ? 'إضافة حي' : 'Add district'}
          </button>
          <button
            type="button"
            onClick={() => { resetAdd(); setMode('element'); }}
            className="inline-flex items-center gap-1 rounded-lg border border-sand/50 bg-white px-3 py-1.5 text-xs font-bold text-charcoal/70 transition hover:bg-cream"
          >
            <Plus size={13} /> {isAr ? 'إضافة عنصر' : 'Add element'}
          </button>
          <button
            type="button"
            disabled={!cityId}
            onClick={() => { resetAdd(); setShowMap(true); }}
            title={!cityId ? (isAr ? 'اختر المدينة أولاً' : 'Pick the city first') : undefined}
            className="inline-flex items-center gap-1 rounded-lg border border-copper/40 bg-copper/10 px-3 py-1.5 text-xs font-bold text-copper transition hover:bg-copper/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MapIcon size={13} /> {isAr ? 'اختيار من الخريطة' : 'Pick on map'}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-sand/50 bg-white p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-bold text-chocolate">
              {mode === 'district' ? (isAr ? 'إضافة حي' : 'Add district') : isAr ? 'إضافة عنصر' : 'Add element rule'}
            </span>
            <button type="button" onClick={resetAdd} className="text-charcoal/40 hover:text-charcoal" aria-label="close">
              <X size={15} />
            </button>
          </div>

          {PolaritySelector}

          {mode === 'district' ? (
            !cityId ? (
              <p className="px-1 py-2 text-xs font-semibold text-charcoal/50">
                {isAr ? 'اختر المدينة في حقل الموقع أعلاه أولاً لاختيار حي.' : 'Select a city in the location field above first to pick a district.'}
              </p>
            ) : (
            <>
              <div className="relative mb-2">
                <Search size={14} className="pointer-events-none absolute top-2.5 ltr:left-2.5 rtl:right-2.5 text-charcoal/30" />
                <input
                  type="text"
                  value={districtQuery}
                  onChange={(e) => setDistrictQuery(e.target.value)}
                  placeholder={isAr ? 'ابحث عن حي…' : 'Search a district…'}
                  className="form-input ltr:pl-8 rtl:pr-8"
                  autoFocus
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filteredDistricts.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-charcoal/40">{isAr ? 'لا توجد أحياء لهذه المدينة.' : 'No districts for this city.'}</p>
                ) : (
                  filteredDistricts.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => addDistrict(o)}
                      className="block w-full rounded px-2 py-1.5 text-start text-xs text-charcoal/80 transition hover:bg-cream"
                    >
                      {o.label}
                    </button>
                  ))
                )}
              </div>
            </>
            )
          ) : picked ? (
            <div>
              <div className="mb-3 flex items-center justify-between rounded-lg bg-cream/60 px-3 py-2">
                <span className="text-xs font-bold text-charcoal">
                  {(isAr ? picked.name_ar || picked.name_en : picked.name_en || picked.name_ar) || picked.external_id}
                </span>
                <button type="button" onClick={() => setPicked(null)} className="text-xs font-semibold text-copper hover:underline">
                  {isAr ? 'تغيير' : 'Change'}
                </button>
              </div>
              {/* Rule options adapt to the element's geometry: point → distance;
                  road (line) → cardinal side or distance; zone (polygon) →
                  inside-area or distance. Include/exclude is the polarity toggle above. */}
              <label className="mb-1 block text-[11px] font-semibold text-charcoal/60">{isAr ? 'القاعدة' : 'Rule'}</label>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {RULE_OPTIONS(kindOf(picked), isAr).map((o) => (
                  <button
                    key={o.rule}
                    type="button"
                    onClick={() => setRuleSel(o.rule)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition ${
                      ruleSel === o.rule ? 'border-copper bg-copper text-white' : 'border-sand/50 bg-white text-charcoal/70 hover:bg-cream'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="flex items-end gap-2">
                {RULE_NEEDS_DISTANCE(ruleSel) && (
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-charcoal/60">
                      {isDirectionRule(ruleSel)
                        ? (isAr ? 'العمق من الطريق (كم)' : 'Depth from road (km)')
                        : (isAr ? 'المسافة (كم)' : 'Distance (km)')}
                    </label>
                    <input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={distKm}
                      onChange={(e) => setDistKm(Math.max(0.1, Number(e.target.value) || 0))}
                      className="form-input w-28"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={addElement}
                  className="inline-flex items-center gap-1 rounded-lg bg-copper px-3 py-2 text-xs font-bold text-white transition hover:bg-terracotta"
                >
                  <Plus size={13} /> {isAr ? 'إضافة' : 'Add'}
                </button>
              </div>
              {picked.confidence_score != null && picked.confidence_score < 0.5 && (
                <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
                  <TriangleAlert size={12} />
                  {isAr ? 'ثقة منخفضة — قد يحتاج مراجعة قبل المطابقة.' : 'Low confidence — may need review before it matches.'}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="relative mb-2">
                <Search size={14} className="pointer-events-none absolute top-2.5 ltr:left-2.5 rtl:right-2.5 text-charcoal/30" />
                <input
                  type="text"
                  value={elemQuery}
                  onChange={(e) => setElemQuery(e.target.value)}
                  placeholder={isAr ? 'ابحث عن معلم / طريق / مول / مترو…' : 'Search a landmark / road / mall / metro…'}
                  className="form-input ltr:pl-8 rtl:pr-8"
                  autoFocus
                />
              </div>
              <div className="max-h-56 overflow-y-auto">
                {elemLoading ? (
                  <p className="flex items-center gap-1 px-1 py-2 text-xs text-charcoal/40">
                    <Loader2 size={13} className="animate-spin" /> {isAr ? 'جارٍ البحث…' : 'Searching…'}
                  </p>
                ) : elemError ? (
                  <p className="px-1 py-2 text-xs text-red-600">{elemError}</p>
                ) : elemResults.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-charcoal/40">{isAr ? 'لا نتائج.' : 'No results.'}</p>
                ) : (
                  elemResults.map((g) => (
                    <button
                      key={g.external_id}
                      type="button"
                      onClick={() => pickElement(g)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start transition hover:bg-cream"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-charcoal/80">
                          {(isAr ? g.name_ar || g.name_en : g.name_en || g.name_ar) || g.external_id}
                        </span>
                        <span className="block truncate text-[10px] text-charcoal/40">
                          {g.category}{g.type ? ` · ${g.type}` : ''}
                          {/* City shown because anchors are nationwide — without it
                              two identically-named roads in different cities are
                              indistinguishable in this list. */}
                          {!cityNameEn && g.city ? ` · ${g.city}` : ''}
                        </span>
                      </span>
                      {g.is_verified ? (
                        <BadgeCheck size={13} className="shrink-0 text-emerald-600" />
                      ) : g.is_approximate ? (
                        <TriangleAlert size={13} className="shrink-0 text-amber-500" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );

  const mapPicker = showMap && cityId ? (
    <DistrictMapPicker
      cityId={cityId}
      items={items}
      onApply={onChange}
      onClose={() => setShowMap(false)}
      isAr={isAr}
    />
  ) : null;

  return embedded ? (
    <div className="space-y-2">
      {inner}
      {mapPicker}
    </div>
  ) : (
    <div className="sm:col-span-2 rounded-xl border border-sand/40 bg-cream/30 p-4">
      {inner}
      {mapPicker}
    </div>
  );
}
