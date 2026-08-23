import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './lib/i18n';
import { useAppStore } from './stores/appStore';
import { installViewportHeightVar } from './lib/viewportHeight';

// Keep --app-height in sync with the visual viewport (shrinks when the on-screen
// keyboard opens) so full-screen surfaces keep their composer above the keyboard.
installViewportHeightVar();

// ── Stale-chunk recovery (needed once the app is route-code-split) ──────────
// A failed dynamic import is almost always a stale deploy: the cached index /
// entry references hashed chunk filenames that no longer exist after a new
// build shipped. With lazy routes and NO handling that's a permanent BLANK
// PAGE (the symptom reps hit opening a deep link from a push notification).
// Reload ONCE to fetch the fresh index + chunk graph; a sessionStorage guard
// prevents an infinite reload loop, and it's cleared after a few seconds of
// successful running so a later (different) stale chunk can still self-heal.
const CHUNK_RELOAD_KEY = 'wassell_chunk_reloaded';
function reloadOnceForStaleChunk(): void {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    // sessionStorage unavailable — still reload (worst case: one extra reload).
  }
  window.location.reload();
}
// Vite fires this when a lazy chunk's <link modulepreload> fails.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk();
});
// And catch the raw dynamic-import rejection (covers browsers / paths that
// don't emit vite:preloadError).
window.addEventListener('unhandledrejection', (event) => {
  const msg = String((event.reason && (event.reason as Error).message) || event.reason || '');
  if (/dynamically imported module|Importing a module script failed|ChunkLoadError|Failed to fetch dynamically imported/i.test(msg)) {
    reloadOnceForStaleChunk();
  }
});
// NOTE: the guard is intentionally NOT cleared on a timer — reloading AT MOST
// once per browser session guarantees we can never enter a reload loop (a
// genuinely broken deploy shows an error after one reload instead of flashing).

// DEV-only debug handle so local browser-driven tests (Claude preview tooling)
// can read/inject store state without an authenticated backend. Dead code in
// production builds (import.meta.env.DEV is statically false).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__appStore = useAppStore;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
