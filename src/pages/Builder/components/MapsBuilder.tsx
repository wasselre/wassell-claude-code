import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GoogleMap, Marker, useJsApiLoader } from '@react-google-maps/api';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  buildColoredPinIcon,
  parseMapStyleJson,
} from '@/lib/locationUtils';
import { useResolvedLocations } from '@/hooks/useResolvedLocations';
import type { AppModel, MapsConfig, ModelField } from '@/types';

interface MapsBuilderProps {
  model: AppModel;
  onChange: (model: AppModel) => void;
  /** Block edits when the model is frozen — see ModelEditor. */
  readOnly?: boolean;
}

const mapContainerStyle = { width: '100%', height: '400px', borderRadius: '12px' };

export default function MapsBuilder({ model, onChange, readOnly = false }: MapsBuilderProps) {
  const { t } = useTranslation();
  const { language, records } = useAppStore();
  const isAr = language === 'ar';

  const allFields = useMemo(
    () => model.schema.sections.flatMap((s) => s.fields).filter((f) => f.type !== 'section_mirror'),
    [model],
  );
  const urlFields = allFields.filter((f) => f.type === 'url' || f.type === 'text');
  const numberFields = allFields.filter((f) => f.type === 'number');
  const dropdownFields = allFields.filter((f) => f.type === 'dropdown' || f.type === 'multiselect');

  const cfg = model.maps_config;
  const update = (updates: Partial<MapsConfig>) => {
    onChange({ ...model, maps_config: { ...cfg, ...updates } });
  };

  const togglePopupField = (fieldId: string) => {
    const ids = cfg.popup_shown_field_ids.includes(fieldId)
      ? cfg.popup_shown_field_ids.filter((id) => id !== fieldId)
      : [...cfg.popup_shown_field_ids, fieldId];
    update({ popup_shown_field_ids: ids });
  };

  const [jsonStatus, setJsonStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');
  const validateJson = () => {
    if (!cfg.map_style_json || !cfg.map_style_json.trim()) {
      setJsonStatus('idle');
      return;
    }
    setJsonStatus(parseMapStyleJson(cfg.map_style_json) ? 'valid' : 'invalid');
  };

  const modelRecords = records[model.id] ?? [];
  // Show up to 5 pins in the preview. Short URLs that require server-side
  // resolution populate asynchronously via the same cache the Maps view uses.
  const { resolved: allResolved } = useResolvedLocations(model, modelRecords);
  const previewPins = useMemo(
    () =>
      allResolved.slice(0, 5).map((p) => ({
        id: p.record.id,
        lat: p.lat,
        lng: p.lng,
        color: p.color,
      })),
    [allResolved],
  );

  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const center =
    previewPins[0] ??
    (cfg.default_center_lat != null && cfg.default_center_lng != null
      ? { lat: cfg.default_center_lat, lng: cfg.default_center_lng }
      : DEFAULT_MAP_CENTER);
  const zoom = cfg.default_zoom ?? DEFAULT_MAP_ZOOM;
  const styles = parseMapStyleJson(cfg.map_style_json) ?? undefined;

  return (
    <div
      className={`grid grid-cols-1 lg:grid-cols-2 gap-8 ${
        readOnly ? 'pointer-events-none select-none opacity-75' : ''
      }`}
      aria-disabled={readOnly || undefined}
    >
      <div className="space-y-5">
        <Select label={t('maps.location_field')} hint={t('maps.location_field_hint')} value={cfg.location_url_field_id ?? ''} onChange={(v) => update({ location_url_field_id: v || null })} fields={urlFields} isAr={isAr} />
        <div className="grid grid-cols-2 gap-3">
          <Select label={t('maps.manual_lat_field')} value={cfg.manual_lat_field_id ?? ''} onChange={(v) => update({ manual_lat_field_id: v || null })} fields={numberFields} isAr={isAr} />
          <Select label={t('maps.manual_lng_field')} value={cfg.manual_lng_field_id ?? ''} onChange={(v) => update({ manual_lng_field_id: v || null })} fields={numberFields} isAr={isAr} />
        </div>
        <p className="text-xs text-charcoal/50 -mt-3">{t('maps.manual_latlng_hint')}</p>
        <Select label={t('maps.pin_color_field')} hint={t('maps.pin_color_hint')} value={cfg.pin_color_field_id ?? ''} onChange={(v) => update({ pin_color_field_id: v || null })} fields={dropdownFields} isAr={isAr} />
        <Select label={t('maps.pin_label_field')} value={cfg.pin_label_field_id ?? ''} onChange={(v) => update({ pin_label_field_id: v || null })} fields={allFields} isAr={isAr} />

        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('maps.click_action')}</label>
          <div className="flex gap-2">
            {(['popup', 'navigate'] as const).map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => update({ click_action: action })}
                className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                  cfg.click_action === action
                    ? 'bg-copper/10 border-copper text-copper font-bold'
                    : 'border-sand/50 text-charcoal/60 hover:bg-cream'
                }`}
              >
                {action === 'popup' ? t('maps.click_popup') : t('maps.click_navigate')}
              </button>
            ))}
          </div>
        </div>

        <Select label={t('maps.popup_title_field')} value={cfg.popup_title_field_id ?? ''} onChange={(v) => update({ popup_title_field_id: v || null })} fields={allFields} isAr={isAr} />
        <Select label={t('maps.popup_subtitle_field')} value={cfg.popup_subtitle_field_id ?? ''} onChange={(v) => update({ popup_subtitle_field_id: v || null })} fields={allFields} isAr={isAr} />
        <Select label={t('maps.popup_badge_field')} value={cfg.popup_badge_field_id ?? ''} onChange={(v) => update({ popup_badge_field_id: v || null })} fields={dropdownFields} isAr={isAr} />

        <div>
          <label className="block text-sm font-bold text-charcoal mb-2">{t('maps.popup_shown_fields')}</label>
          <div className="space-y-1 max-h-48 overflow-y-auto border border-sand/30 rounded-lg p-2">
            {allFields
              .filter(
                (f) =>
                  f.id !== cfg.popup_title_field_id &&
                  f.id !== cfg.popup_subtitle_field_id &&
                  f.id !== cfg.popup_badge_field_id,
              )
              .map((f) => (
                <label key={f.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={cfg.popup_shown_field_ids.includes(f.id)}
                    onChange={() => togglePopupField(f.id)}
                    className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                  />
                  <span className="text-sm text-charcoal">{isAr ? f.label_ar : f.label_en}</span>
                </label>
              ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('maps.style_json')}</label>
          <p className="text-xs text-charcoal/50 mb-1">{t('maps.style_json_hint')}</p>
          <textarea
            value={cfg.map_style_json ?? ''}
            onChange={(e) => {
              update({ map_style_json: e.target.value || null });
              setJsonStatus('idle');
            }}
            className="form-input text-xs font-mono min-h-[140px] leading-snug"
            dir="ltr"
            placeholder="[]"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={validateJson}
              className="text-xs px-2 py-1 rounded-md border border-sand/50 text-charcoal/70 hover:bg-cream"
            >
              {t('maps.validate_json')}
            </button>
            {jsonStatus === 'valid' && <span className="text-xs text-green-600">{t('maps.valid_json')}</span>}
            {jsonStatus === 'invalid' && <span className="text-xs text-red-600">{t('maps.invalid_json')}</span>}
          </div>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('maps.default_center')}</label>
          <div className="grid grid-cols-3 gap-3">
            <input
              type="number"
              step="any"
              placeholder={t('maps.default_center_lat')}
              value={cfg.default_center_lat ?? ''}
              onChange={(e) =>
                update({ default_center_lat: e.target.value === '' ? null : Number(e.target.value) })
              }
              className="form-input text-sm"
              dir="ltr"
            />
            <input
              type="number"
              step="any"
              placeholder={t('maps.default_center_lng')}
              value={cfg.default_center_lng ?? ''}
              onChange={(e) =>
                update({ default_center_lng: e.target.value === '' ? null : Number(e.target.value) })
              }
              className="form-input text-sm"
              dir="ltr"
            />
            <input
              type="number"
              step="1"
              placeholder={t('maps.default_zoom')}
              value={cfg.default_zoom ?? ''}
              onChange={(e) =>
                update({ default_zoom: e.target.value === '' ? null : Number(e.target.value) })
              }
              className="form-input text-sm"
              dir="ltr"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-bold text-charcoal mb-2">{t('maps.preview')}</label>
        {keyMissing ? (
          <EmptyMap title={t('maps.api_key_missing')} hint={t('maps.api_key_missing_hint')} />
        ) : loadError ? (
          <EmptyMap title={t('maps.api_key_missing')} hint={String(loadError.message ?? loadError)} />
        ) : !isLoaded ? (
          <div className="h-[400px] flex items-center justify-center text-charcoal/40 bg-cream/40 rounded-xl">
            {t('common.loading')}
          </div>
        ) : (
          <GoogleMap
            mapContainerStyle={mapContainerStyle}
            center={center}
            zoom={zoom}
            options={{ styles, disableDefaultUI: true, zoomControl: true }}
          >
            {previewPins.map((p) => (
              <Marker
                key={p.id}
                position={{ lat: p.lat, lng: p.lng }}
                icon={buildColoredPinIcon(p.color) as google.maps.Icon | undefined}
              />
            ))}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}

interface SelectProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  fields: ModelField[];
  isAr: boolean;
}

function Select({ label, hint, value, onChange, fields, isAr }: SelectProps) {
  return (
    <div>
      <label className="block text-sm font-bold text-charcoal mb-1">{label}</label>
      {hint && <p className="text-xs text-charcoal/50 mb-1">{hint}</p>}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="form-input text-sm">
        <option value="">—</option>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {isAr ? f.label_ar : f.label_en}
          </option>
        ))}
      </select>
    </div>
  );
}

function EmptyMap({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="h-[400px] flex flex-col items-center justify-center gap-2 text-center px-6 bg-cream/40 rounded-xl border border-dashed border-sand/50">
      <p className="text-sm font-bold text-charcoal/70">{title}</p>
      <p className="text-xs text-charcoal/50 max-w-sm">{hint}</p>
    </div>
  );
}
