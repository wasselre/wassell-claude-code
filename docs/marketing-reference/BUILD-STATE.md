# MOS exact-build — orchestration state (updated 2026-08-01 ~11:15)

## PROVEN LIVE (do not re-derive)
- Engine end-to-end: writer bootstrap via real API returns the s33 surface map
  exactly + 2 role-path workflows (6/10 steps) at v1. Migrations 01–05 + 07 on branch.
- Migration 07 added: role_path rows readable via wassell_mos_can('read') —
  the old workflows SELECT policy gates on can_view_workflows (Sales-only flag).
- Full stack runs: `npx vite --port 5173` (branch VITE_ env) +
  `node scripts/mos-dev-server.mjs --port 3000 --vite-port 5173 --env .mos-branch.env`;
  SPA login by seeding localStorage sb-czdznzadjqzajrnjoafi-auth-token.
- FIRST CAPTURE DONE: `node scripts/mos-qa.mjs s01-main-ar-dark` (env: MOS_APP_URL,
  MOS_SUPABASE_URL/ANON from .mos-branch.local, MOS_FIXTURE_PASSWORD) → ssim 0.808 /
  pixel 94.0 vs the filled reference on an EMPTY db — dims matched, delta = missing
  fixture data + minor rail-label drift. Harness + compare pipeline WORK.
- Clock-skew note: one-off "JWT issued at future" console error on a Sales-side load
  (local clock behind AWS); resync Windows clock if it pollutes console-clean gate.
- Empty-DB ssim baselines (dims all matched): s01 0.808, s13 0.844, s14 0.830, s16 0.718.
  Gaps = missing fixture data + minor shell drift; re-capture after fixtures phase 1.
- Dev stack MUST run as harness background tasks (plain `&` children die with the
  shell): task 1 `npx vite --port 5173 --strictPort` with branch VITE_ env; task 2
  `node scripts/mos-dev-server.mjs --port 3000 --vite-port 5173 --env .mos-branch.env`.
- B3 COMPLETE (migrations 04+06 on branch, worker loops, send-notification-wa endpoint).
  Kimi part2 dispatch died once with instant exit 4 + empty output (transient) — retried.

## FIXTURES LIVE (A5 DONE — 2026-08-01 ~13:00)
- `node scripts/mos-fixtures.mjs --phase 1` PASSED VERIFY on the branch: 25 content
  items at mockup steps, V-004 at script_review r2 with the s10 note, C-002..C-008,
  7 executions + 6 ads, 16 assets, 3 shoots (2 delivered), 18 publications,
  8 attributions hitting the CRM rows in-window. Open tasks: mm2/writer3/montage4/ops1.
- Engine gaps the build surfaced → migrations 08 (workflow_role_path_start — creation
  right opens first task), 09 (versions UPDATE policy + write_content), 10 (versions
  INSERT + assign). All applied to branch. RESTART the dev server after EVERY api/ edit
  (lazy esbuild bundle caches the file state at first hit).
- Known divergence: shoot refs are SH-* (mos_next_ref trigger prefix) vs mockup SR-* —
  either migrate the prefix + re-ref rows, or accept + mask; DECIDE during s42 chase.
- Branch DB is occasionally flaky (one ERR_CONNECTION_CLOSED, one transient 401, one
  transient 400) — retry once before diagnosing; fixtures converge on re-run.

## FILLED-DATA CAPTURES (drift chase open)
Latest sweep: s01 .78 / s02 .80 / s03 .75 / s04 .85 / s13 .79 / s14 .79 / s16 .62 /
s42 .80 / s35 fixed dimension bug (manifest now reads real PNG dims — rounding off-by-one).
- s01 diff readout: STRUCTURE aligned (cards/table/paid card all in place). Red =
  (1) fixture VALUES vs mock numbers — the drive matrix sent ~14 items to 'done' but
  s01 wants ٢٣ تحت الإنتاج (≈2 done). RECONCILE the fixture drive targets against
  s01+s03 jointly (edit CONTENT drive fields in scripts/mos-fixtures.mjs, teardown-less
  re-drive is NOT possible backwards — plan: adjust targets, --teardown, full rebuild).
  (2) rail badge counts (مهامي ٦١/الحملات ٦ style badges in mock). (3) pill styling.
- s16 regressed with data (0.62): likely asset thumbnails (real vs mock placeholders)
  → candidate for the mask mechanism (masks allowed ONLY where reference shows
  placeholder media) + section layout drift.
- NEXT LOOP: per-screen: view diffs/<id>.png → fix UI or fixture values → re-capture.
  Then dispatch kimi-specs/qa-setups-full.md, then remaining clusters
  (c-content-detail-1, c-content-detail-2, c-campaign-detail, c-settings-engine,
  c-pages-remaining, d-mobile-layer), then journeys E, gates F.

Working doc for the one-phase build. Claude orchestrates + reviews; **Kimi K3 writes the
code** (`bash scripts/kimi-code.sh "$(cat <spec>)"`, specs in the session scratchpad
`kimi-specs/`; Kimi cannot run shell commands — Claude runs tsc/build/captures).
Deploy: ONLY the single final deployment (approved plan). Migrations: BRANCH-ONLY until F4.

