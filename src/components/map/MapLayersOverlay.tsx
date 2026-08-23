import { useMemo, useState } from 'react';
import { Layers, X, Loader2 } from 'lucide-react';
import { MAP_LAYER_GROUPS, categoriesForLayers } from '@/lib/geo/mapLayers';
import { useMapElementLayers } from './useMapElementLayers';

/**
 * Floating map layer control — the single shared panel mounted on every pin map
 * (records/all_projects, Project Finder, Client Options). Lets the user switch
 * optional context layers on over the property pins: main streets, ring roads,
 * metro, malls, parks, hospitals, universities, landmarks.
 *
 * Self-contained: holds its own toggle state (all OFF by default — the map opens
 * clean), resolves the enabled layers to geo_elements categories, and drives
 * useMapElementLayers to draw them. Drop it as a child of <GoogleMap> with the
 * map instance:  {map && <MapLayersOverlay map={map} isAr={isAr} />}
 *
 * The administrative boundary outline is a separate always-on layer
 * (useGeoBoundaryLayer) and is not toggled here.
 */
export default function MapLayersOverlay({ map, isAr }: { map: google.maps.Map | null; isAr: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Set<string>>(() => new Set());

  const activeCategories = useMemo(() => categoriesForLayers(active), [active]);
  const { loading } = useMapElementLayers(map, activeCategories, isAr);

  const toggle = (id: string) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const L = (ar: string, en: string) => (isAr ? ar : en);
  const activeCount = active.size;

  return (
    <div className="absolute top-3 start-3 z-10" dir={isAr ? 'rtl' : 'ltr'}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-sand/50 bg-white/95 px-2.5 py-1.5 text-[13px] font-semibold text-charcoal shadow-sm backdrop-blur hover:bg-cream"
          aria-label={L('طبقات الخريطة', 'Map layers')}
        >
          <Layers size={15} className="text-copper" />
          {L('الطبقات', 'Layers')}
          {activeCount > 0 && (
            <span className="rounded-full bg-copper px-1.5 text-[11px] font-bold text-white">{activeCount}</span>
          )}
        </button>
      ) : (
        <div className="w-56 overflow-hidden rounded-xl border border-sand/50 bg-white/97 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between border-b border-sand/40 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-charcoal">
              <Layers size={14} className="text-copper" />
              {L('طبقات الخريطة', 'Map layers')}
              {loading && <Loader2 size={12} className="animate-spin text-charcoal/40" />}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-charcoal/40 hover:text-charcoal"
              aria-label={L('إغلاق', 'Close')}
            >
              <X size={15} />
            </button>
          </div>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-3">
            {MAP_LAYER_GROUPS.map((group) => (
              <div key={group.label_en}>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-charcoal/40">
                  {L(group.label_ar, group.label_en)}
                </div>
                <div className="space-y-0.5">
                  {group.layers.map((layer) => (
                    <label
                      key={layer.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-cream"
                    >
                      <input
                        type="checkbox"
                        checked={active.has(layer.id)}
                        onChange={() => toggle(layer.id)}
                        className="h-3.5 w-3.5 accent-copper"
                      />
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: layer.color }}
                        aria-hidden
                      />
                      <span className="text-[13px] text-charcoal">{L(layer.label_ar, layer.label_en)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => setActive(new Set())}
              className="w-full border-t border-sand/40 px-3 py-2 text-[12px] font-semibold text-charcoal/55 hover:bg-cream hover:text-charcoal"
            >
              {L('مسح الكل', 'Clear all')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
