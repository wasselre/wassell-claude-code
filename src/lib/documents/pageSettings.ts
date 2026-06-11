/**
 * Per-document page settings — size, orientation, margins, header/footer.
 *
 * One source of truth for the three surfaces that consume page geometry:
 *   - the editor canvas (px @ 96dpi → live WYSIWYG page width/padding)
 *   - the print/PDF + HTML shells (mm in @page + fixed header/footer divs)
 *   - the DOCX section properties (twips/DXA + real Header/Footer parts)
 *
 * Stored in wassel_documents.settings (JSONB, {} = all defaults).
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

const PX_PER_MM = 96 / 25.4;

/** Inline style for the editor's page canvas — live WYSIWYG geometry. */
export function pageCanvasStyle(s: PageSettings): { width: string; paddingInline: string; paddingBlock: string } {
  const size = PAGE_MM[s.page_size];
  const w = s.orientation === 'landscape' ? size.h : size.w;
  const margin = MARGIN_MM[s.margin];
  return {
    width: `${Math.round(w * PX_PER_MM)}px`,
    paddingInline: `${Math.round(margin * PX_PER_MM)}px`,
    paddingBlock: `${Math.round(margin * PX_PER_MM)}px`,
  };
}

/** CSS `@page` size token for the print shell. */
export function pageCssSize(s: PageSettings): string {
  const name = s.page_size === 'a4' ? 'A4' : s.page_size;
  return s.orientation === 'landscape' ? `${name} landscape` : name;
}

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
