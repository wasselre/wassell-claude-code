/**
 * One-shot seeding of the Image Chats libraries.
 *
 * Inserts on a fresh tenant:
 *   - One "Wassel default" `image_presets` record (palette, mood,
 *     typography pulled from CLAUDE.md and the wassel-deck-review
 *     skill).
 *   - Five starter `prompt_snippets` across the model's categories
 *     (property listing, launch, lifestyle, edit / cleanup).
 *
 * **Idempotency.** Previously the caller passed in-memory record
 * counts from the Zustand cache; that cache is empty during initial
 * page mount (records load lazily *after* models), so every page
 * load with empty cache → seed → duplicate records. Fixed by:
 *
 *   1. Querying Supabase directly for the live count BEFORE inserting.
 *      The in-memory cache is no longer trusted.
 *   2. Persisting a `wassell_image_chats_seeded:<userId>` flag in
 *      localStorage as soon as the seed runs OR detects existing
 *      records. Subsequent loads short-circuit on the flag, so the
 *      Supabase round-trip only happens once per user per browser.
 *
 * The flag is per-user so multiple users on shared machines don't
 * skip each other's checks.
 */

import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import type { AppRecord } from '@/types';

const WASSEL_DEFAULT_PROMPT = `Maintain Wassel Real Estate's (وصل العقارية) visual identity:

Palette: copper bronze (#B8734F) as primary accent, warm sand/beige (#D4B896), soft cream (#F5EDE0) for backgrounds, charcoal slate (#4A4E54) for text, deep terracotta (#8E4E3A) for depth, subtle gold (#C09B5F) for highlights. No blues, no pure black, no cold corporate gradients.

Mood: earthy, premium, calm. Saudi real estate — authoritative and considered, not flashy or neon.

If any text is rendered in the image, use Arabic with Amiri-style serif typography, right-to-left layout, generous spacing.

Avoid: stock-photo people, cliché skylines, low-contrast palettes, anything that reads as Western corporate.`;

interface StarterSnippet {
  title_en: string;
  title_ar: string;
  text: string;
  category_en: string;
  category_ar: string;
}

const STARTER_SNIPPETS: StarterSnippet[] = [
  {
    title_en: 'Property listing — exterior hero',
    title_ar: 'عرض عقار — صورة خارجية رئيسية',
    category_en: 'Property listing',
    category_ar: 'عرض عقار',
    text:
      'Generate a hero exterior shot of the property suitable for the cover of a sales brochure. Soft golden-hour lighting, no people, clean composition with the building filling roughly 70% of the frame. Leave breathing room at the top for a headline.',
  },
  {
    title_en: 'Instagram square — project launch',
    title_ar: 'منشور إنستغرام — إعلان إطلاق',
    category_en: 'Launch announcement',
    category_ar: 'إعلان إطلاق',
    text:
      'Create a 1:1 Instagram launch post. Big bold Arabic headline at the top reading "قريبًا" (Coming Soon), the project name beneath it, and a single architectural rendering centered below. Keep the bottom 1/4 reserved for the Wassel logo.',
  },
  {
    title_en: 'Story / Reel — lifestyle teaser',
    title_ar: 'ستوري — لقطة نمط حياة',
    category_en: 'Lifestyle',
    category_ar: 'نمط حياة',
    text:
      '9:16 vertical story shot. A premium lifestyle moment evoking the project — coffee on a terrace overlooking the development at dusk, abstract enough that no real person is recognizable. Warm copper highlights, no captions.',
  },
  {
    title_en: 'Cleanup — remove distractions from a building photo',
    title_ar: 'تنظيف — إزالة الإلهاء من صورة المبنى',
    category_en: 'Edit / cleanup',
    category_ar: 'تحرير / تنظيف',
    text:
      'Clean up the attached building photograph: remove cars, pedestrians, construction equipment, scaffolding, and any temporary signage. Reconstruct the ground and adjacent facades plausibly. Preserve the building\'s shape, materials, and architectural details exactly.',
  },
  {
    title_en: 'Edit — change time of day to golden hour',
    title_ar: 'تحرير — تحويل الإضاءة إلى ساعة ذهبية',
    category_en: 'Edit / cleanup',
    category_ar: 'تحرير / تنظيف',
    text:
      'Take the attached photo and relight it as if shot during golden hour — warm directional sunlight from a low angle, long soft shadows, sky shifted to a warm cream/peach gradient. Do not alter the architecture or composition.',
  },
];

