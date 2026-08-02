TASK: Content detail — part 2 of 2. Rebuild the four record tabs to EXACTLY match design screens 09 (المواد والملفات), 10 (المهام والاعتمادات), 11 (النشر), 12 (الأداء). Files: src/pages/Marketing/components/MaterialsTab.tsx, TaskCard.tsx, PublishTab.tsx, PerformanceTab.tsx, StageRail.tsx (pinned-version reads), a NEW file src/pages/Marketing/styles/cd2.css (import it from MaterialsTab.tsx; same .mos-root-scoped conventions as mos.css — do NOT touch mos.css). Do NOT touch ContentDetailPage.tsx beyond what tab props strictly require (part 1 owns it — if a prop must change, keep it backward-compatible).

GROUND TRUTH: READ docs/marketing-reference/source/screens/s09.html, s10.html, s11.html, s12.html. Bilingual verbatim-Arabic; num() digits.

DATA/API (api-contract.md + api/marketing-os.ts): content_detail (tasks incl. revision_targets + pinned workflow steps), asset_list/asset_link/asset_unlink, content_versions, publication_list/publication_save, metrics_record/metrics_history, campaign_outcomes, shoot actions.

SCREEN 09 — MaterialsTab rebuilt into the FOUR production bands exactly as mocked:
1. أصلية: linked source assets with usage counts + scene tags; PLUS dashed missing-shot rows derived from scenes with footage_status='missing' each carrying «إسناد تصوير» (existing shoot-assignment flow).
2. ملفات العمل: working files (link role 'reference' or per the mockup's definition — read s09's band captions and map to the asset_links role values 'source'/'final'/'reference' accordingly; state your mapping in a comment).
3. نسخ المراجعة: rows from content_versions (round, date, submitter) with their rejected_note attached exactly as mocked.
4. المعتمد والمنشور: assets linked with role 'final' — and ONLY these are offered in PublishTab's file picker (enforce in code, matching the mockup's rule copy).
Side card «تغطية اللقطات»: coverage meter of scenes have/template vs to_make/missing exactly as mocked.

SCREEN 10 — tasks & approvals tab: chronological chain from content_detail tasks: rejection rows red-tinted with their note, and the revision task that followed rendered as an INDENTED CHILD row (per the mockup's nesting); dimmed FUTURE steps listed from the PINNED version's steps (everything after the current step — from the record's workflow_version steps, NOT the live workflow); inline approval card when the current step is an approval for MY role: checklist (required_fields/required_files of the step — check each against actual data presence), note field, consequence lines, اعتماد + طلب تعديلات buttons (the latter opens part 1's RequestChangesModal via a prop callback — add the prop if missing, default no-op); «أين ذهب الوقت» meters: per-step elapsed (closed_at - opened_at) bars exactly as mocked; «القواعد السارية» card rendering the pinned version's step rules verbatim shape (roles, SLAs, approval kinds).

SCREEN 11 — PublishTab: three publication rows in DIFFERENT incomplete states exactly as the mockup demonstrates (missing file / missing caption / scheduled-complete); approved-file-only picker (band 4 rule); per-platform caption; the mockup's checklist affordances. Publishing stays manual (no auto-publish anywhere).

SCREEN 12 — PerformanceTab BOTH states:
1. Manual table state: per-publication metric rows with «ناقص» alert cells for missing weeks, «لم يُدخل» empties (NEVER zero-filled), deep-link «أدخل الأرقام» to /m/numbers, the anti-stall rules card verbatim.
2. Connected-snapshot state (when snapshot history has api-source rows): chart from metrics_history with HONEST dated gaps (missing weeks are gaps, not interpolated), latest-value cards.
3. «أين انتهى» block: campaign_outcomes of the linked campaign (attributed clients/appointments/visits/reservations + value) exactly as mocked, with the «مُدخلة يدويًا»/derived tags the mockup shows.

VERIFY: npx tsc --noEmit clean. Print exactly: CD2 REBUILT + files changed.
