import type { LoadScriptProps } from '@react-google-maps/api';

export const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';

/**
 * Shared `useJsApiLoader` options so MapsView and MapsBuilder use one script
 * tag. Mismatched `id` or library list across callers causes the hook to
 * re-inject the script.
 */
export function getMapsLoaderOptions(language: 'ar' | 'en'): LoadScriptProps {
  return {
    id: 'google-maps-script',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    language,
    region: 'SA',
  };
}

export function isMapsKeyConfigured(): boolean {
  return Boolean(GOOGLE_MAPS_API_KEY);
}
