import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField } from '@/types';
import { formatRangeValue } from '@/pages/Records/components/RangeField';
import { PREF_FIELD_KINDS, asSetValue, asRangeValue } from '@/lib/clientPrefs/mergePrefs';

/**
 * Field labels + value formatting for the client preference fields, from the
 * LIVE clients schema in the store — shared by the chat's preference section
 * (PrefSuggestionsSection) and the call audit's (CallAuditSection) so both
 * name and format a field the same way.
 */
export function usePrefFieldFormat(): {
  isAr: boolean;
  fieldLabel: (slug: string) => string;
  formatValue: (slug: string, value: unknown) => string;
} {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);

  const fields = useMemo(() => {
    const m = models.find((x) => x.name === 'clients');
    const out = new Map<string, ModelField>();
    for (const sec of m?.schema.sections ?? []) for (const f of sec.fields ?? []) out.set(f.name, f);
    return out;
  }, [models]);

  const fieldLabel = useCallback((slug: string): string => {
    const f = fields.get(slug);
    return f ? (isAr ? f.label_ar : f.label_en) : slug;
  }, [fields, isAr]);

  const formatValue = useCallback((slug: string, value: unknown): string => {
    const f = fields.get(slug);
    if (PREF_FIELD_KINDS[slug] === 'set') {
      const opts = f?.options ?? [];
      return asSetValue(value)
        .map((v) => {
          const o = opts.find((x) => x.value === v);
          return o ? (isAr ? o.label_ar : o.label_en) : v;
        })
        .join(isAr ? '، ' : ', ');
    }
    const r = asRangeValue(value);
    if (!r) return '';
    if (f) return formatRangeValue(f, r, isAr);
    return [r.min, r.max].filter((n) => n !== undefined).join(' – ');
  }, [fields, isAr]);

  return { isAr, fieldLabel, formatValue };
}
