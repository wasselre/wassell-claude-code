// Coverage matrix — the DECLARED mapping from every approved-design frame to the
// live app state that must reproduce it, plus the generation rules for the
// locale / theme / role / viewport dimensions. scripts/mos-manifest.mjs consumes
// this together with frames-index.json to emit manifest.json — one row per
// (frame × locale × theme × role-variant × viewport) with NO row cap.
//
// Gates:
//   'ssim'   — a reference crop exists (Arabic mock, dark+light): deterministic
//              capture at the crop's exact dimensions, SSIM >= 0.98 + pixelmatch
//              >= 99% + overlay. Dimension mismatch = FAIL.
//   'assert' — no reference exists for this dimension combo (EN mirrors beyond
//              screen 18, role variants beyond the role screens, page-52 mobile
//              patterns): deterministic capture + structural assertions +
//              human inspection at 100%. Never reported as pixel parity.
//
// `setup` names a fixture-state + navigation recipe implemented in
// scripts/mos-qa.mjs. A row whose setup is not yet implemented FAILS loudly as
// 'no-setup' — it never silently passes.

/** Mobile pattern viewports from the page-52 acceptance matrix. */
export const MOBILE_VIEWPORTS = [
  { key: 'iphone', width: 390, height: 844 },
  { key: 'iphone-max', width: 430, height: 932 },
  { key: 'tablet', width: 768, height: 1024 },
];

/** Marketing role keys (canonical roles table, 'mos_' prefix stripped). */
export const ROLES = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'];

/**
 * Per-screen declaration. Key = screen number (matches frames-index.json `n`).
 *  surface  — surface_access key the screen lives under (nav gating).
 *  route    — app route (fixture ids resolved by the setup recipe).
 *  setup    — fixture/navigation recipe id; per-frame overrides in `frames`.
 *  role     — role the reference was drawn for (default marketing_manager).
 *  en       — true = this surface also gets an EN-locale assert row (LTR mirror
 *             audit). Screen 18 is the one EN frame WITH a reference.
 *  roleVariants — extra per-role assert rows (role screens + behavior deltas).
 *  frames   — optional per-frame-key overrides { setup, route, notes }.
 */
