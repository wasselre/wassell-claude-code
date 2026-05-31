import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/**
 * A <textarea> that grows with its content instead of showing an inner
 * scrollbar. The `rows` attribute still sets the minimum height — the field
 * never shrinks below it, but content taller than that pushes the box down.
 *
 * Height math assumes `box-sizing: border-box` (Tailwind's global default):
 * `scrollHeight` excludes the border, so we add it back — otherwise the last
 * line clips behind the 1.5px `.form-input` border.
 *
 * Drop-in for any controlled `<textarea>` — forwards every native prop, so
 * callers keep passing `value` / `onChange` / `className` / `rows` as before.
 */
export default function AutoGrowTextarea({
  className,
  style,
  onInput,
  value,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${el.scrollHeight + border}px`;
  };

  // Re-fit on mount and whenever the controlled value changes — the latter
  // covers programmatic updates (record load, form reset) that don't fire
  // onInput.
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);

  // Re-fit when the textarea's width changes (viewport resize, RTL flip,
  // sidebar toggle) so re-wrapped lines aren't clipped by overflow:hidden.
  // Guard on width so our own height writes don't retrigger the observer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        fit(el);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      value={value}
      onInput={(e) => {
        fit(e.currentTarget);
        onInput?.(e);
      }}
      className={className}
      style={{ resize: 'none', overflow: 'hidden', ...style }}
      {...rest}
    />
  );
}
