/**
 * Media building blocks for the broker page: image grid + full-screen
 * lightbox, video tiles (CRM files, hosted mp4s, YouTube), and document rows
 * with an in-page PDF viewer.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, Film, Loader2, Play, X } from 'lucide-react';
import { flash } from '../lib/flash';
import type { HostedVideo, PortalFile } from '../lib/api';
import { fmtBytes, fmtDuration, makeT } from '../lib/i18n';

const PdfViewer = lazy(() => import('@/components/ui/PdfViewer'));

// ── Clipboard ──────────────────────────────────────────────────────────────

/** Re-encode any image blob as PNG — the only image type every browser's
 *  clipboard accepts. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'));
}

/** Copy an image to the clipboard so a broker can paste it straight into
 *  WhatsApp. Falls back to a download where the browser has no image clipboard. */
export async function copyImageToClipboard(url: string, download: string | null, isAr: boolean): Promise<void> {
  const t = makeT(isAr);
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    if (download) window.location.href = download;
    flash(t('copyUnsupported'), 'error');
    return;
  }
  try {
    // The item is built synchronously with a PROMISE (Safari only allows a
    // clipboard write inside the click's own task).
    const png = fetch(url).then((r) => r.blob()).then(toPng);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flash(t('imageCopied'));
  } catch (e) {
    console.error('[broker-portal] image copy failed:', e);
    if (download) window.location.href = download;
    flash(t('copyUnsupported'), 'error');
  }
}

export async function copyText(text: string, okMsg: string, failMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(okMsg);
  } catch (e) {
    // Clipboard blocked (permissions / insecure context). The text is on
    // screen and selectable, so say so instead of opening a blocking prompt.
    console.error('[broker-portal] text copy failed:', e);
    flash(failMsg, 'error');
  }
}

// ── Lightbox ───────────────────────────────────────────────────────────────

export interface LightboxItem {
  id: string;
  src: string;
  kind: 'image' | 'video';
  caption?: string;
  download?: string | null;
  transcript?: string | null;
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
          {item.kind === 'image' && (
            <button
              type="button"
              onClick={() => void copyImageToClipboard(item.src, item.download ?? null, isAr)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
            >
              <Copy size={16} /> <span className="hidden sm:inline">{t('copyImage')}</span>
            </button>
          )}
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
      {item.kind === 'video' && item.transcript && (
        <div className="mx-auto mb-4 w-full max-w-3xl px-4">
          <div className="rounded-xl bg-white/10 text-white/90 p-3 max-h-[22vh] overflow-y-auto text-sm leading-7 whitespace-pre-line">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-bold text-white/60">{t('transcript')}</span>
              <button type="button" onClick={() => void copyText(item.transcript ?? '', t('copied'), t('copyFailed'))} className="inline-flex items-center gap-1 text-xs text-white/80 hover:text-white">
                <Copy size={13} /> {t('copyTranscript')}
              </button>
            </div>
            {item.transcript}
          </div>
        </div>
      )}
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
    transcript: f.transcript,
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
/** Always-visible (touch) / hover (desktop) copy + download buttons on a tile. */
function TileActions({ f, isAr }: { f: PortalFile; isAr: boolean }) {
  const t = makeT(isAr);
  const btn = 'w-8 h-8 rounded-lg bg-black/60 hover:bg-black/80 text-white flex items-center justify-center';
  return (
    <div className="absolute bottom-2 end-2 flex gap-1.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition">
      {f.kind === 'image' && (
        <button type="button" aria-label={t('copyImage')} title={t('copyImage')} className={btn}
          onClick={() => void copyImageToClipboard(f.url, f.download, isAr)}>
          <Copy size={15} />
        </button>
      )}
      {f.download && (
        <a href={f.download} aria-label={t('download')} title={t('download')} className={btn}>
          <Download size={15} />
        </a>
      )}
    </div>
  );
}

export function MediaGrid({ files, isAr, square = true }: { files: PortalFile[]; isAr: boolean; square?: boolean }) {
  const t = makeT(isAr);
  const [open, setOpen] = useState<number | null>(null);
  const items = files.map(fileToLightbox);
  if (files.length === 0) return <EmptySection isAr={isAr} />;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {files.map((f, i) => (
          <div
            key={f.id}
            className={`group relative overflow-hidden rounded-xl bg-cream-200 border border-sand/40 ${square ? 'aspect-square' : 'aspect-[4/3]'}`}
          >
            <button type="button" onClick={() => setOpen(i)} className="absolute inset-0 w-full h-full" aria-label={f.name || t('open')}>
            {f.kind === 'video' ? (
              <>
                <video src={`${f.url}#t=0.5`} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="w-12 h-12 rounded-full bg-black/55 text-white flex items-center justify-center group-hover:scale-110 transition">
                    <Play size={20} className="ms-0.5" />
                  </span>
                </span>
                {fmtDuration(f.duration_seconds) && (
                  <span className="absolute top-2 end-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">
                    {fmtDuration(f.duration_seconds)}
                  </span>
                )}
                {f.transcript && (
                  <span className="absolute top-2 start-2 text-[10px] px-1.5 py-0.5 rounded bg-copper text-white font-bold">
                    {t('transcript')}
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
            <TileActions f={f} isAr={isAr} />
          </div>
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
              {f.transcript && <TranscriptBlock text={f.transcript} isAr={isAr} />}
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

export function TranscriptBlock({ text, isAr }: { text: string; isAr: boolean }) {
  const t = makeT(isAr);
  return (
    <details className="bg-cream-50 border-t border-sand/40 text-xs text-charcoal">
      <summary className="cursor-pointer px-3 py-2 font-bold text-copper">{t('transcript')}</summary>
      <div className="px-3 pb-3 leading-6 whitespace-pre-line max-h-48 overflow-y-auto">{text}</div>
      <div className="px-3 pb-2">
        <button type="button" onClick={() => void copyText(text, t('copied'), t('copyFailed'))} className="inline-flex items-center gap-1 text-copper font-bold">
          <Copy size={13} /> {t('copyTranscript')}
        </button>
      </div>
    </details>
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