export const SCREENS = {
  1:  { surface: 'overview',  route: '/m',                        setup: 'overview-loaded', en: true },
  2:  { surface: 'mywork',    route: '/m/my-work',                setup: 'mywork-writer', role: 'writer', en: true },
  3:  { surface: 'content',   route: '/m/content',                setup: 'content-table', en: false /* screen 18 IS the EN row */ },
  4:  { surface: 'content',   route: '/m/content?view=board',     setup: 'content-board', en: true },
  5:  { surface: 'content',   route: '/m/content',                setup: 'new-content-modal', en: true },
  6:  { surface: 'content',   route: '/m/content/:v004',          setup: 'v004-overview', en: true },
  7:  { surface: 'content',   route: '/m/content/:v004',          setup: 'v004-writing', en: true },
  8:  { surface: 'content',   route: '/m/content/:p013',          setup: 'p013-writing', en: true },
  9:  { surface: 'content',   route: '/m/content/:v004?tab=materials', setup: 'v004-materials', en: true },
  10: { surface: 'content',   route: '/m/content/:v004?tab=tasks',    setup: 'v004-tasks', en: true },
  11: { surface: 'content',   route: '/m/content/:v001?tab=publish',  setup: 'v001-publish', en: true },
  12: { surface: 'content',   route: '/m/content/:v001?tab=performance', setup: 'v001-performance-manual', en: true,
        extraSubstates: [{ key: 'connected', setup: 'v001-performance-connected', gate: 'assert',
          notes: 'snapshot-history state — same tab, connected-source data' }] },
  13: { surface: 'calendar',  route: '/m/calendar',               setup: 'calendar-month', en: true },
  14: { surface: 'campaigns', route: '/m/campaigns',              setup: 'campaigns-list', en: true },
  15: { surface: 'campaigns', route: '/m/campaigns/:c002',        setup: 'c002-detail', en: true },
  16: { surface: 'library',   route: '/m/library',                setup: 'library-grid', en: true },
  17: { surface: 'settings',  route: '/m/settings/workflows',     setup: 'workflows-editor', en: true },
  18: { surface: 'content',   route: '/m/content',                setup: 'content-table-en', locale: 'en',
        notes: 'THE EN reference — content table in LTR English. ssim-gated like Arabic rows.' },
  19: { surface: 'campaigns', route: '/m/campaigns',              setup: 'new-campaign-modal', en: true },
  20: { surface: 'campaigns', route: '/m/campaigns/:c002?tab=executions', setup: 'c002-executions', en: true },
  21: { surface: 'campaigns', route: '/m/campaigns/:c002/exec/:e1', setup: 'c002-exec-detail', en: true },
  22: { surface: 'library',   route: '/m/library/:a012',          setup: 'asset-detail', en: true },
  23: { surface: 'library',   route: '/m/library/upload',         setup: 'upload-queue-realism', en: true },
  24: { surface: 'shoots',    route: '/m/shoots/:sr003',          setup: 'shoot-request-detail', en: true },
  25: { surface: 'settings',  route: '/m/settings',               setup: 'settings-home', en: true },
  26: { surface: 'settings',  route: '/m/settings/platforms',     setup: 'settings-platforms', en: true },
  27: { surface: 'settings',  route: '/m/settings/content-types', setup: 'settings-content-types', en: true },
  28: { surface: 'mywork',    route: '/m/my-work',                setup: 'mobile-today', mobile: true },
  29: { surface: 'content',   route: '/m/content/:v004',          setup: 'mobile-review', mobile: true,
        frames: { phone1: { setup: 'mobile-review-push' }, phone2: { setup: 'mobile-review-scenes' }, phone3: { setup: 'mobile-review-sheet' } } },
  30: { surface: 'shoots',    route: '/m/shoots/:sr003?mode=site', setup: 'mobile-site-shoot', mobile: true,
        frames: { phone1: { setup: 'mobile-site-list' }, phone2: { setup: 'mobile-site-offline' } } },
  31: { surface: 'content',   route: '/m/content/:v001?tab=publish', setup: 'mobile-publish-assistant', mobile: true },
  32: { surface: 'campaigns', route: '/m/campaigns/:c002',        setup: 'mobile-exec-cards', mobile: true },
  33: { surface: 'settings',  route: '/m/settings/roles',         setup: 'settings-role-matrix', en: true,
        roleVariants: ['marketing_manager'] },
  34: { surface: 'overview',  route: '/m',                        setup: 'overview-ceo', role: 'ceo',
        roleVariants: ['ceo'] },
  35: { surface: 'team',      route: '/m/team',                   setup: 'team-followup', en: true },
  36: { surface: 'content',   route: '/m/content/:v004',          setup: 'v004-role-harness',
        roleVariants: ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'],
        notes: 'one record, five role states — each roleVariant row asserts the exact button/lock set' },
  37: { surface: 'settings',  route: '/m/settings/people',        setup: 'settings-people', en: true },
  38: { surface: 'content',   route: '/m/content/:v004?tab=tasks', setup: 'request-changes-modal', en: true },
  39: { surface: 'campaigns', route: '/m/campaigns/:c002?tab=content', setup: 'c002-content-tab', en: true },
  40: { surface: 'campaigns', route: '/m/campaigns/:c002?tab=results', setup: 'c002-results-tab', en: true },
  41: { surface: 'library',   route: '/m/library/unused',         setup: 'library-unused', en: true },
  42: { surface: 'shoots',    route: '/m/shoots',                 setup: 'shoots-bands', en: true },
  43: { surface: 'settings',  route: '/m/settings/notifications', setup: 'settings-notifications', en: true },
  44: { surface: 'search',    route: '/m/search?q=مينا',          setup: 'search-results', en: true },
  45: { surface: 'overview',  route: '/m',                        setup: 'zero-records-day-one',
        notes: 'captured on the branch AFTER fixture teardown — the truthful empty state' },
  46: { surface: 'account',   route: '/m/account',                setup: 'mobile-account', mobile: true },
  48: { surface: 'more',      route: '/m',                        setup: 'mobile-more-sheet', mobile: true,
        frames: { phone1: { setup: 'mobile-more-sheet' }, phone2: { setup: 'mobile-campaign-verdicts', route: '/m/campaigns' } } },
  49: { surface: 'calendar',  route: '/m/calendar',               setup: 'mobile-calendar-agenda', mobile: true,
        frames: { phone2: { setup: 'mobile-roles-list', route: '/m/settings/roles' } } },
  50: { surface: 'numbers',   route: '/m/numbers',                setup: 'numbers-weekly-entry', en: true },
  51: { surface: 'settings',  route: '/m/settings/workflows',     setup: 'mobile-workflow-accordion', mobile: true,
        frames: { phone2: { setup: 'mobile-library-grid', route: '/m/library' } } },
  52: { surface: 'numbers',   route: '/m/numbers',                setup: 'mobile-numbers-task', mobile: true,
        frames: { phone2: { setup: 'mobile-overview-stack', route: '/m' } } },
};

