import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, MapPin, Play, X } from 'lucide-react';
import type { LinkBrochure, LinkPhoto, LinkVideo, UnitDetail, UnitSummary } from '../lib/api';
import { fetchUnit } from '../lib/api';
import { money, sqm, tr } from '../lib/i18n';
import type { Tracker } from '../lib/tracker';

const PdfViewer = lazy(() => import('@/components/ui/PdfViewer'));

// ── Photos ────────────────────────────────────────────────────────────────────

export function PhotosSection({ photos, tracker, isAr }: { photos: LinkPhoto[]; tracker: Tracker; isAr: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const show = useCallback((i: number) => {
    setOpen(i);
    const p = photos[i];
    if (p) tracker.track('photo_open', { item: p.id, once: true });
  }, [photos, tracker]);
  const current = open !== null ? photos[open] : null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => show(i)}
            className="aspect-[4/3] overflow-hidden rounded-xl bg-sand/30"
          >
            {p.thumb && <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />}
          </button>
        ))}
      </div>
      {current && open !== null && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95" role="dialog" aria-modal="true">
          <div className="flex items-center justify-between p-3 text-white/80">
            <span className="text-sm tabular-nums">{open + 1} / {photos.length}</span>
            <button type="button" onClick={() => setOpen(null)} aria-label={tr('close', isAr)} className="p-2">
              <X size={22} />
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-hidden px-2">
            {current.url && <img src={current.url} alt="" className="max-h-full max-w-full object-contain" />}
          </div>
          <div className="flex items-center justify-between p-4 text-white">
            <button
              type="button"
              disabled={open === 0}
              onClick={() => show(open - 1)}
              className="flex items-center gap-1 rounded-lg px-3 py-2 disabled:opacity-30"
            >
              {isAr ? <ChevronRight size={20} /> : <ChevronLeft size={20} />} {tr('prev', isAr)}
            </button>
            <button
              type="button"
              disabled={open === photos.length - 1}
              onClick={() => show(open + 1)}
              className="flex items-center gap-1 rounded-lg px-3 py-2 disabled:opacity-30"
            >
              {tr('next', isAr)} {isAr ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Videos ────────────────────────────────────────────────────────────────────

function TrackedVideo({ v, tracker }: { v: LinkVideo; tracker: Tracker }) {
  const onTime = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const el = e.currentTarget;
    if (!el.duration || !Number.isFinite(el.duration)) return;
    const pct = (el.currentTime / el.duration) * 100;
    for (const m of [25, 50, 75, 100]) {
      if (pct >= m - 0.5) tracker.track('video_progress', { item: v.id, value: m, once: true });
    }
  };
  if (!v.url) return null;
  return (
    <video
      src={v.url}
      controls
      playsInline
      preload="metadata"
      className="w-full rounded-xl bg-black"
      onPlay={() => tracker.track('video_play', { item: v.id, once: true })}
      onTimeUpdate={onTime}
    />
  );
}

export function VideosSection({ videos, tracker, isAr }: { videos: LinkVideo[]; tracker: Tracker; isAr: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {videos.map((v) => v.external ? (
        <a
          key={v.id}
          href={v.url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => { tracker.track('video_play', { item: v.id, once: true }); tracker.flushNow(); }}
          className="flex items-center justify-between rounded-xl border border-sand bg-white px-4 py-3 text-charcoal"
        >
          <span className="flex items-center gap-2"><Play size={18} className="text-copper" /> {tr('watch', isAr)}</span>
          <ExternalLink size={16} className="text-charcoal/50" />
        </a>
      ) : (
        <TrackedVideo key={v.id} v={v} tracker={tracker} />
      ))}
    </div>
  );
}

// ── Brochure ──────────────────────────────────────────────────────────────────

export function BrochureSection({ brochure, tracker, isAr }: { brochure: LinkBrochure; tracker: Tracker; isAr: boolean }) {
  const onPage = useCallback((page: number) => tracker.track('brochure_page', { item: String(page), once: true }), [tracker]);
  if (brochure.external || !brochure.url) {
    return (
      <a
        href={brochure.url ?? '#'}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => { tracker.track('brochure_page', { item: 'external', once: true }); tracker.flushNow(); }}
        className="flex items-center justify-center gap-2 rounded-xl bg-copper px-4 py-3 text-white"
      >
        {tr('openBrochure', isAr)} <ExternalLink size={16} />
      </a>
    );
  }
  return (
    <div className="h-[78vh] overflow-hidden rounded-xl border border-sand">
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-copper" /></div>}>
        <PdfViewer url={brochure.url} isAr={isAr} onPageChange={onPage} />
      </Suspense>
    </div>
  );
}

// ── Units ─────────────────────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between border-b border-sand/40 py-2 text-sm last:border-0">
      <span className="text-charcoal/60">{label}</span>
      <span className="font-medium text-charcoal">{value}</span>
    </div>
  );
}

