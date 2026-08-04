/**
 * useBilingualLabelAutofill — the small forms outside the Builder (Marketing OS
 * settings, inline "new measure type", etc.) hold a plain Arabic + English label
 * pair in local `useState`. This hook wires that pair to the same live
 * /api/translate flow the Builder uses, so typing one side auto-fills the other
 * exactly like the rest of the app.
 *
 * Direction is decided by whichever side the user is editing: type Arabic and
 * the English fills, type English and the Arabic fills. A side the user has
 * actually typed is "touched" and never auto-overwritten; an untouched side is
 * re-derived from the LATEST translation on every result, so a mid-word partial
 * ("ت" → "T…") gets replaced by the full-phrase translation instead of sticking.
 *
 * Wiring a form:
 *   const fill = useBilingualLabelAutofill({ ar, en, setAr, setEn, enabled });
 *   <input value={ar} onChange={(e)=>fill.onArChange(e.target.value)} onBlur={fill.onBlur} />
 *   <input value={en} onChange={(e)=>fill.onEnChange(e.target.value)} onBlur={fill.onBlur} />
 *
 * When the edited entity changes (a different row loaded, a fresh form opened),
 * call `fill.reset(nextAr, nextEn)` so an existing pair isn't treated as
 * translatable and a blank form starts clean.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedTranslation } from '@/hooks/useDebouncedTranslation';
import type { TranslatedLabel, TranslationKind } from '@/lib/translateLabel';

export interface BilingualLabelAutofill {
  /** onChange for the Arabic input — marks it touched + fires the fill. */
  onArChange: (value: string) => void;
  /** onChange for the English input — marks it touched + fires the fill. */
  onEnChange: (value: string) => void;
  /** onBlur for either input — force-resolves so a fast tab-away still fills. */
  onBlur: () => void;
  /** True while a translation is in flight (drive a spinner / "Translating…"). */
  pending: boolean;
  /** Re-seed touched state when a new draft loads or a form (re)opens. */
  reset: (nextAr: string, nextEn: string) => void;
}

export function useBilingualLabelAutofill({
  ar,
  en,
  setAr,
  setEn,
  enabled = true,
  kind = 'generic',
}: {
  ar: string;
  en: string;
  setAr: (value: string) => void;
  setEn: (value: string) => void;
  /** Turn the whole flow off (e.g. the form is closed). Default: true. */
  enabled?: boolean;
  kind?: TranslationKind;
}): BilingualLabelAutofill {
  // Which side is being edited — drives the translation SOURCE. null until the
  // user touches a field, so merely loading an existing pair never translates.
  const [editing, setEditing] = useState<'ar' | 'en' | null>(null);
  const [arTouched, setArTouched] = useState<boolean>(() => !!ar.trim());
  const [enTouched, setEnTouched] = useState<boolean>(() => !!en.trim());

  const source = editing === 'ar' ? ar : editing === 'en' ? en : '';
  // Only fire when the OPPOSITE side is still auto-fillable (not user-typed).
  const canFill =
    (editing === 'ar' && !enTouched) || (editing === 'en' && !arTouched);

  const translation = useDebouncedTranslation(source, {
    kind,
    enabled: enabled && !!source.trim() && canFill,
  });

  // Read the freshest setters/flags from the result effect so it never writes
  // through a stale closure (the parent passes new setters each render).
  const setArRef = useRef(setAr);
  const setEnRef = useRef(setEn);
  const editingRef = useRef(editing);
  const arTouchedRef = useRef(arTouched);
  const enTouchedRef = useRef(enTouched);
  setArRef.current = setAr;
  setEnRef.current = setEn;
  editingRef.current = editing;
  arTouchedRef.current = arTouched;
  enTouchedRef.current = enTouched;

  // Fill the untouched opposite side from a resolved translation. Overwrites
  // (not just fill-when-empty) so a full-phrase result replaces an earlier
  // partial; gated by the touched flags so a typed side is never clobbered.
  const apply = useCallback((out: TranslatedLabel): void => {
    if (editingRef.current === 'ar' && !enTouchedRef.current && out.label_en) {
      setEnRef.current(out.label_en);
    }
    if (editingRef.current === 'en' && !arTouchedRef.current && out.label_ar) {
      setArRef.current(out.label_ar);
    }
  }, []);

  useEffect(() => {
    if (translation.result) apply(translation.result);
    // Apply once per new result; depending on apply/result value would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translation.result]);

  const onArChange = useCallback((value: string): void => {
    setEditing('ar');
    setArTouched(true);
    setAr(value);
  }, [setAr]);

  const onEnChange = useCallback((value: string): void => {
    setEditing('en');
    setEnTouched(true);
    setEn(value);
  }, [setEn]);

  // Safety net for fast typers who blur before the debounce settles.
  const onBlur = useCallback((): void => {
    if (!source.trim() || !canFill) return;
    if (translation.result) { apply(translation.result); return; }
    void translation.translateNow().then(apply).catch(() => {
      // Failure is already surfaced as a toast by the hook; keep the typed
      // input so the user can retry without losing it.
    });
  }, [source, canFill, translation, apply]);

  const reset = useCallback((nextAr: string, nextEn: string): void => {
    setEditing(null);
    setArTouched(!!nextAr.trim());
    setEnTouched(!!nextEn.trim());
  }, []);

  return {
    onArChange,
    onEnChange,
    onBlur,
    pending: translation.status === 'pending',
    reset,
  };
}
