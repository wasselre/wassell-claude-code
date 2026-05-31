import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  /** The trigger element (kebab button) the menu anchors to. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  isAr: boolean;
  /** Menu width in px. Default 192 (12rem). */
  width?: number;
  children: ReactNode;
}

/**
 * Dropdown menu rendered through a portal to document.body and positioned
 * (position:fixed) next to its anchor button.
 *
 * Escaping the normal DOM flow is deliberate: file/folder tiles use
 * `overflow-hidden` (to clip image thumbnails to their rounded corners) and
 * the Drive picker lives inside an `overflow-auto` modal — both clip an
 * in-flow absolutely-positioned menu, so previously only the top sliver of
 * the dropdown showed. Portaling + fixed positioning means the menu always
 * floats in front, never cut off by an ancestor's overflow or stacking
 * context.
 */
export default function TileMenu({ open, anchorRef, onClose, isAr, width = 192, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Start offscreen + hidden; useLayoutEffect measures and repositions before
  // the browser paints, so there's no visible flicker at the wrong spot.
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: -9999,
    left: -9999,
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const gap = 4;
    const pad = 8;
    // Vertical — prefer opening below the button; flip above if it would
    // overflow the bottom of the viewport.
    let top = a.bottom + gap;
    if (top + m.height > window.innerHeight - pad) {
      const above = a.top - m.height - gap;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - m.height - pad);
    }
    // Horizontal — align the menu's "end" edge with the button (RTL-aware),
    // then clamp into the viewport.
    let left = isAr ? a.left : a.right - width;
    left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
    setStyle({ position: 'fixed', top, left, width, visibility: 'visible' });
  }, [open, isAr, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onScrollOrResize = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase so we see the event even if a child stops propagation.
    document.addEventListener('mousedown', onDown, true);
    // Any scroll detaches the fixed menu from its anchor → close it.
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      style={style}
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="z-[200] bg-white border border-sand/30 rounded-xl shadow-lg shadow-charcoal/10 py-1"
    >
      {children}
    </div>,
    document.body,
  );
}
