/**
 * Bilingual W6-M: on-demand translation for Marketing-OS content FIELD VALUES.
 *
 * Marketing content (mkt_content_items titles, hooks, captions, …) is authored
 * in Arabic and is NOT part of the durable record-translation pipeline (it lives
 * in mkt_* tables, and the internal team works in Arabic — chrome stays Arabic
 * by design). But when a viewer switches the workspace to English, the content
 * VALUES they read should be English. This wraps the legacy on-demand overlay
 * (`resolveDisplayText` → value_translations cache → /api/value-translate) so a
 * value translates the first time it's shown and is instant thereafter.
 *
 * Arabic mode is a pass-through (the source IS the display); English mode
 * resolves the Arabic source to its translation, showing the source until it
 * lands (honest, no flash of nothing). Editable inputs must NOT use this — a
 * user edits the source, never a translation.
 */
import { useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { resolveDisplayText, useValueTranslationVersion } from '@/lib/valueTranslation/runtime';

export function useMosText(): (value: string | null | undefined, fieldHint?: string) => string {
  const isAr = useAppStore((s) => s.language) === 'ar';
  // Re-render this component when a queued translation arrives.
  useValueTranslationVersion();
  return useCallback(
    (value, fieldHint) => {
      const text = typeof value === 'string' ? value : value == null ? '' : String(value);
      if (isAr || text.trim() === '') return text;
      return resolveDisplayText(text, 'en', { field_hint: fieldHint });
    },
    [isAr],
  );
}
