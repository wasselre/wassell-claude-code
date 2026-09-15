/**
 * A project's PAYMENT PLANS — resolved once, rendered three ways: the Payment
 * Plans tab, the branded PDF (`./unitsPdf.ts` → `buildPaymentPlansPdf`), and the
 * WhatsApp text message (`composePaymentPlansMessage` below).
 *
 * Extracted from `PaymentPlansTabPane` so the tab, the PDF and the message can
 * never disagree about what the project offers. Pure — store slices in, plain
 * data out, no I/O, no React.
 *
 * WHERE THE DATA LIVES. Prices live PER UNIT: the source of truth is the
 * `payment_plans` table field on each unit (columns `plan`, `down`,
 * `before_handover`, `on_handover`, `after_handover`, `price` (AED),
 * `price_sar`, `schedule`). The project never stores prices; it stores a MENU of
 * the distinct structures, maintained by a Postgres rollup
 * (`supabase/migrations/2026-09-07_project_payment_plans_rollup.sql`). We
 * aggregate live from the units in the store for the same reason the tab always
 * has: the menu deliberately omits the per-structure price ranges, and a price
 * range is exactly what a customer asks for.
 *
 * A card with no price of its own (the Saudi shape: the plan is a %-split and
 * the price is the unit's `total_price`) falls back to that unit's total price
 * as SAR. A card may also carry free-text `schedule` — the milestone-by-
 * milestone breakdown — which rides along to every surface.
 */

import type { AppRecord } from '@/types';
import type { ProjectView } from '@/lib/projects/projectView';

/** One raw row of a unit's `payment_plans` table field. */
export interface PlanRow {
  plan?: string;
  down?: number;
  before_handover?: number;
  on_handover?: number;
  after_handover?: number;
  price?: number;
  price_sar?: number;
  schedule?: string;
}

