import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  loadBrandKit,
  brandKitPromptBlock,
  isHexInKit,
  nearestKitColor,
  paletteRolesFor,
  validatePaletteAgainstKit,
  normalizeHex,
  type SettingsClient,
} from '../brandKit';
import type { BrandKit, PaletteEntry } from '../contracts';

/** The seeded kit, straight from docs/brand/brand-kit.draft.json (the migration's payload). */
const DRAFT_URL = new URL('../../../../docs/brand/brand-kit.draft.json', import.meta.url);
const MIGRATION_URL = new URL('../../../../supabase/migrations/2026-09-02_26_creative_brand_kit_seed.sql', import.meta.url);
const draftKit = JSON.parse(readFileSync(DRAFT_URL, 'utf8')) as BrandKit;

function makeKit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    version: 1,
    status: 'draft',
    mode: 'advisory',
    reviewed_by: null,
    reviewed_at: null,
    sources: [],
    palette: [
      { name: 'Copper Bronze', hex: '#B8734F', roles: ['primary', 'cta'] },
      { name: 'Deep Terracotta', hex: '#A6482A', roles: ['hover', 'emphasis'] },
      { name: 'Warm Sand/Beige', hex: '#E8D9C0', roles: ['divider', 'soft_background'] },
      { name: 'Rich Chocolate Brown', hex: '#6B4226', roles: ['dark_ground', 'headline_on_light', 'wordmark'] },
      { name: 'Soft Cream', hex: '#F8F5E9', roles: ['page_background', 'light_text_on_dark'] },
      { name: 'Charcoal/Slate Gray', hex: '#3F3F3F', roles: ['body_text'] },
      { name: 'Subtle Gold', hex: '#D9B57F', roles: ['badge', 'highlight', 'underline'] },
      { name: 'White', hex: '#FFFFFF', roles: ['light_text_on_dark', 'logo_on_dark', 'card_fill'] },
    ],
    usage_ratio: { copper: 50, earth: 30, charcoal: 15, gold: 5 },
    combinations_allowed: [],
    combinations_avoid: [],
    typography: { display: 'Amiri', body: 'Amiri', numerals: 'arabic_indic', max_sizes_per_slide: 2, latin_policy: 'Amiri; bilingual project names allowed' },
    logo: { variants: ['horizontal', 'icon'], on_dark: 'white', on_light: 'copper or chocolate', clear_space: '1× icon height', min_size: '24px', default_position: 'top_start' },
    character: { statement: 'Traditional, clean, Najdi.', motifs: ['stepped-triangle notch strip'], negative_space: 'generous' },
    image_treatment: { allowed: ['real project photography'], avoid: ['glow or drop shadows'] },
    prohibited: ['«بدون سعي»', '«Wassel CRM» (always «نظام وصل»)'],
    approved_example_ids: [],
    ...overrides,
  };
}

