/**
 * Is this client's saved preference profile complete enough to BE a search
 * request?
 *
 * An unanswered request is not free text: it IS the client's saved preferences
 * (unit type, requested districts, budget, …). The office message, the office
 * matching and the unmet-demand summary all read those fields, so a request
 * opened on an empty profile reaches no office and says nothing. Every way of
 * opening a request checks this first:
 *   - the request form (LogUnansweredRequestModal),
 *   - the follow-up outcome «طلب غير مجاب» (validateFollowUpCompletion, which
 *     the Workspace, the chat modals AND the AI outcome auto-apply all call).
 *
 * The minimum (operator, 2026-10-05):
 *   - at least one unit type,
 *   - at least one INCLUDED district — offices are matched on the district ids
 *     in `location_items` (office_outreach_candidates), nothing else,
 *   - at least ONE of: a budget, a bedroom count, or a size (min or max of any).
 *
 * The WhatsApp sales agent is told the same gaps (savedProfile.ts →
 * requestChecklistLine) so it asks the customer for exactly what is missing
 * before a request can open.
 *
 * Pure and dependency-free: imported by the SPA and by server code (`api/`).
 */

export type RequestGap = 'unit_type' | 'districts' | 'specs';

export const REQUEST_GAP_LABELS: Record<RequestGap, { ar: string; en: string }> = {
  unit_type: { ar: 'نوع الوحدة', en: 'Unit type' },
  districts: { ar: 'الأحياء المطلوبة', en: 'Requested districts' },
  specs: { ar: 'الميزانية أو عدد الغرف أو المساحة', en: 'Budget, bedrooms or size' },
};

const positive = (v: unknown): boolean => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0;
};

/** A range value ({min,max}) with a positive min or max. */
const hasRange = (v: unknown): boolean => {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return positive(r.min) || positive(r.max);
};

/** True when the client has at least one included district with an id. */
export function hasRequestedDistrict(locationItems: unknown): boolean {
  if (!Array.isArray(locationItems)) return false;
  return locationItems.some((it) => {
    if (!it || typeof it !== 'object') return false;
    const o = it as Record<string, unknown>;
    return o.kind === 'district'
      && o.polarity !== 'exclude'
      && typeof o.district_id === 'string' && o.district_id.trim() !== '';
  });
}

/** What is still missing before this client can have a request. Empty = ready. */
export function requestPreferenceGaps(clientData: Record<string, unknown> | null | undefined): RequestGap[] {
  const d = clientData ?? {};
  const gaps: RequestGap[] = [];
  const types = d.preferred_unit_type;
  const hasType = Array.isArray(types)
    ? types.some((t) => typeof t === 'string' && t.trim() !== '')
    : typeof types === 'string' && types.trim() !== '';
  if (!hasType) gaps.push('unit_type');
  if (!hasRequestedDistrict(d.location_items)) gaps.push('districts');
  if (!hasRange(d.budget) && !hasRange(d.preferred_bedrooms) && !hasRange(d.preferred_area)) gaps.push('specs');
  return gaps;
}

/** «نوع الوحدة، الميزانية» — the gaps as one localised list. */
export function gapListText(gaps: RequestGap[], isAr: boolean): string {
  return gaps.map((g) => (isAr ? REQUEST_GAP_LABELS[g].ar : REQUEST_GAP_LABELS[g].en)).join(isAr ? '، ' : ', ');
}
