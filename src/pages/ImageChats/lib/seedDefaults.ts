/**
 * One-shot seeding of the Image Chats libraries.
 *
 * Runs the first time the page is opened on a fresh tenant. Inserts:
 *   - One "Wassel default" `image_presets` record (the brand-language
 *     starter — palette, mood, typography rules pulled from CLAUDE.md
 *     and the wassel-deck-review skill).
 *   - A small set of starter `prompt_snippets` covering the four
 *     categories defined on the model (property listing, launch,
 *     lifestyle, edit / cleanup, other).
 *
 * Idempotent at the call site: the caller passes the current record
 * counts and skips invocation when either library is non-empty.
 * Within this function, each insert is unconditional — the caller is
 * the gatekeeper, not us.
 */

import { v4 as uuid } from 'uuid';
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
  presetsCount: number;
  snippetsCount: number;
  saveRecord: (record: AppRecord) => unknown;
  isAr: boolean;
}

export async function seedDefaultLibrariesIfEmpty(input: SeedInput): Promise<void> {
  const nowIso = new Date().toISOString();

  if (input.presetsCount === 0) {
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
      // Failure is non-fatal — the user can always create a preset
      // manually from the dropdown's "Manage" link.
    }
  }

  if (input.snippetsCount === 0) {
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
        // Same posture — non-fatal; the user can curate the library
        // manually if a particular insert errors.
      }
    }
  }
}
