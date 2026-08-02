TASK: The mobile SHELL only — the two NEW files of the mobile layer, nothing else. A parallel task owns the responsive edits inside existing pages; you must NOT touch any existing file except the single MarketingWorkspace.tsx mount line noted below. Files:
- NEW src/pages/Marketing/components/MobileTabBar.tsx
- NEW src/pages/Marketing/AccountPage.tsx
- NEW src/pages/Marketing/styles/mobile-shell.css (imported by MobileTabBar.tsx; .mos-root-scoped)
- src/pages/Marketing/MarketingWorkspace.tsx: ONLY add the <MobileTabBar /> mount inside the shell layout (one import + one JSX line — nothing else changes) 
- Do NOT touch src/App.tsx — the /m/account route is registered by the orchestrator later; build AccountPage as a default-exported page ready for it.

GROUND TRUTH: READ docs/marketing-reference/source/screens/s46.html (الحساب) and s48.html (المزيد sheet) — reproduce the .ph-scr surfaces exactly. Bilingual verbatim-Arabic (isAr pattern); num() digits; touch targets >= 44px.

MobileTabBar (<760px via the css media query; hidden entirely on desktop): tabs اليوم(/m/my-work) · المحتوى(/m/content) · التصوير(/m/shoots) · المزيد(opens the s48 bottom sheet). Items FILTERED by useWorkspace() surfaces (hidden = absent, never disabled). Active tab from useLocation. The المزيد sheet lists every remaining non-hidden surface (calendar/library/campaigns/numbers/team/settings/search per the workspace NAV mapping) + الحساب → /m/account, styled exactly like s48's sheet (scrim + rounded top sheet + rows with icons); closes on scrim tap and navigation.

AccountPage (/m/account, works on desktop too but styled mobile-first per s46): role display card; ACTIVE-role switcher ONLY when the user holds 2+ mos roles (uses ctx roles + setActiveRole; absent for single role — absent, not disabled); notification prefs card (whatsapp toggle + digest hour select → notification_prefs_save action via the client lib); load card (my open tasks count from work_list mine scope) + «طلب تأجيل» action as s46 shows it; the desktop-only features list + email-link EXACTLY as s46's copy.

VERIFY: npx tsc --noEmit clean for your files (run it; if the sandbox denies, say so and hand-audit). Print exactly: MOBILE-SHELL BUILT + files changed.
