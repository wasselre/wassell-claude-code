/**
 * ⚠️  VERBATIM COPY of api/_lib/marketing/creative/brandKit.ts — keep in sync.
 *
 * The Fly.io worker is a standalone npm package (worker/tsconfig.json has
 * rootDir:"src"; the Dockerfile copies only worker/src/), so it cannot import
 * from api/_lib/ or src/. The ONLY differences from the master are this header
 * and the contracts import path (`./contracts.js` — the worker's own verbatim
 * copy of src/lib/creative/contracts.ts). Same posture as worker/src/imageGen.ts.
 *
 * Brand kit — the Post Creative Director's brand truth, as DATA.
 *
 * The kit lives in `mos_settings` key='brand_kit' (a `BrandKit` per
 * src/lib/creative/contracts.ts; seeded by migration
 * 2026-09-02_26_creative_brand_kit_seed.sql from docs/brand/brand-kit.draft.json).
 * Contracts §0 rule 12: while `mode='advisory'` deviations are LISTED, never
 * failed; after a reviewer (approve_creative capability) promotes it to
 * `mode='constraint'`, validators enforce.
 *
 *   loadBrandKit(sb)                      → BrandKit | null   (null = no usable kit; always logged)
 *   brandKitPromptBlock(kit, language)    → compact prompt block for the director prompts
 *   isHexInKit(kit, hex)                  → boolean
 *   nearestKitColor(kit, hex)             → closest kit palette entry (RGB distance)
 *   paletteRolesFor(kit, {ground})        → semantic role → hex map for a light|dark ground
 *   validatePaletteAgainstKit(kit, pal)   → { deviations, errors } honoring kit.mode
 *
 * Pure except loadBrandKit (one settings read). No network anywhere else —
 * unit tests inject a fake settings client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrandKit, PaletteEntry } from './contracts.js';

export type BrandKitPaletteEntry = BrandKit['palette'][number];

/** The only slice of a Supabase client `loadBrandKit` needs (tests inject a fake). */
export type SettingsClient = Pick<SupabaseClient, 'from'>;

// ---------------------------------------------------------------------------
// loadBrandKit
// ---------------------------------------------------------------------------

/**
 * Read the kit from mos_settings. Returns null — loudly, via console.error —
 * when the row is missing, unreadable, or fails the shape check. Callers treat
 * null as "no brand kit configured" and skip brand grounding; they never get a
 * half-parsed kit.
 */
export async function loadBrandKit(sb: SettingsClient): Promise<BrandKit | null> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'brand_kit').maybeSingle();
  if (error) {
    console.error(`[brandKit] mos_settings.brand_kit read failed: ${error.message}`);
    return null;
  }
  const value = (data as { value?: unknown } | null)?.value;
  if (value === null || value === undefined) {
    // Not an error — the seed migration may not have run yet.
    return null;
  }
  const problem = brandKitShapeProblem(value);
  if (problem) {
    console.error(`[brandKit] mos_settings.brand_kit is not a usable BrandKit (${problem}) — treating as absent`);
    return null;
  }
  return value as BrandKit;
}

/** Structural check. Returns a human-readable problem, or null when the value quacks like a BrandKit. */
function brandKitShapeProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not an object';
  const k = v as Record<string, unknown>;
  if (typeof k.version !== 'number') return 'version must be a number';
  if (k.status !== 'draft' && k.status !== 'reviewed') return `status '${String(k.status)}' not draft|reviewed`;
  if (k.mode !== 'advisory' && k.mode !== 'constraint') return `mode '${String(k.mode)}' not advisory|constraint`;
  if (!Array.isArray(k.palette) || k.palette.length === 0) return 'palette must be a non-empty array';
  for (const [i, p] of k.palette.entries()) {
    if (typeof p !== 'object' || p === null) return `palette[${i}] not an object`;
    const e = p as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name) return `palette[${i}].name missing`;
    if (typeof e.hex !== 'string' || !normalizeHex(e.hex)) return `palette[${i}].hex '${String(e.hex)}' is not a valid hex colour`;
    if (!Array.isArray(e.roles)) return `palette[${i}].roles must be an array`;
  }
  if (typeof k.typography !== 'object' || k.typography === null) return 'typography missing';
  if (typeof k.logo !== 'object' || k.logo === null) return 'logo missing';
  if (typeof k.character !== 'object' || k.character === null) return 'character missing';
  if (typeof k.image_treatment !== 'object' || k.image_treatment === null) return 'image_treatment missing';
  if (!Array.isArray(k.prohibited)) return 'prohibited must be an array';
  return null;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/** Normalize '#abc' | 'abc' | '#AABBCC' | 'AABBCC' → '#aabbcc'. Null on anything else. */
