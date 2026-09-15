/**
 * Delivery readiness of a Project Finder result — "جاهز / Ready" vs
 * "على الخارطة / Off-plan", plus the expected handover date when off-plan.
 *
 * THIN ADAPTER. The classification rules, the status sets and the month
 * formatting all live in `src/lib/projectMessage/delivery.ts` — the pure,
 * browser-free core shared with the WhatsApp message composers (deterministic
 * sheet, AI message + its guard, payment-plan message). This module keeps the
 * Finder's existing shape (`DeliveryStatus`, `deliveryLabel`,
 * `formatHandoverMonth`) so its callers are untouched.
 *
 * NO NEW FIELDS — everything derives from the two EXISTING source-of-truth
 * status fields on the live `all_projects` model plus its `handover_date`:
 *
 *   - `construction_status` (dropdown) — the construction reality. Live option
 *     values: excavation | foundations | structure | finishing |
 *     facade_installation | ready | تحت-التطوير.
 *   - `project_status` (dropdown) — the sales/lifecycle status. Live option
 *     values: under_construction | available_on_map | unknown | sold_out |
 *     available | upcoming (plus legacy free-text Arabic values that predate the
 *     dropdown and still sit in the data).
 *   - `handover_date` (date, `YYYY-MM-DD`) — Handover Date / تاريخ التسليم.
 *
 * Both status fields ride on `FinderMatch.facts` (stamped by `scoreProject` in
 * `api/_lib/matchAgent.ts`). Market listings carry neither — a resale ad has no
 * construction stage — so they resolve to `unknown` and the card shows nothing.
 */

import {
  resolveProjectDelivery,
  deliveryKindLabel,
  handoverMonthLabel,
  type DeliveryKind,
} from '@/lib/projectMessage/delivery';

export type { DeliveryKind };

export interface DeliveryStatus {
  kind: DeliveryKind;
  /** Raw stored handover date (`YYYY-MM-DD`). Only meaningful when off-plan. */
  handoverDate: string | null;
}

/**
 * Resolve a finder match's delivery readiness from its `facts`.
 *
 * `construction_status` WINS over `project_status` — it is the specific
 * construction-reality field, so a project stamped `ready` while its sales status
 * still says `available_on_map` (14 such rows live on 2026-08-18) reads as Ready.
 */
export function resolveDeliveryStatus(facts: Record<string, unknown>): DeliveryStatus {
  const d = resolveProjectDelivery(facts);
  return { kind: d.kind, handoverDate: d.handoverDate };
}

/** Bilingual badge label for a delivery kind. */
export function deliveryLabel(kind: DeliveryKind, isAr: boolean): string {
  return deliveryKindLabel(kind, isAr);
}

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
  return handoverMonthLabel(iso, isAr);
}
