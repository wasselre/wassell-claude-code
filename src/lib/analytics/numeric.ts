/**
 * Numeric coercion — the TypeScript twin of the SQL `try_numeric(text)` used by
 * `recalc_project_rollups_data`. Parses a stored value to a finite number, or
 * `null` on failure.
 *
 * Kept deliberately STRICT to match Postgres `text::numeric`: no comma
 * stripping, no locale parsing. This is what keeps the in-browser engine and
 * the SQL rollups agreeing to the digit — see the rollup-parity test. Booleans
 * return null here; callers that mean to count checkboxes coerce true/false → 1/0
 * explicitly.
 */
export function toNumeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
