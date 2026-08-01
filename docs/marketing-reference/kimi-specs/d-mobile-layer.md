TASK: The mobile layer — MobileTabBar + the ten mobile screens, matching design screens 28–32, 46, 48, 49, 51, 52 EXACTLY. Files: NEW src/pages/Marketing/components/MobileTabBar.tsx, NEW src/pages/Marketing/AccountPage.tsx (/m/account + route in App.tsx /m tree), targeted responsive additions to existing pages, and mobile CSS at END of mos.css under `/* === mobile layer === */` (media queries <760px; use the mockup phone CSS as the source — the .ph-* styles in the source screens translate to the app's mobile classes).

GROUND TRUTH: READ docs/marketing-reference/source/screens/s28.html, s29.html, s30.html, s31.html, s32.html, s46.html, s48.html, s49.html, s51.html, s52.html — the .ph-scr blocks are the app surfaces to reproduce (ignore .ph-notch/.ph-stat/.ph-cap device chrome/captions). Bilingual verbatim-Arabic; num() digits; ALL touch targets >= 44px.

MobileTabBar (<760px, replaces the desktop rail): اليوم(/m/my-work) · المحتوى(/m/content) · التصوير(/m/shoots) · المزيد(sheet) — items FILTERED by the workspace ctx surfaces (hidden = absent). المزيد opens the s48 bottom sheet listing the remaining non-hidden surfaces + الحساب(/m/account). Active tab styling per the mockups.

S28: my-work mobile = اليوم card groups (متأخر/اليوم/قادم) + content cards + chip filters exactly as the phone frames show.
S29: mobile review flow on content detail: pinned prior rejection note card, scene list with duration bar, FIXED bottom bar تعديلات/اعتماد; the approval bottom sheet (s29 phone3): checklist ABOVE the buttons + the conscious «اعتماد رغم النقص» path exactly as mocked (wires to task_complete / RequestChangesModal from the desktop build).
S30: shoot site mode (/m/shoots/:id?mode=site): big tick targets per item, catch-all input, OFFLINE queue states via src/pages/Marketing/lib/offline.ts (READ its exported API: enqueueTick/enqueueCapture/subscribe/startAutoDrain/retryItem/listQueue) — queued/uploading/failed/retry chips exactly as the mockup; drain handlers call shoot_item_toggle + the upload/registration path used by /m/library/upload?shoot= (READ UploadPage.tsx's delivery wire and reuse its API calls); reconnect drains automatically (startAutoDrain on mount, teardown on unmount).
S31: Publish Assistant bottom sheet on mobile publish tab: copy-caption button (clipboard), approved file row, platform deep link, «تم النشر» confirm + URL input (publication_save), tonight's remaining list — exactly as mocked.
S32: campaigns/executions wide tables → cards on mobile (dominant number + verdict per card) exactly as the phone frames; activity access preserved.
S46 AccountPage: role display + ACTIVE-role switcher (only when user holds 2+ mos roles — switching updates the ctx activeRole + localStorage; absent for single role), notification prefs (whatsapp toggle, digest hour — notification_prefs_save), load card (my open tasks count) + طلب تأجيل action as mocked, desktop-only features list + email-link exactly as the mockup.
S48: المزيد sheet (above) + campaign verdict cards mobile styling.
S49: calendar mobile = agenda list (empty week = warning row) per phone1; roles-permission mobile list (role-first accordion) per phone2.
S51: workflows editor mobile = accordion per step; library mobile = 2-col grid + FIXED upload CTA.
S52: numbers mobile = one-at-a-time task mode (card per publication with big inputs, next/skip) + overview stacked cards.

VERIFY: npx tsc --noEmit clean. Print exactly: MOBILE LAYER BUILT + files changed.
