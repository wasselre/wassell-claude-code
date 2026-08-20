import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * Google-Drive-style rubber-band selection, extracted from FilesPage so the
 * Library can have it too.
 *
 * ── WHY THIS IS A HOOK AND NOT COPIED ─────────────────────────────────────
 * There is about 250 lines of genuinely subtle behaviour here — a drag-vs-click
 * threshold, grid-RELATIVE coordinates, an edge auto-scroll rAF loop, and a
 * post-drag click suppressor — and every one of those exists because a specific
 * bug was found and fixed. Copying it into a second page would guarantee the
 * two drift, and the second copy would silently lose whichever fix its author
 * did not know to carry across. The worker packages in this repo duplicate code
 * because they physically cannot import it; these two pages can.
 *
 * ── WHAT IS DELIBERATELY GENERIC ──────────────────────────────────────────
 * The caller owns the selection MODEL. FilesPage keeps folders and files in two
 * separate sets (so bulk actions can address them independently); the Library
 * has files only. Rather than force one shape on both — which would mean
 * rewriting the shipped page's selection to match — the hook takes an opaque
 * `base` snapshot from `captureBase()` and hands it straight back to
 * `applyHits()`. The hook never inspects it.
 *
 * ── THE COORDINATE RULE, WHICH IS THE EASY ONE TO GET WRONG ───────────────
 * The anchor and the rectangle live in GRID-RELATIVE space (client coords minus
 * the grid container's viewport top-left), not viewport space. Grid-relative
 * space scrolls with the content, so the anchor stays pinned to the tile the
 * drag started on even after the page auto-scrolls a long way down. Storing the
 * anchor in viewport space is what made the box drift onto the wrong tiles
 * mid-scroll, and it is not a bug that reproduces on a short page.
 */

export interface MarqueeHit {
  kind: string;
  id: string;
}

export type MarqueeMode = 'replace' | 'add' | 'toggle';

export interface MarqueeRect { x: number; y: number; w: number; h: number }

interface Params<TBase> {
  /** The scrolling container the rectangle is measured against. Every
   *  selectable descendant must carry data-selectable-id + data-selectable-kind. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /** Snapshot of the selection at mousedown. Opaque to the hook. */
  captureBase: () => TBase;
  /** Apply a live hit-test result. Called on every frame of the drag. */
  applyHits: (hits: MarqueeHit[], mode: MarqueeMode, base: TBase) => void;
  /** Mousedown on empty grid background with no drag = "click away". */
  onBackgroundClick: () => void;
  /** Replace-mode drags clear first; the hook asks the caller to do it. */
  clearSelection: () => void;
  /** Disable entirely (e.g. while a bulk action is running). */
  disabled?: boolean;
}

const DRAG_THRESHOLD = 5;    // px — typical drag-vs-click threshold
const EDGE_BAND = 64;        // px from the viewport edge that triggers auto-scroll
const MAX_SCROLL_SPEED = 20; // px/frame at the very edge (ramps with proximity)

export function useMarqueeSelection<TBase>({
  gridRef, captureBase, applyHits, onBackgroundClick, clearSelection, disabled,
}: Params<TBase>) {
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);

  // Callbacks live in refs so the window listeners can attach ONCE. Putting
  // them in the effect deps re-attaches on every render, which churns a
  // listener pair per frame during a drag.
  const cbRef = useRef({ captureBase, applyHits, onBackgroundClick, clearSelection });
  cbRef.current = { captureBase, applyHits, onBackgroundClick, clearSelection };

  const dragStartRef = useRef<{
    gx: number; gy: number; mode: MarqueeMode; onCard: boolean; base: TBase;
  } | null>(null);
  const draggingRef = useRef(false);
  /** True for a beat after a drag ends, so the synthetic click on whatever card
   *  the cursor released over does not also open it. */
  const justFinishedDragRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoScrollRef = useRef<{ vel: number; raf: number | null }>({ vel: 0, raf: null });

  const hitTest = useCallback((rect: MarqueeRect): MarqueeHit[] => {
    const root = gridRef.current;
    if (!root) return [];
    const gridBox = root.getBoundingClientRect();
    const hits: MarqueeHit[] = [];
    const rL = rect.x, rT = rect.y, rR = rect.x + rect.w, rB = rect.y + rect.h;
    root.querySelectorAll<HTMLElement>('[data-selectable-id]').forEach((el) => {
      const b = el.getBoundingClientRect();
      const left = b.left - gridBox.left, right = b.right - gridBox.left;
      const top = b.top - gridBox.top, bottom = b.bottom - gridBox.top;
      if (right < rL || left > rR || bottom < rT || top > rB) return;
      const id = el.getAttribute('data-selectable-id');
      const kind = el.getAttribute('data-selectable-kind');
      if (id && kind) hits.push({ kind, id });
    });
    return hits;
  }, [gridRef]);

  const onGridMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Interactive elements keep their own behaviour — but a CARD may itself be
    // one, and must still be able to start a drag.
    //
    // The Library renders each tile as a <button>, so a naive
    // `closest('button')` check refuses to start a marquee anywhere on the
    // grid: every pixel of it is inside a button. (FilesPage's cards are divs,
    // which is why the original never hit this.) The rule that works for both:
    // skip only when the interactive element is something OTHER than the card
    // itself — a kebab inside it, or a control outside the grid entirely.
    const card = target.closest('[data-selectable-id]');
    const interactive = target.closest(
      'button, a, input, textarea, select, [role="button"], [data-no-marquee]',
    );
    if (interactive && interactive !== card) return;

    const mode: MarqueeMode = e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace';
    const gridBox = gridRef.current?.getBoundingClientRect();
    dragStartRef.current = {
      gx: e.clientX - (gridBox?.left ?? 0),
      gy: e.clientY - (gridBox?.top ?? 0),
      mode,
      onCard: Boolean(card),
      base: cbRef.current.captureBase(),
    };
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    draggingRef.current = false;
    // Deliberately no pre-clear and no rectangle yet: this might never become a
    // drag, and flashing a selection change on every mousedown is worse than
    // waiting for the threshold.
  }, [disabled, gridRef]);

  useEffect(() => {
    const computeAndApply = (clientX: number, clientY: number) => {
      const start = dragStartRef.current;
      const root = gridRef.current;
      if (!start || !root) return;
      const gridBox = root.getBoundingClientRect();
      const curGX = clientX - gridBox.left;
      const curGY = clientY - gridBox.top;
      const dx = curGX - start.gx;
      const dy = curGY - start.gy;
      if (!draggingRef.current) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        draggingRef.current = true;
        if (start.mode === 'replace') cbRef.current.clearSelection();
      }
      const rect = {
        x: Math.min(start.gx, curGX), y: Math.min(start.gy, curGY),
        w: Math.abs(dx), h: Math.abs(dy),
      };
      setMarquee(rect);
      cbRef.current.applyHits(hitTest(rect), start.mode, start.base);
    };

    const tick = () => {
      const st = autoScrollRef.current;
      if (st.vel === 0 || !dragStartRef.current) { st.raf = null; return; }
      window.scrollBy(0, st.vel);
      const p = lastPointerRef.current;
      computeAndApply(p.x, p.y);   // re-evaluate against the NEW scroll position
      st.raf = requestAnimationFrame(tick);
    };
    const updateAutoScroll = (clientY: number) => {
      const vh = window.innerHeight;
      let vel = 0;
      if (clientY > vh - EDGE_BAND) {
        vel = Math.max(1, Math.round(Math.min(1, (clientY - (vh - EDGE_BAND)) / EDGE_BAND) * MAX_SCROLL_SPEED));
      } else if (clientY < EDGE_BAND) {
        vel = -Math.max(1, Math.round(Math.min(1, (EDGE_BAND - clientY) / EDGE_BAND) * MAX_SCROLL_SPEED));
      }
      autoScrollRef.current.vel = vel;
      if (vel !== 0 && autoScrollRef.current.raf == null) {
        autoScrollRef.current.raf = requestAnimationFrame(tick);
      }
    };
    const stopAutoScroll = () => {
      autoScrollRef.current.vel = 0;
      if (autoScrollRef.current.raf != null) {
        cancelAnimationFrame(autoScrollRef.current.raf);
        autoScrollRef.current.raf = null;
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      computeAndApply(e.clientX, e.clientY);
      // Armed only once past the threshold, so a plain click that happens to
      // land in the edge band does not scroll the page out from under it.
      if (draggingRef.current) updateAutoScroll(e.clientY);
    };
    // Manual wheel/trackpad scroll mid-drag, with the cursor outside the edge
    // bands: nothing else would recompute, so the box would stop tracking the
    // content under the cursor.
    const onScroll = () => {
      if (!dragStartRef.current || !draggingRef.current) return;
      if (autoScrollRef.current.vel !== 0) return;   // the tick already handles it
      const p = lastPointerRef.current;
      computeAndApply(p.x, p.y);
    };
    const onUp = () => {
      const wasDragging = draggingRef.current;
      const start = dragStartRef.current;
      dragStartRef.current = null;
      draggingRef.current = false;
      stopAutoScroll();
      setMarquee(null);
      if (wasDragging) {
        justFinishedDragRef.current = true;
        window.setTimeout(() => { justFinishedDragRef.current = false; }, 150);
      } else if (start && !start.onCard) {
        cbRef.current.onBackgroundClick();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('scroll', onScroll);
      stopAutoScroll();
    };
  }, [gridRef, hitTest]);

  /** True while the click that follows a completed drag should be swallowed.
   *  Cards call this from onClick before acting. */
  const swallowClickAfterDrag = useCallback(() => justFinishedDragRef.current, []);

  return { marquee, onGridMouseDown, swallowClickAfterDrag };
}
