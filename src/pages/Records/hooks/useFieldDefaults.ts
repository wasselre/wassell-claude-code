import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel } from '@/types';

interface UseFieldDefaultsArgs {
  model: AppModel | null | undefined;
  /** Only NEW records get seeded — editing an existing record must never re-stamp. */
  isNew: boolean;
  formData: Record<string, unknown>;
  /** React useState dispatcher; functional form so concurrent edits survive. */
  setFormData: Dispatch<SetStateAction<Record<string, unknown>>>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time 'YYYY-MM-DD' — matches DateTimePicker's `date` storage shape. */
function localDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-time 'YYYY-MM-DDTHH:MM' — matches DateTimePicker's `datetime` storage shape. */
function localDateTimeString(): string {
  const d = new Date();
  return `${localDateString()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Seeds dynamic defaults (`default_dynamic`) into a NEW record's form once on
 * mount. For every field declaring a default whose current value is empty:
 *   - 'current_user' → the signed-in user's id (assignee fields)
 *   - 'now'          → local 'YYYY-MM-DDTHH:MM' (datetime fields)
 *   - 'today'        → local 'YYYY-MM-DD' (date fields)
 *
 * The default only SEEDS the blank — the user can edit or clear it afterwards,
 * and we never re-apply for the same mount (guarded by `appliedRef`), so a
 * deliberately-cleared field stays cleared. No-ops when the model declares no
 * dynamic defaults, so it's cheap to mount on every form.
 *
 * Mirrors the safety posture of `useAutoFill`: the functional `setFormData`
 * updater re-checks emptiness against live `prev`, so a value the user typed
 * between render and commit is never clobbered.
 */
export function useFieldDefaults({ model, isNew, formData, setFormData }: UseFieldDefaultsArgs): void {
  const currentUserId = useAppStore((s) => s.currentUserId);

  // One application per (model, mount). Cleared when we leave the new-record
  // form so navigating new → existing → new re-seeds correctly.
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!model || !isNew) {
      appliedRef.current = null;
      return;
    }
    if (appliedRef.current === model.id) return;
    appliedRef.current = model.id;

    const fills: Record<string, unknown> = {};
    const fields = model.schema.sections
      .filter((s) => !s.is_mirrored)
      .flatMap((s) => s.fields);
    for (const f of fields) {
      if (!f.default_dynamic) continue;
      const cur = formData[f.name];
      if (cur !== undefined && cur !== null && cur !== '') continue; // already has a value
      let v: unknown;
      switch (f.default_dynamic) {
        case 'current_user':
          v = currentUserId ?? undefined;
          break;
        case 'now':
          v = localDateTimeString();
          break;
        case 'today':
          v = localDateString();
          break;
        case 'token':
          // Opaque write-once key (e.g. visits.rating_token). Generated client-
          // side so a create-triggered workflow can embed it in a public link
          // before the record is persisted. A DB BEFORE-INSERT trigger backstops
          // any server-created record that arrives without one.
          v = crypto.randomUUID();
          break;
      }
      if (v !== undefined) fills[f.name] = v;
    }

    if (Object.keys(fills).length === 0) return;
    setFormData((prev) => {
      const out = { ...prev };
      for (const [k, v] of Object.entries(fills)) {
        const c = out[k];
        if (c === undefined || c === null || c === '') out[k] = v;
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id, isNew, currentUserId]);
}
