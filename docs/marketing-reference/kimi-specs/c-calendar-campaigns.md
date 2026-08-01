TASK: Rebuild TWO Marketing-workspace pages to EXACTLY match the approved design. Modify only:
- src/pages/Marketing/CalendarPage.tsx  (design screen 13 — التقويم)
- src/pages/Marketing/CampaignsPage.tsx (design screen 14 — الحملات; do NOT touch its screen-19 CampaignModal except where noted)
plus, if needed, additive CSS at the END of src/pages/Marketing/mos.css under a banner comment `/* === s13/s14 additions === */` (never edit existing rules).

GROUND TRUTH — the design's exact DOM: READ docs/marketing-reference/source/screens/s13.html and s14.html. These are the approved mockup extracts; the live page must reproduce their structure, classes, labels, digit formatting, colors and states with REAL data. mos.css already contains the design system classes (verify a class exists before relying on it; missing ones go in the additions block). All Arabic labels come from the mockup verbatim; every string must be bilingual via the existing pattern in these files (isAr ? '...' : '...') — transcribe the Arabic EXACTLY from the mockup and write sensible English equivalents. Arabic-Indic digits via num() from src/pages/Marketing/lib/format.ts everywhere the mockup shows Arabic digits.

DATA: the existing actions in api/marketing-os.ts — `calendar` (read its response shape in the api file), `campaign_list`, `publication_list`. Read src/lib/marketingOS/client.ts for types. Do NOT invent new API actions; if a mockup element needs data the current actions lack, derive client-side from what they return, and add a `// TODO(api): ...` comment ONLY if truly impossible (do not fake values silently).

SCREEN 13 — التقويم requirements (from the mockup, verify each against s13.html):
1. Campaign lanes ABOVE the month grid: one horizontal lane per active campaign spanning its date range across the visible month, campaign name + kind pill; lanes use the mockup's classes.
2. View switcher: شهر / أسبوع / قائمة (segmented control, mockup classes). Month = grid; week = single row expanded; قائمة = chronological list of entries.
3. Filter chips: الكل / النشر / الاستحقاقات — النشر shows scheduled/published publications, الاستحقاقات shows task due dates, الكل both.
4. Day cells: entries as small colored blocks exactly like the mockup (publication = platform-tinted, due = warning-tinted); today highlighted.
5. Empty-week highlight: a week row with zero publish entries gets the mockup's warning wash + its inline note (transcribe it).
6. Legend at the bottom exactly as mocked.
7. RTL correct; weekday headers as mocked (السبت-start or as the mockup shows — follow the mockup).

SCREEN 14 — الحملات requirements:
1. Filter bar exactly as mocked: status segmented (الكل/نشطة/مخططة/منتهية), kind filter (مدفوعة/عضوية), search input if mocked.
2. Table columns exactly as the mockup (incl. النوع column with kind pill; platform sub-lines under the campaign name listing its executions' platforms; spend/budget with SAR formatting; qualified etc. — transcribe headers verbatim).
3. Organic campaigns: money cells render — (dash, the mockup's muted style), NEVER ٠.
4. Ended campaigns: whole row dimmed exactly as mocked.
5. «+ حملة جديدة» button keeps opening the existing screen-19 modal.
6. Row click → /m/campaigns/:id (keep).
7. Any campaign flagged requires_signature && !signed_at shows the mockup's signature-pending pill IF s14.html shows one (verify; if not shown there, skip).

VERIFY: npm run build must pass (run npx tsc --noEmit yourself if npm build is slow). Preserve existing exports/routing contracts. Never remove the loading/LoadError/Empty states — restyle to the mockup where they differ. When done print exactly: S13-S14 REBUILT plus one line per file changed.
