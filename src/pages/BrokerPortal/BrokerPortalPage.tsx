/**
 * /brokers/:token — public broker portal (no login).
 *
 * One developer's full sales kit for outside brokers: every project with its
 * units, floor plans, payment plans, photos, videos, marketing library and
 * brochures. Data comes from the anonymous /api/broker-portal endpoint, which
 * resolves the token against `broker_portals` and returns a whitelisted,
 * signed-URL projection (see api/broker-portal.ts).
 *
 * URL state (so a broker can share a deep link with a client):
 *   ?p=<projectId>&tab=<tab>&u=<unitId>&lang=en
 * Arabic is the default language; the page keeps its own language (it does
 * not touch the logged-in app's stored preference).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Building2, Globe, Loader2, MapPin, Phone, Search } from 'lucide-react';
import {
  fetchPortalOverview, fetchPortalProject,
  type PortalOverview, type PortalProjectCard, type PortalProjectDetail,
} from './lib/api';
import { bi, fmtMoneyShort, fmtNum, fmtRange, makeT } from './lib/i18n';
import ProjectView, { type TabKey } from './components/ProjectView';

const TABS: TabKey[] = ['overview', 'units', 'plans', 'photos', 'videos', 'library', 'documents'];

type Load<T> = { phase: 'loading' } | { phase: 'ready'; data: T; at: number } | { phase: 'not-found' } | { phase: 'error'; message: string };

/** Signed media URLs live 6 h server-side; refresh a bit before that. */
const STALE_MS = 5 * 60 * 60 * 1000;

