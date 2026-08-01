TASK: Rebuild TWO Marketing-workspace settings surfaces to EXACTLY match the approved design:
- Screen 26 (المنصات والحسابات) and Screen 27 (أنواع المحتوى). Both live inside src/pages/Marketing/SettingsPage.tsx today (sections routed via /m/settings/:section — read the file first to see how sections mount). You may split each section into new files under src/pages/Marketing/components/ (SettingsPlatforms.tsx, SettingsContentTypes.tsx) if SettingsPage.tsx is getting long — keep routing identical (/m/settings/platforms, /m/settings/content-types). Additive CSS only, at the END of src/pages/Marketing/mos.css under `/* === s26/s27 additions === */`.

GROUND TRUTH: READ docs/marketing-reference/source/screens/s26.html and s27.html. Reproduce structure/classes/labels/states exactly, with real data. Bilingual (isAr ? ... : ...) everywhere, Arabic transcribed verbatim; num() for Arabic-Indic digits.

DATA: existing actions — settings_data (returns platform accounts + content types + workflows; read its shape), account_save, content_type_save. No new actions. NOTE: mos workflows are being migrated to canonical `workflows` rows in a parallel task — for the s27 workflow SELECT dropdown, populate from whatever settings_data returns today and keep the mapping through an adapter const so the parallel API change lands with a one-line adapter fix; add a comment `// NOTE: workflow list source switches to canonical role_path rows when the engine API lands`.

SCREEN 26 requirements (verify each against s26.html):
1. Connection cards per platform account exactly as mocked: platform icon, handle, THREE capability lines (النشر / قراءة الأداء / رمز الوصول) each with its state pill exactly as the mockup styles them (متصل/غير متصل/تنتهي ...), token-expiry date when present.
2. Pending counts per account if the mockup shows them (scheduled publications per account from settings_data or publication_list — derive; do not invent).
3. The «قرار: النشر يبقى يدويًا» banner VERBATIM from the mockup (full text transcribed exactly, same styling). No OAuth flows anywhere — informational + editable metadata only (account_save edits labels/handles/flags as today).
4. «+ حساب» add flow as the mockup shows (modal or inline row — follow the mockup).

SCREEN 27 requirements:
1. Type list exactly as mocked: each type row/card with name (both languages), prefix pill, workflow name, field count, active toggle.
2. Full type editor exactly as mocked: name_ar/name_en, prefix, workflow select, DRAGGABLE field list (use @dnd-kit — already a repo dependency — matching the mockup's drag affordance), field editor supporting the 7 field kinds the mockup shows (transcribe the kind list from s27.html exactly — e.g. نص قصير/نص طويل/قائمة/رقم/تاريخ/مرفق/مشاهد — follow the mockup), required toggle per field.
3. Deletion is HIDE-NOT-ERASE exactly as the design dictates: deactivating a field flags it hidden in field_schema (is_hidden true) rather than removing it — existing records keep their data. Same for deleting a type: is_active=false via content_type_save, never a hard delete. The mockup's copy about this must appear where s27.html shows it.
4. «إضافة نوع» creates a new type via content_type_save with the next sort_order.
5. field_schema shape: read how mos_content_types.field_schema is consumed in ContentDetailPage/WritingFields first, and write schema entries compatible with that consumption (key, label_ar, label_en, kind, required, is_hidden?).

VERIFY: npx tsc --noEmit passes. Print exactly: S26-S27 REBUILT + one line per file changed.
