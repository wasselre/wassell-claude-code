/**
 * Media building blocks for the broker page: image grid + full-screen
 * lightbox, video tiles (CRM files, hosted mp4s, YouTube), and document rows
 * with an in-page PDF viewer.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Film, Loader2, Play, X } from 'lucide-react';
import type { HostedVideo, PortalFile } from '../lib/api';
import { fmtBytes, fmtDuration, makeT } from '../lib/i18n';

const PdfViewer = lazy(() => import('@/components/ui/PdfViewer'));

// ── Lightbox ───────────────────────────────────────────────────────────────

export interface LightboxItem {
  id: string;
  src: string;
  kind: 'image' | 'video';
  caption?: string;
  download?: string | null;
}

export function Lightbox({
  items, index, onIndex, onClose, isAr,
}: {
  items: LightboxItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  isAr: boolean;
}) {
  const t = makeT(isAr);
  const item = items[index];
  const go = useCallback((delta: number) => {
    if (items.length < 2) return;
    onIndex((index + delta + items.length) % items.length);
  }, [index, items.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // In RTL the "next" arrow points left.
      if (e.key === 'ArrowRight') go(isAr ? -1 : 1);
      if (e.key === 'ArrowLeft') go(isAr ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose, isAr]);

  if (!item) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/90 flex flex-col" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white/90">
        <div className="text-sm truncate min-w-0">
          <span className="opacity-60 me-2">{index + 1} / {items.length}</span>
          {item.caption}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.download && (
            <a href={item.download} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm">
              <Download size={16} /> {t('download')}
            </a>
          )}
          <button type="button" onClick={onClose} aria-label={t('close')} className="p-2 rounded-lg bg-white/10 hover:bg-white/20">
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="relative flex-1 flex items-center justify-center px-2 pb-4 min-h-0" onClick={onClose}>
        {item.kind === 'image' ? (
          <img
            src={item.src}
            alt={item.caption ?? ''}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <video
            key={item.src}
            src={item.src}
            controls
            autoPlay
            playsInline
            className="max-w-full max-h-full rounded-lg shadow-2xl bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label={t('prev')}
              onClick={(e) => { e.stopPropagation(); go(-1); }}
              className="absolute start-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/25 text-white"
            >
              {isAr ? <ChevronRight size={22} /> : <ChevronLeft size={22} />}
            </button>
            <button
              type="button"
              aria-label={t('next')}
              onClick={(e) => { e.stopPropagation(); go(1); }}
              className="absolute end-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/25 text-white"
            >
              {isAr ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function fileToLightbox(f: PortalFile): LightboxItem {
  return {
    id: f.id,
    src: f.url,
    kind: f.kind === 'video' ? 'video' : 'image',
    caption: f.name,
    download: f.download,
  };
}

// ── Grids ──────────────────────────────────────────────────────────────────

export function EmptySection({ isAr }: { isAr: boolean }) {
  const t = makeT(isAr);
  return (
    <div className="rounded-2xl border border-dashed border-sand bg-white/60 py-14 text-center text-charcoal/50 text-sm">
      {t('nothingHere')}
    </div>
  );
}

/** Mixed image + video grid (photos, marketing library). Opens a lightbox. */
export function MediaGrid({ files, isAr, square = true }: { files: PortalFile[]; isAr: boolean; square?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const items = files.map(fileToLightbox);
  if (files.length === 0) return <EmptySection isAr={isAr} />;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {files.map((f, i) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setOpen(i)}
            className={`group relative overflow-hidden rounded-xl bg-cream-200 border border-sand/40 ${square ? 'aspect-square' : 'aspect-[4/3]'}`}
          >
            {f.kind === 'video' ? (
              <>
                <video src={`${f.url}#t=0.5`} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="w-12 h-12 rounded-full bg-black/55 text-white flex items-center justify-center group-hover:scale-110 transition">
                    <Play size={20} className="ms-0.5" />
                  </span>
                </span>
                {fmtDuration(f.duration_seconds) && (
                  <span className="absolute bottom-2 end-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">
                    {fmtDuration(f.duration_seconds)}
                  </span>
                )}
              </>
            ) : (
              <img
                src={f.thumb ?? f.url}
                alt={f.name}
                loading="lazy"
                className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                onError={(e) => {
                  // Thumbnail transform unavailable → fall back to the original once.
                  const img = e.currentTarget;
                  if (img.src !== f.url) img.src = f.url;
                }}
              />
            )}
          </button>
        ))}
      </div>
      {open != null && (
        <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} isAr={isAr} />
      )}
    </>
  );
}

// ── Videos ─────────────────────────────────────────────────────────────────

