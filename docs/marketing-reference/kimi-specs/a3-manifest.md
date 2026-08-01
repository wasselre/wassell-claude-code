TASK: Write ONE new file: scripts/mos-manifest.mjs — the coverage-manifest generator for the Marketing workspace visual gate. Write the file only; do not run it, do not modify other files.

INPUTS (both exist — READ BOTH FIRST):
- docs/marketing-reference/frames-index.json — per screen: { n, id, title, frames: [{ key, kind: 'desktop'|'phone', file_dark, file_light, width, height }] }. 51 screens, 62 frames.
- docs/marketing-reference/coverage-matrix.mjs — exports SCREENS, ALL_ROUTES, MOBILE_VIEWPORTS, ROLES, NAV_VISIBILITY_ROLES. Its header comment defines the semantics — follow it exactly.

OUTPUTS (paths relative to repo root):
- docs/marketing-reference/manifest.json
- docs/marketing-reference/manifest.md (readable table)

ROW GENERATION RULES (no artificial cap — emit whatever the rules produce):

1. REFERENCE ROWS (gate 'ssim'): for every screen in frames-index that has an entry in SCREENS, for every frame, for theme in ['dark','light']:
   - locale = SCREENS[n].locale ?? 'ar' (screen 18 declares locale 'en')
   - role = SCREENS[n].role ?? 'marketing_manager'
   - setup = frame-level override SCREENS[n].frames?.[frame.key]?.setup ?? SCREENS[n].setup; route likewise (frame-level route override wins).
   - viewport = { width: frame.width, height: frame.height } (the crop's exact dimensions)
   - reference = frame.file_dark / frame.file_light per theme
   - id = `s${NN}-${frame.key}-${locale}-${theme}` (NN zero-padded)
2. EXTRA SUBSTATE ROWS: SCREENS[n].extraSubstates (array of {key, setup, gate, notes}) → one row per theme with gate as declared ('assert' rows have reference null), viewport = the screen's FIRST frame dims, id `s${NN}-${key}-ar-${theme}`.
3. EN MIRROR ROWS (gate 'assert'): for every screen with en: true → one row locale 'en', theme 'dark', reference null, viewport = first frame dims, id `s${NN}-main-en-mirror`. (Screen 18 covers the ssim-grade EN case.)
4. ROLE VARIANT ROWS (gate 'assert'): for every screen with roleVariants → one row per role in the list, locale ar, theme dark, reference null, id `s${NN}-role-${role}`, viewport = first frame dims, setup = SCREENS[n].setup + `@role=${role}` (string suffix convention the QA harness parses).
5. PAGE-52 MOBILE PATTERN ROWS (gate 'assert'): for every entry in ALL_ROUTES × every viewport in MOBILE_VIEWPORTS → id `route-${slug(route)}-${vp.key}`, locale ar, theme dark, reference null. slug(route) = route with non-alphanumerics collapsed to '-'; keep it stable and collision-free (include query part).
6. NAV VISIBILITY ROWS (gate 'assert'): for every role in NAV_VISIBILITY_ROLES → two rows: `nav-${role}-desktop` (viewport 1320x760) and `nav-${role}-iphone` (390x844), route '/m', setup `overview-loaded@role=${role}`, notes 'rail/tab set must equal surface_access — hidden means absent'.

Each row object: { id, screen: n|null, title, frame_key|null, surface, route, setup, locale, theme, role, viewport: {width,height}, gate: 'ssim'|'assert', reference: path|null, status: 'pending', evidence: { actual: null, overlay: null, diff: null, ssim: null, pixel_pct: null, inspected: false }, notes? }.
DEDUPE: if two rules produce the same id, throw. Sort rows: reference rows by screen then frame then locale then theme; then extra/en/role; then route rows; then nav rows.

manifest.json = { generated_at, source: { frames_index: 'frames-index.json', matrix: 'coverage-matrix.mjs' }, totals: { rows, ssim, assert, by_gate_pending: ... }, rows: [...] }.
manifest.md = header with the totals + one markdown table (id | screen | route | setup | locale | theme | role | viewport | gate | status) — full listing, no truncation.

IMPORTANT BEHAVIOR: the script is a PURE GENERATOR — but re-running it must NOT wipe QA progress: if docs/marketing-reference/manifest.json already exists, carry forward status + evidence for rows whose id AND (setup, route, viewport, reference) are unchanged; changed or new rows reset to pending. Log how many were carried vs reset.

Plain modern JS, ESM, no deps beyond node:fs/node:path/node:url. Import coverage-matrix.mjs with a relative file URL. When done, print exactly: MANIFEST-GENERATOR WRITTEN.
