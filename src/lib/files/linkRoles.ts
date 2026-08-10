/**
 * Relationship roles for the Phase 1 file-link projection.
 *
 * MIRROR OF SQL. The authoritative mapping lives in
 * `public.file_link_role_for(model, field, ftype)` — see
 * supabase/migrations/2026-08-10_file_links_projection.sql. This file exists so
 * the UI can LABEL a role bilingually; it must never be used to derive one.
 *
 * Why a mapping and not a lookup table (yet): the projection is read-only in
 * Phase 1, so a vocabulary table would add a table and a write surface for no
 * Phase-1 benefit. When manual linking ships, the roles become a real table and
 * `file_link_role_for` reads it instead — at which point this constant becomes a
 * fallback for labels only. That is the migration path.
 *
 * IMPORTANT: a role is resolved from (model, field, field type) — never from the
 * field slug alone. The same slug means different things on different models.
 */

export type FileLinkRole =
  | 'floor_plan'
  | 'main_image'
  | 'hero_image'
  | 'agent_image'
  | 'gallery_image'
  | 'video'
  | 'developer_content'
  | 'task_attachment'
  | 'reference'
  | 'source'
  | 'marketing_asset'
  | 'supporting_document'
  | 'attachment'
  | 'unmapped';

/**
 * Two of these are NOT field-derived roles, and the distinction matters:
 *
 *   `attachment` — role-NEUTRAL. The legacy `files.record_id` column proves the
 *                  file is associated with the record but asserts nothing about
 *                  HOW. Used when no field-derived role exists on the triple, or
 *                  when SEVERAL do and picking one would be a fabrication.
 *   `unmapped`   — a real field we have not named in the vocabulary yet. A
 *                  reporting signal, not something to paper over.
 *
 * Bilingual labels below.
 */
export const FILE_LINK_ROLE_LABELS: Record<FileLinkRole, { ar: string; en: string }> = {
  floor_plan:          { ar: 'مخطط',            en: 'Floor plan' },
  main_image:          { ar: 'الصورة الرئيسية',  en: 'Main image' },
  hero_image:          { ar: 'صورة الغلاف',      en: 'Hero image' },
  agent_image:         { ar: 'صورة المسؤول',     en: 'Agent image' },
  gallery_image:       { ar: 'معرض الصور',       en: 'Gallery image' },
  video:               { ar: 'فيديو',            en: 'Video' },
  developer_content:   { ar: 'محتوى المطوّر',    en: 'Developer content' },
  task_attachment:     { ar: 'مرفق مهمة',        en: 'Task attachment' },
  reference:           { ar: 'مرجع',             en: 'Reference' },
  source:              { ar: 'مصدر',             en: 'Source' },
  marketing_asset:     { ar: 'مادة تسويقية',     en: 'Marketing material' },
  supporting_document: { ar: 'مستند مساند',      en: 'Supporting document' },
  // Role-neutral: "attached to this record; relationship type not asserted".
  attachment:          { ar: 'مرفق',             en: 'Attached' },
  unmapped:            { ar: 'غير مصنّف',        en: 'Unclassified' },
};

export function roleLabel(role: string, isAr: boolean): string {
  const hit = FILE_LINK_ROLE_LABELS[role as FileLinkRole];
  if (!hit) return role;
  return isAr ? hit.ar : hit.en;
}
