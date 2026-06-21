/**
 * Per-document page settings — size, orientation, margins, header/footer.
 *
 * ⚠️ KEEP IN SYNC with src/lib/documents/pageSettings.ts. The worker is a
 * standalone npm package (rootDir:src) and CANNOT import from src/* — same
 * COPY posture as worker/src/imageGen.ts. This is a faithful copy; if you
 * change one, change both.
 *
 * Only the DOCX-relevant pieces are exercised here (docxPageGeometry,
 * normalizePageSettings, DEFAULT_PAGE_SETTINGS); the canvas/print-CSS helpers
 * are carried verbatim so the file stays a byte-comparable copy.
 */

export type PageSize = 'a4' | 'letter' | 'legal';
export type PageOrientationSetting = 'portrait' | 'landscape';
export type PageMargin = 'normal' | 'narrow' | 'wide';

export interface PageSettings {
  page_size: PageSize;
  orientation: PageOrientationSetting;
  margin: PageMargin;
  header_text: string;
  footer_text: string;
  show_page_numbers: boolean;
  different_first_page: boolean;
}

export const DEFAULT_PAGE_SETTINGS: PageSettings = {
  page_size: 'a4',
  orientation: 'portrait',
  margin: 'normal',
  header_text: '',
  footer_text: '',
  show_page_numbers: false,
  different_first_page: false,
};

/** Merge stored JSONB (possibly {}/partial/garbage) into a full settings object. */
export function normalizePageSettings(raw: unknown): PageSettings {
  const r = (raw ?? {}) as Partial<Record<keyof PageSettings, unknown>>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  return {
    page_size: pick(r.page_size, ['a4', 'letter', 'legal'] as const, 'a4'),
    orientation: pick(r.orientation, ['portrait', 'landscape'] as const, 'portrait'),
    margin: pick(r.margin, ['normal', 'narrow', 'wide'] as const, 'normal'),
    header_text: typeof r.header_text === 'string' ? r.header_text : '',
    footer_text: typeof r.footer_text === 'string' ? r.footer_text : '',
    show_page_numbers: r.show_page_numbers === true,
    different_first_page: r.different_first_page === true,
  };
}

// ─── Geometry tables ──────────────────────────────────────────────────────

/** Page dimensions in millimetres (portrait). */
export const PAGE_MM: Record<PageSize, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  letter: { w: 216, h: 279 },
  legal: { w: 216, h: 356 },
};

/** Margins in millimetres. */
export const MARGIN_MM: Record<PageMargin, number> = {
  normal: 25,
  narrow: 12,
  wide: 40,
};

// ─── DOCX section geometry (twips: 1mm ≈ 56.7) ───────────────────────────

const TWIPS_PER_MM = 1440 / 25.4;

export function docxPageGeometry(s: PageSettings): {
  width: number;
  height: number;
  margin: number;
  landscape: boolean;
} {
  const size = PAGE_MM[s.page_size];
  return {
    width: Math.round(size.w * TWIPS_PER_MM),
    height: Math.round(size.h * TWIPS_PER_MM),
    margin: Math.round(MARGIN_MM[s.margin] * TWIPS_PER_MM),
    landscape: s.orientation === 'landscape',
  };
}

/** Content width in EMUs (914400 per inch) for sizing embedded images so a
 *  logo never overflows the page. Worker-only helper (not in the src copy). */
export function contentWidthEmu(s: PageSettings): number {
  const size = PAGE_MM[s.page_size];
  const wMm = s.orientation === 'landscape' ? size.h : size.w;
  const usableMm = wMm - 2 * MARGIN_MM[s.margin];
  const EMU_PER_MM = 36000;
  return Math.round(usableMm * EMU_PER_MM);
}
