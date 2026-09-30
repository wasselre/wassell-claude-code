/**
 * One project on the broker page: hero + KPI strip + tabs
 * (overview · units · floor plans · photos · videos · marketing library · documents).
 */

import { useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Building2, CalendarClock, CheckCircle2, Clock, FileText, Film, Images,
  LayoutGrid, Library, MapPin, Maximize2, Send, ShieldCheck, Sparkles, Wallet,
} from 'lucide-react';
import SendToClientModal from './SendToClientModal';
import type { PortalFile, PortalProjectDetail, PortalUnit } from '../lib/api';
import { bi, fmtDate, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, fmtRange, makeT, type TKey } from '../lib/i18n';
import { DocumentsSection, Lightbox, MediaGrid, VideosSection, fileToLightbox } from './Media';
import UnitsSection, { ScheduleList } from './UnitsSection';

export type TabKey = 'overview' | 'units' | 'plans' | 'photos' | 'videos' | 'library' | 'documents';

export default function ProjectView({
  token, canSend, detail, isAr, onBack, tab, onTab, initialUnitId,
}: {
  token: string;
  canSend: boolean;
  detail: PortalProjectDetail;
  isAr: boolean;
  onBack: () => void;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  initialUnitId: string | null;
}) {
  const t = makeT(isAr);
  const { project: p, units, files, hosted_videos } = detail;
  const [focusUnits, setFocusUnits] = useState<string[] | null>(null);
  const [heroIdx, setHeroIdx] = useState<number | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const by = useMemo(() => {
    const out: Record<'photos' | 'videos' | 'library' | 'documents' | 'plans', PortalFile[]> = {
      photos: [], videos: [], library: [], documents: [], plans: [],
    };
    for (const f of files) out[f.section].push(f);
    // The Videos tab shows EVERY video, including the marketing-library reels.
    out.videos = [...out.videos, ...out.library.filter((f) => f.kind === 'video')];
    return out;
  }, [files]);
  const filesById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

  const heroImages = useMemo(() => {
    const imgs = [...by.photos, ...by.library.filter((f) => f.kind === 'image' && (f.width ?? 0) >= (f.height ?? 0))];
    return imgs.slice(0, 12);
  }, [by]);

  const externalLinks = [
    p.links.developer_brochure && { label: t('developerBrochure'), url: p.links.developer_brochure },
    p.links.brochure && { label: t('brochure'), url: p.links.brochure },
    p.links.page && { label: t('projectPage'), url: p.links.page },
  ].filter((x): x is { label: string; url: string } => !!x);

  const tabs: Array<{ key: TabKey; label: TKey; icon: typeof Images; count?: number }> = [
    { key: 'overview', label: 'overview', icon: Sparkles },
    { key: 'units', label: 'units', icon: Building2, count: units.length },
    { key: 'plans', label: 'plans', icon: LayoutGrid, count: by.plans.length },
    { key: 'photos', label: 'photos', icon: Images, count: by.photos.length },
    { key: 'videos', label: 'videos', icon: Film, count: by.videos.length + hosted_videos.length },
    { key: 'library', label: 'library', icon: Library, count: by.library.length },
    { key: 'documents', label: 'documents', icon: FileText, count: by.documents.length + externalLinks.length },
  ];
  // Hide empty media tabs; overview + units always show.
  const visibleTabs = tabs.filter((x) => x.key === 'overview' || x.key === 'units' || (x.count ?? 0) > 0);

  const place = [bi(p.location.district, isAr), bi(p.location.city, isAr)].filter(Boolean).join(isAr ? '، ' : ', ');
  const priceRange = fmtRange(p.available_price_range, (n) => fmtMoneyShort(n, isAr));
  const areaRange = fmtRange(p.available_area_range, (n) => `${fmtNum(n)} ${t('m2')}`);
  const cover = heroImages[0];

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-bold text-chocolate/70 hover:text-copper">
        {isAr ? <ArrowRight size={16} /> : <ArrowLeft size={16} />} {t('back')}
      </button>

      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-chocolate text-white shadow-xl">
        {cover && (
          <img src={cover.url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-45" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-chocolate via-chocolate/60 to-transparent" />
        <div className="relative px-5 sm:px-8 pt-24 sm:pt-40 pb-6 sm:pb-8">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {p.status && <span className="px-2.5 py-1 rounded-full bg-white/15 backdrop-blur text-xs font-bold">{bi(p.status, isAr)}</span>}
            {p.unit_types.map((u) => (
              <span key={u.ar} className="px-2.5 py-1 rounded-full bg-copper/80 text-xs font-bold">{bi(u, isAr)}</span>
            ))}
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold leading-tight" style={{ fontFamily: '"Amiri", serif' }}>{p.name}</h1>
          {place && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-white/85 text-sm">
              <MapPin size={15} /> {place}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSendOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#25D366] text-white text-sm font-bold shadow-lg hover:opacity-90"
            >
              <Send size={16} /> {t('sendToClient')}
            </button>
            {heroImages.length > 1 && (
              <button
                type="button"
                onClick={() => setHeroIdx(0)}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 backdrop-blur text-xs font-bold"
              >
                <Maximize2 size={14} /> {heroImages.length} {t('images')}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={CheckCircle2} label={t('available')} value={`${fmtNum(p.available_units)} / ${fmtNum(p.unit_count)}`} />
        <Kpi icon={Wallet} label={t('priceRange')} value={priceRange ?? (p.unit_count > 0 && p.available_units === 0 ? t('soldOut') : '—')} />
        <Kpi icon={Maximize2} label={t('areaRange')} value={areaRange ?? '—'} />
        <Kpi icon={CalendarClock} label={t('handover')} value={fmtDate(p.handover_date, isAr) ?? bi(p.construction_status, isAr) ?? '—'} />
      </section>

      {/* Tabs */}
      <nav className="sticky top-0 z-30 -mx-4 px-4 py-2 bg-cream-light/90 backdrop-blur border-b border-sand/40">
        <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {visibleTabs.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => { onTab(key); if (key !== 'units') setFocusUnits(null); }}
              className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold transition ${
                tab === key ? 'bg-copper text-white shadow' : 'text-charcoal hover:bg-white'
              }`}
            >
              <Icon size={15} /> {t(label)}
              {count != null && count > 0 && <span className={`text-[11px] ${tab === key ? 'opacity-80' : 'opacity-50'}`}>{count}</span>}
            </button>
          ))}
        </div>
      </nav>

      <section>
        {tab === 'overview' && <Overview detail={detail} isAr={isAr} />}
        {tab === 'units' && (
          <UnitsSection
            units={units}
            filesById={filesById}
            isAr={isAr}
            projectName={p.name}
            focusUnitIds={focusUnits}
            onClearFocus={() => setFocusUnits(null)}
            initialUnitId={initialUnitId}
            token={token}
            projectId={p.id}
          />
        )}
        {tab === 'plans' && (
          <PlansSection
            plans={by.plans}
            units={units}
            isAr={isAr}
            onShowUnits={(ids) => { setFocusUnits(ids); onTab('units'); }}
          />
        )}
        {tab === 'photos' && <MediaGrid files={by.photos} isAr={isAr} />}
        {tab === 'videos' && <VideosSection files={by.videos} hosted={hosted_videos} isAr={isAr} />}
        {tab === 'library' && <LibrarySection files={by.library} isAr={isAr} />}
        {tab === 'documents' && <DocumentsSection files={by.documents} externalLinks={externalLinks} isAr={isAr} />}
      </section>

      {sendOpen && (
        <SendToClientModal
          token={token}
          projectId={p.id}
          projectName={p.name}
          isAr={isAr}
          canSend={canSend}
          brochures={by.documents.filter((f) => f.kind === 'pdf').slice(0, 3)}
          onClose={() => setSendOpen(false)}
        />
      )}
      {heroIdx != null && (
        <Lightbox items={heroImages.map(fileToLightbox)} index={heroIdx} onIndex={setHeroIdx} onClose={() => setHeroIdx(null)} isAr={isAr} />
      )}
    </div>
  );
}

function Kpi({ icon: Icon, label, value }: { icon: typeof Images; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white border border-sand/50 p-4">
      <div className="flex items-center gap-1.5 text-xs text-charcoal/55"><Icon size={14} className="text-copper" /> {label}</div>
      <div className="mt-1 text-base sm:text-lg font-bold text-chocolate leading-snug">{value}</div>
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: typeof Images; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white border border-sand/50 p-5">
      <h3 className="flex items-center gap-2 text-base font-bold text-chocolate mb-3">
        <Icon size={18} className="text-copper" /> {title}
      </h3>
      {children}
    </div>
  );
}

function Overview({ detail, isAr }: { detail: PortalProjectDetail; isAr: boolean }) {
  const t = makeT(isAr);
  const p = detail.project;
  const { lat, lng } = p.location;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        {p.description && (
          <div className="rounded-2xl bg-white border border-sand/50 p-5 text-[15px] leading-8 text-charcoal whitespace-pre-line">
            {p.description}
          </div>
        )}
        {p.features.length > 0 && (
          <Card title={t('features')} icon={Sparkles}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {p.features.map((f) => (
                <div key={f} className="flex items-start gap-2 text-sm text-charcoal">
                  <CheckCircle2 size={16} className="text-copper shrink-0 mt-0.5" /> {f}
                </div>
              ))}
            </div>
          </Card>
        )}
        {p.payment_plans.length > 0 && (
          <Card title={t('paymentPlans')} icon={Wallet}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {p.payment_plans.map((pl, i) => (
                <div key={`${pl.plan}-${i}`} className="rounded-xl border border-sand/50 bg-cream-50 p-4">
                  <div className="font-bold text-chocolate">{pl.plan}</div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <PlanStat label={t('down')} v={fmtPct(pl.down, isAr)} strong />
                    <PlanStat label={t('duringConstruction')} v={fmtPct(pl.during_construction, isAr)} />
                    <PlanStat label={t('onHandover')} v={fmtPct(pl.on_handover, isAr)} />
                  </div>
                  {pl.schedule && <ScheduleList schedule={pl.schedule} isAr={isAr} />}
                </div>
              ))}
            </div>
          </Card>
        )}
        {p.guarantees.length > 0 && (
          <Card title={t('guarantees')} icon={ShieldCheck}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {p.guarantees.map((g) => (
                <div key={g.item} className="flex items-center justify-between gap-3 text-sm py-1.5 border-b border-sand/30">
                  <span className="text-charcoal">{g.item}</span>
                  <span className="font-bold text-copper whitespace-nowrap">{g.period}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        {(lat != null && lng != null) || p.location.map_url ? (
          <Card title={t('location')} icon={MapPin}>
            {lat != null && lng != null && (
              <iframe
                title="map"
                loading="lazy"
                className="w-full h-56 rounded-xl border border-sand/40"
                src={`https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`}
              />
            )}
            {p.location.map_url && (
              <a href={p.location.map_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-copper">
                <MapPin size={15} /> {t('openMap')}
              </a>
            )}
          </Card>
        ) : null}
        {p.landmarks.length > 0 && (
          <Card title={t('landmarks')} icon={Clock}>
            <ul className="space-y-1.5">
              {p.landmarks.map((l) => (
                <li key={l.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-charcoal">{l.name}</span>
                  {(l.duration || l.distance) && <span className="text-xs text-charcoal/55 whitespace-nowrap">{l.duration || l.distance}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {p.services.length > 0 && (
          <Card title={t('services')} icon={CheckCircle2}>
            <ul className="space-y-2">
              {p.services.map((s) => (
                <li key={s.service} className="text-sm">
                  <div className="font-bold text-chocolate">{s.service}</div>
                  {s.notes && <div className="text-xs text-charcoal/60">{s.notes}</div>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {p.avg_price_per_m2 != null && (
          <Card title={t('pricePerM2')} icon={Wallet}>
            <div className="text-xl font-bold text-copper">{fmtMoney(p.avg_price_per_m2, isAr)}</div>
          </Card>
        )}
      </div>
    </div>
  );
}

function PlanStat({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-2 ${strong ? 'bg-copper text-white' : 'bg-white border border-sand/40 text-chocolate'}`}>
      <div className="text-lg font-bold leading-none">{v}</div>
      <div className={`text-[10px] mt-1 ${strong ? 'text-white/85' : 'text-charcoal/55'}`}>{label}</div>
    </div>
  );
}

function PlansSection({
  plans, units, isAr, onShowUnits,
}: {
  plans: PortalFile[];
  units: PortalUnit[];
  isAr: boolean;
  onShowUnits: (ids: string[]) => void;
}) {
  const t = makeT(isAr);
  const [open, setOpen] = useState<number | null>(null);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const cards = useMemo(() => plans.map((f) => {
    const us = f.unit_ids.map((id) => unitById.get(id)).filter((u): u is PortalUnit => !!u);
    const first = us[0];
    const available = us.filter((u) => u.status === 'available').length;
    const areas = us.map((u) => u.area).filter((a): a is number => a != null);
    const prices = us.filter((u) => u.status === 'available').map((u) => u.price).filter((p): p is number => p != null);
    return {
      f, us, available,
      title: first
        ? [bi(first.type, isAr), first.model && `${t('model')} ${first.model}`, first.bedrooms != null && `${first.bedrooms} ${t('rooms')}`].filter(Boolean).join(' · ')
        : f.name,
      area: areas.length ? fmtRange({ min: Math.min(...areas), max: Math.max(...areas) }, (n) => `${fmtNum(n, 1)} ${t('m2')}`) : null,
      price: prices.length ? fmtMoneyShort(Math.min(...prices), isAr) : null,
    };
  }).sort((a, b) => b.available - a.available || b.us.length - a.us.length), [plans, unitById, isAr, t]);

  if (plans.length === 0) {
    return <div className="rounded-2xl border border-dashed border-sand bg-white/60 py-14 text-center text-charcoal/50 text-sm">{t('nothingHere')}</div>;
  }
  const items = cards.map((c) => ({ ...fileToLightbox(c.f), caption: c.title }));
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c, i) => (
          <div key={c.f.id} className="rounded-2xl bg-white border border-sand/50 overflow-hidden flex flex-col">
            <button type="button" onClick={() => setOpen(i)} className="aspect-[4/3] bg-cream-50 flex items-center justify-center">
              <img src={c.f.thumb ?? c.f.url} alt={c.title} loading="lazy" className="w-full h-full object-contain p-2" />
            </button>
            <div className="p-3 flex-1 flex flex-col gap-1.5">
              <div className="font-bold text-chocolate text-sm">{c.title}</div>
              <div className="text-xs text-charcoal/60 flex flex-wrap gap-x-3">
                {c.area && <span>{c.area}</span>}
                {c.price && <span>{t('from')} {c.price}</span>}
              </div>
              {c.us.length > 0 && (
                <button
                  type="button"
                  onClick={() => onShowUnits(c.us.map((u) => u.id))}
                  className="mt-auto self-start text-xs font-bold text-copper hover:underline"
                >
                  {t('showUnits')} · {c.available} {t('available')} / {c.us.length}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {open != null && <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} isAr={isAr} />}
    </>
  );
}

function LibrarySection({ files, isAr }: { files: PortalFile[]; isAr: boolean }) {
  const t = makeT(isAr);
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all');
  const images = files.filter((f) => f.kind === 'image');
  const videos = files.filter((f) => f.kind === 'video');
  const shown = kind === 'all' ? files : kind === 'image' ? images : videos;
  return (
    <div className="space-y-4">
      {images.length > 0 && videos.length > 0 && (
        <div className="flex gap-2">
          {([['all', t('all'), files.length], ['image', t('images'), images.length], ['video', t('videos'), videos.length]] as const).map(([k, l, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-bold border ${kind === k ? 'bg-chocolate text-white border-chocolate' : 'bg-white text-charcoal border-sand'}`}
            >
              {l} <span className="opacity-60 ms-1">{n}</span>
            </button>
          ))}
        </div>
      )}
      <MediaGrid files={shown} isAr={isAr} />
    </div>
  );
}
