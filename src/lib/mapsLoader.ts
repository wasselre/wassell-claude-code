import type { LoadScriptProps } from '@react-google-maps/api';

export const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';

/**
 * Shared `useJsApiLoader` options so MapsView and MapsBuilder use one script
 * tag. Mismatched `id` or library list across callers causes the hook to
 * re-inject the script.
 *
 * NOTE: do NOT add the `drawing` library — Google REMOVED DrawingManager in
 * Maps JS v3.65 (instantiating it throws and crashed the app, live incident
 * 2026-07-13). DistrictMapPicker's free-draw mode is implemented manually
 * with map click listeners instead.
 *
 * VERSION PIN (2026-08-16): `version` is pinned rather than riding Google's
 * default `weekly` channel. Weekly silently ships breaking changes we inherit
 * with no code change — it removed DrawingManager (v3.65, incident above) and
 * then changed how overlapping map-style rules resolve, which un-hid Google's
 * labels on every geo map and made districts render twice (live report
 * 2026-08-16). Pinning to a known-good release means Maps behaviour only changes
 * when WE bump this number and re-test — never under us. Bump deliberately;
 * Google retires very old versions, so revisit periodically.
 */
const MAPS_JS_VERSION = '3.65';
export function getMapsLoaderOptions(language: 'ar' | 'en'): LoadScriptProps {
  return {
    id: 'google-maps-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    version: MAPS_JS_VERSION,
    language,
    region: 'SA',
  };
}

export function isMapsKeyConfigured(): boolean {
  return Boolean(GOOGLE_MAPS_API_KEY);
}
