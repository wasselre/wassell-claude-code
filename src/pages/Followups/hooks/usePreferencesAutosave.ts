// usePreferencesAutosave — saves the client's preference draft a moment after
// every change, so the rep never presses Save (operator, 2026-10-05).
//
// Mount it ONCE per page (the Follow-up Workspace, the follow-up finder page):
// the inline preferences panel, the floating preferences pop-up and the units
// filter all edit the SAME draft (the qualification session), and one saver per
// page means no two savers race the same client row.
//
// Versioned: the version we write against only moves forward — our own saves
// bump it, a newer one arriving over realtime is adopted. One save in flight;
// an edit during it is saved right after. A conflict is surfaced loudly and
// saving pauses until the next edit (retrying a stale version would only
// conflict again).

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import { EDITABLE_PREF_SLUGS } from '@/lib/clientPrefs/prefSlugs';

export type PrefSaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_MS = 900;
const KEYS = [...EDITABLE_PREF_SLUGS, 'location_items', 'preference_constraints'];

export function usePreferencesAutosave(
  clientId: string | null,
  draft: Record<string, unknown>,
  enabled = true,
): { saveState: PrefSaveState; dirty: boolean } {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';

  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel && clientId ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null : null;

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const versionRef = useRef<number | null>(null);
  useEffect(() => { versionRef.current = null; }, [clientId]);
  useEffect(() => {
    const v = clientRec?.version ?? null;
    if (v !== null && (versionRef.current === null || v > versionRef.current)) versionRef.current = v;
  }, [clientRec?.version]);

  const [saveState, setSaveState] = useState<PrefSaveState>('idle');
  const savingRef = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  const draftKey = JSON.stringify(KEYS.map((k) => draft[k] ?? null));
  const dirty = clientRec ? preferencesDirty(clientRec.data, draft, EDITABLE_PREF_SLUGS) : false;

  useEffect(() => {
    if (!enabled || !clientRec || !dirty) return;
    const t = setTimeout(async () => {
      if (savingRef.current) { setRetryTick((n) => n + 1); return; } // one in flight — try again after it
      savingRef.current = true;
      setSaveState('saving');
      // The freshest copy from the store (an echo may have landed since render).
      const st = useAppStore.getState();
      const cm = st.models.find((m) => m.name === 'clients');
      const fresh = cm ? (st.records[cm.id] ?? []).find((r) => r.id === clientRec.id) ?? clientRec : clientRec;
      const res = await saveClientPreferences({
        client: fresh,
        draft: draftRef.current,
        slugs: EDITABLE_PREF_SLUGS,
        saveRecord,
        expectedVersion: versionRef.current ?? fresh.version ?? null,
        isAr,
      });
      savingRef.current = false;
      if (res.ok) {
        if (res.nextVersion != null) versionRef.current = res.nextVersion;
        setSaveState('saved');
      } else {
        setSaveState('error');
        addToast(res.message, res.tone);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, draftKey, dirty, retryTick]);

  return { saveState, dirty };
}
