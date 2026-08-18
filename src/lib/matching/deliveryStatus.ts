/**
 * Delivery readiness of a Project Finder result — "جاهز / Ready" vs
 * "على الخارطة / Off-plan", plus the expected handover date when off-plan.
 *
 * NO NEW FIELDS. Everything here is derived from the two EXISTING source-of-truth
 * fields on the live `all_projects` model plus its `handover_date`:
 *
 *   - `construction_status` (dropdown) — the construction reality. Live option
 *     values: excavation | foundations | structure | finishing |
 *     facade_installation | ready | تحت-التطوير.
 *   - `project_status` (dropdown) — the sales/lifecycle status. Live option
 *     values: under_construction | available_on_map | unknown | sold_out |
 *     available | upcoming (plus legacy free-text Arabic values that predate the
 *     dropdown and still sit in the data — see LEGACY_* below).
 *   - `handover_date` (date, `YYYY-MM-DD`) — Handover Date / تاريخ التسليم.
 *
 * Both status fields ride on `FinderMatch.facts` (stamped by `scoreProject` in
 * `api/_lib/matchAgent.ts`). Market listings carry neither — a resale ad has no
 * construction stage — so they resolve to `unknown` and the card shows nothing.
 *
 * HONESTY RULE: we never guess "ready". A project is Ready only when a field
 * says so explicitly; anything ambiguous stays `unknown` and renders as a neutral
 * "غير محدد" chip (or nothing), never as a readiness claim.
 */

import { MONTH_NAMES_AR } from '@/lib/dateFormat';

export type DeliveryKind = 'ready' | 'off_plan' | 'unknown';

export interface DeliveryStatus {
  kind: DeliveryKind;
  /** Raw stored handover date (`YYYY-MM-DD`). Only meaningful when off-plan. */
  handoverDate: string | null;
}

/** `construction_status` values that mean the building is finished. */
const READY_CONSTRUCTION = new Set(['ready']);

/** `construction_status` values that mean the building is NOT finished yet. */
const OFF_PLAN_CONSTRUCTION = new Set([
  'excavation',
  'foundations',
  'structure',
  'finishing',
  'facade_installation',
  'تحت-التطوير',
]);

/** `project_status` values that mean the project is still being built / sold pre-build. */
const OFF_PLAN_PROJECT_STATUS = new Set([
  'under_construction',
  'available_on_map',
  'upcoming',
  // Legacy free-text (pre-dropdown imports): "قريبا" = coming soon → not built yet.
  'قريبا',
]);

/**
 * Legacy free-text `project_status` values that unambiguously mean "finished".
 * Deliberately NARROW: "مكتمل" is EXCLUDED because it also reads as a truncation
 * of "مكتمل البيع" (sales complete / sold out — that is exactly the wording the
 * our_projects `portfolio_status` dropdown uses), and "مشاريع حالية" /
 * "للتاجير" / "للبيع" say nothing about construction. Those all stay `unknown`
 * rather than being guessed into "Ready".
 */
const LEGACY_READY_PROJECT_STATUS = new Set(['منجز', 'تم الانتهاء']);

const asTrimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolve a finder match's delivery readiness from its `facts`.
 *
 * `construction_status` WINS over `project_status` — it is the specific
 * construction-reality field, so a project stamped `ready` while its sales status
 * still says `available_on_map` (14 such rows live on 2026-08-18) reads as Ready.
 */
export function resolveDeliveryStatus(facts: Record<string, unknown>): DeliveryStatus {
  const construction = asTrimmed(facts.construction_status);
  const projectStatus = asTrimmed(facts.project_status);
  const rawHandover = asTrimmed(facts.handover_date);
  const handoverDate = rawHandover !== '' ? rawHandover : null;

  if (READY_CONSTRUCTION.has(construction)) return { kind: 'ready', handoverDate };
  if (OFF_PLAN_CONSTRUCTION.has(construction)) return { kind: 'off_plan', handoverDate };
  if (LEGACY_READY_PROJECT_STATUS.has(projectStatus)) return { kind: 'ready', handoverDate };
  if (OFF_PLAN_PROJECT_STATUS.has(projectStatus)) return { kind: 'off_plan', handoverDate };
  return { kind: 'unknown', handoverDate };
}

/** Bilingual badge label for a delivery kind. */
export function deliveryLabel(kind: DeliveryKind, isAr: boolean): string {
  if (kind === 'ready') return isAr ? 'جاهز' : 'Ready';
  if (kind === 'off_plan') return isAr ? 'على الخارطة' : 'Off-plan';
  return isAr ? 'غير محدد' : 'Not specified';
}

// English month names. `MONTH_NAMES_AR` is the app's single exported source of
// Arabic (GREGORIAN, not Hijri) month names; its English twin is module-private
// in `dateFormat.ts`, so — exactly like `src/lib/analytics/dateWindows.ts` does
// for its period labels — the English list is restated here and the two are
// combined into the same "Month YYYY" shape that module already renders.
const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a stored handover date as a month + year label ("سبتمبر 2027" /
 * "September 2027"). Handover dates are month-granular commitments in practice
 * (the live data is overwhelmingly end-of-month), so the day is dropped from the
 * badge — the card still exposes the exact stored date in the chip's tooltip.
 *
 * Returns `null` for empty / unparseable input so the caller can omit the date
 * rather than print a stray string.
 */
export function formatHandoverMonth(iso: string | null, isAr: boolean): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) return null;
  const name = isAr ? MONTH_NAMES_AR[monthIdx] : MONTH_NAMES_EN[monthIdx];
  return `${name} ${year}`;
}