export default function BrokerPortalPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [params, setParams] = useSearchParams();
  const isAr = params.get('lang') !== 'en';
  const t = makeT(isAr);
  const projectId = params.get('p');
  const tabParam = params.get('tab') as TabKey | null;
  const tab: TabKey = tabParam && TABS.includes(tabParam) ? tabParam : (params.get('u') ? 'units' : 'overview');

  const [overview, setOverview] = useState<Load<PortalOverview>>({ phase: 'loading' });
  const [detail, setDetail] = useState<Load<PortalProjectDetail>>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const detailCache = useRef(new Map<string, { data: PortalProjectDetail; at: number }>());

  useEffect(() => {
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
    document.documentElement.lang = isAr ? 'ar' : 'en';
  }, [isAr]);

  const loadOverview = useCallback(() => {
    setOverview({ phase: 'loading' });
    fetchPortalOverview(token)
      .then((data) => setOverview({ phase: 'ready', data, at: Date.now() }))
      .catch((e: Error & { status?: number }) => {
        console.error('[broker-portal] overview failed:', e.message);
        setOverview(e.status === 404 ? { phase: 'not-found' } : { phase: 'error', message: e.message });
      });
  }, [token]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadDetail = useCallback((id: string, force = false) => {
    const cached = detailCache.current.get(id);
    if (cached && !force && Date.now() - cached.at < STALE_MS) {
      setDetail({ phase: 'ready', data: cached.data, at: cached.at });
      return;
    }
    setDetail({ phase: 'loading' });
    fetchPortalProject(token, id)
      .then((data) => {
        const at = Date.now();
        detailCache.current.set(id, { data, at });
        setDetail({ phase: 'ready', data, at });
      })
      .catch((e: Error & { status?: number }) => {
        console.error('[broker-portal] project failed:', e.message);
        setDetail(e.status === 404 ? { phase: 'not-found' } : { phase: 'error', message: e.message });
      });
  }, [token]);

  useEffect(() => {
    if (projectId) loadDetail(projectId);
  }, [projectId, loadDetail]);

  // A tab left open past the signed-URL lifetime re-fetches on focus.
  useEffect(() => {
    const onFocus = () => {
      if (overview.phase === 'ready' && Date.now() - overview.at > STALE_MS) loadOverview();
      if (projectId && detail.phase === 'ready' && Date.now() - detail.at > STALE_MS) loadDetail(projectId, true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [overview, detail, projectId, loadOverview, loadDetail]);

  const update = (patch: Record<string, string | null>, push = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: !push });
  };

  const openProject = (id: string) => {
    update({ p: id, tab: null, u: null });
    window.scrollTo({ top: 0 });
  };

  const data = overview.phase === 'ready' ? overview.data : null;
  const title = data ? (isAr ? data.portal.title_ar : data.portal.title_en) || data.developer.name : '';

  useEffect(() => {
    const projName = detail.phase === 'ready' && projectId ? detail.data.project.name : null;
    document.title = [projName, title, t('gift')].filter(Boolean).join(' · ');
  }, [title, detail, projectId, t]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.projects;
    return data.projects.filter((p) =>
      [p.name, p.location.district?.ar, p.location.district?.en, p.location.city?.ar, p.location.city?.en]
        .some((s) => s?.toLowerCase().includes(q)),
    );
  }, [data, query]);

  const totals = useMemo(() => {
    const ps = data?.projects ?? [];
    return {
      projects: ps.length,
      units: ps.reduce((a, p) => a + p.unit_count, 0),
      available: ps.reduce((a, p) => a + p.available_units, 0),
    };
  }, [data]);

  const shareBaseUrl = `${window.location.origin}/brokers/${token}?p=${projectId ?? ''}${isAr ? '' : '&lang=en'}`;

  return (
    <div className="min-h-screen bg-cream-light text-charcoal overflow-x-hidden" style={{ fontFamily: '"Amiri", serif' }}>
      {/* Top bar */}
      <header className="bg-white/90 backdrop-blur border-b border-sand/40">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/assets/wassel-icon.png" alt="" className="w-9 h-9 object-contain shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-chocolate truncate">{title || t('brand')}</div>
              <div className="text-[11px] text-charcoal/50 truncate">{t('gift')} · {t('brand')}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => update({ lang: isAr ? 'en' : null }, false)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand text-sm font-bold text-charcoal hover:border-copper"
          >
            <Globe size={15} /> {isAr ? 'English' : 'العربية'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        {overview.phase === 'loading' && <Centered><Loader2 className="animate-spin text-copper" size={28} /></Centered>}
        {overview.phase === 'not-found' && <Message title={t('notFoundTitle')} body={t('notFoundBody')} />}
        {overview.phase === 'error' && <Message title={t('errorTitle')} body={overview.message} onRetry={loadOverview} retryLabel={t('retry')} />}

        {data && !projectId && (
          <div className="space-y-8">
            {/* Developer hero */}
            <section className="relative overflow-hidden rounded-3xl bg-chocolate text-white px-6 sm:px-10 py-10 sm:py-14 shadow-xl">
              <img src="/assets/wassel-icon-white.png" alt="" className="absolute -bottom-10 -end-10 w-64 opacity-[0.07] pointer-events-none" />
              <div className="relative max-w-3xl">
                <div className="text-copper-200 text-sm font-bold mb-2">{t('gift')}</div>
                <h1 className="text-3xl sm:text-5xl font-bold leading-tight">{title}</h1>
                <p className="mt-4 text-white/80 leading-8 text-[15px]">{t('intro')}</p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Stat label={t('projects')} value={fmtNum(totals.projects)} />
                  <Stat label={t('totalUnits')} value={fmtNum(totals.units)} />
                  <Stat label={t('available')} value={fmtNum(totals.available)} />
                </div>
                {(data.developer.phone || data.developer.website) && (
                  <div className="mt-6 flex flex-wrap gap-2 text-sm">
                    {data.developer.phone && (
                      <a href={`tel:${data.developer.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">
                        <Phone size={14} /> <span dir="ltr">{data.developer.phone}</span>
                      </a>
                    )}
                    {data.developer.website && (
                      <a href={data.developer.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">
                        <Globe size={14} /> {t('website')}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <h2 className="text-2xl font-bold text-chocolate">{t('projects')}</h2>
                <label className="relative sm:w-80">
                  <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('searchProjects')}
                    className="w-full h-11 rounded-xl border border-sand bg-white ps-9 pe-3 text-sm focus:outline-none focus:border-copper"
                  />
                </label>
              </div>
              {filtered.length === 0 ? (
                <Message title={t('noResults')} body="" />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filtered.map((p) => <ProjectCard key={p.id} p={p} isAr={isAr} onOpen={() => openProject(p.id)} />)}
                </div>
              )}
            </section>
          </div>
        )}

        {data && projectId && (
          <>
            {detail.phase === 'loading' && <Centered><Loader2 className="animate-spin text-copper" size={28} /></Centered>}
            {detail.phase === 'not-found' && <Message title={t('notFoundTitle')} body="" onRetry={() => update({ p: null, tab: null, u: null })} retryLabel={t('back')} />}
            {detail.phase === 'error' && <Message title={t('errorTitle')} body={detail.message} onRetry={() => loadDetail(projectId, true)} retryLabel={t('retry')} />}
            {detail.phase === 'ready' && (
              <ProjectView
                key={projectId}
                detail={detail.data}
                isAr={isAr}
                onBack={() => update({ p: null, tab: null, u: null })}
                tab={tab}
                onTab={(k) => update({ tab: k === 'overview' ? null : k, u: null }, false)}
                initialUnitId={params.get('u')}
                shareBaseUrl={shareBaseUrl}
              />
            )}
          </>
        )}
      </main>

      <footer className="border-t border-sand/40 mt-10">
        <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-charcoal/55">
          <div className="inline-flex items-center gap-2">
            <img src="/assets/wassel-icon.png" alt="" className="w-5 h-5 object-contain" />
            {t('poweredBy')}
          </div>
          <div>{t('lastUpdated')}</div>
        </div>
      </footer>
    </div>
  );
}

function ProjectCard({ p, isAr, onOpen }: { p: PortalProjectCard; isAr: boolean; onOpen: () => void }) {
  const t = makeT(isAr);
  const place = [bi(p.location.district, isAr), bi(p.location.city, isAr)].filter(Boolean).join(isAr ? '، ' : ', ');
  const from = p.available_price_range?.min ?? p.available_price_range?.max ?? null;
  const area = fmtRange(p.available_area_range, (n) => `${fmtNum(n)} ${t('m2')}`);
  const hasUnits = p.unit_count > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group text-start rounded-3xl overflow-hidden bg-white border border-sand/50 hover:shadow-xl hover:-translate-y-0.5 transition flex flex-col"
    >
      <div className="relative aspect-[3/2] bg-gradient-to-br from-chocolate to-copper overflow-hidden">
        {p.cover ? (
          <img src={p.cover} alt={p.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Building2 size={48} className="text-white/30" />
          </div>
        )}
        <div className="absolute top-3 start-3 flex flex-wrap gap-1.5">
          {p.status && <span className="px-2.5 py-1 rounded-full bg-black/55 backdrop-blur text-white text-[11px] font-bold">{bi(p.status, isAr)}</span>}
        </div>
        {hasUnits && (
          <div className={`absolute bottom-3 end-3 px-2.5 py-1 rounded-full text-[11px] font-bold ${p.available_units > 0 ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>
            {p.available_units > 0 ? `${fmtNum(p.available_units)} ${t('availableUnits')}` : t('soldOut')}
          </div>
        )}
      </div>
      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="text-xl font-bold text-chocolate leading-snug">{p.name}</div>
        {place && <div className="inline-flex items-center gap-1 text-sm text-charcoal/60"><MapPin size={14} /> {place}</div>}
        <div className="flex flex-wrap gap-1.5">
          {p.unit_types.map((u) => (
            <span key={u.ar} className="px-2 py-0.5 rounded-full bg-cream border border-sand/50 text-[11px] text-charcoal">{bi(u, isAr)}</span>
          ))}
        </div>
        <div className="mt-auto pt-3 flex items-end justify-between gap-2 border-t border-sand/30">
          <div>
            <div className="text-[11px] text-charcoal/50">{from != null ? t('from') : ''}</div>
            <div className="text-lg font-bold text-copper">{from != null ? fmtMoneyShort(from, isAr) : (hasUnits ? '—' : t('comingSoon'))}</div>
          </div>
          {area && <div className="text-xs text-charcoal/60">{area}</div>}
        </div>
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2.5 rounded-2xl bg-white/10 backdrop-blur">
      <div className="text-2xl font-bold leading-none">{value}</div>
      <div className="text-xs text-white/70 mt-1">{label}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="py-32 flex items-center justify-center">{children}</div>;
}

function Message({ title, body, onRetry, retryLabel }: { title: string; body: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="max-w-md mx-auto my-16 text-center rounded-3xl bg-white border border-sand/50 p-8">
      <AlertTriangle className="mx-auto text-copper" size={32} />
      <h2 className="mt-3 text-xl font-bold text-chocolate">{title}</h2>
      {body && <p className="mt-2 text-sm text-charcoal/60 leading-7">{body}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-5 px-4 py-2 rounded-xl bg-copper text-white text-sm font-bold hover:bg-terracotta">
          {retryLabel}
        </button>
      )}
    </div>
  );
}