/** Minimal mos_settings fake: `from('mos_settings').select('value').eq('key','brand_kit').maybeSingle()`. */
function fakeSb(value: unknown, error: { message: string } | null = null): SettingsClient {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: error ? null : { value }, error }),
        }),
      }),
    }),
  } as unknown as SettingsClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadBrandKit', () => {
  it('returns the kit when the row holds a valid BrandKit', async () => {
    const kit = makeKit();
    expect(await loadBrandKit(fakeSb(kit))).toEqual(kit);
  });

  it('returns null (quietly) when the row does not exist', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadBrandKit(fakeSb(null))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null + logs when the read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadBrandKit(fakeSb(null, { message: 'connection reset' }))).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('connection reset');
  });

  it('returns null + logs when the value fails the shape check', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadBrandKit(fakeSb({ version: 'one', palette: [] }))).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('not a usable BrandKit');
  });

  it('rejects a palette entry with an invalid hex', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = makeKit();
    bad.palette[0] = { name: 'Copper', hex: 'copper', roles: ['primary'] };
    expect(await loadBrandKit(fakeSb(bad))).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('normalizeHex', () => {
  it('normalizes the accepted forms', () => {
    expect(normalizeHex('#B8734F')).toBe('#b8734f');
    expect(normalizeHex('b8734f')).toBe('#b8734f');
    expect(normalizeHex('#fff')).toBe('#ffffff');
    expect(normalizeHex(' F8F5E9 ')).toBe('#f8f5e9');
  });
  it('rejects non-hex input', () => {
    expect(normalizeHex('copper')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('isHexInKit', () => {
  const kit = makeKit();
  it('matches case- and format-insensitively', () => {
    expect(isHexInKit(kit, '#B8734F')).toBe(true);
    expect(isHexInKit(kit, 'b8734f')).toBe(true);
    expect(isHexInKit(kit, '#FFF')).toBe(true); // white, shorthand
  });
  it('rejects off-kit and invalid values', () => {
    expect(isHexInKit(kit, '#123456')).toBe(false);
    expect(isHexInKit(kit, 'copper')).toBe(false);
  });
});

describe('nearestKitColor', () => {
  const kit = makeKit();
  it('finds the exact colour', () => {
    expect(nearestKitColor(kit, '#B8734F')?.name).toBe('Copper Bronze');
  });
  it('finds the closest colour for a near-miss', () => {
    // One step off copper in the green channel.
    expect(nearestKitColor(kit, '#B8744F')?.name).toBe('Copper Bronze');
    // A gold-ish tint is closer to Subtle Gold than to sand.
    expect(nearestKitColor(kit, '#D9B580')?.name).toBe('Subtle Gold');
  });
  it('returns null on invalid hex or empty palette', () => {
    expect(nearestKitColor(kit, 'not-a-color')).toBeNull();
    expect(nearestKitColor(makeKit({ palette: [] }), '#B8734F')).toBeNull();
  });
});

describe('paletteRolesFor', () => {
  const kit = makeKit();
  it('maps the light ground onto the documented roles', () => {
    const roles = paletteRolesFor(kit, { ground: 'light' });
    expect(roles.background).toBe('#f8f5e9'); // cream
    expect(roles.headline).toBe('#6b4226'); // chocolate
    expect(roles.body).toBe('#3f3f3f'); // charcoal
    expect(roles.accent).toBe('#b8734f'); // copper
    expect(roles.accent_hover).toBe('#a6482a'); // terracotta
    expect(roles.divider).toBe('#e8d9c0'); // sand
    expect(roles.badge).toBe('#d9b57f'); // gold
    expect(roles.text_on_accent).toBe('#ffffff'); // white
  });
  it('maps the dark ground with cream text and gold accents', () => {
    const roles = paletteRolesFor(kit, { ground: 'dark' });
    expect(roles.background).toBe('#6b4226'); // chocolate
    expect(roles.headline).toBe('#f8f5e9'); // cream (first light_text_on_dark entry)
    expect(roles.accent).toBe('#d9b57f'); // gold
    expect(roles.text_on_accent).toBe('#ffffff'); // white
    expect(roles.wordmark).toBe('#6b4226'); // chocolate wordmark colourway
  });
  it('omits slots whose role no palette entry carries (never invents a hex)', () => {
    const sparse = makeKit({ palette: [{ name: 'Copper Bronze', hex: '#B8734F', roles: ['primary'] }] });
    const roles = paletteRolesFor(sparse, { ground: 'light' });
    expect(roles).toEqual({ accent: '#b8734f' });
  });
});

describe('validatePaletteAgainstKit', () => {
  const entry = (hex: string, source: PaletteEntry['source'], name = 'X'): PaletteEntry => ({ hex, name, role: 'accent', source });

  it('passes in-kit colours cleanly', () => {
    const kit = makeKit();
    const r = validatePaletteAgainstKit(kit, [entry('#B8734F', 'brand_kit'), entry('#fff', 'asset')]);
    expect(r).toEqual({ deviations: [], errors: [] });
  });

  it('lists off-kit colours as deviations in advisory mode', () => {
    const kit = makeKit({ mode: 'advisory' });
    const r = validatePaletteAgainstKit(kit, [entry('#112233', 'project_identity', 'Midnight')]);
    expect(r.errors).toEqual([]);
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]).toContain('Midnight');
    expect(r.deviations[0]).toContain('#112233');
    expect(r.deviations[0]).toContain('nearest kit colour');
  });

  it('fails off-kit colours as errors in constraint mode', () => {
    const kit = makeKit({ mode: 'constraint', status: 'reviewed' });
    const r = validatePaletteAgainstKit(kit, [entry('#112233', 'asset', 'Midnight')]);
    expect(r.deviations).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('constraint mode');
  });

  it('always errors when source claims brand_kit but the hex is off-kit — even in advisory mode', () => {
    const kit = makeKit({ mode: 'advisory' });
    const r = validatePaletteAgainstKit(kit, [entry('#112233', 'brand_kit', 'FakeCopper')]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("claims source 'brand_kit'");
  });

  it('errors on unparseable hexes', () => {
    const kit = makeKit();
    const r = validatePaletteAgainstKit(kit, [entry('copper', 'asset', 'Broken')]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('invalid hex');
  });
});

describe('brandKitPromptBlock', () => {
  const kit = makeKit();

  it('includes palette with roles, ratio, typography, logo, character, motifs, prohibited, and mode (en)', () => {
    const block = brandKitPromptBlock(kit, 'en');
    expect(block).toContain('ADVISORY');
    expect(block).toContain('#b8734f Copper Bronze — primary, cta');
    expect(block).toContain('copper 50%');
    expect(block).toContain('Amiri');
    expect(block).toContain('max 2 type sizes');
    expect(block).toContain('on dark: white');
    expect(block).toContain('clear space 1× icon height');
    expect(block).toContain('Traditional, clean, Najdi.');
    expect(block).toContain('stepped-triangle notch strip');
    expect(block).toContain('Prohibited');
    expect(block).toContain('«بدون سعي»');
    expect(block).toContain('نظام وصل');
  });

  it('renders Arabic labels in ar mode and flags constraint mode in both languages', () => {
    const arBlock = brandKitPromptBlock(kit, 'ar');
    expect(arBlock).toContain('هوية وصل البصرية');
    expect(arBlock).toContain('استرشادي');
    expect(arBlock).toContain('ممنوعات');
    const constraint = brandKitPromptBlock(makeKit({ mode: 'constraint', status: 'reviewed' }), 'ar');
    expect(constraint).toContain('إلزامي');
    expect(brandKitPromptBlock(makeKit({ mode: 'constraint', status: 'reviewed' }), 'en')).toContain('CONSTRAINT');
  });
});

describe('the seeded draft kit (docs/brand/brand-kit.draft.json)', () => {
  it('passes the loader shape check (loadable as-is)', async () => {
    expect(await loadBrandKit(fakeSb(draftKit))).toEqual(draftKit);
  });

  it('is version 1, draft, advisory, unreviewed, with no approved examples yet', () => {
    expect(draftKit.version).toBe(1);
    expect(draftKit.status).toBe('draft');
    expect(draftKit.mode).toBe('advisory');
    expect(draftKit.reviewed_by).toBeNull();
    expect(draftKit.reviewed_at).toBeNull();
    expect(draftKit.approved_example_ids).toEqual([]);
  });

  it('carries the 2026 canon and none of the retired palette', () => {
    const hexes = draftKit.palette.map((e) => normalizeHex(e.hex));
    for (const canon of ['#b8734f', '#a6482a', '#e8d9c0', '#6b4226', '#f8f5e9', '#3f3f3f', '#d9b57f']) {
      expect(hexes).toContain(canon);
    }
    for (const retired of ['#8e4e3a', '#d4b896', '#4a2c2a', '#f5ede0', '#4a4e54', '#c09b5f']) {
      expect(hexes).not.toContain(retired);
    }
  });

  it('usage ratio follows the palette sheet (50/30/15/5)', () => {
    expect(draftKit.usage_ratio).toEqual({ copper: 50, earth: 30, charcoal: 15, gold: 5 });
  });

  it('its own palette validates clean against itself', () => {
    const asEntries: PaletteEntry[] = draftKit.palette.map((e) => ({ hex: e.hex, name: e.name, role: e.roles[0] ?? 'other', source: 'brand_kit' }));
    expect(validatePaletteAgainstKit(draftKit, asEntries)).toEqual({ deviations: [], errors: [] });
  });
});

describe('migration parity (2026-09-02_26)', () => {
  it('seeds brand_kit with EXACTLY the draft JSON, ON CONFLICT DO NOTHING', () => {
    const sql = readFileSync(MIGRATION_URL, 'utf8');
    const m = sql.match(/\$kit\$([\s\S]*?)\$kit\$::jsonb/);
    expect(m, 'migration must embed the kit between $kit$ markers').toBeTruthy();
    const embedded = JSON.parse(m![1]) as unknown;
    expect(embedded).toEqual(JSON.parse(readFileSync(DRAFT_URL, 'utf8')));
    expect(sql).toContain("INSERT INTO public.mos_settings (key, value) VALUES");
    expect(sql).toContain("'brand_kit'");
    expect(sql).toContain('ON CONFLICT (key) DO NOTHING');
    // Idempotency posture: no UPDATE / DELETE / DROP of the settings row.
    expect(sql).not.toMatch(/\bUPDATE\s+public\.mos_settings/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+public\.mos_settings/i);
  });
});
