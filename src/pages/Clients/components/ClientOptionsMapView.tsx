import { useMemo, type ReactNode } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';
import { useAppStore } from '@/stores/appStore';
import {
  buildColoredPinIcon, buildPillIcon,
} from '@/lib/locationUtils';
import { getMapsLoaderOptions } from '@/lib/mapsLoader';
import {
  CLIENT_OPTION_STATUS_META, CLIENT_OPTION_STATUS_ORDER,
  type ClientOptionStatus, type ClientOptionSourceType,
} from '@/lib/matching/clientOptions';
import BaseMapView, { type MapPin } from '@/components/map/BaseMapView';
import type { LocationItem } from '@/lib/geo/locationItems';
import type { AppRecord } from '@/types';

/**
 * MAP view for the Client Options tab — the alternative to the card list.
 * A thin ADAPTER over the shared BaseMapView: it maps every visible option that
 * carries coordinates to a pin colored by its option STATUS (same colors as the
 * status badges), supplies the status legend, and renders the clicked option's
 * full list card. The main option renders as a named pill that is never absorbed
 * into a cluster. Every piece of map plumbing — clustering, the client-area
 * highlight, the full-view button, the layers overlay, fit-bounds — lives in
 * BaseMapView, so this map and the Project Finder map stay in lock-step (they used
 * to be separate copies and kept drifting apart).
 *
 * Coordinates come from the option's saved facts snapshot (facts.latitude /
 * facts.longitude, written by the Project Finder at save time); options saved
 * before that snapshot existed — or added manually — fall back to the source
 * record's own latitude/longitude in the store.
 */

interface Props {
  /** The options to plot (the tab's already-filtered `visible` list). */
  options: AppRecord[];
  isAr: boolean;
  /** Render the clicked option as the full list card (identical action wiring). */
  renderCard: (option: AppRecord) => ReactNode;
  /** Tailwind height for the map container. Default h-[65vh]. */
  heightClass?: string;
  /** The client's selected area — shaded under the pins. See useClientAreaLayer. */
  areaItems?: LocationItem[] | null;
}

const asCoord = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

const SOURCE_MODEL: Record<ClientOptionSourceType, string> = {
  project: 'all_projects',
  unit: 'units',
  market_listing: 'market_listings',
};

// Our brand copper — project options render as NAMED pills in this colour so they
// never read the same as a market ad's status-coloured teardrop pin.
const OUR_PROJECTS_COLOR = '#B8734F';

export default function ClientOptionsMapView({ options, isAr, renderCard, heightClass = 'h-[65vh]', areaItems }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Track when the Maps script is ready. Icon builders return `undefined` until
  // `window.google.maps` exists; keying the memos below on `isLoaded` makes them
  // rebuild once it does — otherwise a map opened before the script finished
  // loading would cache `undefined` icons forever and every pin would fall back
  // to Google's default RED marker.
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));

  const optionById = useMemo(() => {
    const m = new Map<string, AppRecord>();
    for (const r of options) m.set(r.id, r);
    return m;
  }, [options]);

  // One icon per status color, reused across markers (built lazily as statuses appear).
  const iconFor = useMemo(() => {
    const cache = new Map<string, google.maps.Icon | undefined>();
    return (status: ClientOptionStatus) => {
      const color = (CLIENT_OPTION_STATUS_META[status] ?? CLIENT_OPTION_STATUS_META.suitable).color;
      if (!cache.has(color)) cache.set(color, buildColoredPinIcon(color) as google.maps.Icon | undefined);
      return cache.get(color);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  // facts snapshot first; source record's own coordinates as the fallback. The main
  // option renders as a named pill (solo, on top); the rest are status-colored pins.
  const pins = useMemo<MapPin[]>(() => {
    const modelIdByName = new Map(models.map((m) => [m.name, m.id]));
    const out: MapPin[] = [];
    for (const r of options) {
      const d = r.data as Record<string, unknown>;
      const f = (d.facts ?? {}) as Record<string, unknown>;
      let lat = asCoord(f.latitude);
      let lng = asCoord(f.longitude);
      if (lat == null || lng == null) {
        const modelName = SOURCE_MODEL[d.source_type as ClientOptionSourceType];
        const mid = modelName ? modelIdByName.get(modelName) : undefined;
        const src = mid ? (records[mid] ?? []).find((x) => x.id === d.source_id) : undefined;
        if (src) {
          lat = asCoord((src.data as Record<string, unknown>).latitude);
          lng = asCoord((src.data as Record<string, unknown>).longitude);
        }
      }
      if (lat == null || lng == null) continue;
      const status = d.status as ClientOptionStatus;
      const isMain = d.is_main === true;
      const isProject = (d.source_type as ClientOptionSourceType) === 'project';
      const name = typeof d.source_name === 'string' && d.source_name ? d.source_name : L('بدون اسم', 'Untitled');
      // Our projects (and the main option) render as a NAMED copper pill — the
      // name inside the marker, in our brand colour — so they never read the same
      // as a market ad's status-coloured teardrop. Market listings & units keep
      // their status-coloured pins.
      const asPill = isMain || isProject;
      out.push({
        id: r.id,
        lat,
        lng,
        icon: asPill
          ? (buildPillIcon(name, OUR_PROJECTS_COLOR) as google.maps.Icon | undefined)
          : iconFor(status),
        title: name,
        // Pills sit on top (main above the rest) so they're never hidden under
        // another pin, and are solo markers so a named pill is never absorbed
        // into a cluster.
        zIndex: isMain ? 1000 : isProject ? 900 : undefined,
        solo: asPill,
        // Rebuild the marker when the STATUS color (or the pill name / main /
        // project flag) changes.
        sig: asPill ? `${isMain ? 'main' : 'proj'}:${name}` : status,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, models, records, isAr, isLoaded]);

  const missingCount = options.length - pins.length;

  // Status legend covers only the status-coloured teardrops (market listings /
  // units). Project & main options render as copper "Our Projects" pills, so
  // they're represented by their own swatch instead of a status colour.
  const statusesPresent = useMemo(() => {
    const present = new Set<string>();
    for (const r of options) {
      const d = r.data as Record<string, unknown>;
      if (d.is_main === true || d.source_type === 'project') continue;
      present.add(String(d.status));
    }
    return CLIENT_OPTION_STATUS_ORDER.filter((s) => present.has(s));
  }, [options]);

  const hasProjectPills = useMemo(
    () => options.some((r) => {
      const d = r.data as Record<string, unknown>;
      return d.is_main === true || d.source_type === 'project';
    }),
    [options],
  );

  const legend = (
    <>
      {hasProjectPills && (
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: OUR_PROJECTS_COLOR }} />
          {L('مشاريعنا', 'Our Projects')}
        </span>
      )}
      {statusesPresent.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CLIENT_OPTION_STATUS_META[s].color }} />
          {isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en}
        </span>
      ))}
    </>
  );

  return (
    <BaseMapView
      pins={pins}
      isAr={isAr}
      areaItems={areaItems}
      heightClass={heightClass}
      missingCount={missingCount}
      outerClassName="overflow-hidden rounded-2xl border border-sand/30 bg-white"
      stateBoxClassName="rounded-2xl border border-sand/30 bg-white"
      renderSelectedCard={(id) => { const o = optionById.get(id); return o ? renderCard(o) : null; }}
      legend={legend}
    />
  );
}
