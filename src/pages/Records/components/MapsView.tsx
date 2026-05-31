import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { GoogleMap, OverlayView, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  buildClusterIcon,
  buildPillIcon,
  resolveMapStyles,
} from '@/lib/locationUtils';
import { useResolvedLocations, type ResolvedPin } from '@/hooks/useResolvedLocations';
import { resolveMirror } from '@/lib/mirrorResolver';
import { collectViewFields, readExpandedValue, type ExpandedField } from '@/lib/sectionMirrorExpand';
import { formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import { formatNumberWithCommas, formatRangeValue } from './RangeField';
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
      const resolveOne = (id: unknown): string => {
        if (typeof id !== 'string' || !id) return '';
        const rec = linked.find((r) => r.id === id);
        if (!rec) return isAr ? 'سجل محذوف' : 'Deleted record';
        const dv = rec.data[displayName];
        if (dv === null || dv === undefined || typeof dv === 'object') return id.slice(0, 8);
        const s = String(dv);
        return s.trim() === '' ? id.slice(0, 8) : s;
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
      return String(raw);
  }
}

export default function MapsView({ model, records, onCardClick }: MapsViewProps) {
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

  const { resolved, unresolved, resolving, resolvingCount } = useResolvedLocations(model, records);

  // Persisted view state (cross-navigation): center/zoom/selected pin.
  // Hydrate from the in-memory store on mount so back-from-record-edit
  // returns the user to the exact map view they left.
  const persisted = mapsViewState[model.id];
  const [selectedId, setSelectedId] = useState<string | null>(persisted?.selectedId ?? null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);

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
    for (const p of resolved) {
      const value = readExpandedValue(labelEf, p.record, allRecords, model);
      const text = formatFieldValue(labelEf.field, value, { ...ctx, recordData: p.record.data });
      out[p.record.id] = text === '—' ? '' : text;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, labelEf, isAr, allRecords, models, users, model]);

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
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    resolvedRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    if (!mapInstance || !isLoaded) return;

    // Tear down previous markers + clusterer on every recompute. Cheap because
    // markers are SVG data URIs, no network.
    clustererRef.current?.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const newMarkers: google.maps.Marker[] = [];
    for (const p of resolved) {
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
  }, [mapInstance, isLoaded, resolved, pinLabels, cfg.click_action]);

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

  const selectedPin = resolved.find((r) => r.record.id === selectedId);

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

      {resolved.length === 0 && !resolving && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 rounded-lg border border-sand/50 px-4 py-2 text-center">
            <p className="text-sm font-bold text-charcoal/70">{t('maps.no_pins')}</p>
            <p className="text-xs text-charcoal/50 mt-0.5">
              {unresolved.length > 0
                ? t('maps.unresolvable_records', { count: unresolved.length })
                : t('maps.configure_in_builder')}
            </p>
          </div>
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
  const valueOf = (ef: ExpandedField): unknown => readExpandedValue(ef, record, allRecords, model);
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
