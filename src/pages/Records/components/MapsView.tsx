import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { GoogleMap, OverlayView, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import Supercluster from 'supercluster';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  buildClusterIcon,
  buildPillIcon,
  resolveMapStyles,
} from '@/lib/locationUtils';
import { isSummaryModel } from '@/lib/lazyModels';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import { useResolvedLocations, type ResolvedPin } from '@/hooks/useResolvedLocations';
import { resolveMirror, resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { collectViewFields, readExpandedValue, type ExpandedField } from '@/lib/sectionMirrorExpand';
import { formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import { formatNumberWithCommas, formatRangeValue } from './RangeField';
import { resolveDisplayText } from '@/lib/valueTranslation/runtime';
import { isTranslatableField, kindForField } from '@/lib/valueTranslation/config';
import type { AppModel, AppRecord, MapsConfig, ModelField, NoteEntry, User } from '@/types';

interface MapsViewProps {
  model: AppModel;
  records: AppRecord[];
  onCardClick: (record: AppRecord) => void;
}

// Map fills its parent container — RecordListPage gives it a viewport-sized
// wrapper in full-bleed mode. No border-radius: the map runs edge-to-edge.
const mapContainerStyle = { width: '100%', height: '100%' };
// Default pill background — Wassel charcoal slate. Per-record `pin_color`
// overrides take effect when a `pin_color_field_id` is configured.
const PILL_DEFAULT_COLOR = '#4A4E54';

// Hard ceiling on how many markers we instantiate on the map at once. Each pin
// is a real google.maps.Marker (SVG data-URI icon + click listener), so tens of
// thousands would freeze the tab even WITH clustering — the cost is creating the
// marker objects, not the clustering math. When the resolved set exceeds this we
// render the first MAX and show a "narrow filters / zoom in" banner. Applies to
// EVERY model's map but only ever triggers for very large sets (e.g.
// market_listings, ~46k); normal models resolve far fewer than this.
const MAX_MAP_MARKERS = 2000;

export interface FormatCtx {
  isAr: boolean;
  t: TFunction;
  allRecords: Record<string, AppRecord[]>;
  models: AppModel[];
  users: User[];
  recordData: Record<string, unknown>;
}

/**
 * Format any field's stored value as a friendly display string. Mirrors the
 * canonical resolution logic in DynamicCell — handles lookups, dropdowns,
 * multiselects, ranges, currency, formulas, dates, mirrors, etc.
 *
 * Used for both popup field rendering and pill marker labels, so the same
 * "what does this field render as" answer is consistent everywhere.
 */
export function formatFieldValue(field: ModelField, raw: unknown, ctx: FormatCtx): string {
  const { isAr, t, allRecords, models, users, recordData } = ctx;
  const joinSep = isAr ? '، ' : ', ';

  if (raw === null || raw === undefined || raw === '') return '—';

  switch (field.type) {
    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === raw);
      if (!opt) return String(raw);
      return isAr ? opt.label_ar : opt.label_en;
    }

    case 'multiselect':
    case 'section_selector': {
      const vals = Array.isArray(raw) ? (raw as unknown[]) : [];
      if (vals.length === 0) return '—';
      return vals
        .map((v) => {
          const opt = field.options?.find((o) => o.value === v);
          return opt ? (isAr ? opt.label_ar : opt.label_en) : String(v);
        })
        .join(joinSep);
    }

    case 'multi_link': {
      const links = Array.isArray(raw)
        ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      if (links.length === 0) return '—';
      return links.join(joinSep);
    }

    case 'lookup': {
      if (!field.lookup_model_id || !field.lookup_display_field) return '—';
      const linked = allRecords[field.lookup_model_id] ?? [];
      const displayName = field.lookup_display_field;
      const targetModel = models.find((m) => m.id === field.lookup_model_id);
      const resolveOne = (id: unknown): string => {
        if (typeof id !== 'string' || !id) return '';
        const rec = linked.find((r) => r.id === id);
        if (!rec) return isAr ? 'سجل محذوف' : 'Deleted record';
        const dv = resolveLookupDisplayValue(rec, displayName, { targetModel, allModels: models, allRecords });
        if (dv === null || dv === undefined || typeof dv === 'object') return id.slice(0, 8);
        const s = String(dv);
        return s.trim() === '' ? id.slice(0, 8) : resolveDisplayText(s, isAr ? 'ar' : 'en', { kind: 'name', field_hint: displayName });
      };
      if (field.is_multi || Array.isArray(raw)) {
        const ids = Array.isArray(raw) ? raw : [];
        if (ids.length === 0) return '—';
        return ids.map(resolveOne).filter(Boolean).join(joinSep);
      }
      const out = resolveOne(raw);
      return out || '—';
    }

    case 'range': {
      const str = formatRangeValue(field, raw, isAr);
      return str || '—';
    }

    case 'currency': {
      const num = Number(raw);
      if (!Number.isFinite(num)) return String(raw);
      const formatted = num.toLocaleString(isAr ? 'ar-SA' : 'en-SA');
      return `${formatted} ${isAr ? 'ر.س' : 'SAR'}`;
    }

    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) return String(raw);
      return formatNumberWithCommas(num, isAr);
    }

    case 'formula': {
      if (isFormulaErrorValue(raw)) return String(raw);
      const locale = isAr ? 'ar-SA' : 'en-SA';
      return formatFormulaValue(raw as number | string, field, locale);
    }

    case 'date': {
      try {
        const d = new Date(String(raw));
        if (isNaN(d.getTime())) return String(raw);
        return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
      } catch {
        return String(raw);
      }
    }

    case 'datetime': {
      try {
        const d = new Date(String(raw));
        if (isNaN(d.getTime())) return String(raw);
        const date = d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
        const time = d.toLocaleTimeString(isAr ? 'ar-SA' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
        return `${date} ${time}`;
      } catch {
        return String(raw);
      }
    }

    case 'checkbox':
      return raw ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No');

    case 'notes': {
      const entries: NoteEntry[] = Array.isArray(raw)
        ? (raw as unknown[]).filter(
            (e): e is NoteEntry =>
              !!e && typeof e === 'object' && typeof (e as NoteEntry).text === 'string',
          )
        : [];
      if (entries.length === 0) return t('fields.notes_count_zero');
      if (entries.length === 1) return t('fields.notes_count_one');
      if (isAr && entries.length === 2) return t('fields.notes_count_two');
      return t('fields.notes_count_other', { count: entries.length });
    }

    case 'assignee': {
      if (typeof raw !== 'string' || !raw) return '—';
      const u = users.find((x) => x.id === raw);
      if (!u) return isAr ? 'غير معيّن' : 'Unassigned';
      return isAr ? u.name_ar : u.name_en;
    }

    case 'mirror': {
      const res = resolveMirror(field, recordData, allRecords, models);
      if (res.status === 'target_record_missing') return isAr ? 'سجل محذوف' : 'Deleted record';
      if (res.status !== 'ok' || !res.targetField) return '—';
      if (Array.isArray(res.value)) {
        if (res.value.length === 0) return '—';
        return res.value.map((v) => formatFieldValue(res.targetField!, v, ctx)).filter(Boolean).join(joinSep);
      }
      return formatFieldValue(res.targetField, res.value, ctx);
    }

    default:
      if (Array.isArray(raw)) return raw.map((v) => String(v)).join(joinSep);
      if (typeof raw === 'object') return JSON.stringify(raw);
      if (isTranslatableField(field)) {
        return resolveDisplayText(raw, isAr ? 'ar' : 'en', { kind: kindForField(field), field_hint: field.name });
      }
      return String(raw);
  }
}

