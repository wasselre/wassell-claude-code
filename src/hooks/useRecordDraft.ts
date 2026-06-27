import { useEffect, useState } from 'react';
import type { AppRecord } from '@/types';

export interface RecordDraft {
  /** Editable copy of the record's `data`. */
  draft: Record<string, unknown>;
  /** Full replace (e.g. set the whole draft to a computed object). */
  setDraft: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  /** Shallow-merge a partial patch into the draft. */
  patchDraft: (patch: Record<string, unknown>) => void;
}

/**
 * Local editable copy ("draft") of a store record's `data`, seeded from the
 * record AND re-seeded when the record first becomes available.
 *
 * Why this exists — the hard-reload race: custom record-detail pages reached by
 * a direct `/model/<name>/<id>` URL render BEFORE `initialize()`'s records
 * slow-tail resolves on a hard browser reload. A plain
 * `useState(() => ({ ...record?.data }))` runs its initializer exactly once, so
 * it captures a still-null record and the draft stays `{}` forever — the page
 * looks "lost"/degraded until a client-side re-navigation remounts it (which is
 * why navigating out and back "fixes" it). This hook adds the missing re-seed
 * effect: it repopulates the draft on the null→loaded transition (and when the
 * page navigates to a different record).
 *
 * Keyed on `record?.id`, NOT `record.data`, on purpose: it fires only when the
 * record IDENTITY changes, so realtime echoes / version bumps during an active
 * edit session never clobber the rep's in-progress edits.
 *
 * Use this for any custom record page that keeps a single editable draft object
 * of `record.data`. (The generic `RecordFormPage` predates the hook but follows
 * the identical pattern via its `formData` reset effect.)
 */
export function useRecordDraft(record: AppRecord | null | undefined): RecordDraft {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}) }));

  useEffect(() => {
    setDraft({ ...(record?.data ?? {}) });
    // Intentionally keyed on the record id only — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id]);

  const patchDraft = (patch: Record<string, unknown>) =>
    setDraft((d) => ({ ...d, ...patch }));

  return { draft, setDraft, patchDraft };
}
