import { useEffect, useMemo, useState } from 'react';
import { callJson } from '@/pages/Chats/lib/cardHttp';
import type { AiChangeRow } from '@/pages/Chats/lib/aiActivity';

/**
 * Which client fields the AI filled (operator, 2026-10-05: "whenever a field
 * is filled in with AI, we should know"). Per field: the newest applied,
 * not-undone AI change, and whether the field STILL holds what the AI wrote
 * (a rep may have edited it since). Places: the AI's place additions, shown on
 * the `location` field. Read from /api/client-ai-changes (newest 30).
 */

export interface AiFieldMark {
  at: string;
  source: AiChangeRow['source'];
  quote: string | null;
  /** The field still holds the AI's value. */
  current: boolean;
  /** Places only: how many the AI added. */
  places?: number;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function useAiFieldMarks(clientId: string, data: Record<string, unknown>, version: number | null | undefined): Record<string, AiFieldMark> {
  const [changes, setChanges] = useState<AiChangeRow[]>([]);

  useEffect(() => {
    let alive = true;
    callJson<{ changes: AiChangeRow[] }>(`/api/client-ai-changes?clientId=${encodeURIComponent(clientId)}`, { method: 'GET' })
      .then((r) => { if (alive) setChanges(r.changes); })
      // The marks are an annotation: a failed read leaves the form untouched, logged.
      .catch((err: unknown) => console.error('[useAiFieldMarks] load failed:', err));
    return () => { alive = false; };
  }, [clientId, version]);

  return useMemo(() => {
    const out: Record<string, AiFieldMark> = {};
    let places = 0;
    // Only changes to the profile on screen (the active one): a change written
    // to another profile, or before profiles were tracked (no id), shows there.
    const activeId = typeof data.active_profile_id === 'string' ? data.active_profile_id : null;
    for (const c of changes) {
      if (!c.applied || c.undone_at) continue;
      if (c.profile_id && c.profile_id !== activeId) continue;
      if (c.kind === 'pref' && c.field && !out[c.field]) {
        out[c.field] = { at: c.created_at, source: c.source, quote: c.quote, current: same(c.after_value, data[c.field]) };
      } else if (c.kind === 'place' && Array.isArray(c.added) && c.added.length) {
        places += Array.isArray(c.added) ? c.added.length : 1;
        if (!out.location) out.location = { at: c.created_at, source: c.source, quote: c.quote, current: true };
      }
    }
    if (out.location) out.location.places = places;
    return out;
  }, [changes, data]);
}
