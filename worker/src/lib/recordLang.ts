/**
 * Server-side record localization (bilingual W4, REV 4 §C1).
 *
 * Batched read of `translation_variants` for a set of record ids + one target
 * language, returning a per-record overlay of field_path → display text. The
 * capture trigger clears a variant's display SYNCHRONOUSLY in the same
 * transaction as any source change, so any non-null display_text in state
 * translated|approved is current by construction — no generation join needed
 * here (same guarantee the SPA store relies on).
 *
 * Consumers overlay scalar fields only; element paths (`field[id=…]`) and twin
 * pairs (`pair:…`) are intentionally left to their dedicated pipelines.
 *
 * WORKER COPY of api/_lib/recordLang.ts (the worker is a standalone package
 * and cannot import api/_lib) — change BOTH together.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type Lang = 'ar' | 'en';

/** entityId → (fieldPath → display text) */
export type TranslationOverlay = Map<string, Record<string, string>>;

const CHUNK = 200;

/**
 * Fetch the current translation overlay for `entityIds` in `lang`.
 * Service-role or user-JWT client both work (translation_variants SELECT is
 * RLS-gated through translation_visible for authenticated callers).
 * Failures return what was fetched so far — callers degrade to source text.
 */
export async function fetchTranslationOverlay(
  client: SupabaseClient,
  entityIds: string[],
  lang: Lang,
): Promise<TranslationOverlay> {
  const overlay: TranslationOverlay = new Map();
  const ids = [...new Set(entityIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await client
      .from('translation_variants')
      .select('entity_id, field_path, display_text')
      .eq('resource_kind', 'record')
      .in('entity_id', chunk)
      .eq('lang', lang)
      .eq('role', 'target')
      .in('state', ['translated', 'approved'])
      .not('display_text', 'is', null)
      .limit(1000);
    if (error) {
      console.error(`[recordLang] overlay fetch failed (${chunk.length} ids): ${error.message}`);
      continue; // degrade to source for this chunk — never fail the consumer
    }
    if ((data?.length ?? 0) >= 1000) {
      console.error('[recordLang] overlay chunk hit the 1,000-row page — results may be partial; shrink CHUNK');
    }
    for (const row of data ?? []) {
      const id = row.entity_id as string;
      const path = row.field_path as string;
      if (path.includes('[') || path.startsWith('pair:')) continue; // scalar overlay only
      let m = overlay.get(id);
      if (!m) overlay.set(id, (m = {}));
      m[path] = row.display_text as string;
    }
  }
  return overlay;
}

/** Localized copy of one record's data: scalar string fields replaced by their
 *  current translation where one exists; everything else untouched. */
export function localizeRecordData(
  data: Record<string, unknown>,
  overlay: TranslationOverlay,
  entityId: string,
): Record<string, unknown> {
  const m = overlay.get(entityId);
  if (!m) return data;
  const out: Record<string, unknown> = { ...data };
  for (const [path, text] of Object.entries(m)) {
    if (typeof out[path] === 'string' && (out[path] as string).trim().length > 0) {
      out[path] = text;
    }
  }
  return out;
}

/** One-field lookup against a fetched overlay. Null = no current translation. */
export function overlayFieldText(
  overlay: TranslationOverlay,
  entityId: string,
  fieldPath: string,
): string | null {
  return overlay.get(entityId)?.[fieldPath] ?? null;
}
