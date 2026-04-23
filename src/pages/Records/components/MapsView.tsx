import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from '@react-google-maps/api';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  buildColoredPinIcon,
  parseMapStyleJson,
} from '@/lib/locationUtils';
import { useResolvedLocations } from '@/hooks/useResolvedLocations';
import Badge from '@/components/ui/Badge';
import type { AppModel, AppRecord, MapsConfig, ModelField } from '@/types';

interface MapsViewProps {
  model: AppModel;
  records: AppRecord[];
  onCardClick: (record: AppRecord) => void;
}

const mapContainerStyle = { width: '100%', height: 'calc(100vh - 320px)', minHeight: '480px', borderRadius: '12px' };

export default function MapsView({ model, records, onCardClick }: MapsViewProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const cfg = model.maps_config;
  const allFields = useMemo(() => model.schema.sections.flatMap((s) => s.fields), [model]);

  const { resolved, unresolved, resolving, resolvingCount } = useResolvedLocations(model, records);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const styles = parseMapStyleJson(cfg.map_style_json) ?? undefined;
  const center = resolved[0]
    ? { lat: resolved[0].lat, lng: resolved[0].lng }
    : cfg.default_center_lat != null && cfg.default_center_lng != null
      ? { lat: cfg.default_center_lat, lng: cfg.default_center_lng }
      : DEFAULT_MAP_CENTER;
  const zoom = cfg.default_zoom ?? DEFAULT_MAP_ZOOM;

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
      >
        {resolved.map((p) => (
          <Marker
            key={p.record.id}
            position={{ lat: p.lat, lng: p.lng }}
            icon={buildColoredPinIcon(p.color) as google.maps.Icon | undefined}
            onClick={() => {
              if (cfg.click_action === 'navigate') onCardClick(p.record);
              else setSelectedId(p.record.id);
            }}
          />
        ))}
        {cfg.click_action === 'popup' && selectedPin && (
          <InfoWindow
            position={{ lat: selectedPin.lat, lng: selectedPin.lng }}
            onCloseClick={() => setSelectedId(null)}
          >
            <PopupContent
              record={selectedPin.record}
              cfg={cfg}
              fields={allFields}
              isAr={isAr}
              openLabel={t('maps.open_record')}
              onOpen={() => onCardClick(selectedPin.record)}
            />
          </InfoWindow>
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

interface PopupContentProps {
  record: AppRecord;
  cfg: MapsConfig;
  fields: ModelField[];
  isAr: boolean;
  openLabel: string;
  onOpen: () => void;
}

function PopupContent({ record, cfg, fields, isAr, openLabel, onOpen }: PopupContentProps) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const titleField = cfg.popup_title_field_id ? byId.get(cfg.popup_title_field_id) : undefined;
  const subtitleField = cfg.popup_subtitle_field_id ? byId.get(cfg.popup_subtitle_field_id) : undefined;
  const badgeField = cfg.popup_badge_field_id ? byId.get(cfg.popup_badge_field_id) : undefined;
  const shownFields = cfg.popup_shown_field_ids
    .map((id) => byId.get(id))
    .filter((f): f is ModelField => Boolean(f));

  const renderValue = (field: ModelField): string => {
    const raw = record.data[field.name];
    if (raw == null || raw === '') return '—';
    if (Array.isArray(raw)) return raw.join(', ');
    if (typeof raw === 'object') return JSON.stringify(raw);
    return String(raw);
  };

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
    <div className="min-w-[200px] max-w-[260px]" dir={isAr ? 'rtl' : 'ltr'}>
      {badgeLabel && (
        <div className="mb-1">
          <Badge label={badgeLabel} color={badgeColor} />
        </div>
      )}
      <div className="text-sm font-bold text-charcoal mb-0.5">{title}</div>
      {subtitle && <div className="text-xs text-charcoal/60 mb-2">{subtitle}</div>}
      {shownFields.length > 0 && (
        <div className="space-y-0.5 mt-2 border-t border-sand/30 pt-2">
          {shownFields.map((f) => (
            <div key={f.id} className="flex justify-between gap-3 text-xs">
              <span className="text-charcoal/50">{isAr ? f.label_ar : f.label_en}</span>
              <span className="text-charcoal font-medium text-end">{renderValue(f)}</span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 text-xs font-bold text-copper hover:text-terracotta transition-colors"
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
