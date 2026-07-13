import type { LoadScriptProps } from '@react-google-maps/api';

export const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '';

/** Extra Maps libraries loaded app-wide. MODULE-LEVEL constant: the loader
 *  compares array identity across hook calls — a fresh array per call would
 *  make it think the options changed and re-inject the script.
 *  `drawing` powers the free-draw mode in DistrictMapPicker. */
const MAPS_LIBRARIES: LoadScriptProps['libraries'] = ['drawing'];

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
    libraries: MAPS_LIBRARIES,
  };
}

export function isMapsKeyConfigured(): boolean {
  return Boolean(GOOGLE_MAPS_API_KEY);
}