## Done + committed
- Reference system: 51 screens, 62 frames × dark+light crops, frames-index.json
- coverage-matrix.mjs + mos-manifest.mjs → manifest.json (278 rows: 124 ssim / 154 assert)
- mos-qa.mjs + mos-qa-setups.mjs + tools/compare.py (real skimage SSIM; self-tested)
- audit.md (inventory + ledger + seams §3), api-contract.md (the coordination artifact)
- Migrations 01–05 written; 01–04 APPLIED + verified on branch `czdznzadjqzajrnjoafi`
  (2 role_paths, 55 surface cells, 135 ntf rules, legacy engine tables dropped)
- Branch bootstrap 01..14 (byte-verified prod replica) + apply-branch-sql.mjs
- Phase-0 fixture users seeded on branch; password sign-in + wassell_mos_roles PROVEN
- offline.ts (B7 engine), s13 Calendar + s14 Campaigns rebuilt, mos-dev-server.mjs
- .mos-branch.env (dev-server env), .mos-branch.local (keys) — both git-ignored

## In flight (Kimi background tasks)
- api-engine-rewrite (marketing-os.ts + client.ts + MarketingWorkspace + SettingsPage +
  migration 05) — after it lands: typecheck, review, commit, then apply 05 to branch
- worker-notifications (migration 06 + worker loops + api/internal/send-notification-wa)
- c-library-grid (s16 LibraryPage)

## Dispatch order for remaining specs (all in scratchpad kimi-specs/)
1. `api-domain-part2.md` — AFTER api-engine-rewrite lands (same file). Then apply
   migrations 05+06 to branch, typecheck, commit.
2. `a5-fixtures.md` — after part2 (fixtures drive the real API). Then: run dev server
   (`node scripts/mos-dev-server.mjs --env .mos-branch.env` + `npm run dev` for vite),
   run fixtures phase 0+1, `--verify`.
3. `c-settings-platforms-types.md` (s26/s27) — after api rewrite (SettingsPage conflict).
4. Remaining C clusters to SPEC (template = existing cluster specs; mockup extracts in
   docs/marketing-reference/source/screens/):
   - content list/board/new/EN (s03/04/05/18) — content_list + board columns from pinned
     workflow stage list (bootstrap.workflows steps)
   - content detail tabs (s06–s12 + s36 harness + s38 modal) — the biggest; split in 2–3
   - overview/mywork/team (s01/02/34/35) + remind wiring
   - campaign detail (s15/20/21/39/40) — events/outcomes/budget_shift/sign
   - library detail/unused/upload polish (s22/41/23) + shoots (s24/42)
   - settings engine screens (s17 workflows editor / s33 roles matrix / s37 people /
     s43 notifications / s25 settings home)
   - numbers (s50) + search (s44) + day-one (s45)
   - B6 overlay pass (resolveDisplayText on display surfaces) — LAST of C (touches many)
5. Mobile D (MobileTabBar + s28–32/46/48/49/51/52 + page-52 matrix rows).
6. Captures: mos-qa per-screen as clusters land (setups grow in mos-qa-setups.mjs;
   fixture ids via MOS_FIXTURE_IDS_JSON or FIXTURE_IDS map). Human --approve after
   viewing overlays. Iterate UI until ssim ≥0.98/pixel ≥99.
7. E journeys on the branch (10), F gates, legacy-removal check (already-deleted legacy
   confirmed in audit §2 — only redirects remain), rebase+push+deploy+smoke, final report,
   delete branch fc7fc812-f62f-479d-b313-6746859f6cec.

## Gotchas learned
- kimi-code.sh: Kimi's shell is blocked (acceptEdits) — never ask it to run npm/tsc.
- apply-branch-sql.mjs strips outer BEGIN/COMMIT (exec RPC limitation; call = one txn).
- GoTrue seeded users need ''-not-NULL token columns (see memory).
- Branch has NO automation workflows/records data — only config seeds + what fixtures add.
- Concurrent Kimi tasks must own DISJOINT files (marketing-os.ts is serialized).

## KIMI FLEET SUSPENDED (2026-08-01 ~14:00) — awaiting Moonshot recharge
Moonshot org org-4d0f622b… hit insufficient balance mid-wave; all 8 sessions died.
Salvaged as WIP commit: content-detail-1 (substantial, compiles — VERIFY against its
spec before calling done: header shortcuts/version compare/activity rail/s36 gating),
fixture-reconciliation partial. Wrote NOTHING: content-detail-2, campaign-detail,
settings-engine (2-line fragment reverted), pages-remaining, mobile-shell.
RELAUNCH QUEUE after recharge (specs in kimi-specs/): verify-finish content-detail-1 →
content-detail-2 + campaign-detail + settings-engine + pages-remaining + mobile-shell
(all disjoint, can fan out) + fixture-value-reconciliation resume.
Alternative if user prefers: Claude codes the remaining clusters directly.

