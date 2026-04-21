import type { Language } from '@/types';

/**
 * Given text in one language, generate a placeholder for the other language.
 * In production, this would call a translation API.
 * For now, it copies the text as-is — the Translation Settings page shows
 * which items still need proper translation.
 */
export function autoTranslate(text: string, _fromLang: Language): string {
  return text;
}

/**
 * Set both label_ar and label_en from a single input based on current language.
 * The "other" language gets an auto-translated placeholder.
 */
export function bilingualFromInput(
  input: string,
  language: Language,
): { label_ar: string; label_en: string } {
  if (language === 'ar') {
    return { label_ar: input, label_en: autoTranslate(input, 'ar') };
  }
  return { label_en: input, label_ar: autoTranslate(input, 'en') };
}

/**
 * Generate a slug from text (always Latin-friendly).
 * For Arabic text, produces a generic slug; for English, uses the text.
 */
export function slugify(text: string): string {
  // Check if text contains Latin characters
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasLatin) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  }
  // For Arabic/non-Latin text, generate a short slug from timestamp
  return `item_${Date.now().toString(36)}`;
}

/**
 * Check if an item likely needs translation
 * (both languages have identical text, meaning one is just a copy)
 */
export function needsTranslation(labelAr: string, labelEn: string): boolean {
  if (!labelAr || !labelEn) return true;
  return labelAr.trim() === labelEn.trim();
}