/**
 * Page-52 pattern rows: every APP ROUTE must also prove itself at the three
 * mobile viewports (assert-gated — the phone reference crops above cover the
 * ten mobile screens; these cover everything else so no route escapes).
 */
export const ALL_ROUTES = [
  { route: '/m', setup: 'overview-loaded', surface: 'overview' },
  { route: '/m/my-work', setup: 'mywork-writer', surface: 'mywork' },
  { route: '/m/team', setup: 'team-followup', surface: 'team' },
  { route: '/m/content', setup: 'content-table', surface: 'content' },
  { route: '/m/content?view=board', setup: 'content-board', surface: 'content' },
  { route: '/m/content/:v004', setup: 'v004-overview', surface: 'content' },
  { route: '/m/content/:v004?tab=materials', setup: 'v004-materials', surface: 'content' },
  { route: '/m/content/:v004?tab=tasks', setup: 'v004-tasks', surface: 'content' },
  { route: '/m/content/:v001?tab=publish', setup: 'v001-publish', surface: 'content' },
  { route: '/m/content/:v001?tab=performance', setup: 'v001-performance-manual', surface: 'content' },
  { route: '/m/calendar', setup: 'calendar-month', surface: 'calendar' },
  { route: '/m/library', setup: 'library-grid', surface: 'library' },
  { route: '/m/library/upload', setup: 'upload-queue-realism', surface: 'library' },
  { route: '/m/library/:a012', setup: 'asset-detail', surface: 'library' },
  { route: '/m/library/unused', setup: 'library-unused', surface: 'library' },
  { route: '/m/shoots', setup: 'shoots-bands', surface: 'shoots' },
  { route: '/m/shoots/:sr003', setup: 'shoot-request-detail', surface: 'shoots' },
  { route: '/m/campaigns', setup: 'campaigns-list', surface: 'campaigns' },
  { route: '/m/campaigns/:c002', setup: 'c002-detail', surface: 'campaigns' },
  { route: '/m/campaigns/:c002?tab=executions', setup: 'c002-executions', surface: 'campaigns' },
  { route: '/m/campaigns/:c002?tab=content', setup: 'c002-content-tab', surface: 'campaigns' },
  { route: '/m/campaigns/:c002?tab=results', setup: 'c002-results-tab', surface: 'campaigns' },
  { route: '/m/campaigns/:c002/exec/:e1', setup: 'c002-exec-detail', surface: 'campaigns' },
  { route: '/m/numbers', setup: 'numbers-weekly-entry', surface: 'numbers' },
  { route: '/m/search?q=مينا', setup: 'search-results', surface: 'search' },
  { route: '/m/settings', setup: 'settings-home', surface: 'settings' },
  { route: '/m/settings/workflows', setup: 'workflows-editor', surface: 'settings' },
  { route: '/m/settings/content-types', setup: 'settings-content-types', surface: 'settings' },
  { route: '/m/settings/platforms', setup: 'settings-platforms', surface: 'settings' },
  { route: '/m/settings/roles', setup: 'settings-role-matrix', surface: 'settings' },
  { route: '/m/settings/people', setup: 'settings-people', surface: 'settings' },
  { route: '/m/settings/notifications', setup: 'settings-notifications', surface: 'settings' },
  { route: '/m/account', setup: 'mobile-account', surface: 'account' },
];

/**
 * Per-role navigation-visibility assert rows: for each role, one row proving
 * the rail/tab set matches surface_access (hidden = absent, read = visible
 * without write affordances). Captured on /m at desktop + iphone.
 */
export const NAV_VISIBILITY_ROLES = ROLES;
