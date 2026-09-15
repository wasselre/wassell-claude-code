/**
 * Is a project READY or still ON THE MAP (off-plan) — and, when off-plan, when
 * is it handed over? This is the ONE implementation of that question; it is the
 * pure core behind:
 *
 *   • the Project Finder's delivery badge (`src/lib/matching/deliveryStatus.ts`
 *     delegates here),
 *   • the deterministic project WhatsApp sheet (`./compose.ts`),
 *   • the AI project message + its output guard (`api/_lib/projectMessageAi.ts`),
 *   • the payment-plan message/PDF (`src/lib/projects/paymentPlans.ts`).
 *
 * THIS MODULE IMPORTS NOTHING — keep it that way. `api/**` imports it through a
 * relative `.js` specifier, and Vercel's Node-ESM runtime rejects `@/` aliases
 * and extensionless relative imports (ERR_MODULE_NOT_FOUND at runtime, invisible
 * to `npm run build`). Same posture as `./compose.ts` and `geo/localizedName.ts`.
 * That is also why the month names are restated below instead of imported from
 * `../dateFormat.ts` — `__tests__/delivery.test.ts` asserts the Arabic list is
 * identical to that module's `MONTH_NAMES_AR`, so the copy cannot drift.
 *
 * NO NEW FIELDS — everything derives from three EXISTING `all_projects` fields:
 *   - `construction_status` (dropdown): excavation | foundations | structure |
 *     finishing | facade_installation | ready | تحت-التطوير
 *   - `project_status` (dropdown): under_construction | available_on_map |
 *     unknown | sold_out | available | upcoming (+ legacy free-text Arabic)
 *   - `handover_date` (date, `YYYY-MM-DD`)
 *
 * HONESTY RULE: we never guess "ready". A project is Ready only when a field
 * says so explicitly; anything ambiguous stays `unknown` and is rendered as
 * nothing at all rather than as a readiness claim. And an off-plan project with
 * NO handover date says «على الخارطة» with no date — never an invented one.
 */

export type DeliveryKind = 'ready' | 'off_plan' | 'unknown';

export interface Bilingual {
  ar: string;
  en: string;
}

export interface ProjectDelivery {
  kind: DeliveryKind;
  /** Raw stored handover date (`YYYY-MM-DD`). Only meaningful when off-plan. */
  handoverDate: string | null;
  /** "أغسطس 2028" / "August 2028" — null when there is no parseable date. */
  handoverLabel: Bilingual | null;
  /**
   * The ready-to-paste customer-facing phrase, or null when the status is
   * genuinely unknown (→ say nothing). Off-plan WITH a date carries the month;
   * off-plan WITHOUT one is just «على الخارطة».
   */
  phrase: Bilingual | null;
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
 * of "مكتمل البيع" (sales complete / sold out — exactly the wording the
 * our_projects `portfolio_status` dropdown uses), and "مشاريع حالية" /
 * "للتاجير" / "للبيع" say nothing about construction. Those all stay `unknown`
 * rather than being guessed into "Ready".
 */
const LEGACY_READY_PROJECT_STATUS = new Set(['منجز', 'تم الانتهاء']);

const asTrimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// GREGORIAN (not Hijri) month names. Restated here rather than imported so this
// module stays import-free for the Node-ESM api bundles — see the header. The
// Arabic list is asserted identical to `dateFormat.ts`'s exported
// `MONTH_NAMES_AR` by this module's unit test, so the two cannot drift.
export const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a stored handover date as a month + year label ("سبتمبر 2027" /
 * "September 2027"). Handover dates are month-granular commitments in practice
 * (the live data is overwhelmingly end-of-month), so the day is dropped.
 *
 * Returns `null` for empty / unparseable input so the caller omits the date
 * rather than printing a stray string.
 */
export function handoverMonthLabel(iso: string | null, isAr: boolean): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) return null;
  const name = isAr ? MONTH_NAMES_AR[monthIdx] : MONTH_NAMES_EN[monthIdx];
  return `${name} ${year}`;
}

/** The 4-digit handover YEAR, or null. Used by the AI output guard, which must
 *  verify the date survived without depending on how the model spelled the
 *  month (Arabic/English, abbreviated or not). */
export function handoverYear(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-\d{2}/.exec(iso.trim());
  return m ? m[1]! : null;
}