/**
 * Map view dispatcher. Summary models (e.g. `market_listings`, ~46k rows) use a
 * VIEWPORT-DRIVEN supercluster path (`SummaryMapsView`) that only ever
 * instantiates google.maps.Marker objects for what's currently visible. Every
 * other model keeps the original markerclusterer pipeline (`LegacyMapsView`),
 * unchanged.
 */
export default function MapsView(props: MapsViewProps) {
  if (isSummaryModel(props.model)) return <SummaryMapsView {...props} />;
  return <LegacyMapsView {...props} />;
}

function LegacyMapsView({ model, records, onCardClick }: MapsViewProps) {
  const { t } = useTranslation();
  const { language, records: allRecords, models, users, mapsViewState, setMapsViewState } = useAppStore();
  const isAr = language === 'ar';

  const cfg = model.maps_config;
  // Expanded field set keyed by id — local fields PLUS section-mirror children,
  // so pin labels and the popup can reference data mirrored in from a linked
  // record (e.g. a project's master fields). Mirrored ids are `container::child`.
  const expandedById = useMemo(() => {
    const m = new Map<string, ExpandedField>();
    for (const ef of collectViewFields(model, models)) m.set(ef.id, ef);
    return m;
  }, [model, models]);
  const labelEf = cfg.pin_label_field_id ? expandedById.get(cfg.pin_label_field_id) : undefined;

  const { resolved, unresolved, resolving, resolvingCount, retry } = useResolvedLocations(model, records);

  // Cap how many markers we actually put on the map (see MAX_MAP_MARKERS). The
  // full `resolved` set still drives the count + center; only the marker
  // pipeline (and pin labels) use the capped slice, so a huge filtered set
  // (e.g. all 46k market listings) can't freeze the tab.
  const markersCapped = resolved.length > MAX_MAP_MARKERS;
  const cappedResolved = useMemo(
    () => (markersCapped ? resolved.slice(0, MAX_MAP_MARKERS) : resolved),
    [resolved, markersCapped],
  );

  // Persisted view state (cross-navigation): center/zoom/selected pin.
  // Hydrate from the in-memory store on mount so back-from-record-edit
  // returns the user to the exact map view they left.
  const persisted = mapsViewState[model.id];
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  // Administrative context under the record pins — see useGeoBoundaryLayer.
  useGeoBoundaryLayer(mapInstance);

  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const styles = resolveMapStyles(cfg.map_style_json);
  const center = persisted?.center
    ? persisted.center
    : resolved[0]
      ? { lat: resolved[0].lat, lng: resolved[0].lng }
      : cfg.default_center_lat != null && cfg.default_center_lng != null
        ? { lat: cfg.default_center_lat, lng: cfg.default_center_lng }
        : DEFAULT_MAP_CENTER;
  const zoom = persisted?.zoom ?? cfg.default_zoom ?? DEFAULT_MAP_ZOOM;

  // Build the label for each pin once, memoized off resolved + label field +
  // store data so the imperative marker effect can re-create on real changes
  // only.
  const pinLabels = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (!labelEf) return out;
    const ctx: Omit<FormatCtx, 'recordData'> = { isAr, t, allRecords, models, users };
    for (const p of cappedResolved) {
      const value = readExpandedValue(labelEf, p.record, allRecords, model, models);
      const text = formatFieldValue(labelEf.field, value, { ...ctx, recordData: p.record.data });
      out[p.record.id] = text === '—' ? '' : text;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cappedResolved, labelEf, isAr, allRecords, models, users, model]);

  // Friendly names for records that couldn't be placed — same label source as
  // the pins (pin-label field, falling back to the popup title) so the
  // "not on the map" chip lists recognizable project names, not raw ids.
  const titleEf = cfg.popup_title_field_id ? expandedById.get(cfg.popup_title_field_id) : undefined;
  const nameEf = labelEf ?? titleEf;
  const unresolvedNamed = useMemo(() => {
    const ctxBase: Omit<FormatCtx, 'recordData'> = { isAr, t, allRecords, models, users };
    return unresolved.map((rec) => {
      let label = `#${rec.id.slice(0, 8)}`;
      if (nameEf) {
        const value = readExpandedValue(nameEf, rec, allRecords, model, models);
        const text = formatFieldValue(nameEf.field, value, { ...ctxBase, recordData: rec.data });
        if (text && text !== '—') label = text;
      }
      return { record: rec, label };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresolved, nameEf, isAr, allRecords, models, users, model]);

  // Persist selection changes — onIdle only fires on pan/zoom, not on
  // pin clicks, so we mirror selectedId into the store separately.
  useEffect(() => {
    if (!mapInstance) return;
    const c = mapInstance.getCenter();
    const z = mapInstance.getZoom();
    if (!c || z == null) return;
    setMapsViewState(model.id, {
      center: { lat: c.lat(), lng: c.lng() },
      zoom: z,
      selectedId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mapInstance, model.id]);

  // Imperative Marker + Clusterer pipeline — render markers as native
  // google.maps.Marker (so MarkerClusterer can manage them) and listen for
  // clicks to drive our own React popup overlay below.
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  // Keep the latest resolved array in a ref so click handlers can re-resolve
  // by record id at click time. Belt-and-suspenders against any closure
  // capturing the wrong record (e.g. if `resolved` mutates between mount and
  // click — shouldn't happen given our useMemo, but cheap insurance).
  const resolvedRef = useRef(cappedResolved);
  useEffect(() => {
    resolvedRef.current = cappedResolved;
  }, [cappedResolved]);

  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    // Tear down previous markers + clusterer on every recompute. Cheap because
    // markers are SVG data URIs, no network.
    clustererRef.current?.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const newMarkers: google.maps.Marker[] = [];
    for (const p of cappedResolved) {
      const label = pinLabels[p.record.id] || '';
      const icon = label
        ? buildPillIcon(label, p.color || PILL_DEFAULT_COLOR)
        : buildPillIcon('•', p.color || PILL_DEFAULT_COLOR);
      const recordId = p.record.id;
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: icon as google.maps.Icon | undefined,
        // Native browser tooltip — handy for diagnosing which record a
        // visible pill belongs to when pills overlap.
        title: label || recordId.slice(0, 8),
      });
      marker.addListener('click', () => {
        // Re-resolve by record id from the latest snapshot rather than the
        // closed-over `p`. Defensive against the (theoretical) case where
        // resolved mutates between marker creation and click.
        const cur = resolvedRef.current.find((r) => r.record.id === recordId);
        const target = cur?.record ?? p.record;
        if (cfg.click_action === 'navigate') onCardClick(target);
        else setSelectedId(recordId);
      });
      newMarkers.push(marker);
    }
    markersRef.current = newMarkers;

    if (newMarkers.length === 0) return;

    clustererRef.current = new MarkerClusterer({
      map: mapInstance,
      markers: newMarkers,
      // Wider cluster radius (default 60px) — pill markers can run 100–200px
      // wide depending on label length, so two pins 70–150px apart appear
      // visually stacked but the default radius leaves them un-clustered. The
      // click then lands on whichever marker is on top in z-order, which may
      // not be the pill the user thought they clicked. 110px catches most
      // visually-overlapping pairs without over-clustering distant ones.
      algorithm: new SuperClusterAlgorithm({ radius: 110 }),
      renderer: {
        render: ({ count, position }) => {
          const icon = buildClusterIcon(count);
          return new google.maps.Marker({
            position,
            icon: icon as google.maps.Icon | undefined,
            // zIndex slightly above the default so cluster dots win z-fights
            // with overlapping pills.
            zIndex: Number(google.maps.Marker.MAX_ZINDEX) + count,
          });
        },
      },
    });

    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, isLoaded, cappedResolved, pinLabels, cfg.click_action]);

  if (keyMissing) {
    return <EmptyState title={t('maps.api_key_missing')} hint={t('maps.api_key_missing_hint')} />;
  }
  if (loadError) {
    return <EmptyState title={t('maps.api_key_missing')} hint={String(loadError.message ?? loadError)} />;
  }
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-charcoal/40">
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  const selectedPin = cappedResolved.find((r) => r.record.id === selectedId);

  return (
    <div className="relative h-full">
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={zoom}
        options={{ styles, mapTypeControl: false, streetViewControl: false, fullscreenControl: false }}
        onLoad={(m) => setMapInstance(m)}
        onUnmount={() => setMapInstance(null)}
        onIdle={() => {
          // Persist current pan/zoom + selected pin so back-from-detail
          // restores the same view. Fires after pans, zooms, and the initial
          // load — cheap, in-memory only.
          if (!mapInstance) return;
          const c = mapInstance.getCenter();
          const z = mapInstance.getZoom();
          if (!c || z == null) return;
          setMapsViewState(model.id, {
            center: { lat: c.lat(), lng: c.lng() },
            zoom: z,
            selectedId,
          });
        }}
      >
        {cfg.click_action === 'popup' && selectedPin && (
          <OverlayView
            position={{ lat: selectedPin.lat, lng: selectedPin.lng }}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height - 40 })}
          >
            <PopupCard
              pin={selectedPin}
              cfg={cfg}
              model={model}
              expandedById={expandedById}
              isAr={isAr}
              t={t}
              allRecords={allRecords}
              models={models}
              users={users}
              openLabel={t('maps.open_record')}
              onOpen={() => onCardClick(selectedPin.record)}
              onClose={() => setSelectedId(null)}
            />
          </OverlayView>
        )}
      </GoogleMap>

      {/* Floating progress chip — center of the map, shows while the resolver
          is working through unresolved URLs. Hidden once all land. */}
      {resolving && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 bg-white/95 rounded-full border border-copper/40 px-4 py-2 shadow-lg flex items-center gap-2 pointer-events-none">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-copper animate-pulse" />
          <span className="text-sm font-bold text-copper">
            {t('maps.resolving', { count: resolvingCount })}
          </span>
        </div>
      )}

      {/* Marker-cap banner — when more than MAX_MAP_MARKERS records resolve to a
          location we only instantiate the first MAX (so the tab never freezes on
          e.g. all 46k market listings). Tell the user how to see the rest. */}
      {markersCapped && !resolving && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-white/95 rounded-xl border border-copper/40 px-4 py-2 shadow-lg text-center max-w-[90%]"
          dir={isAr ? 'rtl' : 'ltr'}
        >
          <p className="text-xs font-bold text-chocolate">
            {isAr
              ? `يتم عرض ${MAX_MAP_MARKERS.toLocaleString('ar-SA')} من ${resolved.length.toLocaleString('ar-SA')} قائمة على الخريطة`
              : `Showing ${MAX_MAP_MARKERS.toLocaleString()} of ${resolved.length.toLocaleString()} listings on the map`}
          </p>
          <p className="text-[11px] text-charcoal/60 mt-0.5">
            {isAr
              ? 'عدد كبير جدًا من القوائم لعرضها دفعة واحدة. حدّد عوامل التصفية لعرض نتائج خريطة أكثر صلة.'
              : 'Too many listings to display at once. Narrow your filters to show more relevant map results.'}
          </p>
        </div>
      )}

      {/* Truly-empty map (nothing resolved AND nothing pending to place) —
          centered "configure the location field" hint. */}
      {resolved.length === 0 && unresolved.length === 0 && !resolving && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 rounded-lg border border-sand/50 px-4 py-2 text-center">
            <p className="text-sm font-bold text-charcoal/70">{t('maps.no_pins')}</p>
            <p className="text-xs text-charcoal/50 mt-0.5">{t('maps.configure_in_builder')}</p>
          </div>
        </div>
      )}

      {/* Unplaced-records chip — ALWAYS shown when some records couldn't be
          placed, no matter how many pins succeeded. Previously this was only
          surfaced when EVERY pin failed, so partial failures (e.g. a short
          maps.app.goo.gl link that the server couldn't follow on this load)
          vanished silently. Lists names + a retry that re-fires resolution. */}
      {unresolvedNamed.length > 0 && !resolving && (
        <div className="absolute bottom-3 start-3 z-20 max-w-[280px] bg-white/95 rounded-xl border border-copper/40 shadow-lg overflow-hidden" dir={isAr ? 'rtl' : 'ltr'}>
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-copper/10 border-b border-copper/20">
            <span className="text-xs font-bold text-chocolate">
              {t('maps.unresolvable_records', { count: unresolvedNamed.length })}
            </span>
            <button
              type="button"
              onClick={retry}
              className="shrink-0 text-[11px] font-bold text-copper hover:text-terracotta underline decoration-dotted transition-colors"
            >
              {t('maps.unplaced_retry')}
            </button>
          </div>
          <ul className="max-h-40 overflow-y-auto py-1">
            {unresolvedNamed.slice(0, 8).map(({ record, label }) => (
              <li key={record.id}>
                <button
                  type="button"
                  onClick={() => onCardClick(record)}
                  title={t('maps.unplaced_open')}
                  className="w-full text-start px-3 py-1.5 text-xs text-charcoal hover:bg-cream truncate transition-colors"
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
          {unresolvedNamed.length > 8 && (
            <div className="px-3 py-1.5 text-[11px] text-charcoal/50 border-t border-sand/40">
              {t('maps.unplaced_more', { count: unresolvedNamed.length - 8 })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Summary-model map (viewport-driven supercluster)
//
// For huge summary models (market_listings, ~46k rows already loaded as a slim
// set in the store) we DO NOT instantiate a google.maps.Marker per record. That
// would freeze the tab and the old global "first 2,000" slice silently hid the
// other ~40k. Instead we build ONE in-memory Supercluster spatial index from the
// records' top-level lat/lng and, on every map idle, query it for the CURRENT
// viewport + zoom — creating marker objects only for the handful of clusters +
// pins actually visible (tens–hundreds), never the whole set.
// ───────────────────────────────────────────────────────────────────────────

// Supercluster tuning. `radius`/`maxZoom` are chosen so that by the time a user
// is zoomed in far enough to want individual pins, the per-viewport point count
// is comfortably under PIN_CAP — so the dense-viewport banner is rare.
//   radius   80px — aggressive enough to keep zoomed-out Riyadh as a few big
//                    clusters (no freeze), loose enough to split into district
//                    clusters as you zoom in.
//   maxZoom  16   — above this, getClusters returns individual points (pins).
//   minPoints 2   — a lone listing is always a pin, never a 1-count cluster.
const SUPERCLUSTER_RADIUS = 80;
const SUPERCLUSTER_MAX_ZOOM = 16;
// Per-viewport SAFETY CAP — applies ONLY to individual clickable PINS. Clusters
// always represent the rest, so nothing is ever hidden behind a global slice;
// the only effect of the cap is "very dense + zoomed-in" views render up to this
// many pins and surface a "zoom in / narrow filters" banner. Tuned high enough
// that the radius/maxZoom above keep it from firing in normal use.
const PIN_CAP = 2000;
// How many no-location rows the side panel lists. We resolve friendly labels for
// ONLY these — never the full no-location set (3,652+ on market_listings), which
// would block the map's first paint with thousands of synchronous lookups.
const NO_LOCATION_PANEL_LIMIT = 8;

/** Temporary, opt-in map lifecycle logging. Enable in the browser console with
 *  `localStorage.wassell_map_debug = '1'` then reload — no redeploy needed.
 *  Logs zoom, bbox, cluster count, markers rendered, and every clear + reason. */
const MAP_DEBUG = (() => {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('wassell_map_debug') === '1';
  } catch {
    // localStorage can throw in locked-down/private contexts — never block on it.
    return false;
  }
})();

/** Geometry shape returned by getClusters for an individual (non-cluster) point. */
type SummaryPointProps = { cluster?: false; id: string };

/** A finite numeric coordinate read from a top-level slim field. Null otherwise. */
function finiteCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function SummaryMapsView({ model, records, onCardClick }: MapsViewProps) {
  const { t } = useTranslation();
  const { language, records: allRecords, models, users, mapsViewState, setMapsViewState } = useAppStore();
  const isAr = language === 'ar';

  const cfg = model.maps_config;
  const expandedById = useMemo(() => {
    const m = new Map<string, ExpandedField>();
    for (const ef of collectViewFields(model, models)) m.set(ef.id, ef);
    return m;
  }, [model, models]);

  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  // Partition the (already-filtered) records into mapped (valid finite top-level
  // lat/lng) and no-location. Read lat/lng DIRECTLY off the slim summary data —
  // no geocode pipeline. Each mapped point becomes a GeoJSON feature carrying its
  // record id (the only payload the index needs; we re-resolve the full record
  // by id at click time).
  const { points, mappedById, noLocation } = useMemo(() => {
    const pts: Supercluster.PointFeature<SummaryPointProps>[] = [];
    const byId = new Map<string, AppRecord>();
    const none: AppRecord[] = [];
    for (const rec of records) {
      const lat = finiteCoord(rec.data.latitude);
      const lng = finiteCoord(rec.data.longitude);
      if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        none.push(rec);
        continue;
      }
      byId.set(rec.id, rec);
      pts.push({
        type: 'Feature',
        properties: { cluster: false, id: rec.id },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    }
    return { points: pts, mappedById: byId, noLocation: none };
  }, [records]);

  // ONE spatial index, rebuilt only when the mapped point set changes. Pure JS —
  // creates NO google.maps.Marker objects. Built OFF the render/commit path (in a
  // deferred effect) so loading a heavy point set (46k) can never block the
  // GoogleMap from mounting + painting tiles on first load. Starts empty; fills
  // in right after `points` settle, and the marker effect below (which depends on
  // `index`) then renders the clusters — no user interaction required.
  const makeIndex = () =>
    new Supercluster<SummaryPointProps>({
      radius: SUPERCLUSTER_RADIUS,
      maxZoom: SUPERCLUSTER_MAX_ZOOM,
      minPoints: 2,
    });
  // Index lives in state with a `ready` flag. `ready` is false until the first
  // build finishes, so the marker effect never renders (and so never clears the
  // existing markers) against an un-loaded index.
  const [indexState, setIndexState] = useState<{ index: Supercluster<SummaryPointProps>; ready: boolean }>(
    () => ({ index: makeIndex(), ready: false }),
  );
  const { index, ready: indexReady } = indexState;
  useEffect(() => {
    // setTimeout(0) yields a frame so the map can mount/paint before we spend
    // ~hundreds of ms building the KD-tree.
    const handle = window.setTimeout(() => {
      const sc = makeIndex();
      sc.load(points);
      setIndexState({ index: sc, ready: true });
    }, 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  // Persisted view state (cross-navigation), same as the legacy path.
  const persisted = mapsViewState[model.id];
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  // Administrative context under the record pins — see useGeoBoundaryLayer.
  useGeoBoundaryLayer(mapInstance);

  const styles = useMemo(() => resolveMapStyles(cfg.map_style_json), [cfg.map_style_json]);
  const firstPoint = points[0];
  // coordinates are [lng, lat]; indexed access is `number | undefined` under
  // noUncheckedIndexedAccess, so coerce to finite numbers.
  const firstLng = firstPoint?.geometry.coordinates[0];
  const firstLat = firstPoint?.geometry.coordinates[1];
  const center = persisted?.center
    ? persisted.center
    : firstPoint && Number.isFinite(firstLat) && Number.isFinite(firstLng)
      ? { lat: firstLat as number, lng: firstLng as number }
      : cfg.default_center_lat != null && cfg.default_center_lng != null
        ? { lat: cfg.default_center_lat, lng: cfg.default_center_lng }
        : DEFAULT_MAP_CENTER;
  const zoom = persisted?.zoom ?? cfg.default_zoom ?? DEFAULT_MAP_ZOOM;

  // STABLE props for <GoogleMap> (the fix for the idle/re-render storm).
  // @react-google-maps re-applies center/zoom/options whenever their REFERENCE
  // changes; passing fresh objects every render made it re-apply on each
  // re-render, nudging the viewport → firing `idle` → setMapsViewState →
  // re-render → an idle loop. We freeze the INITIAL view once (restored from
  // persisted view / first point / default) and memoize the options, so the map
  // is left alone after mount. The user still pans/zooms freely (the prop ref
  // never changes, so @react-google-maps won't fight them), and onIdle keeps
  // persisting the live view to the store for the next mount.
  const initialViewRef = useRef<{ center: { lat: number; lng: number }; zoom: number } | null>(null);
  if (!initialViewRef.current && (persisted?.center || firstPoint)) {
    initialViewRef.current = { center, zoom };
  }
  const stableCenter = initialViewRef.current?.center ?? center;
  const stableZoom = initialViewRef.current?.zoom ?? zoom;
  const mapOptions = useMemo(
    () => ({ styles, mapTypeControl: false, streetViewControl: false, fullscreenControl: false }),
    [styles],
  );

  // Friendly names for no-location records — reuse the pin-label / popup-title
  // field so the "without location" panel lists recognizable titles.
  const labelEf = cfg.pin_label_field_id ? expandedById.get(cfg.pin_label_field_id) : undefined;
  const titleEf = cfg.popup_title_field_id ? expandedById.get(cfg.popup_title_field_id) : undefined;
  const nameEf = labelEf ?? titleEf;
  const noLocationNamed = useMemo(() => {
    const ctxBase: Omit<FormatCtx, 'recordData'> = { isAr, t, allRecords, models, users };
    // Only the rows the panel renders — the total count uses noLocation.length.
    return noLocation.slice(0, NO_LOCATION_PANEL_LIMIT).map((rec) => {
      let label = `#${rec.id.slice(0, 8)}`;
      if (nameEf) {
        const value = readExpandedValue(nameEf, rec, allRecords, model, models);
        const text = formatFieldValue(nameEf.field, value, { ...ctxBase, recordData: rec.data });
        if (text && text !== '—') label = text;
      }
      return { record: rec, label };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noLocation, nameEf, isAr, allRecords, models, users, model]);

  // Persist selection separately (idle only fires on pan/zoom).
  useEffect(() => {
    if (!mapInstance) return;
    const c = mapInstance.getCenter();
    const z = mapInstance.getZoom();
    if (!c || z == null) return;
    setMapsViewState(model.id, { center: { lat: c.lat(), lng: c.lng() }, zoom: z, selectedId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mapInstance, model.id]);

  // Viewport version — bumped on every map `idle` (settles after pan/zoom and
  // the initial load). The marker effect below re-queries the index for the new
  // viewport whenever this changes.
  const [viewportVersion, setViewportVersion] = useState(0);
  const [pinCapHit, setPinCapHit] = useState(false);

  // Background-tab safety net: browsers gate Google-map init + tile paint on tab
  // visibility, so a page opened in a hidden tab can show a blank map until the
  // user switches to it. When the tab becomes visible, force a resize + viewport
  // re-query so the map fills in tiles + clusters immediately — no pan/zoom.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !mapInstance) return;
      google.maps.event.trigger(mapInstance, 'resize');
      setViewportVersion((v) => v + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [mapInstance]);

  // Imperative marker pipeline — query getClusters for the CURRENT bounds+zoom
  // and render ONLY those features. No MarkerClusterer: supercluster IS the
  // clustering, so we just place the returned cluster/point markers directly.
  const markersRef = useRef<google.maps.Marker[]>([]);
  // Latest record-by-id snapshot for click handlers (re-resolve by id at click
  // time, defensive against stale closures).
  const mappedRef = useRef(mappedById);
  useEffect(() => {
    mappedRef.current = mappedById;
  }, [mappedById]);

  useEffect(() => {
    // LIFECYCLE RULE (the fix for "clusters vanish when panning stops"):
    // never clear the existing markers on a transient/invalid state. We build the
    // new set first and swap it in atomically; the only place markers are fully
    // removed is the unmount cleanup below. Each guard here RETURNS without
    // touching markersRef, so whatever is on the map stays on the map.
    if (!mapInstance || !isLoaded) return;          // keep existing markers
    if (!indexReady && points.length > 0) {
      // Index not built yet but we have data → keep the current markers, wait
      // for the deferred build to flip `indexReady` (which re-runs this effect).
      if (MAP_DEBUG) console.debug('[map] keep %o markers — index not ready', markersRef.current.length);
      return;
    }

    const bounds = mapInstance.getBounds();
    const zNow = mapInstance.getZoom();
    if (!bounds || zNow == null) {                  // transient → keep existing
      if (MAP_DEBUG) console.debug('[map] keep %o markers — no bounds/zoom yet', markersRef.current.length);
      return;
    }

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const bbox: [number, number, number, number] = [sw.lng(), sw.lat(), ne.lng(), ne.lat()];
    const z = Math.round(zNow);
    const clusters = index.getClusters(bbox, z);

    if (MAP_DEBUG) {
      console.debug('[map] query zoom=%o bbox=%o → %o features (prev markers=%o)', z, bbox, clusters.length, markersRef.current.length);
    }

    // Build the new marker set BEFORE removing the old one (see lifecycle rule).
    const newMarkers: google.maps.Marker[] = [];
    let pinsRendered = 0;
    let capExceeded = false;

    for (const feature of clusters) {
      // coordinates are [lng, lat]; indexed access is `number | undefined` under
      // noUncheckedIndexedAccess. Skip any malformed feature defensively, then
      // pin to plain numbers so position literals type-check.
      const rawLng = feature.geometry.coordinates[0];
      const rawLat = feature.geometry.coordinates[1];
      if (typeof rawLng !== 'number' || typeof rawLat !== 'number') continue;
      const lng: number = rawLng;
      const lat: number = rawLat;
      const props = feature.properties;

      if (props && (props as Supercluster.ClusterProperties).cluster) {
        // Cluster feature → count marker. Click zooms to its expansion zoom.
        const clusterProps = props as Supercluster.ClusterProperties;
        const count = clusterProps.point_count;
        const clusterId = clusterProps.cluster_id;
        const icon = buildClusterIcon(count);
        const marker = new google.maps.Marker({
          position: { lat, lng },
          icon: icon as google.maps.Icon | undefined,
          zIndex: Number(google.maps.Marker.MAX_ZINDEX) + Math.min(count, 1000),
          title: String(count),
        });
        marker.addListener('click', () => {
          const expansionZoom = Math.min(index.getClusterExpansionZoom(clusterId), 20);
          mapInstance.setZoom(expansionZoom);
          mapInstance.panTo({ lat, lng });
        });
        newMarkers.push(marker);
        continue;
      }

      // Individual point feature → clickable listing pin. Per-viewport cap
      // applies HERE only; clusters above represent everything else, so the cap
      // never hides a record permanently — zoom/pan and it appears.
      if (pinsRendered >= PIN_CAP) {
        capExceeded = true;
        continue;
      }
      pinsRendered += 1;
      const id = (props as SummaryPointProps).id;
      const rec = mappedRef.current.get(id);
      const color = model.color || PILL_DEFAULT_COLOR;
      // Render the configured pin-label field (e.g. price) on the pill, like the
      // legacy map. Resolving happens ONLY for individual pins actually in view
      // (bounded by PIN_CAP), so it stays cheap. Falls back to a dot when no
      // label field is configured or the value is empty.
      let pillLabel = '•';
      if (labelEf && rec) {
        const value = readExpandedValue(labelEf, rec, allRecords, model, models);
        const text = formatFieldValue(labelEf.field, value, {
          isAr,
          t,
          allRecords,
          models,
          users,
          recordData: rec.data,
        });
        if (text && text !== '—') pillLabel = text;
      }
      const icon = buildPillIcon(pillLabel, color);
      const marker = new google.maps.Marker({
        position: { lat, lng },
        icon: icon as google.maps.Icon | undefined,
        title: pillLabel !== '•' ? pillLabel : id.slice(0, 8),
      });
      marker.addListener('click', () => {
        const cur = mappedRef.current.get(id) ?? rec;
        if (!cur) return;
        if (cfg.click_action === 'navigate') onCardClick(cur);
        else setSelectedId(id);
      });
      newMarkers.push(marker);
    }

    // SWAP: add the new set, then remove the previous set — never an empty frame.
    // If `clusters` was genuinely empty (panned to an area with no listings) the
    // new set is empty and the old is removed, which is the correct "none here"
    // state. NO effect cleanup clears markers — that was the bug.
    newMarkers.forEach((m) => m.setMap(mapInstance));
    const prevMarkers = markersRef.current;
    markersRef.current = newMarkers;
    prevMarkers.forEach((m) => m.setMap(null));
    setPinCapHit(capExceeded);
    if (MAP_DEBUG) console.debug('[map] rendered %o markers, removed %o old', newMarkers.length, prevMarkers.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapInstance, isLoaded, index, indexReady, viewportVersion, cfg.click_action, model.color, points.length, labelEf]);

  // Clear markers ONLY on unmount — never on a dependency change. Clearing on
  // every re-run (the old effect cleanup) is what wiped clusters on each `idle`.
  useEffect(
    () => () => {
      if (MAP_DEBUG) console.debug('[map] unmount — clearing %o markers', markersRef.current.length);
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
    },
    [],
  );

  if (keyMissing) {
    return <EmptyState title={t('maps.api_key_missing')} hint={t('maps.api_key_missing_hint')} />;
  }
  if (loadError) {
    return <EmptyState title={t('maps.api_key_missing')} hint={String(loadError.message ?? loadError)} />;
  }
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-charcoal/40">
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  const selectedRec = selectedId ? mappedById.get(selectedId) : undefined;
  const selectedPin: ResolvedPin | undefined = selectedRec
    ? {
        record: selectedRec,
        lat: finiteCoord(selectedRec.data.latitude) ?? 0,
        lng: finiteCoord(selectedRec.data.longitude) ?? 0,
        color: model.color || PILL_DEFAULT_COLOR,
      }
    : undefined;

  const total = records.length;
  const mappedCount = points.length;
  const noLocationCount = noLocation.length;
  const fmt = (n: number) => n.toLocaleString(isAr ? 'ar-SA' : 'en-US');

  return (
    <div className="relative h-full">
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={stableCenter}
        zoom={stableZoom}
        options={mapOptions}
        onLoad={(m) => {
          setMapInstance(m);
          // Force the map to (re)measure its container and paint tiles even if it
          // mounted before layout settled, then query the FIRST viewport as soon
          // as the map actually has bounds (its first `idle`). Without this the
          // map could stay grey with no clusters until the user panned/zoomed —
          // the `idle` listener guarantees the initial cluster render on load.
          google.maps.event.trigger(m, 'resize');
          google.maps.event.addListenerOnce(m, 'idle', () => setViewportVersion((v) => v + 1));
          setViewportVersion((v) => v + 1);
        }}
        onUnmount={() => setMapInstance(null)}
        onIdle={() => {
          // Re-query the index for the new viewport AND persist pan/zoom.
          setViewportVersion((v) => v + 1);
          if (!mapInstance) return;
          const c = mapInstance.getCenter();
          const z = mapInstance.getZoom();
          if (!c || z == null) return;
          setMapsViewState(model.id, { center: { lat: c.lat(), lng: c.lng() }, zoom: z, selectedId });
        }}
      >
        {cfg.click_action === 'popup' && selectedPin && (
          <OverlayView
            position={{ lat: selectedPin.lat, lng: selectedPin.lng }}
            mapPaneName={OverlayView.FLOAT_PANE}
            getPixelPositionOffset={(width, height) => ({ x: -width / 2, y: -height - 40 })}
          >
            <PopupCard
              pin={selectedPin}
              cfg={cfg}
              model={model}
              expandedById={expandedById}
              isAr={isAr}
              t={t}
              allRecords={allRecords}
              models={models}
              users={users}
              openLabel={t('maps.open_record')}
              onOpen={() => onCardClick(selectedPin.record)}
              onClose={() => setSelectedId(null)}
            />
          </OverlayView>
        )}
      </GoogleMap>

      {/* Counts strip — total / on the map / without location. Always shown so
          the user knows nothing is silently hidden (the old 2k-slice bug). */}
      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-white/95 rounded-full border border-copper/30 px-4 py-1.5 shadow-lg"
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <p className="text-xs font-bold text-chocolate whitespace-nowrap">
          {isAr ? (
            <>
              <span>{fmt(total)} إجمالي</span>
              <span className="text-charcoal/40"> · </span>
              <span>{fmt(mappedCount)} على الخريطة</span>
              <span className="text-charcoal/40"> · </span>
              <span>{fmt(noLocationCount)} بدون موقع</span>
            </>
          ) : (
            <>
              <span>{fmt(total)} total</span>
              <span className="text-charcoal/40"> · </span>
              <span>{fmt(mappedCount)} on map</span>
              <span className="text-charcoal/40"> · </span>
              <span>{fmt(noLocationCount)} without location</span>
            </>
          )}
        </p>
      </div>

      {/* Per-viewport PIN cap banner — only when more than PIN_CAP individual
          points fall in the current view. Clusters still represent the rest, so
          nothing is hidden; this just nudges the user to zoom/narrow to see them
          all as pins. */}
      {pinCapHit && (
        <div
          className="absolute top-14 left-1/2 -translate-x-1/2 z-20 bg-white/95 rounded-xl border border-copper/40 px-4 py-2 shadow-lg text-center max-w-[90%]"
          dir={isAr ? 'rtl' : 'ltr'}
        >
          <p className="text-[11px] font-bold text-chocolate">
            {isAr
              ? 'زوّم أكثر أو حدّد عوامل التصفية لعرض كل القوائم كنقاط'
              : 'Zoom in or narrow filters to show all listings as pins'}
          </p>
        </div>
      )}

      {/* Truly-empty map — nothing mapped AND nothing without location. */}
      {mappedCount === 0 && noLocationCount === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 rounded-lg border border-sand/50 px-4 py-2 text-center">
            <p className="text-sm font-bold text-charcoal/70">{t('maps.no_pins')}</p>
            <p className="text-xs text-charcoal/50 mt-0.5">{t('maps.configure_in_builder')}</p>
          </div>
        </div>
      )}

      {/* No-location side panel — records without valid coordinates. */}
      {noLocationCount > 0 && (
        <div className="absolute bottom-3 start-3 z-20 max-w-[280px] bg-white/95 rounded-xl border border-copper/40 shadow-lg overflow-hidden" dir={isAr ? 'rtl' : 'ltr'}>
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-copper/10 border-b border-copper/20">
            <span className="text-xs font-bold text-chocolate">
              {isAr
                ? `${fmt(noLocationCount)} بدون موقع`
                : `${fmt(noLocationCount)} without location`}
            </span>
          </div>
          <ul className="max-h-40 overflow-y-auto py-1">
            {noLocationNamed.map(({ record, label }) => (
              <li key={record.id}>
                <button
                  type="button"
                  onClick={() => onCardClick(record)}
                  title={t('maps.unplaced_open')}
                  className="w-full text-start px-3 py-1.5 text-xs text-charcoal hover:bg-cream truncate transition-colors"
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
          {noLocationCount > noLocationNamed.length && (
            <div className="px-3 py-1.5 text-[11px] text-charcoal/50 border-t border-sand/40">
              {t('maps.unplaced_more', { count: noLocationCount - noLocationNamed.length })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PopupCardProps {
  pin: ResolvedPin;
  cfg: MapsConfig;
  model: AppModel;
  expandedById: Map<string, ExpandedField>;
  isAr: boolean;
  t: TFunction;
  allRecords: Record<string, AppRecord[]>;
  models: AppModel[];
  users: User[];
  openLabel: string;
  onOpen: () => void;
  onClose: () => void;
}

function PopupCard({
  pin,
  cfg,
  model,
  expandedById,
  isAr,
  t,
  allRecords,
  models,
  users,
  openLabel,
  onOpen,
  onClose,
}: PopupCardProps) {
  const record = pin.record;
  const titleEf = cfg.popup_title_field_id ? expandedById.get(cfg.popup_title_field_id) : undefined;
  const subtitleEf = cfg.popup_subtitle_field_id ? expandedById.get(cfg.popup_subtitle_field_id) : undefined;
  const badgeEf = cfg.popup_badge_field_id ? expandedById.get(cfg.popup_badge_field_id) : undefined;
  const shownEfs = cfg.popup_shown_field_ids
    .map((id) => expandedById.get(id))
    .filter((ef): ef is ExpandedField => Boolean(ef));

  const ctx: FormatCtx = { isAr, t, allRecords, models, users, recordData: record.data };
  // Read the value through the section mirror for mirrored children; for local
  // fields readExpandedValue returns record.data[field.name], so the path is
  // identical to before for the common case.
  const valueOf = (ef: ExpandedField): unknown => readExpandedValue(ef, record, allRecords, model, models);
  const renderValue = (ef: ExpandedField): string => formatFieldValue(ef.field, valueOf(ef), ctx);

  // URL fields render as a clickable "Open link" pill so the popup never
  // shows a raw URL overflowing the card. Mirrors DynamicCell's url case.
  // Returns either a string (default) or a JSX node (URL fields).
  const renderFieldNode = (ef: ExpandedField): React.ReactNode => {
    const field = ef.field;
    if (field.type === 'multi_link') {
      const raw = valueOf(ef);
      const links = Array.isArray(raw)
        ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      if (links.length === 0) return '—';
      return (
        <span className="inline-flex flex-wrap gap-1">
          {links.map((link, i) => {
            const safeHref = /^https?:\/\//i.test(link) ? link : `https://${link}`;
            return (
              <a
                key={i}
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                dir="ltr"
                title={link}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-copper/10 hover:bg-copper/20 text-copper text-[11px] font-bold transition-colors"
              >
                {isAr ? 'زر' : 'Button'} {i + 1}
              </a>
            );
          })}
        </span>
      );
    }
    if (field.type === 'url') {
      const raw = valueOf(ef);
      if (typeof raw !== 'string' || !raw.trim()) return '—';
      const safeHref = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      return (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          dir="ltr"
          title={raw}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-copper/10 hover:bg-copper/20 text-copper text-[11px] font-bold transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path
              d="M5.5 3H3v8h8V8.5M9 3h2v2M11 3L6.5 7.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {isAr ? 'فتح' : 'Open'}
        </a>
      );
    }
    return renderValue(ef);
  };

  const title = titleEf ? renderValue(titleEf) : `#${record.id.slice(0, 8)}`;
  const subtitle = subtitleEf ? renderValue(subtitleEf) : null;

  let badgeLabel: string | null = null;
  let badgeColor: string | undefined;
  if (badgeEf) {
    const raw = valueOf(badgeEf);
    const selected = Array.isArray(raw) ? raw[0] : raw;
    const option = badgeEf.field.options?.find((o) => o.value === selected || o.id === selected);
    if (option) {
      badgeLabel = isAr ? option.label_ar : option.label_en;
      badgeColor = option.color;
    }
  }

  // Compact-pin layout — first 3 shown fields go in chips, the rest become
  // single-line rows below. Mirrors variation B in the design canvas.
  const chipFields = shownEfs.slice(0, 3);
  const restFields = shownEfs.slice(3);

  return (
    <div
      className="relative w-[320px] bg-white border border-sand-light rounded-2xl font-amiri"
      style={{ boxShadow: '0 4px 16px rgba(107, 66, 38, 0.08)' }}
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Downward tail pointer — sits on the bottom edge near the start side. */}
      <div
        className="absolute -bottom-2 w-4 h-4 bg-white border-r border-b border-sand-light rotate-45 start-9"
        aria-hidden
      />

      <div className="px-4 pt-3.5 pb-4">
        {/* Header strip — tag/status pill on the start side, close X on the end. */}
        <header className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {badgeLabel &&
              (badgeColor ? (
                // Status pill — copper-tinted background with a colored dot
                // (option color) when the badge field option carries a color.
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-chocolate bg-copper/10 rounded-full px-2.5 py-1">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{
                      background: badgeColor,
                      boxShadow: `0 0 0 3px ${badgeColor}33`,
                    }}
                  />
                  <span className="truncate max-w-[140px]">{badgeLabel}</span>
                </span>
              ) : (
                // Outlined tag chip — copper border, no fill, when the option
                // has no color (or it's a plain text/dropdown without one).
                <span className="inline-flex items-center text-[11px] font-bold text-copper border border-copper rounded px-2 py-0.5 tracking-wider truncate max-w-[140px]">
                  {badgeLabel}
                </span>
              ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isAr ? 'إغلاق' : 'Close'}
            className="shrink-0 w-7 h-7 rounded-full hover:bg-cream flex items-center justify-center text-charcoal/60 hover:text-chocolate transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Title block — large brown serif, optional location subtitle. */}
        <div className="mb-3">
          <h3 className="font-amiri font-bold text-[20px] leading-tight text-chocolate m-0 mb-1 break-words">
            {title}
          </h3>
          {subtitle && (
            <div className="flex items-center gap-1.5 text-xs text-charcoal/60">
              <svg
                width="12"
                height="14"
                viewBox="0 0 12 14"
                fill="none"
                aria-hidden
                className="text-copper shrink-0"
              >
                <path
                  d="M6 13C6 13 11 8.5 11 5.5C11 2.46243 8.76142 0 6 0C3.23858 0 1 2.46243 1 5.5C1 8.5 6 13 6 13Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <circle cx="6" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <span className="truncate">{subtitle}</span>
            </div>
          )}
        </div>

        {/* Stat chips — first three shown fields, 3-column grid on cream. */}
        {chipFields.length > 0 && (
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            {chipFields.map((ef) => (
              <div
                key={ef.id}
                className="flex items-start gap-1.5 px-2 py-2 bg-cream rounded-md min-w-0"
              >
                <span className="text-copper text-[11px] leading-none mt-1 shrink-0">●</span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] text-charcoal/60 tracking-wide truncate">
                    {isAr ? ef.field.label_ar : ef.field.label_en}
                  </span>
                  <span className="text-[12px] font-bold text-chocolate truncate">
                    {renderFieldNode(ef)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Remaining shown fields — compact label/value rows. */}
        {restFields.length > 0 && (
          <div className="space-y-1 mb-3 text-xs">
            {restFields.map((ef) => (
              <div key={ef.id} className="flex justify-between gap-3 items-center">
                <span className="text-charcoal/60 shrink-0">{isAr ? ef.field.label_ar : ef.field.label_en}</span>
                <span className="font-medium text-charcoal text-end break-words min-w-0">
                  {renderFieldNode(ef)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Foot — dashed top border + copper pill CTA. */}
        <div className="pt-3 border-t border-dashed border-sand-light flex justify-end">
          <button
            type="button"
            onClick={onOpen}
            className="bg-copper hover:bg-terracotta text-white text-[13px] font-bold px-4 py-2 rounded-full inline-flex items-center gap-1.5 transition-colors"
          >
            <span>{openLabel}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden
              className="rtl:rotate-180"
            >
              <path
                d="M8 2L3 6L8 10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center bg-cream/40 rounded-xl border border-dashed border-sand/50">
      <p className="text-base font-bold text-charcoal/70 mb-1">{title}</p>
      <p className="text-sm text-charcoal/50 max-w-md">{hint}</p>
    </div>
  );
}