function YouTubeTile({ v, isAr }: { v: HostedVideo; isAr: boolean }) {
  const [playing, setPlaying] = useState(false);
  const t = makeT(isAr);
  return (
    <div className="relative aspect-video rounded-xl overflow-hidden bg-black border border-sand/40">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${v.youtube_id}?autoplay=1&rel=0`}
          title="YouTube"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="w-full h-full"
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} className="group w-full h-full" aria-label={t('play')}>
          <img src={`https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg`} alt="" loading="lazy" className="w-full h-full object-cover opacity-90" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-14 h-14 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition">
              <Play size={22} className="ms-0.5" fill="currentColor" />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

export function VideosSection({ files, hosted, isAr }: { files: PortalFile[]; hosted: HostedVideo[]; isAr: boolean }) {
  const t = makeT(isAr);
  const youtube = hosted.filter((v) => v.kind === 'youtube' && v.youtube_id);
  const direct = hosted.filter((v) => v.kind === 'direct');
  const links = hosted.filter((v) => v.kind === 'link');
  if (files.length + hosted.length === 0) return <EmptySection isAr={isAr} />;
  return (
    <div className="space-y-6">
      {youtube.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {youtube.map((v) => <YouTubeTile key={v.url} v={v} isAr={isAr} />)}
        </div>
      )}
      {(files.length > 0 || direct.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {files.map((f) => (
            <div key={f.id} className="rounded-xl overflow-hidden bg-black border border-sand/40">
              <video src={f.url} controls preload="metadata" playsInline className="w-full aspect-video bg-black" />
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-white text-xs text-charcoal">
                <span className="truncate">{f.name}</span>
                {f.download && (
                  <a href={f.download} className="inline-flex items-center gap-1 text-copper font-bold shrink-0">
                    <Download size={14} /> {t('download')}
                  </a>
                )}
              </div>
            </div>
          ))}
          {direct.map((v) => (
            <div key={v.url} className="rounded-xl overflow-hidden bg-black border border-sand/40">
              <video src={v.url} controls preload="metadata" playsInline className="w-full aspect-video bg-black" />
              <div className="flex items-center justify-end px-3 py-2 bg-white text-xs">
                <a href={v.url} download className="inline-flex items-center gap-1 text-copper font-bold">
                  <Download size={14} /> {t('download')}
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((v) => (
            <a key={v.url} href={v.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-sand/50 text-sm text-charcoal hover:border-copper">
              <Film size={16} className="text-copper" /> {v.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Documents ──────────────────────────────────────────────────────────────

export function DocumentsSection({
  files, externalLinks, isAr,
}: {
  files: PortalFile[];
  externalLinks: Array<{ label: string; url: string }>;
  isAr: boolean;
}) {
  const t = makeT(isAr);
  const [viewing, setViewing] = useState<PortalFile | null>(null);
  if (files.length + externalLinks.length === 0) return <EmptySection isAr={isAr} />;
  return (
    <div className="space-y-5">
      {files.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {files.map((f) => {
            const isPdf = f.kind === 'pdf' || f.mime_type === 'application/pdf';
            return (
              <div key={f.id} className="flex items-center gap-3 p-3 rounded-xl bg-white border border-sand/50">
                <div className="w-11 h-11 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
                  <FileText size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-chocolate truncate">{f.name}</div>
                  <div className="text-xs text-charcoal/50">{isPdf ? 'PDF' : (f.kind ?? '').toUpperCase()} · {fmtBytes(f.size_bytes)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isPdf ? (
                    <button type="button" onClick={() => setViewing(f)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-copper text-white hover:bg-terracotta">
                      {t('open')}
                    </button>
                  ) : (
                    <a href={f.url} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-lg text-xs font-bold bg-copper text-white hover:bg-terracotta">
                      {t('open')}
                    </a>
                  )}
                  {f.download && (
                    <a href={f.download} aria-label={t('download')} className="p-2 rounded-lg border border-sand/60 text-charcoal hover:border-copper hover:text-copper">
                      <Download size={16} />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {externalLinks.length > 0 && (
        <div>
          <div className="text-xs font-bold text-charcoal/50 mb-2">{t('externalLinks')}</div>
          <div className="flex flex-wrap gap-2">
            {externalLinks.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-sand/50 text-sm text-charcoal hover:border-copper">
                <ExternalLink size={15} className="text-copper" /> {l.label}
              </a>
            ))}
          </div>
        </div>
      )}
      {viewing && (
        <div className="fixed inset-0 z-[80] bg-black/70 flex flex-col p-2 sm:p-6" role="dialog" aria-modal="true">
          <div className="flex items-center justify-between gap-2 bg-white rounded-t-2xl px-4 py-3">
            <div className="text-sm font-bold text-chocolate truncate">{viewing.name}</div>
            <div className="flex items-center gap-2 shrink-0">
              {viewing.download && (
                <a href={viewing.download} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white text-xs font-bold">
                  <Download size={14} /> {t('download')}
                </a>
              )}
              <button type="button" onClick={() => setViewing(null)} aria-label={t('close')} className="p-2 rounded-lg hover:bg-cream">
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 bg-cream-light rounded-b-2xl overflow-hidden">
            <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-copper" /></div>}>
              <PdfViewer url={viewing.url} isAr={isAr} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