export function UnitDetailView({ unit, isAr }: { unit: UnitDetail; isAr: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {unit.plan_url && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-chocolate">{tr('plan', isAr)}</h3>
          <img src={unit.plan_url} alt="" className="w-full rounded-xl bg-white object-contain" />
        </div>
      )}
      <div className="rounded-xl bg-white px-4">
        <Fact label={tr('price', isAr)} value={money(unit.price, isAr) || null} />
        <Fact label={tr('type', isAr)} value={unit.type} />
        <Fact label={tr('bedroomsLabel', isAr)} value={unit.bedrooms !== null ? String(unit.bedrooms) : null} />
        <Fact label={tr('bathroomsLabel', isAr)} value={unit.bathrooms !== null ? String(unit.bathrooms) : null} />
        <Fact label={tr('area', isAr)} value={sqm(unit.area, isAr) || null} />
        <Fact label={tr('totalArea', isAr)} value={unit.total_area && unit.total_area !== unit.area ? sqm(unit.total_area, isAr) : null} />
        <Fact label={tr('privateArea', isAr)} value={unit.private_area ? sqm(unit.private_area, isAr) : null} />
        <Fact label={tr('floor', isAr)} value={unit.floor} />
        <Fact label={tr('facade', isAr)} value={unit.facade} />
        <Fact label={tr('parking', isAr)} value={unit.parking} />
        <Fact label={tr('model', isAr)} value={unit.model} />
      </div>
      {unit.components.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-chocolate">{tr('components', isAr)}</h3>
          <div className="flex flex-wrap gap-2">
            {unit.components.map((c) => (
              <span key={c} className="rounded-full bg-sand/40 px-3 py-1 text-xs text-charcoal">{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function unitTitle(u: UnitSummary, isAr: boolean): string {
  return [u.type, u.bedrooms !== null ? `${u.bedrooms} ${tr('bedrooms', isAr)}` : null, u.area !== null ? sqm(u.area, isAr) : null]
    .filter(Boolean).join(' · ');
}

export function UnitsSection({ token, units, tracker, isAr }: { token: string; units: UnitSummary[]; tracker: Tracker; isAr: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, UnitDetail>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (u: UnitSummary) => {
    if (openId === u.id) { setOpenId(null); return; }
    setOpenId(u.id);
    tracker.track('unit_open', { item: u.id, once: true });
    if (details[u.id]) return;
    setLoadingId(u.id);
    setError(null);
    try {
      const r = await fetchUnit(token, u.id);
      setDetails((d) => ({ ...d, [u.id]: r.unit }));
    } catch (e) {
      console.error('[tracked-link] unit load failed:', e);
      setError(u.id);
    } finally {
      setLoadingId(null);
    }
  };

  if (!units.length) return <p className="py-10 text-center text-charcoal/60">{tr('noUnits', isAr)}</p>;
  return (
    <div className="flex flex-col gap-2">
      {units.map((u) => (
        <div key={u.id} className="overflow-hidden rounded-xl border border-sand/60 bg-white">
          <button type="button" onClick={() => void toggle(u)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start">
            <span className="min-w-0">
              <span className="block truncate font-medium text-charcoal">{unitTitle(u, isAr)}</span>
              {u.floor && <span className="block text-xs text-charcoal/60">{tr('floor', isAr)}: {u.floor}</span>}
            </span>
            <span className="shrink-0 font-semibold text-copper">{money(u.price, isAr)}</span>
          </button>
          {openId === u.id && (
            <div className="border-t border-sand/40 bg-cream/40 p-4">
              {loadingId === u.id && <Loader2 className="mx-auto animate-spin text-copper" />}
              {error === u.id && <p className="text-center text-sm text-red-700">{tr('loadFailed', isAr)}</p>}
              {details[u.id] && <UnitDetailView unit={details[u.id]!} isAr={isAr} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Location ──────────────────────────────────────────────────────────────────

/** Records the tap, then hands the customer to Google Maps. Crawlers (link
 *  previews) run no script, so they never count as a map open. */
export function LocationSection({ mapsUrl, place, tracker, isAr }: { mapsUrl: string | null; place: string; tracker: Tracker; isAr: boolean }) {
  const went = useRef(false);
  const go = useCallback(() => {
    if (!mapsUrl) return;
    tracker.track('map_open', { once: true });
    tracker.flushNow();
    went.current = true;
    window.location.href = mapsUrl;
  }, [mapsUrl, tracker]);

  useEffect(() => {
    if (!mapsUrl || went.current) return;
    const t = window.setTimeout(go, 900);
    return () => window.clearTimeout(t);
  }, [go, mapsUrl]);

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <MapPin size={40} className="text-copper" />
      {place && <p className="text-lg text-charcoal">{place}</p>}
      <p className="text-sm text-charcoal/60">{tr('openingMaps', isAr)}</p>
      {mapsUrl && (
        <button type="button" onClick={go} className="rounded-xl bg-copper px-5 py-3 text-white">
          {tr('openMaps', isAr)}
        </button>
      )}
    </div>
  );
}
