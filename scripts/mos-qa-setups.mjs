// mos-qa-setups.mjs — setup-recipe registry for the Marketing OS visual gate.
//
// Each recipe takes the manifest row from a booted, authenticated, deterministic
// page to the exact app state the row's reference frame depicts. Recipes are
// named by coverage-matrix.mjs `setup` keys; scripts/mos-qa.mjs looks the key
// up here and FAILS LOUDLY as 'no-setup' when it is absent — an unimplemented
// recipe is never stubbed with a fake pass.
//
// ctx (built by mos-qa.mjs):
//   page               — puppeteer Page: authenticated, correct locale/theme/
//                        viewport, time frozen, app already booted at appUrl+'/m'
//   appUrl             — e.g. http://localhost:3000
//   row                — the manifest row (route may contain :token ids)
//   resolveRoute(route)— replaces ':v004'-style tokens from FIXTURE_IDS;
//                        THROWS on an unresolved token
//   goto(path)         — page.goto(appUrl + path, networkidle0), then waits for
//                        document.fonts.ready + a 500ms settle

/**
 * Fixture-record ids the routes point at. Real ids are environment-specific,
 * so every value is overridable via MOS_FIXTURE_IDS_JSON (a JSON object of the
 * same shape). An empty default is deliberate: a route token with no fixture
 * id makes resolveRoute throw, which fails the row loudly instead of navigating
 * to a nonsense URL.
 */
export const FIXTURE_IDS = {
  ...{
    // v004 / v001 — content records; p013 — project; c002 — campaign;
    // e1 — campaign execution; a012 — library asset; sr003 — shoot request.
    v004: null, v001: null, p013: null, c002: null, e1: null, a012: null, sr003: null,
  },
  ...(process.env.MOS_FIXTURE_IDS_JSON ? JSON.parse(process.env.MOS_FIXTURE_IDS_JSON) : {}),
};

/** Navigation-only recipes: reach the route, the screen loads its own data. */
const navOnly = (ctx) => ctx.goto(ctx.resolveRoute(ctx.row.route));

export const SETUPS = {
  'overview-loaded': navOnly,
  'content-table': navOnly,
  'content-table-en': navOnly,
  'content-board': navOnly,
  'campaigns-list': navOnly,
  'calendar-month': navOnly,
  'library-grid': navOnly,
  'shoots-bands': navOnly,
  'settings-home': navOnly,
  'numbers-weekly-entry': navOnly,
  'search-results': navOnly,
  'team-followup': navOnly,
  'mywork-writer': navOnly,

  // Recipes needing modals, fixtures, or seeded state are added as they are
  // implemented. Do NOT add a key without a real recipe — an absent key is how
  // the harness reports 'no-setup'.
};
