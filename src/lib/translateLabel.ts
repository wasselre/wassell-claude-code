/**
 * Live label translator — calls /api/translate with the user's typed text and
 * returns the matching Arabic + English labels and a clean snake_case slug.
 *
 * Used by the Builder to fill the "other" language and slug automatically when
 * the user creates models, sections, fields, dropdown options, and groups.
 * Replaces the old stub that copied input as-is and produced `item_<timestamp>`
 * slugs for any Arabic input.
 *
 * Caching: results are memoized in-memory per (input + kind) for the lifetime
 * of the page — re-typing or re-blurring the same input doesn't re-call the
 * API. In-flight calls dedupe via a promise registry so concurrent requests
 * for the same input collapse to a single network call.
 *
 * Failure posture: throws — callers must surface the error (toast + block save).
 * Per CLAUDE.md "no silent failures": we never silently fall back to gibberish.
 */

import { supabase } from '@/lib/supabase';

export type TranslationKind =
  | 'model'
  | 'section'
  | 'field'
  | 'option'
  | 'group'
  | 'workflow'
  | 'dashboard'
  | 'role'
  | 'profile'
  | 'generic';

export interface TranslatedLabel {
  label_ar: string;
  label_en: string;
  name: string;
}

interface ApiResponse {
  ok?: boolean;
  label_ar?: string;
  label_en?: string;
  name?: string;
  error?: string;
}

const cache = new Map<string, TranslatedLabel>();
const inFlight = new Map<string, Promise<TranslatedLabel>>();

function cacheKey(input: string, kind: TranslationKind): string {
  return `${kind}::${input.trim()}`;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Detect input language by sampling Arabic codepoints. Returns 'ar' if any
 * Arabic letter is present, else 'en'. Used as a hint for the model.
 */
export function detectInputLanguage(input: string): 'ar' | 'en' {
  return /[؀-ۿ]/.test(input) ? 'ar' : 'en';
}

/**
 * Translate a single label. Throws on failure — callers should toast + block
 * the save flow rather than persist a half-translated record.
 */
export async function translateLabel(
  input: string,
  kind: TranslationKind = 'generic',
  signal?: AbortSignal,
): Promise<TranslatedLabel> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('translateLabel: input is empty');
  }

  const key = cacheKey(trimmed, kind);
  const cached = cache.get(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const sourceLang = detectInputLanguage(trimmed);

  const promise = (async (): Promise<TranslatedLabel> => {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeader()),
      },
      body: JSON.stringify({ input: trimmed, source_lang: sourceLang, kind }),
      signal,
    });

    let body: ApiResponse;
    try {
      body = (await res.json()) as ApiResponse;
    } catch {
      throw new Error(`Translation API returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `Translation API failed (HTTP ${res.status})`);
    }

    const result: TranslatedLabel = {
      label_ar: (body.label_ar ?? '').trim(),
      label_en: (body.label_en ?? '').trim(),
      name: (body.name ?? '').trim(),
    };

    if (!result.label_ar || !result.label_en || !result.name) {
      throw new Error('Translation API returned an incomplete payload');
    }

    cache.set(key, result);
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Read-only peek at the cache — used by hooks to render a synchronous initial
 * value when the user re-opens a modal with the same text already cached.
 */
export function peekTranslationCache(
  input: string,
  kind: TranslationKind = 'generic',
): TranslatedLabel | null {
  return cache.get(cacheKey(input.trim(), kind)) ?? null;
}

/**
 * Clear the in-memory cache. Exposed for tests and for the rare case where
 * the user fixes a translation manually and we want subsequent matches to
 * reflect the override (the override gets cached on save, so this is mostly
 * a safety hatch).
 */
export function clearTranslationCache(): void {
  cache.clear();
}
