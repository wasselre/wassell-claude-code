// Qualification working-draft reducer — the state layer behind live-call preference
// capture. PURE: no React, no store, no I/O, no audio. Everything is a synchronous
// (state, event) → state transition, so it is unit-tested directly by feeding
// synthetic extraction events (no microphone needed).
//
// THE ONE INVARIANT
//   AI may update the EPHEMERAL working draft; it may NEVER persist client data.
//   This module only produces the draft + provenance; persistence happens elsewhere
//   (PreferenceSummary.save today, the Phase 6 end-of-call confirm later).
//
// TWO SETTERS decide provenance — never confused, because provenance depends on
// WHICH function ran:
//   • applyRepEdit(...)  — the HUMAN. Stamps `rep_edited` and LOCKS the field.
//   • applyAiEvidence(...) — the AI. Runs the auto-apply decision table below.
//
// EXTENSIBILITY (per product decision, 2026-08-08): multi-value fields union/add by
// default in v1, but every AI value carries an OPERATION (`add` | `set` | `remove` |
// `replace`). The extractor only emits add/set today; when a later phase interprets
// explicit corrections ("villa or floor" → "actually villa only") it emits `set`/
// `replace`/`remove` and this reducer already applies them — no state redesign.

import { normalizeForSearch } from '@/lib/recordSearch';

// ── config ───────────────────────────────────────────────────────────────────

/** Confidence at/above which AI evidence may auto-enter the draft. Tunable against
 *  real extraction data — start conservative. */
export const HIGH_CONFIDENCE_THRESHOLD = 80;

/** How a field merges new evidence. Excludes `preferred_direction` on purpose
 *  (extracted but not applied in this phase — no editor/finder support yet). */
export type FieldKind = 'multi' | 'range' | 'scalar' | 'location_items';

export const QUALIFICATION_FIELD_KINDS: Record<string, FieldKind> = {
  preferred_unit_type: 'multi',
  preferred_amenities: 'multi',
  purchase_objective: 'multi',
  budget: 'range',
  preferred_area: 'range',
  preferred_bedrooms: 'range',
  location_items: 'location_items',
};

/** Operation an AI value applies. v1 emits add/set; remove/replace are reserved for
 *  explicit-correction evidence and already work here. */
export type FieldOp = 'add' | 'set' | 'remove' | 'replace';

// ── state ────────────────────────────────────────────────────────────────────

export type FieldProvenance = 'saved' | 'ai_filled' | 'ai_changed' | 'rep_edited';

export interface FieldMeta {
  provenance: FieldProvenance;
  /** True for `ai_changed` — a value that differs from what was saved, so it must be
   *  reviewed at end-of-call before it persists. */
  needsReview: boolean;
  aiConfidence?: number;
  aiQuote?: string | null;
}

export type ExceptionKind = 'conflict_rep_edit' | 'low_confidence' | 'district_ambiguous';

export interface QualificationException {
  id: string;
  slug: string;
  kind: ExceptionKind;
  /** The AI value that did NOT enter the draft (a set, a range, or a district name). */
  value: unknown;
  quote: string | null;
  confidence: number | null;
  at: number;
}

export interface QualificationState {
  /** The value source of truth (== the workspace prefDraft). Only this ever persists. */
  draft: Record<string, unknown>;
  /** Per-slug provenance. Absent ⇒ 'saved'. */
  meta: Record<string, FieldMeta>;
  /** AI evidence that was NOT applied — awaiting the rep's attention. Never in the draft. */
  exceptions: QualificationException[];
}

// ── evidence ─────────────────────────────────────────────────────────────────

export interface AiFieldEvidence {
  slug: string;
  value: unknown;
  op?: FieldOp;
  confidence: number;
  quote?: string | null;
}

/** SPA-side mirror of the extractor output (api/_lib/prefExtract ExtractionOutput). */
export interface ExtractionSuggestion { value: unknown; quote?: string | null; confidence: number }
export interface ExtractionInput {
  suggestions: Record<string, ExtractionSuggestion>;
  districts?: string[];
}

// ── value helpers ────────────────────────────────────────────────────────────

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('min' in o || 'max' in o) return o.min == null && o.max == null;
    return Object.keys(o).length === 0;
  }
  return false;
}

