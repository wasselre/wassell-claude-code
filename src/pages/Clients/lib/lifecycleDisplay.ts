import type { LifecycleHealth } from './clientView';

/**
 * Pure display mappings for client lifecycle facts — badge labels, tones, and
 * colors — plus small bilingual formatters. No React, no store: testable.
 *
 * "Tone" is a small semantic vocabulary the UI translates into Tailwind/brand
 * colors. Keeping it abstract here lets the same mapping drive list badges,
 * detail headers, and KPI cards consistently.
 */

export type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'info' | 'neutral';

export interface BadgeStyle {
  label_ar: string;
  label_en: string;
  tone: Tone;
  /** Hex used for the brand-styled chip (background is rendered at ~12% alpha). */
  color: string;
}

const TONE_COLOR: Record<Tone, string> = {
  success: '#3F7D54', // calm green
  warning: '#C09B5F', // subtle gold
  danger: '#B5462F', // strong terracotta/red
  muted: '#9A8E7E', // sand-grey
  info: '#4A6FA5', // muted blue
  neutral: '#4A4E54', // charcoal
};

export function toneColor(tone: Tone): string {
  return TONE_COLOR[tone];
}

// ---------------------------------------------------------------------------
// Lifecycle health
// ---------------------------------------------------------------------------

const LIFECYCLE: Record<LifecycleHealth, BadgeStyle> = {
  on_track: { label_ar: 'على المسار', label_en: 'On track', tone: 'success', color: TONE_COLOR.success },
  overdue: { label_ar: 'متأخر', label_en: 'Overdue', tone: 'danger', color: TONE_COLOR.danger },
  no_next_action: { label_ar: 'لا يوجد إجراء تالٍ', label_en: 'No next action', tone: 'warning', color: TONE_COLOR.warning },
  closed: { label_ar: 'مغلق', label_en: 'Closed', tone: 'muted', color: TONE_COLOR.muted },
};

/** Display style for a lifecycle_health value. Null/unknown → a neutral chip. */
export function lifecycleHealthDisplay(value: LifecycleHealth | string | null | undefined): BadgeStyle {
  if (value && value in LIFECYCLE) return LIFECYCLE[value as LifecycleHealth];
  return { label_ar: 'غير محدد', label_en: 'Unknown', tone: 'neutral', color: TONE_COLOR.neutral };
}

/** Plain-English/Arabic explanation of WHY a client is in a given health state. */
export function lifecycleHealthExplanation(value: LifecycleHealth | string | null | undefined, isAr: boolean): string {
  switch (value) {
    case 'overdue':
      return isAr
        ? 'الإجراء التالي تجاوز موعده — تواصل مع العميل الآن.'
        : 'The next action is past due — reach out to the client now.';
    case 'no_next_action':
      return isAr
        ? 'لا توجد متابعة مفتوحة لهذا العميل — أنشئ متابعة لإبقائه نشطًا.'
        : 'There is no open follow-up for this client — create one to keep them active.';
    case 'closed':
      return isAr
        ? 'العميل في مرحلة نهائية (مغلق ناجح أو خاسر/غير مؤهل).'
        : 'The client is in a terminal stage (closed-won or lost/unqualified).';
    case 'on_track':
      return isAr
        ? 'يوجد إجراء تالٍ مجدول ولم يتأخر بعد.'
        : 'A next action is scheduled and not yet overdue.';
    default:
      return isAr ? 'حالة دورة الحياة غير محددة بعد.' : 'Lifecycle health is not determined yet.';
  }
}

// ---------------------------------------------------------------------------
// Next action type
// ---------------------------------------------------------------------------

const NEXT_ACTION: Record<string, { label_ar: string; label_en: string }> = {
  call: { label_ar: 'اتصال', label_en: 'Call' },
  whatsapp: { label_ar: 'واتساب', label_en: 'WhatsApp' },
  appointment: { label_ar: 'موعد', label_en: 'Appointment' },
  offer: { label_ar: 'عرض سعر', label_en: 'Offer' },
  financing: { label_ar: 'تمويل', label_en: 'Financing' },
  ownership: { label_ar: 'إفراغ', label_en: 'Ownership transfer' },
};

export function nextActionTypeLabel(value: string | null | undefined, isAr: boolean): string | null {
  if (!value) return null;
  const m = NEXT_ACTION[value];
  if (m) return isAr ? m.label_ar : m.label_en;
  return value;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Compact SAR amount: 1,200,000 → "1.2M", 850000 → "850K". */
function compactSar(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${Number.isInteger(v) ? v : v.toFixed(0)}K`;
  }
  return String(n);
}

/** Format a `{min,max}` budget as a SAR range. Returns null when empty. */
export function formatBudget(range: { min: number | null; max: number | null } | null, isAr: boolean): string | null {
  if (!range) return null;
  const cur = isAr ? 'ر.س' : 'SAR';
  const { min, max } = range;
  if (min !== null && max !== null) {
    if (min === max) return `${compactSar(min)} ${cur}`;
    return `${compactSar(min)} – ${compactSar(max)} ${cur}`;
  }
  if (min !== null) return `${isAr ? 'من' : 'from'} ${compactSar(min)} ${cur}`;
  if (max !== null) return `${isAr ? 'حتى' : 'up to'} ${compactSar(max)} ${cur}`;
  return null;
}

/** Format a generic `{min,max}` numeric range (area, bedrooms). Returns null when empty. */
export function formatRange(range: { min: number | null; max: number | null } | null, unit?: string): string | null {
  if (!range) return null;
  const u = unit ? ` ${unit}` : '';
  const { min, max } = range;
  if (min !== null && max !== null) return min === max ? `${min}${u}` : `${min} – ${max}${u}`;
  if (min !== null) return `${min}+${u}`;
  if (max !== null) return `≤ ${max}${u}`;
  return null;
}

/** Localized absolute date-time. Returns null for empty/invalid input. */
export function formatDateTime(iso: string | null | undefined, isAr: boolean): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString(isAr ? 'ar-SA' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Localized date-only (for timeline day groups). */
export function formatDate(iso: string | null | undefined, isAr: boolean): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Relative "time ago / from now" in coarse buckets. `now` injectable for tests.
 * Negative diffs (future) read as "in N…"; past as "N… ago".
 */
export function formatRelative(iso: string | null | undefined, isAr: boolean, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - now;
  const future = diffMs > 0;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  let qty: number;
  let unitAr: string;
  let unitEn: string;
  if (mins < 60) {
    qty = Math.max(mins, 0);
    unitAr = 'دقيقة';
    unitEn = qty === 1 ? 'minute' : 'minutes';
    if (qty === 0) return isAr ? 'الآن' : 'just now';
  } else if (hours < 24) {
    qty = hours;
    unitAr = 'ساعة';
    unitEn = qty === 1 ? 'hour' : 'hours';
  } else if (days < 30) {
    qty = days;
    unitAr = 'يوم';
    unitEn = qty === 1 ? 'day' : 'days';
  } else if (days < 365) {
    qty = Math.round(days / 30);
    unitAr = 'شهر';
    unitEn = qty === 1 ? 'month' : 'months';
  } else {
    qty = Math.round(days / 365);
    unitAr = 'سنة';
    unitEn = qty === 1 ? 'year' : 'years';
  }

  if (isAr) return future ? `خلال ${qty} ${unitAr}` : `قبل ${qty} ${unitAr}`;
  return future ? `in ${qty} ${unitEn}` : `${qty} ${unitEn} ago`;
}
