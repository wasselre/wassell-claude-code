import { useEffect, useMemo, useState } from 'react';
import { MapPin, Plus, X, Search, Loader2, BadgeCheck, TriangleAlert } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, ModelField } from '@/types';
import {
  type LocationItem,
  type GeoPolarity,
  describeLocationItem,
  newDistrictItem,
  newRadiusItem,
} from '@/lib/geo/locationItems';
import { searchGeoElements, type GeoElementHit } from '@/lib/geo/client';

interface Props {
  items: LocationItem[];
  onChange: (items: LocationItem[]) => void;
  /** The clients `location` field (carries location_levels → district model). */
  locationField?: ModelField;
  /** Current value of the client's location cascade (to read the selected city). */
  locationValue: unknown;
  isAr: boolean;
  disabled?: boolean;
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
export default function LocationItemsEditor({ items, onChange, locationField, locationValue, isAr, disabled }: Props) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Resolve the district model + its city-lookup field + the selected city id
  // from the location field's level config (same source the cascade uses).
  const { districtModelId, districtCityField, cityId } = useMemo(() => {
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
    return { districtModelId: dModelId, districtCityField: cityField, cityId: cId };
  }, [locationField, locationValue, models]);

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
  const [polarity, setPolarity] = useState<GeoPolarity>('include');
  const [districtQuery, setDistrictQuery] = useState('');

  const [elemQuery, setElemQuery] = useState('');
  const [elemResults, setElemResults] = useState<GeoElementHit[]>([]);
  const [elemLoading, setElemLoading] = useState(false);
  const [elemError, setElemError] = useState<string | null>(null);
  const [picked, setPicked] = useState<GeoElementHit | null>(null);
  const [distKm, setDistKm] = useState(5);

  // Debounced live search of geo anchors when the element panel is open.
  useEffect(() => {
    if (mode !== 'element' || picked) return;
    let cancelled = false;
    setElemLoading(true);
    setElemError(null);
    const t = setTimeout(async () => {
      try {
        const hits = await searchGeoElements(elemQuery, { limit: 20 });
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
  }, [elemQuery, mode, picked]);

  const resetAdd = () => {
    setMode(null);
    setPolarity('include');
    setDistrictQuery('');
    setElemQuery('');
    setElemResults([]);
    setPicked(null);
    setDistKm(5);
  };

  const addDistrict = (opt: { id: string; label: string }) => {
    onChange([...items, newDistrictItem(opt.id, opt.label, polarity)]);
    resetAdd();
  };
  const addElement = () => {
    if (!picked) return;
    const label = (isAr ? picked.name_ar || picked.name_en : picked.name_en || picked.name_ar) || picked.display_name || picked.external_id;
    onChange([...items, newRadiusItem(picked.external_id, label, Math.round(distKm * 1000), polarity)]);
    resetAdd();
  };
  const removeItem = (id: string) => onChange(items.filter((i) => i.id !== id));

  const filteredDistricts = useMemo(() => {
    const q = districtQuery.trim().toLowerCase();
    return (q ? districtOptions.filter((o) => o.label.toLowerCase().includes(q)) : districtOptions).slice(0, 40);
  }, [districtOptions, districtQuery]);

  const PolarityToggle = (
    <div className="inline-flex overflow-hidden rounded-lg border border-sand/50 text-xs font-bold">
      {(['include', 'exclude'] as GeoPolarity[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => setPolarity(p)}
          className={`px-3 py-1.5 transition ${polarity === p ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}
        >
          {p === 'include' ? (isAr ? 'تضمين' : 'Include') : isAr ? 'استثناء' : 'Exclude'}
        </button>
      ))}
    </div>
  );

  return (
    <div className="sm:col-span-2 rounded-xl border border-sand/40 bg-cream/30 p-4">
      <div className="mb-2 flex items-center gap-2">
        <MapPin size={15} className="text-copper" />
        <h4 className="text-xs font-bold text-chocolate">{isAr ? 'تفضيلات الموقع التفصيلية' : 'Detailed location preferences'}</h4>
      </div>
      <p className="mb-3 text-[11px] leading-5 text-charcoal/50">
        {isAr
          ? 'أحياء أو عناصر (مثل: ضمن ٥ كم من معلم). كل عنصر بديل مستقل — تُجمع النتائج (أو)، وتُطرح الاستثناءات.'
          : 'Districts or elements (e.g. within 5 km of a landmark). Each is an independent option — results are unioned (OR); excludes subtract.'}
      </p>

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

      {disabled ? null : !cityId ? (
        <p className="text-xs font-semibold text-charcoal/50">
          {isAr ? 'اختر المدينة في حقل الموقع أعلاه أولاً.' : 'Select a city in the location field above first.'}
        </p>
      ) : mode === null ? (
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
        </div>
      ) : (
        <div className="rounded-lg border border-sand/50 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-chocolate">
              {mode === 'district' ? (isAr ? 'إضافة حي' : 'Add district') : isAr ? 'إضافة عنصر' : 'Add element rule'}
            </span>
            <div className="flex items-center gap-2">
              {PolarityToggle}
              <button type="button" onClick={resetAdd} className="text-charcoal/40 hover:text-charcoal" aria-label="close">
                <X size={15} />
              </button>
            </div>
          </div>

          {mode === 'district' ? (
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
              <label className="mb-1 block text-[11px] font-semibold text-charcoal/60">{isAr ? 'المسافة (كم)' : 'Distance (km)'}</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={distKm}
                  onChange={(e) => setDistKm(Math.max(0.1, Number(e.target.value) || 0))}
                  className="form-input w-28"
                />
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
                      onClick={() => setPicked(g)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start transition hover:bg-cream"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-charcoal/80">
                          {(isAr ? g.name_ar || g.name_en : g.name_en || g.name_ar) || g.external_id}
                        </span>
                        <span className="block truncate text-[10px] text-charcoal/40">{g.category}{g.type ? ` · ${g.type}` : ''}</span>
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
    </div>
  );
}
