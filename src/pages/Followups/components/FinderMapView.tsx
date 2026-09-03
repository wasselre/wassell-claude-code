import { useMemo, type ReactNode } from 'react';
import { markActivity } from '@/lib/perf/freezeDetector';
import { buildColoredPinIcon } from '@/lib/locationUtils';
import type { FinderMatch, FinderSource } from '@/lib/matching/projectFinder';
import BaseMapView, { type MapPin } from '@/components/map/BaseMapView';
import type { LocationItem } from '@/lib/geo/locationItems';

/**
 * MAP view for the Project Finder results — the alternative to the card list.
 * A thin ADAPTER over the shared BaseMapView: it maps each match with coordinates
 * to a pin colored by SOURCE (our projects / market / all projects), supplies the
 * source legend, and renders the clicked pin's FinderCard. Every piece of map
 * plumbing — clustering, the client-area highlight, the full-view button, the
 * layers overlay, fit-bounds, focus — lives in BaseMapView, so this map and the
 * Client Options map stay in lock-step (they used to be separate copies and kept
 * drifting apart).
 *
 * Shared by the standalone Project Finder page and the Follow-up finder.
 */

interface Props {
  /** The matches to plot (typically pinned our-projects + the active tab's items). */
  matches: FinderMatch[];
  isAr: boolean;
  /** Fallback pin action when no card renderer is supplied (opens the record). */
  onOpenDetails: (item: FinderMatch) => void;
  /** Render the clicked match as a full card (the parent's own wired FinderCard).
   *  When provided, a pin click shows this card in a panel instead of navigating. */
  renderSelectedCard?: (match: FinderMatch) => ReactNode;
  /** External "show on map" request from a list card — open + center this pin. */
  focus?: { id: string; nonce: number } | null;
  /** Tailwind height for the map container. Default h-[70vh]. */
  heightClass?: string;
  /** The client's selected area — shaded under the pins. See useClientAreaLayer. */
  areaItems?: LocationItem[] | null;
}

// Pin color by source — mirrors the card SourcePill so map & list read the same.
const SOURCE_COLOR: Record<FinderSource, string> = {
  our_projects: '#16A34A',   // green — our portfolio
  market_listings: '#4A2C2A', // chocolate — external market ads
  all_projects: '#4A4E54',   // charcoal — the listings DB
};
const SOURCE_LABEL: Record<FinderSource, { ar: string; en: string }> = {
  our_projects: { ar: 'مشاريعنا', en: 'Our Projects' },
  market_listings: { ar: 'إعلانات السوق', en: 'Market' },
  all_projects: { ar: 'كل المشاريع', en: 'Listings DB' },
};

const asCoord = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

export default function FinderMapView({ matches, isAr, onOpenDetails, renderSelectedCard, focus, heightClass = 'h-[70vh]', areaItems }: Props) {
  // One pin icon per source color, reused across every marker (a dense tab has
  // thousands of pins — re-encoding an identical SVG data-URI per marker was the
  // main-thread stall when opening the map on a large result set).
  const iconBySource = useMemo(() => ({
    our_projects: buildColoredPinIcon(SOURCE_COLOR.our_projects) as google.maps.Icon | undefined,
    market_listings: buildColoredPinIcon(SOURCE_COLOR.market_listings) as google.maps.Icon | undefined,
    all_projects: buildColoredPinIcon(SOURCE_COLOR.all_projects) as google.maps.Icon | undefined,
  }), []);

  // Only matches with real coordinates can be plotted. Keyed by project_id, colored
  // by source; our projects are "solo" pins (never clustered) and sit on top.
  const matchById = useMemo(() => {
    const m = new Map<string, FinderMatch>();
    for (const x of matches) m.set(x.project_id, x);
    return m;
  }, [matches]);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    for (const m of matches) {
      const lat = asCoord(m.facts.latitude);
      const lng = asCoord(m.facts.longitude);
      if (lat == null || lng == null) continue;
      // Market pins carry the Aqar ad id in the hover title ("… @123456").
      const extId =
        m.source === 'market_listings' && typeof m.facts.external_id === 'string' && m.facts.external_id
          ? ` @${m.facts.external_id}`
          : '';
      out.push({
        id: m.project_id,
        lat,
        lng,
        icon: iconBySource[m.source],
        title: `${m.project_name}${extId}`,
        // Our projects sit on top so they're never hidden under a market pin.
        zIndex: m.source === 'our_projects' ? 1000 : undefined,
        solo: m.source === 'our_projects',
        sig: m.source,
      });
    }
    return out;
  }, [matches, iconBySource]);

  const missingCount = matches.length - pins.length;

  const legend = (Object.keys(SOURCE_LABEL) as FinderSource[]).map((s) => (
    <span key={s} className="inline-flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLOR[s] }} />
      {isAr ? SOURCE_LABEL[s].ar : SOURCE_LABEL[s].en}
    </span>
  ));

  return (
    <BaseMapView
      pins={pins}
      isAr={isAr}
      focus={focus}
      areaItems={areaItems}
      heightClass={heightClass}
      mobileGreedy
      cardMaxWidthClass="max-w-[360px]"
      missingCount={missingCount}
      onRebuild={(count) => markActivity(`finder: rendering ${count} map pins`)}
      onPinClick={(id) => { const m = matchById.get(id); if (m) onOpenDetails(m); }}
      renderSelectedCard={renderSelectedCard ? (id) => { const m = matchById.get(id); return m ? renderSelectedCard(m) : null; } : undefined}
      legend={legend}
    />
  );
}
