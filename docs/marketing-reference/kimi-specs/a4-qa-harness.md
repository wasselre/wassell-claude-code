TASK: Write THREE new files (nothing else; do not run anything):
1. scripts/mos-qa.mjs — deterministic capture + comparison harness
2. scripts/mos-qa-setups.mjs — setup-recipe registry (skeleton with the first recipes)
3. docs/marketing-reference/tools/compare.py — real-SSIM + pixel comparison

READ FIRST: docs/marketing-reference/manifest.json (row shape), docs/marketing-reference/coverage-matrix.mjs (semantics header), scripts/mos-manifest.mjs, docs/marketing-reference/tools/render-refs.mjs (puppeteer conventions), src/pages/Marketing/MarketingWorkspace.tsx (the app shell under test).

=== compare.py ===
CLI: python compare.py <reference.png> <actual.png> <overlay_out.png> <diff_out.png> [masks_json]
- Loads both as RGB numpy arrays. If dimensions differ: print JSON {"dim_match": false, "ref": [w,h], "actual": [w,h]} and exit 0 (the harness fails the row; NO resizing/aligning/warping EVER).
- Optional masks_json = JSON list of {x,y,w,h} rects: sets those rects to a constant mid-gray in BOTH images before comparison (only used where the reference itself shows placeholder media).
- SSIM: from skimage.metrics import structural_similarity, channel_axis=2 on the full images (float, data_range 255).
- Pixel diff: per-pixel max channel abs delta; a pixel "differs" if delta > 25 (tolerance for AA); pixel_pct = 100 * (1 - differing/total).
- Overlay: reference at 50% alpha over actual → overlay_out.
- Diff visualization: differing pixels red on a desaturated actual → diff_out.
- Prints one JSON line: {"dim_match": true, "ssim": 0.9x, "pixel_pct": 99.x, "width": w, "height": h}.

=== scripts/mos-qa-setups.mjs ===
Exports SETUPS: Record<string, (ctx) => Promise<void>> and FIXTURE_IDS (placeholder map: v004, v001, p013, c002, e1, a012, sr003 → env-overridable via process.env.MOS_FIXTURE_IDS_JSON, default {}). ctx = { page (puppeteer Page — already authenticated, correct locale/theme/viewport, app booted at appUrl), appUrl, row (the manifest row), resolveRoute(route) (replaces :v004-style tokens from FIXTURE_IDS; THROWS on unresolved token), goto(path) helper (page.goto(appUrl+path, waitUntil networkidle0) then waits for fonts + 500ms settle) }.
First recipes (navigation-only): 'overview-loaded', 'content-table', 'content-table-en', 'content-board', 'campaigns-list', 'calendar-month', 'library-grid', 'shoots-bands', 'settings-home', 'numbers-weekly-entry', 'search-results', 'team-followup', 'mywork-writer' — each: await ctx.goto(ctx.resolveRoute(ctx.row.route)). Recipes needing modals/fixtures come later — do NOT stub them with fake passes; absent key = the harness reports no-setup.

=== scripts/mos-qa.mjs ===
CLI: node scripts/mos-qa.mjs [row-id ...] [--all] [--gate=ssim|assert] [--screen=NN] [--approve id ...] [--list-pending]
Env: MOS_APP_URL (default http://localhost:3000), MOS_SUPABASE_URL, MOS_SUPABASE_ANON_KEY, MOS_QA_EPOCH (default '2026-07-29T10:00:00+03:00'), MOS_FIXTURE_PASSWORD, role emails pattern mos-<role>@fixtures.wassel.local.

Flow per selected row:
1. Resolve setup id: row.setup, parsing an optional '@role=<r>' suffix (overrides row.role). Missing from SETUPS → record {status:'pending', note:'no-setup'} and continue (collect + report at end, nonzero exit).
2. Browser per (role, locale, theme, viewport) combo — reuse a shared puppeteer instance; new incognito context per role. Launch env: TZ='Asia/Riyadh'. Viewport = row.viewport, deviceScaleFactor 1.
3. Determinism, BEFORE any app load (evaluateOnNewDocument):
   - Freeze time: overwrite Date with a subclass where new Date() with no args and Date.now() return MOS_QA_EPOCH (advancing by real elapsed ms is NOT wanted — truly frozen); keep explicit-arg constructors working.
   - Stub matchMedia prefers-reduced-motion to true.
   - Inject CSS on load (page.evaluate after goto or a <style> via addStyleTag): *,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}
4. emulateMediaFeatures prefers-color-scheme = row.theme.
5. AUTH: sign in via fetch POST `${MOS_SUPABASE_URL}/auth/v1/token?grant_type=password` (headers apikey + content-type) with the role user's email/password; on failure THROW with the auth error body. Compute projectRef from the URL host (first dns label). Before first navigation, page.evaluateOnNewDocument to seed localStorage: key `sb-${projectRef}-auth-token` = JSON.stringify(session object as returned in the token response body — supabase-js v2 expects the full session json), plus the language key: localStorage 'wassell_language' = JSON.stringify(row.locale) — that is the key src/lib/i18n.ts storedLanguage() reads (JSON-encoded string, e.g. '"en"').
6. Load: goto appUrl + '/m' first (app boot), wait for networkidle0 + document.fonts.ready. AMIRI ASSERTION: in-page probe — create two spans ('اختبار النص' with font-family 'Amiri' vs 'serif'), compare widths; identical widths ⇒ Amiri did not render ⇒ FAIL the row with note 'amiri-fallback'.
7. Run the setup recipe.
8. Capture viewport screenshot (PNG) → docs/marketing-reference/actual-screenshots/<row.id>.png.
9. gate 'ssim': spawn python docs/marketing-reference/tools/compare.py ref actual overlays/<id>.png diffs/<id>.png; parse JSON. Row result: dim_match false → status 'fail', note 'dimension-mismatch'; else pass_metrics = ssim >= 0.98 && pixel_pct >= 99 → status 'metrics-pass' else 'fail'. Record evidence {actual, overlay, diff, ssim, pixel_pct}.
   gate 'assert': status 'captured' with evidence.actual (assertions per-setup come later; never auto-pass).
10. FINAL 'pass' requires human approval: --approve <id> flips a row from 'metrics-pass' or 'captured' to 'pass' setting evidence.inspected=true. Never auto-approve.
11. Persist results into docs/marketing-reference/manifest.json (read-modify-write; keep unrelated rows untouched) and regenerate manifest.md via the same table format scripts/mos-manifest.mjs uses (import its md-rendering if exported, else duplicate the small renderer).
12. Summary table to stdout: counts per status + list of failures with notes. Exit 1 if any selected row is 'fail' or 'no-setup'.

Style: plain ESM JS, no new deps (puppeteer/pixelmatch/pngjs resolve via createRequire from docs/marketing-reference/tools/node_modules — do createRequire(join(root,'docs/marketing-reference/tools/package.json')) and require('puppeteer')). python invoked as 'python'. Loud failures everywhere; no silent catches. When done print exactly: QA-HARNESS WRITTEN.
