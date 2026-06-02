import type { AppRecord, ModelField } from '@/types';
import type { ColumnStandardization, StandardizableType, ValueDecision } from './types';
import type { StandardizeCandidate, StandardizeDecision } from './client';

/** dropdown/multiselect candidates = the field's options. */
export function optionCandidates(field: ModelField): StandardizeCandidate[] {
  return (field.options ?? []).map((o) => ({ value: o.value, label_ar: o.label_ar, label_en: o.label_en }));
}

/** lookup candidates = existing target records, keyed by display field. */
export function lookupCandidates(
  field: ModelField,
  allRecords: Record<string, AppRecord[]>,
): StandardizeCandidate[] {
  const modelId = field.lookup_model_id;
  const disp = field.lookup_display_field;
  if (!modelId || !disp) return [];
  const out: StandardizeCandidate[] = [];
  for (const r of allRecords[modelId] ?? []) {
    const display = String(r.data[disp] ?? '').trim();
    if (display) out.push({ id: r.id, display });
  }
  return out;
}

const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase();

function findOption(field: ModelField, canonical: string) {
  const c = norm(canonical);
  return (field.options ?? []).find(
    (o) => norm(o.label_en) === c || norm(o.label_ar) === c || norm(o.value) === c,
  );
}

function toProposal(
  field: ModelField,
  fieldType: StandardizableType,
  raw: string,
  ai: StandardizeDecision | undefined,
  isAr: boolean,
): ValueDecision['proposal'] {
  const confidence = ai?.confidence ?? 0;
  const reason = ai?.reason;
  if (!ai || ai.kind === 'unmatched') return { kind: 'unmatched', label: '', confidence, reason };

  if (ai.kind === 'new') {
    return fieldType === 'lookup'
      ? { kind: 'create_record', label: ai.canonical || raw, confidence, reason }
      : { kind: 'create_option', label: ai.canonical || raw, confidence, reason };
  }

  // ai.kind === 'match'
  if (fieldType === 'lookup') {
    if (ai.candidateId) {
      return { kind: 'lookup_record', recordId: ai.candidateId, label: ai.canonical || raw, confidence, reason };
    }
    return { kind: 'unmatched', label: '', confidence, reason };
  }
  const opt = findOption(field, ai.canonical);
  if (opt) {
    return { kind: 'option', optionValue: opt.value, label: isAr ? opt.label_ar : opt.label_en, confidence, reason };
  }
  return { kind: 'unmatched', label: '', confidence, reason };
}

export function proposalToDecision(p: ValueDecision['proposal']): ValueDecision['decision'] {
  switch (p.kind) {
    case 'option':
      return { kind: 'option', optionValue: p.optionValue };
    case 'lookup_record':
      return { kind: 'lookup_record', recordId: p.recordId };
    case 'create_option':
      return { kind: 'create_option', newLabel: p.label };
    case 'create_record':
      return { kind: 'create_record', newLabel: p.label };
    default:
      return { kind: 'unmatched' };
  }
}

/** Build a column's standardization plan from the AI decisions: each distinct
 * value gets a proposal (the AI suggestion) and a default decision (= proposal,
 * which the user can then accept or override). */
export function buildColumnStandardization(
  colIndex: number,
  field: ModelField,
  fieldType: StandardizableType,
  distinct: { raw: string; count: number }[],
  aiDecisions: StandardizeDecision[],
  isAr: boolean,
): ColumnStandardization {
  const byRaw = new Map(aiDecisions.map((d) => [d.rawValue, d]));
  const values: ValueDecision[] = distinct.map(({ raw, count }) => {
    const proposal = toProposal(field, fieldType, raw, byRaw.get(raw), isAr);
    return { raw, count, proposal, decision: proposalToDecision(proposal) };
  });
  return { colIndex, fieldName: field.name, fieldType, values };
}
