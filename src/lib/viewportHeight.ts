/**
 * Track the VISUAL viewport height into the `--app-height` CSS variable.
 *
 * Why: `100vh` / `100dvh` on iOS do NOT shrink when the on-screen keyboard
 * opens — the layout viewport stays full-height and the keyboard just overlaps
 * it. A full-screen surface whose composer is pinned to the bottom (the mobile
 * Chats view) then puts that composer BEHIND the keyboard, and iOS's own
 * keyboard toolbar floats in the misaligned layout (the "keyboard appears in a
 * very messed-up way" bug). `window.visualViewport.height` DOES reflect the
 * keyboard, so binding the container height to it keeps the composer above the
 * keyboard.
 *
 * Sets a default of `100dvh` in CSS (see index.css) so there is never a moment
 * with no value; this only ever makes it more accurate.
 */
export function installViewportHeightVar(): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const vv = window.visualViewport;

  const apply = (): void => {
    const h = vv ? vv.height : window.innerHeight;
    if (h > 0) root.style.setProperty('--app-height', `${Math.round(h)}px`);
  };

  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
}
