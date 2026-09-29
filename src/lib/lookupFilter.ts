import type { ModelField } from '@/types';

type Candidate = { data: Record<string, unknown> };

/** The picker predicate for a lookup field's `lookup_filter`, or undefined when
 *  the field has none. A multi-value target field matches when it contains the
 *  value. */
export function lookupFilterPredicate(field: Pick<ModelField, 'lookup_filter'>): ((rec: Candidate) => boolean) | undefined {
  const f = field.lookup_filter;
  if (!f?.field) return undefined;
  return (rec) => {
    const v = rec.data?.[f.field];
    return Array.isArray(v) ? v.includes(f.value) : v === f.value;
  };
}

/** Data a record created inline from this picker must carry, so it lands in
 *  the filtered set (a company created from the marketers picker IS a marketer). */
export function lookupFilterDefaults(field: Pick<ModelField, 'lookup_filter'>): Record<string, unknown> | undefined {
  const f = field.lookup_filter;
  return f?.field ? { [f.field]: f.value } : undefined;
}