interface SeedInput {
  presetsModelId: string;
  snippetsModelId: string;
  userId: string | null;
  saveRecord: (record: AppRecord) => unknown;
  isAr: boolean;
}

const FLAG_PREFIX = 'wassell_image_chats_seeded:';

/**
 * Live count of records for a given model id by going straight to
 * Supabase via the anon-key client (RLS-scoped to the caller). We
 * deliberately avoid the in-memory Zustand cache because it's empty
 * during initial page mount.
 *
 * Returns `null` on any failure — the caller treats that as "don't
 * know, skip the seed" so we never duplicate on transient errors.
 */
async function liveCount(modelId: string): Promise<number | null> {
  if (!supabase) return null;
  const { count, error } = await supabase
    .from('records')
    .select('id', { count: 'exact', head: true })
    .eq('model_id', modelId);
  if (error || typeof count !== 'number') return null;
  return count;
}

export async function seedDefaultLibrariesIfEmpty(input: SeedInput): Promise<void> {
  // Per-user flag — once set, never query Supabase again on subsequent
  // mounts. Unset only by `localStorage.removeItem('wassell_image_chats_seeded:<id>')`,
  // which is fine for a manual reset.
  const flagKey = `${FLAG_PREFIX}${input.userId ?? '_anon'}`;
  if (typeof localStorage !== 'undefined' && localStorage.getItem(flagKey) === '1') {
    return;
  }

  // Belt-and-suspenders authoritative check via Supabase. If either count
  // returns null (network blip / RLS denial), abort without seeding AND
  // without setting the flag — next page mount can retry cleanly.
  const [presetCount, snippetCount] = await Promise.all([
    liveCount(input.presetsModelId),
    liveCount(input.snippetsModelId),
  ]);
  if (presetCount === null || snippetCount === null) {
    return;
  }

  const nowIso = new Date().toISOString();

  if (presetCount === 0) {
    const record: AppRecord = {
      id: uuid(),
      model_id: input.presetsModelId,
      data: {
        name: 'Wassel default',
        description: input.isAr
          ? 'لغة العلامة الرسمية: نحاسي، خط أميري، تخطيط RTL.'
          : "Wassel brand language — copper bronze, Amiri, RTL composition.",
        prompt_text: WASSEL_DEFAULT_PROMPT,
        images: [],
      },
      created_at: nowIso,
      updated_at: nowIso,
    };
    try {
      await input.saveRecord(record);
    } catch {
      // Non-fatal — the user can always create a preset manually
      // from the dropdown's "Manage" link.
    }
  }

  if (snippetCount === 0) {
    for (const s of STARTER_SNIPPETS) {
      const record: AppRecord = {
        id: uuid(),
        model_id: input.snippetsModelId,
        data: {
          title: input.isAr ? s.title_ar : s.title_en,
          category: input.isAr ? s.category_ar : s.category_en,
          text: s.text,
          images: [],
        },
        created_at: nowIso,
        updated_at: nowIso,
      };
      try {
        await input.saveRecord(record);
      } catch {
        // Same posture — non-fatal.
      }
    }
  }

  // Set the flag REGARDLESS of whether we actually inserted anything.
  // If both counts were > 0 (libraries already populated), we still
  // want to skip the Supabase round-trip on future mounts.
  try {
    localStorage.setItem(flagKey, '1');
  } catch {
    // localStorage may throw on quota / disabled storage; not fatal —
    // worst case is we re-query Supabase next mount (cheap, idempotent).
  }
}
