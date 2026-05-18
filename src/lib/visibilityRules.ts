import type { VisibleIfClause, VisibleIfRule } from '../types';

type RecordData = Record<string, unknown>;

const isEmptyValue = (v: unknown): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

export function evaluateVisibleIfClause(clause: VisibleIfClause, data: RecordData): boolean {
  const fieldValue = data[clause.field_name];
  switch (clause.operator) {
    case 'is_set':
      return !isEmptyValue(fieldValue);
    case 'is_not_set':
      return isEmptyValue(fieldValue);
    case 'equals':
      return fieldValue === clause.value;
    case 'not_equals':
      return fieldValue !== clause.value;
    case 'in':
      return Array.isArray(clause.value) && clause.value.includes(fieldValue as string);
    case 'not_in':
      return !Array.isArray(clause.value) || !clause.value.includes(fieldValue as string);
    case 'contains':
      return asArray(fieldValue).includes(clause.value as string);
    case 'not_contains':
      return !asArray(fieldValue).includes(clause.value as string);
    default:
      return true;
  }
}

export function evaluateVisibleIf(rule: VisibleIfRule | undefined, data: RecordData): boolean {
  if (!rule || !rule.all || rule.all.length === 0) return true;
  return rule.all.every((clause) => evaluateVisibleIfClause(clause, data));
}
