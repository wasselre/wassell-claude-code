TASK: Rebuild the content LIST + BOARD surfaces to EXACTLY match design screens 03 (جدول المحتوى), 04 (اللوحة), and re-evidence 05 (محتوى جديد modal). Files you may modify: src/pages/Marketing/ContentListPage.tsx, src/pages/Marketing/components/NewContentModal.tsx, additive CSS at END of src/pages/Marketing/mos.css under `/* === s03/s04 additions === */`.

GROUND TRUTH: READ docs/marketing-reference/source/screens/s03.html, s04.html, s05.html (and s18.html — the same table in EN/LTR; your build must render BOTH from one component via the isAr pattern, LTR handled by the app's dir switch — no separate EN component). Bilingual strings verbatim-Arabic + sensible English; num() digits; verify mos.css classes exist before use.

DATA: content_list action (read its current response in api/marketing-os.ts) + bootstrap (me/workflows/content_types — read src/lib/marketingOS/client.ts for the post-engine shapes: workflows are role_path defs with steps[]).

SCREEN 03 requirements (verify against s03.html):
1. Columns exactly as the mockup (incl. الحملة column showing the campaign name or —; the type pill; the status chip from status_key + pinned step labels; owner role; due date with overdue tint as mocked).
2. Filter bar exactly: type chips, status select, platform filter (publications-derived platforms per row — derive from what content_list returns; if absent, extend content_list's select minimally IN api/marketing-os.ts — allowed only for adding fields to this action), «+ تصفية» button behavior as the mockup shows (adds a filter chip row).
3. View switcher جدول/لوحة exactly as mocked; board = ?view=board (read/write via useSearchParams).
4. Row click → /m/content/:id. «+ محتوى جديد» opens NewContentModal.

SCREEN 04 requirements:
1. Columns = the FULL stage list of the selected workflow's PINNED-DEFINITION steps (from bootstrap.workflows[].steps) INCLUDING empty stages, plus the مسودة and نُشر terminals if the mockup shows them — transcribe the exact column set from s04.html and derive it from the steps array (labels from step label_ar), NOT hardcoded.
2. A workflow selector chip row if the mockup has one (video path default).
3. Cards per item in its current stage column (status_key ↔ step key); card content exactly as mocked (ref, title, owner role chip, due).
4. Bottleneck column highlighted exactly as the mockup (the column with most overdue/oldest items — read the mockup's rule from its caption/notes and implement that stated rule deterministically).
5. NO drag-and-drop — the board is read-only; stage changes only happen through task actions. If the mockup shows a hint/copy about this, include it.
6. Empty columns render as mocked (ghost style).

SCREEN 05 (NewContentModal) re-evidence: verify against s05.html — the modal must show workflow name + ref preview (next ref from content type prefix) + first-step preview (first step of the type's workflow from canonical steps: role + label) exactly as mocked; adjust what drifted.

VERIFY: npx tsc --noEmit clean for your files. Print exactly: S03-S04-S05 REBUILT + files changed.