/** Order-insensitive, key-stable stringify so array unions and range key order don't
 *  produce spurious "changes". */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).sort().join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function valueEqual(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return stableStringify(a) === stableStringify(b);
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function defaultOp(kind: FieldKind): FieldOp {
  return kind === 'range' || kind === 'scalar' ? 'set' : 'add';
}

/** Apply one operation to the current value. add/remove are meaningful for multi +
 *  location_items; range/scalar always take the incoming value (set/replace). */
export function applyOp(current: unknown, incoming: unknown, op: FieldOp, kind: FieldKind): unknown {
  if (op === 'set' || op === 'replace') return incoming;

  if (kind === 'multi') {
    const cur = asStringArray(current);
    const inc = asStringArray(incoming);
    if (op === 'remove') return cur.filter((x) => !inc.includes(x));
    return Array.from(new Set([...cur, ...inc])); // add (union)
  }

  if (kind === 'location_items') {
    const cur = Array.isArray(current) ? (current as Record<string, unknown>[]) : [];
    const inc = Array.isArray(incoming) ? (incoming as Record<string, unknown>[]) : [];
    const idOf = (r: Record<string, unknown>) => (r.kind === 'district' ? `d:${String(r.district_id ?? '')}` : stableStringify(r));
    if (op === 'remove') {
      const rm = new Set(inc.map(idOf));
      return cur.filter((r) => !rm.has(idOf(r)));
    }
    const seen = new Set(cur.map(idOf));
    const merged = [...cur];
    for (const r of inc) { const id = idOf(r); if (!seen.has(id)) { seen.add(id); merged.push(r); } }
    return merged; // add (union by district id, keeps other rules)
  }

  return incoming; // range/scalar: add/remove not meaningful → treat as set
}

// ── exceptions ───────────────────────────────────────────────────────────────

function exceptionId(slug: string, kind: ExceptionKind, value: unknown): string {
  // District exceptions coexist one-per-name; field exceptions are one-per-slug+kind.
  return kind === 'district_ambiguous'
    ? `${slug}:${kind}:${normalizeForSearch(String(value ?? ''))}`
    : `${slug}:${kind}`;
}

function upsertException(list: QualificationException[], ex: Omit<QualificationException, 'id'>): QualificationException[] {
  const id = exceptionId(ex.slug, ex.kind, ex.value);
  return [...list.filter((e) => e.id !== id), { id, ...ex }];
}

// ── reducer ──────────────────────────────────────────────────────────────────

export function seedQualification(savedData: Record<string, unknown> | null | undefined): QualificationState {
  return { draft: { ...(savedData ?? {}) }, meta: {}, exceptions: [] };
}

/** The HUMAN setter: stamps rep_edited + LOCKS the field, and clears any pending
 *  exception for it (the rep just decided). */
export function applyRepEdit(state: QualificationState, slug: string, value: unknown): QualificationState {
  return {
    draft: { ...state.draft, [slug]: value },
    meta: { ...state.meta, [slug]: { provenance: 'rep_edited', needsReview: false } },
    exceptions: state.exceptions.filter((e) => e.slug !== slug),
  };
}

export interface ApplyAiCtx {
  savedData: Record<string, unknown> | null;
  fieldKinds?: Record<string, FieldKind>;
  threshold?: number;
  now?: number;
}

/** The AI setter (op-based, extensible). Runs the auto-apply decision table. */
export function applyAiEvidence(
  state: QualificationState,
  evidence: AiFieldEvidence[],
  ctx: ApplyAiCtx,
): QualificationState {
  const kinds = ctx.fieldKinds ?? QUALIFICATION_FIELD_KINDS;
  const threshold = ctx.threshold ?? HIGH_CONFIDENCE_THRESHOLD;
  const now = ctx.now ?? Date.now();

  let { draft, meta, exceptions } = state;
  let changed = false;

  for (const ev of evidence) {
    const kind = kinds[ev.slug];
    if (!kind) continue; // unmanaged field (e.g. preferred_direction) — never applied

    const current = draft[ev.slug];
    const next = applyOp(current, ev.value, ev.op ?? defaultOp(kind), kind);
    const differs = !valueEqual(next, current);

    // 1. Locked by a rep edit — AI can only flag a conflict, never apply.
    if (meta[ev.slug]?.provenance === 'rep_edited') {
      if (differs) {
        exceptions = upsertException(exceptions, { slug: ev.slug, kind: 'conflict_rep_edit', value: ev.value, quote: ev.quote ?? null, confidence: ev.confidence ?? null, at: now });
        changed = true;
      }
      continue;
    }

    // 2. Low confidence — hold as a suggestion, never touch the draft.
    if (ev.confidence < threshold) {
      if (differs) {
        exceptions = upsertException(exceptions, { slug: ev.slug, kind: 'low_confidence', value: ev.value, quote: ev.quote ?? null, confidence: ev.confidence, at: now });
        changed = true;
      }
      continue;
    }

    // 3. No-op — AI matches what's already there.
    if (!differs) continue;

    // 4. Apply. Green when the SAVED baseline was empty; amber (needs review) when it
    //    changes a value that was saved. Sticky across refinements of AI's own value.
    const existing = meta[ev.slug]?.provenance;
    const provenance: FieldProvenance =
      existing === 'ai_filled' || existing === 'ai_changed'
        ? existing
        : isEmptyValue(ctx.savedData?.[ev.slug]) ? 'ai_filled' : 'ai_changed';

    draft = { ...draft, [ev.slug]: next };
    meta = { ...meta, [ev.slug]: { provenance, needsReview: provenance === 'ai_changed', aiConfidence: ev.confidence, aiQuote: ev.quote ?? null } };
    // This field is now applied — drop any stale low-confidence/conflict entry for it
    // (district_ambiguous entries are per-name and kept).
    exceptions = exceptions.filter((e) => e.slug !== ev.slug || e.kind === 'district_ambiguous');
    changed = true;
  }

  return changed ? { draft, meta, exceptions } : state;
}

// ── district resolution (pure; the hook injects the index) ────────────────────

export interface DistrictIndexEntry { id: string; label: string; cityId: string | null }
export type DistrictIndex = Record<string, DistrictIndexEntry[]>;

/** Decision 3: resolve only when unambiguous globally, or unambiguous within the
 *  client's selected city. Everything else is 'ambiguous'/'not_found' (→ exception). */
export function resolveDistrictInIndex(
  name: string,
  index: DistrictIndex,
  cityScope?: string | null,
): DistrictIndexEntry | 'ambiguous' | 'not_found' {
  const matches = index[normalizeForSearch(name)] ?? [];
  if (matches.length === 0) return 'not_found';
  if (matches.length === 1) return matches[0]!;
  if (cityScope) {
    const inCity = matches.filter((m) => m.cityId === cityScope);
    if (inCity.length === 1) return inCity[0]!;
  }
  return 'ambiguous';
}

// ── adapter: extractor output → evidence ──────────────────────────────────────

export interface ExtractionAdapterCtx {
  excludeSlugs?: string[];
  resolveDistrict?: (name: string) => DistrictIndexEntry | 'ambiguous' | 'not_found';
  fieldKinds?: Record<string, FieldKind>;
}

/** Map the extractor's ExtractionInput into op-based evidence + district results.
 *  `preferred_direction` (and any excludeSlugs) is dropped here. */
export function extractionToEvidence(extraction: ExtractionInput, ctx: ExtractionAdapterCtx): {
  evidence: AiFieldEvidence[];
  districtNames: { name: string; result: 'ambiguous' | 'not_found' }[];
} {
  const kinds = ctx.fieldKinds ?? QUALIFICATION_FIELD_KINDS;
  const exclude = new Set(ctx.excludeSlugs ?? ['preferred_direction']);
  const evidence: AiFieldEvidence[] = [];

  for (const [slug, sug] of Object.entries(extraction.suggestions ?? {})) {
    if (exclude.has(slug) || !(slug in kinds)) continue;
    evidence.push({ slug, value: sug.value, confidence: sug.confidence, quote: sug.quote ?? null });
  }

  const districtNames: { name: string; result: 'ambiguous' | 'not_found' }[] = [];
  const rules: Record<string, unknown>[] = [];
  for (const name of extraction.districts ?? []) {
    const r = ctx.resolveDistrict?.(name) ?? 'not_found';
    if (r === 'ambiguous' || r === 'not_found') { districtNames.push({ name, result: r }); continue; }
    rules.push({ kind: 'district', district_id: r.id, district_label: r.label, polarity: 'include' });
  }
  if (rules.length) {
    // Resolved districts are high-confidence by construction (resolution is the gate).
    evidence.push({ slug: 'location_items', value: rules, op: 'add', confidence: 100, quote: null });
  }

  return { evidence, districtNames };
}

/** Convenience: adapter + reducer + district exceptions, in one step. */
export function applyExtraction(
  state: QualificationState,
  extraction: ExtractionInput,
  ctx: ApplyAiCtx & ExtractionAdapterCtx,
): QualificationState {
  const { evidence, districtNames } = extractionToEvidence(extraction, ctx);
  let next = applyAiEvidence(state, evidence, ctx);
  if (districtNames.length) {
    let exceptions = next.exceptions;
    const now = ctx.now ?? Date.now();
    for (const d of districtNames) {
      exceptions = upsertException(exceptions, { slug: 'location_items', kind: 'district_ambiguous', value: d.name, quote: null, confidence: null, at: now });
    }
    next = { ...next, exceptions };
  }
  return next;
}

// ── end-of-call diff (feeds the Phase 6 reconciliation screen) ────────────────

export interface DiffEntry {
  slug: string;
  savedValue: unknown;
  draftValue: unknown;
  provenance: FieldProvenance;
  needsReview: boolean;
  aiQuote: string | null;
}

/** Every managed field where the draft differs from what was saved, annotated with
 *  why. Phase 6 groups these: ai_filled (green, pre-checked), ai_changed (amber,
 *  required), rep_edited (the rep's own). Exceptions render separately from state. */
export function computeDiff(
  state: QualificationState,
  savedData: Record<string, unknown> | null,
  slugs: string[] = Object.keys(QUALIFICATION_FIELD_KINDS),
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const slug of slugs) {
    const savedValue = savedData?.[slug];
    const draftValue = state.draft[slug];
    if (valueEqual(draftValue, savedValue)) continue;
    const m = state.meta[slug];
    out.push({
      slug, savedValue, draftValue,
      provenance: m?.provenance ?? 'rep_edited',
      needsReview: m?.needsReview ?? false,
      aiQuote: m?.aiQuote ?? null,
    });
  }
  return out;
}
