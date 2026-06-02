/**
 * useDebouncedTranslation — wires a single user-typed label to the live
 * /api/translate flow. The hook returns the translated counterpart + slug
 * once the user pauses typing for ~700ms, plus a `translateNow()` escape
 * hatch that resolves immediately (used on save / on blur to make sure we
 * never persist a half-translated record).
 *
 * Behavior:
 *   - Watches `input` and re-fires after `delay` ms of quiet
 *   - Aborts in-flight requests when input changes
 *   - Caches results in module-level cache (see translateLabel.ts) so the
 *     same input typed twice never re-hits the API
 *   - On error: surfaces to the toast queue and exposes `error` for inline UI
 *
 * Callers:
 *   const { result, status, error, translateNow } = useDebouncedTranslation(
 *     label, { kind: 'field', enabled: !editingExisting }
 *   );
 *
 *   useEffect(() => {
 *     if (result) {
 *       setLabelOther(result.label_ar);
 *       setSlug(result.name);
 *     }
 *   }, [result]);
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  translateLabel,
  peekTranslationCache,
  type TranslatedLabel,
  type TranslationKind,
} from '@/lib/translateLabel';
import { useAppStore } from '@/stores/appStore';

export type TranslationStatus = 'idle' | 'pending' | 'success' | 'error';

interface UseDebouncedTranslationOptions {
  kind?: TranslationKind;
  delay?: number;
  enabled?: boolean;
  /**
   * If true, raise a red toast whenever a translation fails. Default: true.
   * Set to false when the caller wants to handle the error UI itself.
   */
  toastOnError?: boolean;
}

interface UseDebouncedTranslationResult {
  result: TranslatedLabel | null;
  status: TranslationStatus;
  error: string | null;
  /**
   * Force-resolve the translation immediately. Returns the result (cached or
   * freshly fetched) or throws. Use on save / blur paths so the persisted
   * record always has both labels and a real slug.
   */
  translateNow: () => Promise<TranslatedLabel>;
}

// 450ms: long enough to detect a real typing pause, short enough that the
// auto-fill no longer feels laggy. Was 700ms — lowered 2026-06-02 after the
// live option translation was reported as "very very slow". The blur handler
// still force-resolves immediately, so this only governs the pause-and-watch
// case, not tab/click-away.
const DEFAULT_DELAY_MS = 450;

export function useDebouncedTranslation(
  input: string,
  options: UseDebouncedTranslationOptions = {},
): UseDebouncedTranslationResult {
  const { kind = 'generic', delay = DEFAULT_DELAY_MS, enabled = true, toastOnError = true } = options;
  const addToast = useAppStore((s) => s.addToast);
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';

  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslatedLabel | null>(() =>
    input.trim() ? peekTranslationCache(input, kind) : null,
  );

  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestInputRef = useRef<string>(input);

  // Keep the latest input visible to translateNow so blur-fired immediate
  // calls always use the most recent value (not the value at hook-mount).
  latestInputRef.current = input;

  const runTranslation = useCallback(
    async (text: string): Promise<TranslatedLabel> => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error('input is empty');
      }
      const cached = peekTranslationCache(trimmed, kind);
      if (cached) {
        setResult(cached);
        setStatus('success');
        setError(null);
        return cached;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('pending');
      setError(null);
      try {
        const out = await translateLabel(trimmed, kind, controller.signal);
        if (controller.signal.aborted) {
          // A newer call has superseded this one — let that one own the state.
          throw new DOMException('aborted', 'AbortError');
        }
        setResult(out);
        setStatus('success');
        return out;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('error');
        setError(msg);
        if (toastOnError) {
          addToast(
            isAr ? `تعذرت الترجمة التلقائية: ${msg}` : `Auto-translate failed: ${msg}`,
            'error',
          );
        }
        throw err;
      }
    },
    [kind, addToast, isAr, toastOnError],
  );

  useEffect(() => {
    if (!enabled) {
      // Hook is disabled (e.g. editing an existing record where translation
      // would clobber a manually-edited label). Do nothing.
      return;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      // Empty input — clear state and abort any in-flight call.
      abortRef.current?.abort();
      setResult(null);
      setStatus('idle');
      setError(null);
      return;
    }
    const cached = peekTranslationCache(trimmed, kind);
    if (cached) {
      setResult(cached);
      setStatus('success');
      setError(null);
      return;
    }
    timeoutRef.current = setTimeout(() => {
      void runTranslation(trimmed).catch(() => {
        // Errors are already handled inside runTranslation (state + toast).
        // Swallow here so React doesn't see an unhandled promise.
      });
    }, delay);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [input, enabled, delay, kind, runTranslation]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const translateNow = useCallback(async (): Promise<TranslatedLabel> => {
    return runTranslation(latestInputRef.current);
  }, [runTranslation]);

  return { result, status, error, translateNow };
}
