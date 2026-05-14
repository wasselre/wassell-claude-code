/**
 * Curated icon library for the project_details "features" and "landmarks"
 * tables. Each entry is a slug + bilingual label + a public URL pointing
 * at a PNG that lives in the `marketing-assets/icons/library/` Supabase
 * Storage folder.
 *
 * The PNGs themselves are pre-rendered by `scripts/seed-icon-library.ts`
 * (one-time, then committed to the bucket — Supabase Storage is the
 * source of truth, not git). The slug list here is the source of truth
 * for *which* icons make up the library. It must stay in sync with:
 *   - The slug→noun prompt map in `scripts/seed-icon-library.ts`.
 *   - The `FEATURE_ICONS` / `LANDMARK_ICONS` arrays the AI drafter uses
 *     in `supabase/functions/project-details-ai-v2/index.ts`.
 *   - The public website's icon renderer (separate repo).
 *
 * URL shape: `<VITE_SUPABASE_URL>/storage/v1/object/public/marketing-assets/icons/library/<slug>.png`.
 * We resolve it at runtime rather than hardcoding the project ref so the
 * same code works across dev/preview/prod Supabase projects.
 */

export interface IconLibraryEntry {
  /** Stable identifier — also the filename in storage (`<slug>.png`). */
  slug: string;
  label_ar: string;
  label_en: string;
}

export const FEATURE_ICONS: IconLibraryEntry[] = [
  { slug: 'building',   label_ar: 'مبنى',           label_en: 'Building' },
  { slug: 'home',       label_ar: 'منزل',           label_en: 'Home' },
  { slug: 'car',        label_ar: 'سيارة / موقف',   label_en: 'Car / Parking' },
  { slug: 'smart_home', label_ar: 'منزل ذكي',       label_en: 'Smart Home' },
  { slug: 'ac',         label_ar: 'تكييف',          label_en: 'AC' },
  { slug: 'camera',     label_ar: 'كاميرا',         label_en: 'Camera' },
  { slug: 'key',        label_ar: 'مفتاح / دخول',   label_en: 'Key / Entry' },
  { slug: 'facade',     label_ar: 'واجهة',          label_en: 'Facade' },
  { slug: 'bed',        label_ar: 'سرير / غرفة',    label_en: 'Bed / Room' },
  { slug: 'box',        label_ar: 'مخزن',           label_en: 'Storage' },
  { slug: 'sparkle',    label_ar: 'تشطيب فاخر',     label_en: 'Premium Finish' },
  { slug: 'elevator',   label_ar: 'مصعد',           label_en: 'Elevator' },
  { slug: 'shield',     label_ar: 'أمن',            label_en: 'Security' },
  { slug: 'wifi',       label_ar: 'إنترنت',         label_en: 'WiFi' },
  { slug: 'pool',       label_ar: 'مسبح',           label_en: 'Pool' },
  { slug: 'gym',        label_ar: 'صالة رياضية',    label_en: 'Gym' },
];

export const LANDMARK_ICONS: IconLibraryEntry[] = [
  { slug: 'metro',      label_ar: 'مترو',          label_en: 'Metro' },
  { slug: 'road',       label_ar: 'طريق',          label_en: 'Road / Highway' },
  { slug: 'shop',       label_ar: 'مول / تسوق',    label_en: 'Mall / Shopping' },
  { slug: 'school',     label_ar: 'مدرسة',         label_en: 'School' },
  { slug: 'hospital',   label_ar: 'مستشفى',        label_en: 'Hospital' },
  { slug: 'park',       label_ar: 'حديقة',         label_en: 'Park' },
  { slug: 'mosque',     label_ar: 'مسجد',          label_en: 'Mosque' },
  { slug: 'airport',    label_ar: 'مطار',          label_en: 'Airport' },
  { slug: 'restaurant', label_ar: 'مطعم / كافيه',  label_en: 'Restaurant' },
  { slug: 'gas',        label_ar: 'محطة وقود',     label_en: 'Gas Station' },
  { slug: 'pin',        label_ar: 'موقع آخر',      label_en: 'Other Location' },
];

const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/marketing-assets/icons/library/';

/**
 * Build the public URL for a library icon. Resolved at call-time against
 * `VITE_SUPABASE_URL` so the same slug works in dev, preview, and prod
 * without hardcoding a project ref.
 */
export function libraryIconUrl(slug: string, baseUrlOverride?: string): string {
  const base =
    baseUrlOverride
    ?? (typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_SUPABASE_URL as string | undefined) : undefined)
    ?? '';
  const trimmed = base.replace(/\/$/, '');
  return `${trimmed}${STORAGE_PUBLIC_PREFIX}${slug}.png`;
}

/**
 * Reverse-lookup: given a stored value that *might* be a legacy slug
 * (`"building"`) instead of a URL, return the library URL. Returns null
 * when the slug isn't part of the library (caller should leave the
 * value untouched — never silently substitute a fallback).
 */
export function resolveSlugToLibraryUrl(value: string, baseUrlOverride?: string): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const known =
    FEATURE_ICONS.find((e) => e.slug === value)
    ?? LANDMARK_ICONS.find((e) => e.slug === value);
  if (!known) return null;
  return libraryIconUrl(known.slug, baseUrlOverride);
}
