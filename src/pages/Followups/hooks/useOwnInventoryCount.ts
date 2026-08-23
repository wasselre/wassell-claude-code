// useOwnInventoryCount — the live "how much of OUR inventory fits this client"
// number behind the InventoryMeter, updated as the rep edits preferences on a call.
//
// It reuses the deterministic Project Finder in mode:'count' (SAME hard budget /
// type / geo gates and score floor as Suggested Projects — see fetchInventoryCount),
// so the number can never disagree with what the finder would show. It builds
// requirements with the SAME draftToMatchRequirements the finder uses.
//
// Behaviour that makes it safe on a live sales surface:
//   • debounced (~700ms after the draft settles) + AbortController-cancelled — one
//     request per settled edit, never per keystroke;
//   • deduped — an edit that doesn't change the requirements (or an unrelated field,
//     or a realtime echo) sends nothing (the effect is keyed on the VALUE of the
//     requirements, not object identity);
//   • keep-last-good — while a new count is in flight the previous number stays,
//     dimmed; the first load is the only spinner;
//   • never-zero-on-error — a failed request keeps the last good number with a stale
//     marker; 0 is only ever shown when the engine genuinely returned 0.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { buildGeoNameMap } from '@/lib/geo/geoNameMap';
import { draftToMatchRequirements } from '@/lib/matching/requirements';
import { fetchInventoryCount } from '@/lib/matching/projectFinder';
import {
  inventoryBand, missingCorePrefs, hasAnyCriteria,
  type InventoryBand, type CorePref,
} from '@/lib/matching/inventoryBands';

const DEBOUNCE_MS = 700;

export interface OwnInventoryCount {
  /** incomplete = no matchable preference yet; loading = first fetch; ready = have a
   *  number (possibly stale); error = first fetch failed with no prior number. */
  status: 'incomplete' | 'loading' | 'ready' | 'error';
  /** Last good own-inventory count, or null when incomplete / first-load / hard-errored. */
  count: number | null;
  band: InventoryBand | null;
  /** Core prefs still unset (location · budget · unit_type) — a factual hint, not coaching. */
  missing: CorePref[];
  /** True when the shown number is older than the current draft (refreshing or a failed refresh). */
  stale: boolean;
}

export function useOwnInventoryCount(input: {
  clientId: string | null;
  prefDraft: Record<string, unknown>;
}): OwnInventoryCount {
  const { clientId, prefDraft } = input;
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const savedClientData = useMemo(() => {
    if (!clientsModel || !clientId) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === clientId)?.data ?? null;
  }, [clientsModel, records, clientId]);

  // Resolve district/city ids to Arabic names exactly as the finder view does — the
  // matcher fuzzy-matches against Arabic project text, so it wants `.ar`.
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);
  const resolveLookupName = useMemo(
    () => (id: string, _t: 'districts' | 'cities'): string | null => geoNames[id]?.ar ?? null,
    [geoNames],
  );

  const requirements = useMemo(
    () => draftToMatchRequirements({ clientsModel, prefDraft, savedClientData, resolveLookupName }),
    [clientsModel, prefDraft, savedClientData, resolveLookupName],
  );
  const missing = useMemo(() => missingCorePrefs(requirements), [requirements]);
  const criteria = hasAnyCriteria(requirements);

  const locationItems = Array.isArray(prefDraft.location_items) ? prefDraft.location_items : null;
  // VALUE key: identity churn (a realtime echo rebuilding geoNames) produces the same
  // string, so the effect fires only when the requirements genuinely change.
  const key = useMemo(
    () => JSON.stringify({ r: requirements, li: locationItems, c: clientId }),
    [requirements, locationItems, clientId],
  );

  const [state, setState] = useState<Omit<OwnInventoryCount, 'missing'>>({
    status: 'incomplete', count: null, band: null, stale: false,
  });
  const lastGood = useRef<number | null>(null);

  useEffect(() => {
    if (!criteria) {
      lastGood.current = null;
      setState({ status: 'incomplete', count: null, band: null, stale: false });
      return;
    }
    // First load → spinner; otherwise keep the last number, dimmed, while refreshing.
    setState((s) => (lastGood.current == null
      ? { status: 'loading', count: null, band: null, stale: false }
      : { ...s, status: 'ready', stale: true }));

    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetchInventoryCount({ requirements, clientId, locationItems }, ctrl.signal)
        .then((resp) => {
          if (ctrl.signal.aborted) return;
          if (resp.needs_preferences) {
            lastGood.current = null;
            setState({ status: 'incomplete', count: null, band: null, stale: false });
            return;
          }
          lastGood.current = resp.our_count;
          setState({ status: 'ready', count: resp.our_count, band: inventoryBand(resp.our_count), stale: false });
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
          console.error('[inventoryCount] fetch failed:', err);
          // Never turn an error into zero. Keep the last good number if we have one.
          if (lastGood.current != null) {
            setState({ status: 'ready', count: lastGood.current, band: inventoryBand(lastGood.current), stale: true });
          } else {
            setState({ status: 'error', count: null, band: null, stale: false });
          }
        });
    }, DEBOUNCE_MS);

    return () => { clearTimeout(timer); ctrl.abort(); };
    // `key` encodes requirements + locationItems + clientId; `criteria` derives from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ...state, missing };
}