/** One distinct payment STRUCTURE, after grouping. */
export interface PaymentPlanRow {
  /** Stable key — the %-split, e.g. "20/75/5/0". */
  key: string;
  /** The developer's own plan name when it is a real name, else ''. */
  name: string;
  /** The %-split written out: "20% مقدم / 75% أثناء الإنشاء / 5% عند التسليم". */
  label: string;
  /** Free-text milestone breakdown, when the developer supplied one. */
  schedule: string;
  down: number;
  during: number;
  onHandover: number;
  postHandover: number;
  /**
   * Units offering this structure (project view) or priced offers of it (unit
   * view). `countKind` says which — the two views label the column differently.
   */
  count: number;
  countKind: 'units' | 'offers';
  minAed: number;
  maxAed: number;
  minSar: number;
  maxSar: number;
  /** 100% up front — rendered as "دفعة كاملة (كاش)" rather than a %-split. */
  isCash: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const scheduleOf = (p: PlanRow): string => (typeof p.schedule === 'string' ? p.schedule.trim() : '');

/**
 * The developer's own plan NAME, when it is a real name ("نموذج 2", "Flexi
 * Plan") rather than a bare sequence number ("01", "3") — Binghatti cards are
 * numbered, Saudi developers name their models. A real name becomes the row
 * title with the %-split as its subtitle.
 */
export const planNameOf = (p: PlanRow): string => {
  const s = typeof p.plan === 'string' ? p.plan.trim() : '';
  return s && !/^\d+$/.test(s) ? s : '';
};

/** The unit's own total price (SAR) — the price of a plan card that has none. */
function unitTotalPrice(rec: AppRecord | undefined): number {
  return num((rec?.data as Record<string, unknown> | undefined)?.total_price);
}

export const structKey = (p: PlanRow): string =>
  `${num(p.down)}/${num(p.before_handover)}/${num(p.on_handover)}/${num(p.after_handover)}`;

/** The %-split written out in one language. */
export function structLabel(p: PlanRow, isAr: boolean): string {
  const parts: string[] = [];
  if (num(p.down) > 0) parts.push(`${num(p.down)}% ${isAr ? 'مقدم' : 'down'}`);
  if (num(p.before_handover) > 0)
    parts.push(`${num(p.before_handover)}% ${isAr ? 'أثناء الإنشاء' : 'during construction'}`);
  if (num(p.on_handover) > 0) parts.push(`${num(p.on_handover)}% ${isAr ? 'عند التسليم' : 'on handover'}`);
  if (num(p.after_handover) > 0)
    parts.push(`${num(p.after_handover)}% ${isAr ? 'بعد التسليم' : 'post-handover'}`);
  return parts.join(' / ') || '—';
}

/** A unit's `payment_plans` rows, or [] when it has none. */
export function planRowsOf(rec: AppRecord | undefined): PlanRow[] {
  const raw = (rec?.data as Record<string, unknown> | undefined)?.payment_plans;
  return Array.isArray(raw) ? (raw as PlanRow[]) : [];
}

function finish(
  sample: PlanRow,
  name: string,
  schedule: string,
  count: number,
  countKind: 'units' | 'offers',
  aeds: number[],
  sars: number[],
  isAr: boolean,
): PaymentPlanRow {
  const down = num(sample.down);
  const during = num(sample.before_handover);
  const onHandover = num(sample.on_handover);
  return {
    key: structKey(sample),
    name,
    label: structLabel(sample, isAr),
    schedule,
    down,
    during,
    onHandover,
    postHandover: num(sample.after_handover),
    count,
    countKind,
    minAed: aeds.length ? Math.min(...aeds) : 0,
    maxAed: aeds.length ? Math.max(...aeds) : 0,
    minSar: sars.length ? Math.min(...sars) : 0,
    maxSar: sars.length ? Math.max(...sars) : 0,
    isCash: down === 100 && during === 0 && onHandover === 0,
  };
}

const byEntryFirst = (a: PaymentPlanRow, b: PaymentPlanRow) =>
  a.down - b.down || a.during - b.during || a.onHandover - b.onHandover;

/**
 * PROJECT VIEW — the distinct structures offered across the project's units,
 * each with the number of units offering it and the price RANGE rolled up from
 * those units. Answers "what payment plans does this project offer, and what do
 * they cost".
 */
export function resolveProjectPaymentPlans(units: AppRecord[], isAr: boolean): PaymentPlanRow[] {
  const map = new Map<
    string,
    { sample: PlanRow; name: string; schedule: string; units: Set<string>; aeds: number[]; sars: number[] }
  >();
  for (const u of units) {
    for (const p of planRowsOf(u)) {
      const key = structKey(p);
      const price = num(p.price);
      // No plan-specific price → the unit's own total price (SAR).
      const priceSar = num(p.price_sar) || (price > 0 ? 0 : unitTotalPrice(u));
      const g = map.get(key) ?? { sample: p, name: '', schedule: '', units: new Set<string>(), aeds: [], sars: [] };
      if (!g.schedule) g.schedule = scheduleOf(p);
      if (!g.name) g.name = planNameOf(p);
      g.units.add(u.id);
      if (price > 0) g.aeds.push(price);
      if (priceSar > 0) g.sars.push(priceSar);
      map.set(key, g);
    }
  }
  return [...map.values()]
    .map((g) => finish(g.sample, g.name, g.schedule, g.units.size, 'units', g.aeds, g.sars, isAr))
    .sort(byEntryFirst);
}

/**
 * UNIT VIEW — this unit's own plan cards grouped by structure, so the same
 * structure sold at several prices (different offers) reads as one row with its
 * price range, not eleven flat rows.
 */
export function resolveUnitPaymentPlans(unit: AppRecord | undefined, isAr: boolean): PaymentPlanRow[] {
  const map = new Map<
    string,
    { sample: PlanRow; name: string; schedule: string; offers: number; aeds: number[]; sars: number[] }
  >();
  const fallbackSar = unitTotalPrice(unit);
  for (const p of planRowsOf(unit)) {
    const key = structKey(p);
    const g = map.get(key) ?? { sample: p, name: '', schedule: '', offers: 0, aeds: [], sars: [] };
    if (!g.schedule) g.schedule = scheduleOf(p);
    if (!g.name) g.name = planNameOf(p);
    g.offers += 1;
    const aed = num(p.price);
    const sar = num(p.price_sar) || (aed > 0 ? 0 : fallbackSar);
    if (aed > 0) g.aeds.push(aed);
    if (sar > 0) g.sars.push(sar);
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => finish(g.sample, g.name, g.schedule, g.offers, 'offers', g.aeds, g.sars, isAr))
    .sort(byEntryFirst);
}

/** The lowest down payment across the plans — the "entry" plan. 0 when empty. */
export function entryDownPayment(rows: PaymentPlanRow[]): number {
  return rows.length === 0 ? 0 : Math.min(...rows.map((r) => r.down));
}

/** True when at least one card is priced in AED (a Dubai project). Saudi
 *  projects are SAR-only and the extra "—" column/line is noise. */
export function hasAedPricing(rows: PaymentPlanRow[]): boolean {
  return rows.some((r) => r.maxAed > 0);
}

/**
 * "1,200,000 ر.س" — an empty/zero amount renders as an em-dash. The language
 * rides on `currency` («ر.س» vs "SAR"); the digits are always Western with
 * comma grouping, matching every other money string we send a customer
 * (`formatPrice` in projectMessageFacts, `fmt` in unitsPdf).
 */
export function formatPlanMoney(v: number, currency: string): string {
  return v > 0 ? `${Math.round(v).toLocaleString('en-US')} ${currency}` : '—';
}

/** A price cell/line: one figure, or a "min — max" range, or an em-dash. */
export function formatPlanPriceRange(min: number, max: number, currency: string): string {
  if (min <= 0 && max <= 0) return '—';
  if (min === max) return formatPlanMoney(min, currency);
  return `${formatPlanMoney(min, currency)} — ${formatPlanMoney(max, currency)}`;
}

/**
 * ASCII-safe-ish slug for a filename; keeps path separators out of the header
 * line. (`unitsPdf.ts` has the same helper for the units/unit filenames — this
 * copy lives here so the payment-plans filename can be computed WITHOUT
 * importing the PDF module, which drags in jsPDF + html2canvas.)
 */
function slugForFilename(s: string | null | undefined, fallback: string): string {
  const base = (s ?? '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-');
  return base || fallback;
}

/**
 * The payment-plans PDF's filename. Deliberately lives in THIS light module,
 * not next to `buildPaymentPlansPdf`: the send dialog needs the name up front
 * while the ~600 KB PDF stack is only imported when the rep actually builds a
 * document.
 */
export function paymentPlansPdfFilename(project: Pick<ProjectView, 'id' | 'projectId' | 'name'>): string {
  return `wassel-payment-plans-${slugForFilename(project.projectId ?? project.name, project.id.slice(0, 8))}.pdf`;
}

export const planRowTitle = (r: PaymentPlanRow, isAr: boolean): string =>
  r.isCash ? (isAr ? 'دفعة كاملة (كاش)' : 'Full payment (cash)') : r.name || r.label;

/**
 * Compose the WhatsApp TEXT version of a project's payment plans — the same
 * facts the PDF carries, in a scannable message a rep can send as-is or edit.
 *
 * DELIVERY STATUS RIDES ALONG. Payment plans are a timing conversation, so an
 * off-plan project says «على الخارطة» plus its expected handover month here too
 * (and says it with no date when the date is unknown) — the same rule and the
 * same phrasing as the project message. `deliveryPhrase` comes from
 * `resolveProjectDelivery(...).phrase`; null (unknown status) writes no line.
 */
export function composePaymentPlansMessage(args: {
  projectName: string | null;
  rows: PaymentPlanRow[];
  isAr: boolean;
  deliveryPhrase?: string | null;
  /** Public project link, appended last when supplied. */
  link?: string | null;
}): string {
  const { projectName, rows, isAr, deliveryPhrase, link } = args;
  const sar = isAr ? 'ر.س' : 'SAR';
  const aed = isAr ? 'د.إ' : 'AED';
  const out: string[] = [];

  out.push(isAr ? `خطط السداد — ${projectName ?? ''}`.trim() : `Payment plans — ${projectName ?? ''}`.trim());
  if (deliveryPhrase) {
    out.push('');
    out.push(isAr ? `الحالة: ${deliveryPhrase}` : `Status: ${deliveryPhrase}`);
  }

  rows.forEach((r, i) => {
    out.push('');
    const title = planRowTitle(r, isAr);
    out.push(`${i + 1}) ${title}`);
    // When the title is the developer's plan NAME, the %-split still has to be
    // said — it is the plan.
    if (!r.isCash && r.name) out.push(r.label);
    if (r.schedule) out.push(r.schedule);
    if (r.maxAed > 0) {
      out.push(
        isAr
          ? `السعر: ${formatPlanPriceRange(r.minAed, r.maxAed, aed)}`
          : `Price: ${formatPlanPriceRange(r.minAed, r.maxAed, aed)}`,
      );
    }
    if (r.maxSar > 0) {
      out.push(
        isAr
          ? `السعر بالريال: ${formatPlanPriceRange(r.minSar, r.maxSar, sar)}`
          : `Price in SAR: ${formatPlanPriceRange(r.minSar, r.maxSar, sar)}`,
      );
    }
  });

  if (rows.some((r) => r.countKind === 'units' && r.count > 0)) {
    out.push('');
    out.push(
      isAr
        ? 'السعر يختلف حسب الوحدة — النطاق أعلاه يغطي الوحدات المتوفرة بهذه الخطة.'
        : 'Price varies by unit — the range above covers the units available on that plan.',
    );
  }

  if (link) {
    out.push('');
    out.push(isAr ? `الرابط: ${link}` : `Link: ${link}`);
  }

  return out.join('\n').trim();
}
