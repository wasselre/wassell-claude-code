// Computed-field rollups for the our_projects model.
//
// An `our_projects` record represents one of "our" projects, which is a
// 1:1 sidecar on an `all_projects` master record via the lookup field
// with slug `project` (an admin-configured field whose stored value is
// the linked all_projects record id). Each unit row in the `units` model
// in turn carries a `project_id` lookup pointing at an all_projects row.
// So the unit-to-our_project path is:
//
//   our_projects.data.project   →   all_projects.id   ←   units.data.project_id
//
// This module finds the units that share an all_projects id with a given
// our_projects record and computes the eleven aggregate values defined by
// OurProjectsComputedKind (see src/types/index.ts). Computation is pure
// and runs live at read time — never stored on the record, never written
// to Supabase. The render path injects the result into a copy of the
// record's data so the existing field renderers display it with no
// special casing.

import type { AppModel, AppRecord, ModelField, OurProjectsComputedKind } from '@/types';

// ── Status matchers ────────────────────────────────────────────────────
//
// `unit_status` is a dropdown whose option `value` is whatever the admin
// configured. The seed ships with English keys ('available' / 'reserved'
// / 'sold'); a renamed deployment might store the Arabic label as the
// value instead. We accept any reasonable variant so the rollups don't
// silently miscount when the project's options drift. Match is
// case-insensitive substring against a normalized lowercase value.

function matchesStatus(value: unknown, needles: readonly string[]): boolean {
  if (value == null) return false;
  const s = String(value).toLowerCase().trim();
  if (!s) return false;
  return needles.some((n) => s === n || s.includes(n));
}

const AVAILABLE_KEYS = ['available', 'متاح', 'متاحة'] as const;
const RESERVED_KEYS = ['reserved', 'محجوز', 'محجوزة'] as const;
const SOLD_KEYS = ['sold', 'مباع', 'مباعة', 'مبيع'] as const;

function isAvailable(unit: AppRecord): boolean {
  return matchesStatus(unit.data?.unit_status, AVAILABLE_KEYS);
}
function isReserved(unit: AppRecord): boolean {
  return matchesStatus(unit.data?.unit_status, RESERVED_KEYS);
}
function isSold(unit: AppRecord): boolean {
  return matchesStatus(unit.data?.unit_status, SOLD_KEYS);
}

// ── Numeric coercion ───────────────────────────────────────────────────
//
// Field values come back as either numbers (from a real `number` /
// `currency` input) or strings (when the admin pasted into a `text`
// field, or when the value round-tripped through JSON). Coerce defensively
// and ignore non-finite / negative-zero / NaN garbage.

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function collectNumbers(units: AppRecord[], slug: string): number[] {
  const out: number[] = [];
  for (const u of units) {
    const n = toFiniteNumber(u.data?.[slug]);
    if (n != null) out.push(n);
  }
  return out;
}

