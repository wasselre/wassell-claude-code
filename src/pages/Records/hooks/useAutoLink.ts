import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { normalizePhone } from '@/lib/phone';
import type { AppModel, ModelField } from '@/types';

interface UseAutoLinkArgs {
  model: AppModel | null | undefined;
  formData: Record<string, unknown>;
  /**
   * React useState dispatcher. Used in functional form so we don't clobber
   * unrelated edits the user makes during the 400ms search debounce.
   */
  setFormData: Dispatch<SetStateAction<Record<string, unknown>>>;
}

/**
 * Wires the `auto_link_lookup_field_id` primitive on a record-form page or
 * modal. For every field on the model that declares an auto-link target,
 * this hook watches the field's value and — after a 400ms debounce —
 * searches the lookup target's model for an exact match on
 * `auto_link_target_field_name`. On a single unambiguous match, the
 * matched record's id is written into the sibling lookup field.
 *
 * **Conflict avoidance.** We track which lookup ids we set ourselves in a
 * ref. If the user has manually picked a lookup value (i.e. the current
 * lookup value isn't empty AND isn't one we previously set), we don't
 * overwrite — the user's explicit pick wins. If we previously auto-set a
 * lookup to id A and the user is now typing a phone that matches id B,
 * we will replace A with B because A came from us.
 *
 * **Race avoidance.** A monotonically-increasing per-field token is
 * captured before the await; if the field's value changes again before
 * the search resolves, the stale result is ignored.
 *
 * **Errors.** Supabase failures are surfaced via the store's
 * `addToast('error')` — never silently swallowed (CLAUDE.md "Silent
 * Failures").
 */
export function useAutoLink({ model, formData, setFormData }: UseAutoLinkArgs): void {
  const addToast = useAppStore((s) => s.addToast);
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';

  // Ref-tracked: which lookup field ids did we auto-set, and to what value.
  // Used to decide whether re-running auto-link should overwrite.
  const lastSetByMe = useRef<Map<string, string>>(new Map());
  // Per-source-field token to detect stale debounced results.
  const tokenCounter = useRef<Map<string, number>>(new Map());

  // Flatten all native (non-mirrored-section) fields once per render.
  // Empty when the model isn't loaded yet — every check below short-circuits.
  const allFields = model
    ? model.schema.sections.filter((s) => !s.is_mirrored).flatMap((s) => s.fields)
    : [];

  // Index for O(1) lookup-by-id resolution inside the effect closure.
  const fieldsById = new Map<string, ModelField>(allFields.map((f) => [f.id, f]));

  // Build a stable JSON key over the source field values so a useEffect
  // can depend on it without re-firing on unrelated formData changes.
  const sourceValuesSig = JSON.stringify(
    allFields
      .filter((f) => f.auto_link_lookup_field_id)
      .map((f) => [f.id, formData[f.name] ?? null] as const),
  );

  useEffect(() => {
    if (!supabase || !model) return;
    const sb = supabase;
    const cleanups: Array<() => void> = [];

    for (const f of allFields) {
      if (!f.auto_link_lookup_field_id || !f.auto_link_target_field_name) continue;
      const lookupField = fieldsById.get(f.auto_link_lookup_field_id);
      if (!lookupField || lookupField.type !== 'lookup' || !lookupField.lookup_model_id) continue;

      const raw = formData[f.name];
      if (raw === undefined || raw === null || raw === '') continue;

      // Normalize input. 'phone' is the only normalizer in v1; future ones
      // (email_lower, whitespace_collapsed, …) plug in here.
      let needle: string | null = null;
      if (f.auto_link_normalize === 'phone') {
        needle = normalizePhone(String(raw));
      } else {
        needle = String(raw).trim() || null;
      }
      if (!needle) continue;

      // Skip if the user has manually chosen a different lookup value.
      const currentLookup = formData[lookupField.name];
      if (
        currentLookup !== undefined &&
        currentLookup !== null &&
        currentLookup !== '' &&
        lastSetByMe.current.get(lookupField.id) !== currentLookup
      ) {
        continue;
      }

      const myToken = (tokenCounter.current.get(f.id) ?? 0) + 1;
      tokenCounter.current.set(f.id, myToken);

      const targetModelId = lookupField.lookup_model_id;
      const targetField = f.auto_link_target_field_name;

      const handle = setTimeout(() => {
        void (async () => {
          try {
            // Phone normalizer collapses 0xx, 5xx, 966, +966 to one E.164.
            // Compare on the canonical form via `data->>field` after we
            // fetch — clients records are stored in their PhoneInput's
            // canonical "+966xxxxxxxxx" form already (see splitPhone /
            // joinPhone in src/lib/phone.ts).
            const { data, error } = await sb
              .from('unified_records')
              .select('id, data')
              .eq('model_id', targetModelId)
              .eq(`data->>${targetField}`, needle)
              .limit(2);
            // If our token was superseded, drop this stale result.
            if (tokenCounter.current.get(f.id) !== myToken) return;
            if (error) {
              addToast(
                isAr
                  ? `تعذر البحث عن السجل المرتبط: ${error.message}`
                  : `Auto-link search failed: ${error.message}`,
                'error',
              );
              return;
            }
            if (!data || data.length !== 1) return; // 0 or 2+ — do nothing
            const matched = data[0];
            if (!matched) return;
            // Use the functional updater so any unrelated edits made
            // during the debounce are preserved. The user-edit-safety
            // check is also done against `prev` (truly live) rather than
            // the closure-captured formData.
            setFormData((prev) => {
              const live = prev[lookupField.name];
              if (
                live !== undefined &&
                live !== null &&
                live !== '' &&
                lastSetByMe.current.get(lookupField.id) !== live
              ) {
                return prev;
              }
              lastSetByMe.current.set(lookupField.id, matched.id);
              return { ...prev, [lookupField.name]: matched.id };
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addToast(
              isAr
                ? `تعذر البحث عن السجل المرتبط: ${msg}`
                : `Auto-link search failed: ${msg}`,
              'error',
            );
          }
        })();
      }, 400);

      cleanups.push(() => clearTimeout(handle));
    }

    return () => {
      for (const c of cleanups) c();
    };
    // We intentionally key the effect off the source-values signature
    // rather than the entire formData object so unrelated edits don't
    // re-trigger network searches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceValuesSig, model?.id]);
}
