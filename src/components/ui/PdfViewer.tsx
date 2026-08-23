import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/**
 * In-app PDF viewer built on pdf.js — renders pages to <canvas> ourselves so we
 * are NOT at the mercy of the browser's built-in PDF plugin (Chrome's toolbar +
 * download/print/"save to Drive", inconsistent across browsers, broken in a
 * mobile <iframe>). Continuous vertical scroll, pages rendered lazily as they
 * approach the viewport, our own page indicator + zoom. No download/print
 * affordances by design.
 *
 * This whole module is loaded lazily by its consumers (React.lazy) so pdf.js
 * (~1 MB) never enters the main bundle — it arrives only when a PDF is opened.
 */

// Bundle the worker as a Vite asset and point pdf.js at it (v6, ESM worker).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export default function PdfViewer({ url, isAr }: { url: string; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1); // user zoom multiplier over fit-width
  const [current, setCurrent] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const task = pdfjsLib.getDocument({ url });
    task.promise.then(
      (d) => {
        if (cancelled) return; // task.destroy() in cleanup tears the doc down
        setDoc(d);
        setNumPages(d.numPages);
        setLoading(false);
      },
      (e: unknown) => {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  // Track which page is centred, for the "X / N" indicator.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    const pages = el.querySelectorAll<HTMLElement>('[data-page]');
    for (const p of pages) {
      if (p.offsetTop <= mid && p.offsetTop + p.offsetHeight >= mid) {
        setCurrent(Number(p.dataset.page)); break;
      }
    }
  }, []);

  return (
    <div className="w-full h-full bg-charcoal/95 overflow-hidden flex flex-col">
      {/* Toolbar — page indicator + zoom ONLY (no download/print/save). */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-charcoal text-white/90 border-b border-white/10 shrink-0">
        <span className="text-xs font-medium tabular-nums">
          {numPages ? L(`صفحة ${current} من ${numPages}`, `Page ${current} of ${numPages}`) : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)))}
            className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center"
            aria-label={L('تصغير', 'Zoom out')}
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-xs w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
            className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center"
            aria-label={L('تكبير', 'Zoom in')}
          >
            <ZoomIn size={16} />
          </button>
        </div>
      </div>

      {/* Pages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto bg-charcoal/80 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-white/70 text-sm h-full">
            <Loader2 size={18} className="animate-spin" /> {L('جارٍ تحميل الملف…', 'Loading document…')}
          </div>
        ) : error ? (
          <div className="mx-auto max-w-md text-sm text-white bg-red-600/80 rounded-lg px-4 py-3 text-center">{error}</div>
        ) : doc ? (
          <div className="flex flex-col items-center gap-4">
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} zoom={scale} scrollRef={scrollRef} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One page. Fetches its dimensions up front (cheap) to reserve scroll height,
 * then renders to canvas only once it nears the viewport (IntersectionObserver).
 * Re-renders when the zoom or the container width changes.
 */
function PdfPage({
  doc,
  pageNumber,
  zoom,
  scrollRef,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const renderTaskRef = useRef<ReturnType<PDFPageProxy['render']> | null>(null);
  const [ratio, setRatio] = useState(1.414); // h/w; A4 portrait default until known
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  // Page proxy + native size (for the aspect-ratio placeholder).
  useEffect(() => {
    let cancelled = false;
    doc.getPage(pageNumber).then((p) => {
      if (cancelled) return;
      pageRef.current = p;
      const vp = p.getViewport({ scale: 1 });
      setRatio(vp.height / vp.width);
    });
    return () => { cancelled = true; };
  }, [doc, pageNumber]);

  // Reveal when near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) if (e.isIntersecting) { setVisible(true); io.disconnect(); } },
      { root, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRef]);

  // Render (and re-render on zoom / container width change) once visible.
  useEffect(() => {
    if (!visible) return;
    const page = pageRef.current;
    const canvas = canvasRef.current;
    const root = scrollRef.current;
    if (!page || !canvas || !root) return;
    let cancelled = false;

    const draw = () => {
      const cssWidth = Math.min(root.clientWidth - 32, 900) * zoom;
      const base = page.getViewport({ scale: 1 });
      const scale = cssWidth / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
      renderTaskRef.current?.cancel();
      const task = page.render({ canvas, canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      task.promise.then(() => { if (!cancelled) setRendered(true); }, () => {/* cancelled render — ignore */});
    };
    draw();
    return () => { cancelled = true; renderTaskRef.current?.cancel(); };
  }, [visible, zoom, scrollRef]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="bg-white shadow-lg"
      style={{ width: 'min(calc(92vw - 2rem), 900px)', aspectRatio: rendered ? undefined : `1 / ${ratio}` }}
    >
      <canvas ref={canvasRef} className="block w-full h-auto" />
    </div>
  );
}