export function normalizeHex(hex: string): string | null {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return `#${h}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Case/format-insensitive membership: is `hex` one of the kit's palette colours? */
export function isHexInKit(kit: BrandKit, hex: string): boolean {
  const target = normalizeHex(hex);
  if (!target) return false;
  return kit.palette.some((e) => normalizeHex(e.hex) === target);
}

/** Closest kit colour by Euclidean distance in RGB. Null when `hex` is invalid or the palette is empty. */
export function nearestKitColor(kit: BrandKit, hex: string): BrandKitPaletteEntry | null {
  const rgb = hexToRgb(hex);
  if (!rgb || kit.palette.length === 0) return null;
  let best: BrandKitPaletteEntry | null = null;
  let bestDist = Infinity;
  for (const entry of kit.palette) {
    const ergb = hexToRgb(entry.hex);
    if (!ergb) {
      console.error(`[brandKit] palette entry '${entry.name}' has an invalid hex '${entry.hex}' — skipped in nearestKitColor`);
      continue;
    }
    const d = (rgb[0] - ergb[0]) ** 2 + (rgb[1] - ergb[1]) ** 2 + (rgb[2] - ergb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// paletteRolesFor — semantic role → hex for a given ground
// ---------------------------------------------------------------------------

/**
 * Semantic slots mapped onto the kit's palette roles, per ground. First
 * matching palette entry (in kit order) wins; a slot whose role no palette
 * entry carries is simply absent (we never invent a hex).
 *
 * Light ground: cream page, sand surfaces, chocolate headlines, charcoal body,
 * copper accent/cta, terracotta hover, sand dividers, gold highlights.
 * Dark ground: chocolate page, website dark surface as alt ground, cream text,
 * gold accents/dividers, copper cta, white text on accent fills.
 */
const GROUND_ROLE_MAP: Record<'light' | 'dark', Array<[slot: string, kitRole: string]>> = {
  light: [
    ['background', 'page_background'],
    ['surface', 'soft_background'],
    ['card', 'card_fill'],
    ['headline', 'headline_on_light'],
    ['body', 'body_text'],
    ['accent', 'primary'],
    ['cta', 'cta'],
    ['accent_hover', 'hover'],
    ['divider', 'divider'],
    ['highlight', 'highlight'],
    ['badge', 'badge'],
    ['text_on_dark_ground', 'light_text_on_dark'],
    ['text_on_accent', 'logo_on_dark'],
  ],
  dark: [
    ['background', 'dark_ground'],
    ['surface', 'dark_surface'],
    ['headline', 'light_text_on_dark'],
    ['body', 'light_text_on_dark'],
    ['accent', 'highlight'],
    ['cta', 'cta'],
    ['divider', 'underline'],
    ['highlight', 'highlight'],
    ['badge', 'badge'],
    ['text_on_accent', 'logo_on_dark'],
    ['wordmark', 'wordmark'],
  ],
};

export function paletteRolesFor(kit: BrandKit, opts: { ground: 'light' | 'dark' }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, role] of GROUND_ROLE_MAP[opts.ground]) {
    const entry = kit.palette.find((e) => e.roles.includes(role));
    if (entry) {
      const hex = normalizeHex(entry.hex);
      if (hex) out[slot] = hex;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// validatePaletteAgainstKit
// ---------------------------------------------------------------------------

/**
 * Check a generated palette against the kit, honoring `kit.mode`:
 *  - A `source:'brand_kit'` entry whose hex is NOT in the kit is always an
 *    error — it claims brand provenance it doesn't have.
 *  - Any other off-kit hex (`project_identity` / `asset`) is a DEVIATION in
 *    advisory mode (listed, allowed) and an ERROR in constraint mode.
 * In-kit entries and unparseable-already-reported duplicates pass clean.
 */
export function validatePaletteAgainstKit(
  kit: BrandKit,
  palette: PaletteEntry[],
): { deviations: string[]; errors: string[] } {
  const deviations: string[] = [];
  const errors: string[] = [];
  for (const entry of palette) {
    const hex = normalizeHex(entry.hex);
    if (!hex) {
      errors.push(`palette entry '${entry.name}' has an invalid hex '${entry.hex}'`);
      continue;
    }
    if (isHexInKit(kit, hex)) continue;
    const nearest = nearestKitColor(kit, hex);
    const near = nearest ? `nearest kit colour: ${nearest.name} ${normalizeHex(nearest.hex) ?? nearest.hex}` : 'no kit colours to compare';
    if (entry.source === 'brand_kit') {
      errors.push(`palette entry '${entry.name}' ${hex} claims source 'brand_kit' but is not in the kit (${near})`);
    } else if (kit.mode === 'constraint') {
      errors.push(`palette entry '${entry.name}' ${hex} (${entry.source}) is off-kit and the kit is in constraint mode (${near})`);
    } else {
      deviations.push(`palette entry '${entry.name}' ${hex} (${entry.source}) is off-kit (${near})`);
    }
  }
  return { deviations, errors };
}

// ---------------------------------------------------------------------------
// brandKitPromptBlock
// ---------------------------------------------------------------------------

/**
 * Compact brand block for the director prompts. Bilingual: the block's labels
 * follow `language` (the content language, contracts §0 rule 5) — the values
 * (hexes, the Arabic prohibited phrases) are language-independent.
 */
export function brandKitPromptBlock(kit: BrandKit, language: 'ar' | 'en'): string {
  const ar = language === 'ar';
  const lines: string[] = [];
  const t = (arText: string, enText: string): string => (ar ? arText : enText);

  lines.push(
    kit.mode === 'constraint'
      ? t(
          `هوية وصل البصرية (الإصدار ${kit.version}) — وضع إلزامي: لا يُسمح بأي لون خارج الهوية.`,
          `Wassel brand kit (v${kit.version}) — CONSTRAINT mode: off-kit colours are NOT allowed.`,
        )
      : t(
          `هوية وصل البصرية (الإصدار ${kit.version}) — وضع استرشادي: أي لون خارج الهوية يجب أن يُذكر صراحة في قائمة الانحرافات.`,
          `Wassel brand kit (v${kit.version}) — ADVISORY mode: any off-kit colour MUST be listed explicitly in brand_kit.deviations.`,
        ),
  );

  lines.push(t('الألوان وأدوارها:', 'Palette (hex — roles):'));
  for (const e of kit.palette) {
    lines.push(`- ${normalizeHex(e.hex) ?? e.hex} ${e.name} — ${e.roles.join(', ')}`);
  }

  const ratio = Object.entries(kit.usage_ratio)
    .map(([k, v]) => `${k} ${v}%`)
    .join(' · ');
  if (ratio) lines.push(t(`النسبة الاسترشادية: ${ratio}.`, `Usage ratio: ${ratio}.`));

  const ty = kit.typography;
  lines.push(
    t(
      `الخط: ${ty.display} للعناوين و${ty.body} للنص؛ أرقام عربية-هندية (٠١٢٣)؛ حد أقصى ${ty.max_sizes_per_slide} أحجام خط في التصميم الواحد؛ السياسة اللاتينية: ${ty.latin_policy}.`,
      `Typography: ${ty.display} display, ${ty.body} body; Arabic-Indic numerals (٠١٢٣); max ${ty.max_sizes_per_slide} type sizes per design; Latin policy: ${ty.latin_policy}.`,
    ),
  );

  const lg = kit.logo;
  lines.push(
    t(
      `الشعار: الصيغ (${lg.variants.join('، ')})؛ على الداكن ${lg.on_dark}؛ على الفاتح ${lg.on_light}؛ مساحة الأمان ${lg.clear_space}؛ الموضع الافتراضي ${lg.default_position}.`,
      `Logo: variants (${lg.variants.join(', ')}); on dark: ${lg.on_dark}; on light: ${lg.on_light}; clear space ${lg.clear_space}; default position ${lg.default_position}.`,
    ),
  );

  lines.push(t(`الطابع: ${kit.character.statement}`, `Character: ${kit.character.statement}`));
  if (kit.character.motifs.length > 0) {
    lines.push(t(`الزخارف: ${kit.character.motifs.join('؛ ')}.`, `Motifs: ${kit.character.motifs.join('; ')}.`));
  }

  if (kit.image_treatment.allowed.length > 0) {
    lines.push(t(`معالجة الصور — مسموح: ${kit.image_treatment.allowed.join('؛ ')}.`, `Image treatment — allowed: ${kit.image_treatment.allowed.join('; ')}.`));
  }
  if (kit.image_treatment.avoid.length > 0) {
    lines.push(t(`معالجة الصور — تجنّب: ${kit.image_treatment.avoid.join('؛ ')}.`, `Image treatment — avoid: ${kit.image_treatment.avoid.join('; ')}.`));
  }

  if (kit.prohibited.length > 0) {
    lines.push(t('ممنوعات (لا تظهر في التصميم أبداً):', 'Prohibited (never on the design):'));
    for (const p of kit.prohibited) lines.push(`- ${p}`);
  }

  return lines.join('\n');
}
