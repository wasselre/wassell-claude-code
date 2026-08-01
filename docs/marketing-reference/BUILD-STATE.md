# MOS exact-build — orchestration state (updated 2026-08-01 ~10:30)

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