function rangeOf(nums: number[]): { min: number; max: number } | null {
  if (nums.length === 0) return null;
  let min = nums[0]!;
  let max = nums[0]!;
  for (let i = 1; i < nums.length; i++) {
    const v = nums[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// Per-unit price/m². Skips units missing either price or a positive
// unit_area — a 0 m² unit would otherwise produce Infinity and poison
// the min/max/avg. Returns an empty array when no unit qualifies.
function pricePerMeterValues(units: AppRecord[]): number[] {
  const out: number[] = [];
  for (const u of units) {
    const price = toFiniteNumber(u.data?.total_price);
    const area = toFiniteNumber(u.data?.unit_area);
    if (price == null || area == null || area <= 0) continue;
    out.push(price / area);
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Find the all_projects record id this our_projects record is linked to.
 * The lookup field's slug is hardcoded as `project` per the admin's
 * configuration in the live model. If the slug ever changes, this is the
 * only place to update.
 */
function linkedAllProjectId(record: AppRecord): string | null {
  const v = record.data?.project;
  if (typeof v === 'string' && v) return v;
  // Lookup fields with `is_multi` store an array — for the 1:1 sidecar
  // semantics here, take the first id if anyone has misconfigured it.
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0]!;
  return null;
}

/**
 * Filter the full units list to just those linked to the same
 * all_projects record as `ourProjectRecord`. Returns [] when the
 * our_projects record has no linked project or no units match.
 */
export function unitsForOurProject(
  ourProjectRecord: AppRecord,
  allUnits: readonly AppRecord[],
): AppRecord[] {
  const targetId = linkedAllProjectId(ourProjectRecord);
  if (!targetId) return [];
  return allUnits.filter((u) => {
    const linked = u.data?.project_id;
    if (typeof linked === 'string') return linked === targetId;
    if (Array.isArray(linked)) return linked.includes(targetId);
    return false;
  });
}

/**
 * Compute one rollup kind against the given units list. Returns the
 * value in the shape the matching field type expects:
 *   - count kinds      → number (always finite, 0 when no units)
 *   - range kinds      → { min, max } | null (null when no source data)
 *   - per-meter kinds  → number | null (null when no qualifying units)
 *
 * Exported so unit tests can pin behavior per kind.
 */
export function computeRollupKind(
  kind: OurProjectsComputedKind,
  units: readonly AppRecord[],
): unknown {
  const arr = units as AppRecord[];
  switch (kind) {
    case 'units_count':
      return arr.length;
    case 'units_available_count':
      return arr.filter(isAvailable).length;
    case 'units_reserved_count':
      return arr.filter(isReserved).length;
    case 'units_sold_count':
      return arr.filter(isSold).length;
    case 'price_range':
      return rangeOf(collectNumbers(arr, 'total_price'));
    case 'area_range':
      return rangeOf(collectNumbers(arr, 'unit_area'));
    case 'bedroom_range':
      return rangeOf(collectNumbers(arr, 'bedrooms'));
    case 'bathroom_range':
      return rangeOf(collectNumbers(arr, 'bathrooms'));
    case 'min_price_per_meter': {
      const ps = pricePerMeterValues(arr);
      if (ps.length === 0) return null;
      return Math.min(...ps);
    }
    case 'max_price_per_meter': {
      const ps = pricePerMeterValues(arr);
      if (ps.length === 0) return null;
      return Math.max(...ps);
    }
    case 'avg_price_per_meter': {
      const ps = pricePerMeterValues(arr);
      if (ps.length === 0) return null;
      const sum = ps.reduce((a, b) => a + b, 0);
      return sum / ps.length;
    }
  }
}

/**
 * Walk the our_projects model's schema, find every field flagged
 * `is_computed` with a known `computed_kind`, compute its value against
 * the matching units, and return a Record<fieldSlug, value> partial
 * patch. Callers merge this over the record's `data` before rendering.
 *
 * Pure: never mutates the record, the model, or the units list.
 */
export function computeOurProjectsRollups(
  ourProjectRecord: AppRecord,
  ourProjectsModel: AppModel,
  allUnits: readonly AppRecord[],
): Record<string, unknown> {
  const matchingUnits = unitsForOurProject(ourProjectRecord, allUnits);
  const patch: Record<string, unknown> = {};
  for (const section of ourProjectsModel.schema.sections) {
    for (const f of section.fields) {
      if (!f.is_computed || !f.computed_kind) continue;
      patch[f.name] = computeRollupKind(f.computed_kind, matchingUnits);
    }
  }
  return patch;
}

/**
 * Convenience: returns a NEW record object whose `data` already has the
 * rollup values merged in. Use this at every render-time consumer that
 * surfaces an our_projects record's data to the UI (RecordFormPage,
 * generic list / table / card views, mirror resolvers). Stored data
 * always wins over computed values for non-computed fields — only the
 * fields flagged `is_computed` get overwritten.
 */
export function applyOurProjectsRollups(
  ourProjectRecord: AppRecord,
  ourProjectsModel: AppModel,
  allUnits: readonly AppRecord[],
): AppRecord {
  const patch = computeOurProjectsRollups(ourProjectRecord, ourProjectsModel, allUnits);
  if (Object.keys(patch).length === 0) return ourProjectRecord;
  return {
    ...ourProjectRecord,
    data: { ...ourProjectRecord.data, ...patch },
  };
}

/**
 * Helper used by the field-permission resolver / form save path:
 * returns true when the field is one of our hardcoded rollups and so
 * must never be written back to the record by user edits.
 */
export function isOurProjectsRollupField(field: ModelField): boolean {
  return !!field.is_computed && !!field.computed_kind;
}
