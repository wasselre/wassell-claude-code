/**
 * Shared language hooks — the ONE way to read the current UI language.
 *
 * The codebase accumulated ~290 hand-rolled copies of
 * `const isAr = language === 'ar'`, in two spellings with different
 * re-render behavior (narrow selector vs whole-store subscription).
 * New code must use these hooks instead; existing copies migrate
 * opportunistically as files are touched.
 */

import { useAppStore } from '@/stores/appStore';
import type { Language } from '@/types';

/** Current UI language ('ar' | 'en'), narrow subscription. */
export function useLang(): Language {
  return useAppStore((s) => s.language);
}

/** True when the UI is in Arabic. Subscribes to the boolean, not the store. */
export function useIsAr(): boolean {
  return useAppStore((s) => s.language === 'ar');
}
