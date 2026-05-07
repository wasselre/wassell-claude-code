import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { GoogleMap, OverlayView, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  buildClusterIcon,
  buildPillIcon,
  parseMapStyleJson,
} from '@/lib/locationUtils';
import { useResolvedLocations, type ResolvedPin } from '@/hooks/useResolvedLocations';
import { resolveMirror } from '@/lib/mirrorResolver';
import { formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import Badge from '@/components/ui/Badge';
import { formatNumberWithCommas, formatRangeValue } from './RangeField';
import type { AppModel, AppRecord, MapsConfig, ModelField, NoteEntry, User } from '@/types';

interface MapsViewProps {
  model: AppModel;
  records: AppRecord[];
  onCardClick: (record: AppRecord) => void;
}

const mapContainerStyle = { width: '100%', height: 'calc(100vh - 320px)', minHeight: '480px', borderRadius: '12px' };
// Default pill background — Wassel charcoal slate. Per-record `pin_color`
// overrides take effect when a `pin_color_field_id` is configured.
const PILL_DEFAULT_COLOR = '#4A4E54';

interface FormatCtx {
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
function formatFieldValue(field: ModelField, raw: unknown, ctx: FormatCtx): string {
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
  const { language, records: allRecords, models, users } = useAppStore();
  const isAr = language === 'ar';

  const cfg = model.maps_config;
  const allFields = useMemo(() => model.schema.sections.flatMap((s) => s.fields), [model]);
  const fieldsById = useMemo(() => new Map(allFields.map((f) => [f.id, f])), [allFields]);
  const labelField = cfg.pin_label_field_id ? fieldsById.get(cfg.pin_label_field_id) : undefined;

  const { resolved, unresolved, resolving, resolvingCount } = useResolvedLocations(model, records);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);

  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const styles = parseMapStyleJson(cfg.map_style_json) ?? undefined;
  const center = resolved[0]
    ? { lat: resolved[0].lat, lng: resolved[0].lng }
    : cfg.default_center_lat != null && cfg.default_center_lng != null
      ? { lat: cfg.default_center_lat, lng: cfg.default_center_lng }
      : DEFAULT_MAP_CENTER;
  const zoom = cfg.default_zoom ?? DEFAULT_MAP_ZOOM;

  // Build the label for each pin once, memoized off resolved + label field +
  // store data so the imperative marker effect can re-create on real changes
  // only.
  const pinLabels = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (!labelField) return out;
    const ctx: Omit<FormatCtx, 'recordData'> = { isAr, t, allRecords, models, users };
    for (const p of resolved) {
      const text = formatFieldValue(labelField, p.record.data[labelField.name], { ...ctx, recordData: p.record.data });
      out[p.record.id] = text === '—' ? '' : text;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, labelField, isAr, allRecords, models, users]);

  // Imperative Marker + Clusterer pipeline — render markers as native
  // google.maps.Marker (so MarkerClusterer can manage them) and listen for
  // clicks to drive our own React popup overlay below.
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);

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
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: icon as google.maps.Icon | undefined,
      });
      marker.addListener('click', () => {
        if (cfg.click_action === 'navigate') onCardClick(p.record);
        else setSelectedId(p.record.id);
      });
      newMarkers.push(marker);
    }
    markersRef.current = newMarkers;

    if (newMarkers.length === 0) return;

    clustererRef.current = new MarkerClusterer({
      map: mapInstance,
      markers: newMarkers,
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
    <div className="relative">
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={zoom}
        options={{ styles, mapTypeControl: false, streetViewControl: false, fullscreenControl: true }}
        onLoad={(m) => setMapInstance(m)}
        onUnmount={() => setMapInstance(null)}
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
              fieldsById={fieldsById}
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

      {/* Floating progress chip — top-start corner, shows while the resolver
          is working through unresolved URLs. Hidden once all land. */}
      {resolving && (
        <div className="absolute top-3 start-3 bg-white/95 rounded-full border border-copper/40 px-3 py-1 shadow-sm flex items-center gap-2 pointer-events-none">
          <span className="inline-block w-2 h-2 rounded-full bg-copper animate-pulse" />
          <span className="text-xs font-bold text-copper">
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
  fieldsById: Map<string, ModelField>;
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
  fieldsById,
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
  const titleField = cfg.popup_title_field_id ? fieldsById.get(cfg.popup_title_field_id) : undefined;
  const subtitleField = cfg.popup_subtitle_field_id ? fieldsById.get(cfg.popup_subtitle_field_id) : undefined;
  const badgeField = cfg.popup_badge_field_id ? fieldsById.get(cfg.popup_badge_field_id) : undefined;
  const shownFields = cfg.popup_shown_field_ids
    .map((id) => fieldsById.get(id))
    .filter((f): f is ModelField => Boolean(f));

  const ctx: FormatCtx = { isAr, t, allRecords, models, users, recordData: record.data };
  const renderValue = (field: ModelField): string => formatFieldValue(field, record.data[field.name], ctx);

  const title = titleField ? renderValue(titleField) : `#${record.id.slice(0, 8)}`;
  const subtitle = subtitleField ? renderValue(subtitleField) : null;

  let badgeLabel: string | null = null;
  let badgeColor: string | undefined;
  if (badgeField) {
    const raw = record.data[badgeField.name];
    const selected = Array.isArray(raw) ? raw[0] : raw;
    const option = badgeField.options?.find((o) => o.value === selected || o.id === selected);
    if (option) {
      badgeLabel = isAr ? option.label_ar : option.label_en;
      badgeColor = option.color;
    }
  }

  return (
    <div
      className="relative rounded-2xl bg-white shadow-xl border border-sand/40 min-w-[260px] max-w-[320px] overflow-hidden"
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Close button — top-end. */}
      <button
        type="button"
        onClick={onClose}
        aria-label={isAr ? 'إغلاق' : 'Close'}
        className="absolute top-2 end-2 w-6 h-6 rounded-full hover:bg-cream flex items-center justify-center text-charcoal/60 hover:text-charcoal transition-colors z-10"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div className="p-4 pb-3">
        {badgeLabel && (
          <div className="mb-2">
            <Badge label={badgeLabel} color={badgeColor} />
          </div>
        )}
        <div className="text-base font-bold text-charcoal leading-tight pe-6">{title}</div>
        {subtitle && <div className="text-xs text-charcoal/60 mt-1">{subtitle}</div>}
      </div>

      {shownFields.length > 0 && (
        <div className="px-4 pb-3 space-y-1.5 border-t border-sand/30 pt-3">
          {shownFields.map((f) => (
            <div key={f.id} className="flex justify-between gap-3 text-xs">
              <span className="text-charcoal/50 shrink-0">{isAr ? f.label_ar : f.label_en}</span>
              <span className="text-charcoal font-medium text-end break-words">{renderValue(f)}</span>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onOpen}
        className="w-full bg-copper hover:bg-terracotta text-white text-sm font-bold py-2.5 transition-colors"
      >
        {openLabel}
      </button>
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