## CHECKPOINT 2026-08-01 ~15:00 — dual-limit pause, huge salvage integrated
Claude session limit hit (resets 9pm Riyadh); Moonshot still awaiting recharge.
LANDED + BUILD GREEN + s33 matrix verified live: CD1 complete (spec checklist,
incl. real authz fix); SettingsWorkflows/Access/People mounted (people+roles
sections split); AssetDetail/ShootRequest/LibraryUnused/Account routed;
MobileTabBar mounted. Legacy WorkflowsSection/RolesSection/StepModal deleted.
STILL TO BUILD: cd2 tabs (s09-12) — nothing written; campaign-detail cluster —
nothing written; settings s25 home cards + s43 notifications page + bell;
pages-remaining leftovers (SearchPage/NumbersPage/ShootsPage edits, EmptyDayOne);
mobile responsive pass (d-mobile-layer minus shell); fixture reconciliation
finish; B6 overlay; captures/approvals; journeys; gates. All specs in kimi-specs/.
RESUME: after 9pm say continue (Claude agents) OR recharge Moonshot anytime
(kimi-code.sh pipeline — independent budget). Browser gotcha: after vite HMR
bursts, hard-reload the tab before judging runtime errors (stale module mix).

## MODEL POLICY (2026-08-01) — Opus 4.8 for all NEW agents
User switched the session to claude-opus-4-8 and asked all future agents to run on it.
=> Every Agent() spawn from here passes model:"opus" explicitly. The 4 mobile agents
launched just before the switch (ac2970/a3c2d4/ab3360/a17ae0) finish on Fable 5 — left
alone rather than killed mid-file. Kimi pipeline (kimi-code.sh) is a separate budget,
unaffected.

## DEFINITIVE SWEEP + DIAGNOSIS (2026-08-03) — all 46 screens built & measured
Full app built (desktop + mobile), build green. SSIM map: 106 scored 0.47-0.89,
18 no-score (capture-setup gaps: s11/s12/s17/s40 tab-state recipes, mobile
phone-subframe recipes). NONE at the 0.98 gate yet.
DIAGNOSIS (overlay zoom, s01): LAYOUTS ARE PIXEL-ALIGNED — cards/table/rail/
borders + digits overlay as single crisp images. Residual gap is (1) sub-pixel
text rendering (live React+mos.css vs the static mockup HTML/CSS — two CSS
implementations of one design differ at the sub-pixel level everywhere text is
dense), (2) documented mock-vs-data divergences (RECONCILIATION: badge counts,
some sublabels the mockups contradict), (3) minor per-screen spacing/color.
Tested + REJECTED the single-systematic-fix hypothesis: adding Noto Naskh (was
missing vs reference) moved s01 0.767->0.768 — kept for parity, not a lever.
OPEN QUESTION FOR USER: 0.98 SSIM between a React reimplementation and a static
HTML artifact is an extremely tight bar; text-dense screens may cap ~0.90-0.95
even at character-perfect parity. Polish grind (46 screens x rounds, Opus) is
the largest remaining spend. Decision needed: chase 0.98 hard, or set the gate
at an achievable per-screen ceiling with human sign-off on the overlay.

## OPTION-A DONE + DEPLOY PLAN (2026-08-03)
Real fixes shipped: 48h stalled cutoff (api) + notification trim (fixtures) —
verified on branch (stalled 8->4, unread 66->0, s01 0.767->0.792). The other
two "bugs" were interactive-tab artifacts (wrong width = mobile branch showed
short labels; real clock = +5d ages), NOT real — the frozen-clock DESKTOP
capture was already correct. Desktop labels (بانتظارك أنت / ٩ مجدولة · ٣) already
right in code. Deep cosmetic SSIM grind DEFERRED per user (gap = sub-pixel
React-vs-static-HTML rendering, invisible to a person). B6 bilingual overlay:
still PENDING (not in option-a scope; journey 9 = documented partial).

Journeys (E): running on an Opus agent (scripts/mos-journeys.mjs).

DEPLOY (F) — NOT YET EXECUTED, needs explicit go (irreversible prod cutover):
- Branch is 45 commits ahead; origin/main DIVERGED (a 2026-08-03 whatsapp
  migration landed from another session) — MUST rebase onto origin/main first.
- 13 migrations reach prod incl. 01 which DROPS mos_workflows/steps/tasks/
  role_grants and rebuilds the canonical engine. PROD HAS REAL (small) DATA:
  3 content, 4 campaigns, 5 tasks, 2 workflows, 3 role_grants, 2 assets, 4 types.
  Migration 01's data-migration was validated on branch FIXTURES, not prod's
  exact rows — re-validate against prod before/at apply.
- Migrations reach prod MANUALLY (Supabase MCP apply_migration), NOT via Vercel.
  Order: apply migrations to prod FIRST, then push code to main (else the shipped
  app expects an engine the DB doesn't have yet). Coordinate tightly.
- Cutover steps: rebase -> full build -> apply 01..11 to prod (verify 01's
  validation block passes on prod data) -> push HEAD:main -> verify newest READY
  Vercel SHA -> live smoke as each role -> final report -> delete branch
  fc7fc812 / czdznzadjqzajrnjoafi.
