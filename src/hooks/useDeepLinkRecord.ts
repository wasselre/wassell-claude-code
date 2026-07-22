import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';

// Route param ids are uuids; anything else (e.g. a malformed link) would make
// the `unified_records` uuid-typed `id` filter error server-side, so we skip
// the targeted fetch for non-uuid ids and just wait for the tail.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deep-link fast path for `/model/:modelName/:recordId`.
 *
 * On a hard load (opening a link in a new tab, a WhatsApp/email deep link,
 * a browser refresh) the records tail arrives seconds AFTER first paint —
 * see appStore `initialize()` Phase D.2. Without this hook every record
 * detail page renders its "record not found" state until the full tail
 * lands, which reads as breakage and makes deep links feel slow.
 *
 * This hook does two things:
 *  1. Returns `true` while the page should show a loading state instead of
 *     dispatching to the detail page (record not in the store yet AND the
 *     boot records tail hasn't finished).
 *  2. Fires ONE targeted single-row fetch (`refreshRecordById`, RLS-gated,
 *     merged through the same stale-guarded `mergeRecord` path Realtime
 *     uses) so the record lands in the store in ~one round-trip instead of
 *     waiting for the multi-second full tail.
 *
 * The fetch waits for `criticalDataReady` because `mergeRecord` drops rows
 * whose model isn't loaded into the store yet (models arrive with the fast
 * chrome-critical batch, well before the records tail).
 *
 * For a genuinely nonexistent (or RLS-hidden) id the fetch merges nothing;
 * the hook keeps returning `true` until `initialized`, after which the
 * page's own "not found" state renders — now truthfully.
 */
export function useDeepLinkRecordPending(modelName?: string, recordId?: string): boolean {
  const initialized = useAppStore((s) => s.initialized);
  const criticalDataReady = useAppStore((s) => s.criticalDataReady);
  const refreshRecordById = useAppStore((s) => s.refreshRecordById);
  const modelId = useAppStore((s) =>
    modelName ? s.models.find((m) => m.name === modelName)?.id : undefined,
  );
  const inStore = useAppStore((s) => {
    if (!modelId || !recordId) return false;
    return (s.records[modelId] ?? []).some((r) => r.id === recordId);
  });

  const isRealId = !!recordId && recordId !== 'new';
  const pending = isRealId && !initialized && !inStore;

  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || !criticalDataReady) return;
    if (!recordId || !UUID_RE.test(recordId)) return;
    if (firedFor.current === recordId) return; // one targeted fetch per id
    firedFor.current = recordId;
    void refreshRecordById(recordId);
  }, [pending, criticalDataReady, recordId, refreshRecordById]);

  return pending;
}