/** Short badge label for a delivery kind (the Finder card's chip). */
export function deliveryKindLabel(kind: DeliveryKind, isAr: boolean): string {
  if (kind === 'ready') return isAr ? 'جاهز' : 'Ready';
  if (kind === 'off_plan') return isAr ? 'على الخارطة' : 'Off-plan';
  return isAr ? 'غير محدد' : 'Not specified';
}

/**
 * Substrings that PROVE a message disclosed off-plan status. Checked
 * case-insensitively on the English side. «الخارطة» covers «على الخارطة» and
 * «بيع على الخارطة»; «تحت الإنشاء» covers the other phrasing reps use.
 */
export const OFF_PLAN_MARKERS_AR = ['الخارطة', 'تحت الإنشاء', 'تحت الانشاء'];
export const OFF_PLAN_MARKERS_EN = ['off-plan', 'off plan', 'under construction'];

/** True when this body already discloses that the project is off-plan. */
export function bodyDisclosesOffPlan(body: string, lang: 'ar' | 'en'): boolean {
  if (!body) return false;
  const markers = lang === 'ar' ? OFF_PLAN_MARKERS_AR : OFF_PLAN_MARKERS_EN;
  const hay = lang === 'ar' ? body : body.toLowerCase();
  return markers.some((m) => hay.includes(m));
}

/**
 * DETERMINISTIC FLOOR for the rep's send flow: if the project is off-plan and
 * this body does not say so anywhere, append the status line. No AI involved.
 *
 * Why it exists: the AI generator's own guard rejects an undisclosed message, and
 * the deterministic sheet always carries the line — but a SAVED template that
 * predates this rule (or was written by hand, so it is not flagged for a
 * fact-check) would otherwise reach the customer untouched. The rep still sees
 * and can edit the result in the preview before sending.
 *
 * Deliberately narrow: it only fills a TOTAL absence. A body that already
 * discloses off-plan is returned unchanged even if its handover month disagrees
 * — correcting a figure is the fact-check's job, and appending a second status
 * line would read as a contradiction.
 */
export function ensureOffPlanDisclosed(
  body: string,
  lang: 'ar' | 'en',
  delivery: ProjectDelivery | null | undefined,
): string {
  if (!body.trim() || delivery?.kind !== 'off_plan' || !delivery.phrase) return body;
  if (bodyDisclosesOffPlan(body, lang)) return body;
  const line = lang === 'ar' ? `الحالة: ${delivery.phrase.ar}` : `Status: ${delivery.phrase.en}`;
  return `${body.replace(/\s+$/, '')}\n\n${line}`;
}

/**
 * Resolve a project's delivery readiness from its RAW `all_projects` data (or
 * from a Finder match's `facts`, which carries the same three keys).
 *
 * `construction_status` WINS over `project_status` — it is the specific
 * construction-reality field, so a project stamped `ready` while its sales status
 * still says `available_on_map` (14 such rows live on 2026-08-18) reads as Ready.
 */
export function resolveProjectDelivery(data: Record<string, unknown>): ProjectDelivery {
  const construction = asTrimmed(data.construction_status);
  const projectStatus = asTrimmed(data.project_status);
  const rawHandover = asTrimmed(data.handover_date);
  const handoverDate = rawHandover !== '' ? rawHandover : null;

  let kind: DeliveryKind = 'unknown';
  if (READY_CONSTRUCTION.has(construction)) kind = 'ready';
  else if (OFF_PLAN_CONSTRUCTION.has(construction)) kind = 'off_plan';
  else if (LEGACY_READY_PROJECT_STATUS.has(projectStatus)) kind = 'ready';
  else if (OFF_PLAN_PROJECT_STATUS.has(projectStatus)) kind = 'off_plan';

  const ar = handoverMonthLabel(handoverDate, true);
  const en = handoverMonthLabel(handoverDate, false);
  const handoverLabel = ar && en ? { ar, en } : null;

  let phrase: Bilingual | null = null;
  if (kind === 'off_plan') {
    phrase = handoverLabel
      ? {
          ar: `على الخارطة — التسليم المتوقع ${handoverLabel.ar}`,
          en: `Off-plan — expected handover ${handoverLabel.en}`,
        }
      : { ar: 'على الخارطة', en: 'Off-plan' };
  } else if (kind === 'ready') {
    // A ready project's handover date is in the past / meaningless — the useful
    // fact is simply that it is ready today.
    phrase = { ar: 'جاهز', en: 'Ready' };
  }

  return { kind, handoverDate, handoverLabel, phrase };
}
