import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { fetchPage, type LinkPage, type LinkSection } from './lib/api';
import { Tracker, type TrackSection } from './lib/tracker';
import { money, tr, type Key } from './lib/i18n';
import { BrochureSection, LocationSection, PhotosSection, UnitDetailView, UnitsSection, VideosSection } from './components/Sections';

/**
 * Public tracked-link page — /v/:token (a unit link) and /v/:token/:section
 * (photos · videos · brochure · units · location of a project message).
 *
 * Outside the app shell: no login, no CRM store (App.tsx treats /v/ as a
 * self-contained public path). Everything it shows comes from the anonymous
 * /api/tracked-link endpoint; everything the customer does is reported by the
 * Tracker so the CRM can score their interest.
 */

const SECTION_LABEL: Record<LinkSection, Key> = {
  photos: 'photos', videos: 'videos', brochure: 'brochure', units: 'units', location: 'location',
};

export default function TrackedLinkPage() {
  const { token = '', section } = useParams();
  const { search } = useLocation();
  const isAr = new URLSearchParams(search).get('lang') !== 'en';
  const [page, setPage] = useState<LinkPage | null>(null);
  const [error, setError] = useState<'missing' | 'failed' | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
    document.documentElement.lang = isAr ? 'ar' : 'en';
  }, [isAr]);

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setError(null);
    fetchPage(token, section)
      .then((p) => { if (!cancelled) setPage(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[tracked-link] page load failed:', msg);
        setError(/not available/i.test(msg) ? 'missing' : 'failed');
      });
    return () => { cancelled = true; };
  }, [token, section, reload]);

  // One tracker per page view (section), started once the page is known.
  const trackSection: TrackSection | null = page ? (page.kind === 'unit' ? 'unit' : page.section) : null;
  const tracker = useMemo(() => (trackSection ? new Tracker(token, trackSection) : null), [token, trackSection]);
  useEffect(() => {
    if (!tracker) return;
    tracker.start();
    if (page?.kind === 'unit') tracker.track('unit_open', { item: page.unit.id, once: true });
    return () => tracker.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per tracker
  }, [tracker]);

  useEffect(() => {
    if (page) document.title = `${page.project.name} — ${tr('brand', isAr)}`;
  }, [page, isAr]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-cream px-6 text-center">
        <p className="text-lg font-semibold text-chocolate">{error === 'missing' ? tr('notAvailable', isAr) : tr('loadFailed', isAr)}</p>
        {error === 'missing'
          ? <p className="text-sm text-charcoal/70">{tr('notAvailableHint', isAr)}</p>
          : <button type="button" onClick={() => setReload((n) => n + 1)} className="rounded-xl bg-copper px-5 py-2 text-white">{tr('retry', isAr)}</button>}
      </div>
    );
  }
  if (!page || !tracker) {
    return <div className="flex min-h-screen items-center justify-center bg-cream"><Loader2 size={26} className="animate-spin text-copper" /></div>;
  }

  const p = page.project;
  const place = [p.district, p.city].filter(Boolean).join('، ');
  const langQs = isAr ? '' : '?lang=en';

  return (
    <div className="min-h-screen bg-cream text-charcoal">
      <header className="relative">
        {p.cover_url
          ? <img src={p.cover_url} alt="" className="h-52 w-full object-cover sm:h-72" />
          : <div className="h-24 w-full bg-chocolate" />}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-4 pb-3 pt-10 text-white">
          <h1 className="text-2xl font-bold">{p.name}</h1>
          <p className="text-sm text-white/85">
            {[place, p.readiness ? tr(p.readiness === 'ready' ? 'ready' : 'offPlan', isAr) : null,
              p.price_from ? `${tr('from', isAr)} ${money(p.price_from, isAr)}` : null].filter(Boolean).join(' · ')}
          </p>
        </div>
      </header>

      {page.kind === 'project' && page.sections.length > 1 && (
        <nav className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-sand/50 bg-cream/95 px-3 py-2 backdrop-blur">
          {page.sections.map((s) => (
            <Link
              key={s}
              to={`/v/${token}/${s}${langQs}`}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm ${s === page.section ? 'bg-copper text-white' : 'bg-white text-charcoal'}`}
            >
              {tr(SECTION_LABEL[s], isAr)}
            </Link>
          ))}
        </nav>
      )}

      <main className="mx-auto max-w-3xl px-3 py-4">
        {page.kind === 'unit' && (
          <>
            <h2 className="mb-3 text-lg font-semibold text-chocolate">
              {tr('unit', isAr)} {page.unit.code ?? ''}
            </h2>
            <UnitDetailView unit={page.unit} isAr={isAr} />
          </>
        )}
        {page.kind === 'project' && page.section === 'photos' && page.photos && (
          <PhotosSection photos={page.photos} tracker={tracker} isAr={isAr} />
        )}
        {page.kind === 'project' && page.section === 'videos' && page.videos && (
          <VideosSection videos={page.videos} tracker={tracker} isAr={isAr} />
        )}
        {page.kind === 'project' && page.section === 'brochure' && page.brochure && (
          <BrochureSection brochure={page.brochure} tracker={tracker} isAr={isAr} />
        )}
        {page.kind === 'project' && page.section === 'units' && page.units && (
          <UnitsSection token={token} units={page.units} tracker={tracker} isAr={isAr} />
        )}
        {page.kind === 'project' && page.section === 'location' && page.location && (
          <LocationSection mapsUrl={page.location.maps_url} place={place} tracker={tracker} isAr={isAr} />
        )}
      </main>

      <footer className="py-6 text-center text-xs text-charcoal/50">{tr('brand', isAr)}</footer>
    </div>
  );
}
