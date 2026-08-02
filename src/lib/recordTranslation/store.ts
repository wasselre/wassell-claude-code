/**
 * Record-scoped translation store (bilingual W3, REV 4 §C1 SPA path).
 *
 * Replaces the legacy whole-table text-keyed cache with per-entity hydration
 * of `translation_variants`: components resolve a (recordId, fieldPath, lang)
 * synchronously; misses for un-hydrated records queue the record id and a
 * debounced chunked fetch fills the map, then subscribers re-render.
 *
 * Display validity is guaranteed SERVER-side: the capture trigger clears a
 * variant's display synchronously in the same transaction as any source
 * change, so any non-null display_text this store fetches in state
 * translated|approved is current by construction. Client invalidation is
 * therefore simple: drop a record's entries whenever the app observes that
 * record change (realtime record merge / local save), and refetch on demand.
 *
 * The browser NEVER writes any translation table (echo-dedup stays a no-op);
 * corrections go through the SQL RPCs (W3b editing contract).
 */

import { useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';

type Lang = 'ar' | 'en';

interface VariantEntry {
  text: string;
  state: 'translated' | 'approved';
}

/** `${entityId}|${fieldPath}|${lang}` → entry */
const entries = new Map<string, VariantEntry>();
/** Entities whose variants have been fetched (hit or empty). */
const hydrated = new Set<string>();
/** Entities queued for the next chunk fetch. */
const pendingIds = new Set<string>();

let version = 0;
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

const CHUNK = 150;
const FLUSH_MS = 250;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Subscribe components to hydration arrivals. */
export function useRecordTranslationVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

async function flush(): Promise<void> {
  if (inFlight || !supabase) return;
  const ids = [...pendingIds].slice(0, CHUNK);
  if (ids.length === 0) return;
  for (const id of ids) pendingIds.delete(id);
  inFlight = true;
  try {
    // Displays are server-guaranteed current (see header); one page per chunk
    // is fine — a record has at most a handful of translated fields, so 150
    // records stay well under PostgREST's 1,000-row page.
    const { data, error } = await supabase
      .from('translation_variants')
      .select('entity_id, field_path, lang, state, display_text')
      .in('entity_id', ids)
      .eq('role', 'target')
      .in('state', ['translated', 'approved'])
      .not('display_text', 'is', null)
      .limit(1000);
    if (error) throw error;
    if ((data?.length ?? 0) >= 1000) {
      // Loud, honest cap handling per CLAUDE.md: shrink chunks rather than
      // silently dropping rows.
      console.error('[recordTranslation] chunk hit the 1,000-row page — refetching split halves');
      for (const id of ids) pendingIds.add(id);
      entriesSplitChunk();
    } else {
      for (const row of data ?? []) {
        entries.set(
          `${row.entity_id}|${row.field_path}|${row.lang}`,
          { text: row.display_text as string, state: row.state as VariantEntry['state'] },
        );
      }
      for (const id of ids) hydrated.add(id);
      notify();
    }
  } catch (err) {
    // Offline / signed-out / transient: leave un-hydrated so a later render
    // retries; sources keep displaying (honest degradation).
    console.error('[recordTranslation] hydration failed:', err);
    for (const id of ids) pendingIds.add(id);
  } finally {
    inFlight = false;
    if (pendingIds.size > 0) scheduleFlush();
  }
}

let chunkSize = CHUNK;
function entriesSplitChunk(): void {
  chunkSize = Math.max(20, Math.floor(chunkSize / 2));
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
}

/** Queue an entity for hydration (no-op if already hydrated/queued). */
export function requestEntityTranslations(entityId: string): void {
  if (!supabase || hydrated.has(entityId) || pendingIds.has(entityId)) return;
  pendingIds.add(entityId);
  scheduleFlush();
}

/**
 * Drop a record's cached translations — call when the app observes the record
 * change (its translations were synchronously cleared server-side and will be
 * re-produced by the worker). Next render re-hydrates.
 */
export function invalidateEntityTranslations(entityId: string): void {
  let dropped = false;
  for (const key of entries.keys()) {
    if (key.startsWith(entityId + '|')) {
      entries.delete(key);
      dropped = true;
    }
  }
  hydrated.delete(entityId);
  if (dropped) notify();
}

/**
 * Synchronous variant lookup. Returns the stored display text for the exact
 * (record, field, lang), or null when the record is hydrated but has no
 * current translation for that field — the caller then shows the SOURCE
 * (pending honesty), never a stale value and never a text-keyed guess.
 * Un-hydrated records queue themselves and return null this render.
 */
export function getEntityFieldText(
  entityId: string,
  fieldPath: string,
  lang: Lang,
): string | null {
  const hit = entries.get(`${entityId}|${fieldPath}|${lang}`);
  if (hit) return hit.text;
  if (!hydrated.has(entityId)) requestEntityTranslations(entityId);
  return null;
}

/**
 * Awaitable bulk hydration (bilingual W4 — exports). Queues every un-hydrated
 * id and drains the fetch queue before resolving, so a synchronous walk over
 * the records (Excel export) sees their translations. Resolves anyway after
 * `timeoutMs` — an export must never hang on a translation fetch; un-hydrated
 * records just export their source text.
 */
export async function ensureEntityTranslations(entityIds: string[], timeoutMs = 15_000): Promise<void> {
  if (!supabase) return;
  for (const id of entityIds) {
    if (!hydrated.has(id)) pendingIds.add(id);
  }
  if (pendingIds.size === 0) return;
  scheduleFlush();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entityIds.every((id) => hydrated.has(id))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`[recordTranslation] ensureEntityTranslations timed out — exporting with source text for un-hydrated records`);
}

/** Test-only reset. */
export function __resetRecordTranslations(): void {
  entries.clear();
  hydrated.clear();
  pendingIds.clear();
  chunkSize = CHUNK;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
