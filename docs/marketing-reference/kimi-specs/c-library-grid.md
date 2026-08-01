TASK: Rebuild src/pages/Marketing/LibraryPage.tsx to EXACTLY match design screen 16 (مكتبة المواد). Modify only that file, plus additive CSS at the END of src/pages/Marketing/mos.css under `/* === s16 additions === */` (never edit existing rules).

GROUND TRUTH: READ docs/marketing-reference/source/screens/s16.html — the approved mockup extract. Reproduce its structure/classes/labels/states with REAL data. mos.css already holds the design system; verify each class you use exists, add missing ones to the additions block. Bilingual pattern (isAr ? ... : ...) for every string — Arabic verbatim from the mockup. Arabic-Indic digits via num() from src/pages/Marketing/lib/format.ts.

DATA: existing `asset_list` action in api/marketing-os.ts (read its select list + response shape) + `projects_list` for project names + types from src/lib/marketingOS/client.ts. Newly-added DB columns (duration_seconds, parent_asset_id, rights_expiry, shot_by) may not be in the action's select yet — if asset_list selects '*' they arrive free; check, and if the action uses an explicit column list you MAY extend that select list in api/marketing-os.ts (the ONLY api change allowed in this task — no new actions).

SCREEN 16 requirements (verify each against s16.html):
1. Sections grouped by project × kind exactly as the mockup (e.g. «مشروع مينا ٥٢ — فيديو», «— صور»); assets without a project under the mockup's unfiled section label.
2. Cards: thumbnail (photo thumb / video style per mockup), title, duration badge on videos (mm:ss from duration_seconds — only when present), «نسخة معتمدة» badge where the mockup shows it (an asset linked to content with link role 'final' — asset_list exposes links or usage counts; derive from what the action returns; if the action lacks link-role data, extend its select/join minimally), tag chips, shot date.
3. Grid/list view toggle exactly as mocked (segmented control; list = the mockup's row layout).
4. Unused banner at top exactly as mocked (count of assets with zero usage) with CTA linking to /m/library/unused (route may 404 for now — link anyway, screen 41 lands separately).
5. Filters as mocked (kind chips, project select, search) — keep existing filter logic where it matches, restyle to the mockup.
6. Upload CTA keeps navigating to /m/library/upload.
7. Card click → /m/library/:assetId (route lands with screen 22 — link anyway).
8. Keep Skeleton/LoadError/Empty states, restyled to the mockup if it shows them.

VERIFY: npx tsc --noEmit passes. When done print exactly: S16 REBUILT + one line per file changed.
