/**
 * Chat template classification. Every chat_templates record is one of two
 * categories:
 *   • 'project' — project/listing messages (recommendations, prices,
 *     locations, brochures, generated project & listing templates).
 *   • 'contact' — general client communication (greetings, follow-ups,
 *     appointment reminders, check-ins).
 *
 * The category is stored explicitly in `data.category`. Templates created
 * before the field existed derive it: anything linked to a project or a
 * market listing is a project message, everything else is a contact message —
 * so the picker classifies correctly even before the backfill migration runs.
 */
export type TemplateCategory = 'project' | 'contact';

export function resolveTemplateCategory(data: Record<string, unknown>): TemplateCategory {
  const c = data.category;
  if (c === 'project' || c === 'contact') return c;
  if (data.project_id || data.listing_id) return 'project';
  return 'contact';
}

export function templateCategoryLabel(category: TemplateCategory, isAr: boolean): string {
  if (category === 'project') return isAr ? 'رسائل المشاريع' : 'Project messages';
  return isAr ? 'رسائل التواصل' : 'Contact messages';
}
