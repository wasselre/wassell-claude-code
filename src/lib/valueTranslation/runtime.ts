/**
 * Value-translation runtime — the synchronous display resolver behind the
 * bilingual data experience.
 *
 * `resolveDisplayText(raw, lang)` is THE way a rendered record value becomes
 * bilingual. It is synchronous (render-path safe):
 *   - cache hit  → returns the stored translation
 *   - cache miss → returns the SOURCE text (visible, honest — per the
 *     localizedName.ts contract, never a skeleton) and queues the string for
 *     a debounced batch call to /api/value-translate; when the response
 *     lands the version bumps and subscribed components re-render translated.
 *
 * The cache is an overlay keyed by exact source text per target language.
 * Editing a value changes the text → automatic miss → fresh translation.
 * Records are never written by anything in this module.
 *
 * Non-React callers (analytics grouping, exports) call resolveDisplayText
 * directly; React components subscribe via useValueTranslationVersion() so
 * async arrivals re-render them.
 *
 * Failure posture: a failed batch logs loudly (console.error) and leaves the
 * source text on screen — visible degradation, no retry storm (each string is
 * attempted once per session; a reload retries).
 */

import { useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import type { ValueTranslationKind } from './config';

type TargetLang = 'ar' | 'en';

interface MissMeta {
  kind: ValueTranslationKind;
  model_hint?: string;
  field_hint?: string;
}

const MAX_CHARS = 4000;
const BATCH_SIZE = 25;
const FLUSH_DELAY_MS = 800;
const LOAD_PAGE = 1000;

const entriesByTarget: Record<TargetLang, Map<string, string>> = {
  ar: new Map(),
  en: new Map(),
};
const loadState: Record<TargetLang, 'idle' | 'loading' | 'loaded'> = { ar: 'idle', en: 'idle' };
/** Strings already sent (or in flight) this session — one attempt per string. */
const attempted: Record<TargetLang, Set<string>> = { ar: new Set(), en: new Set() };
const pending: Record<TargetLang, Map<string, MissMeta>> = { ar: new Map(), en: new Map() };

let version = 0;
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Subscribe React components to translation arrivals. */
export function useValueTranslationVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

const ARABIC_RE = /[؀-ۿ]/;
const LATIN_WORD_RE = /[A-Za-z]{2}/;
const URL_ISH_RE = /^(https?:\/\/|www\.)|@/;

/** Does this string need translating to reach the given UI language? */
function neededTarget(text: string, lang: TargetLang): TargetLang | null {
  if (text.length === 0 || text.length > MAX_CHARS) return null;
  if (lang === 'en') return ARABIC_RE.test(text) ? 'en' : null;
  // Arabic UI: translate Latin-only prose (rare direction), never URLs/codes.
  if (ARABIC_RE.test(text)) return null;
  if (!LATIN_WORD_RE.test(text) || URL_ISH_RE.test(text)) return null;
  return 'ar';
}

/**
 * Load the persisted cache for a target language, paginated past the
 * PostgREST 1,000-row ceiling (CLAUDE.md "Silent Failures" lesson).
 */
async function loadCache(target: TargetLang): Promise<void> {
  if (!supabase || loadState[target] !== 'idle') return;
  loadState[target] = 'loading';
  try {
    const map = entriesByTarget[target];
    for (let from = 0; ; from += LOAD_PAGE) {
      const { data, error } = await supabase
        .from('value_translations')
        .select('source_text, translated_text')
        .eq('target_lang', target)
        .range(from, from + LOAD_PAGE - 1);
      if (error) throw error;
      for (const row of data ?? []) {
        map.set(row.source_text as string, row.translated_text as string);
      }
      if (!data || data.length < LOAD_PAGE) break;
    }
    loadState[target] = 'loaded';
    if (entriesByTarget[target].size > 0) notify();
  } catch (err) {
    // Table missing / offline / signed out: degrade to source-language display
    // and let the next explicit request path surface real errors. Reset to
    // idle so a later call (e.g. after sign-in) retries the load.
    console.error(`[valueTranslation] cache load failed for '${target}':`, err);
    loadState[target] = 'idle';
  }
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function flush(): Promise<void> {
  if (inFlight) return;
  const target = (['en', 'ar'] as TargetLang[]).find((t) => pending[t].size > 0);
  if (!target) return;

  const batch = Array.from(pending[target].entries()).slice(0, BATCH_SIZE);
  for (const [text] of batch) pending[target].delete(text);

  inFlight = true;
  try {
    const res = await fetch('/api/value-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({
        target,
        items: batch.map(([text, meta]) => ({
          text,
          kind: meta.kind,
          model_hint: meta.model_hint,
          field_hint: meta.field_hint,
        })),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; results?: Array<{ text: string; translated: string | null }>; error?: string }
      | null;
    if (!res.ok || !body?.ok || !Array.isArray(body.results)) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    let got = 0;
    for (const r of body.results) {
      if (r.translated) {
        entriesByTarget[target].set(r.text, r.translated);
        got += 1;
      }
    }
    if (got > 0) notify();
  } catch (err) {
    // Loud, once — the affected strings stay in `attempted` so this session
    // shows source text for them instead of hammering a failing provider.
    console.error('[valueTranslation] batch translate failed:', err);
  } finally {
    inFlight = false;
    if (pending.en.size > 0 || pending.ar.size > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

/**
 * Resolve a record value for display in the given UI language.
 * Synchronous; see module header for the miss behavior.
 */
export function resolveDisplayText(
  raw: unknown,
  lang: TargetLang,
  meta?: Partial<MissMeta>,
): string {
  if (raw == null) return '';
  const text = typeof raw === 'string' ? raw : String(raw);
  const target = neededTarget(text.trim(), lang);
  if (!target) return text;

  const trimmed = text.trim();
  const cached = entriesByTarget[target].get(trimmed);
  if (cached) return cached;

  if (loadState[target] === 'idle') void loadCache(target);

  if (!attempted[target].has(trimmed) && supabase) {
    attempted[target].add(trimmed);
    pending[target].set(trimmed, { kind: meta?.kind ?? 'text', ...meta });
    scheduleFlush();
  }
  return text;
}

/** Test-only reset. */
export function __resetValueTranslations(): void {
  for (const t of ['ar', 'en'] as TargetLang[]) {
    entriesByTarget[t].clear();
    attempted[t].clear();
    pending[t].clear();
    loadState[t] = 'idle';
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
