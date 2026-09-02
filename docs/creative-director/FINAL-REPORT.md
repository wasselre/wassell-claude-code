# Post Creative Director — Implementation Report

**Date:** 2026-09-02 · **Branch:** `claude/marketing-writing-posts-590cfc` (not pushed) · **Status:** CODE COMPLETE, dark. Nothing is live; every flag is off.

## 1. What was implemented
The post writer is now a copywriter **and** creative director. For a `post`/`carousel` content record it produces, in two stages (2–3 concepts → full package):
- **Strategy** (objective, audience, angle, message, desired response, format, intended_use organic/paid/both, master aspect).
- **On-design text** — project-name lead + 3–4 headlines (numbers only when they cite a verified project fact).
- **Base creative** separated from **placement derivatives**: organic captions per selected organic target, paid copy per selected paid target, each with a full **visual adaptation** (aspect/px from placement specs, crop/extend, text+logo reposition, layout changes, scaling, carousel slide-mapping, asset substitution, requires-separate-design).
- **Visual direction + colour palette** grounded in a structured **brand kit** (advisory until reviewed).
- **References** — 2–4 competitor/Wassel posts or slides with real previews and why/study/adapt/don't-copy/differ.
- **Asset selection** from project files, ranked by rights trust; competitor media is reference-only; restricted/do-not-use never selectable.
- **AI image recommendations** (cleanup/crop/colour/extend/declutter/combine/lifestyle/remove-text) that a human must approve before execution; outputs land as `needs_review` candidates, never `final`; a policy gate forbids fabricating a real project's building/units/interiors/views/amenities.
- **Two-level visual intelligence** — per-slide and per-whole-post/carousel design reads (narrative, continuity, cover→CTA, design system), for competitor **and** Wassel content, on the $0 subscription runner or the API.
- **Designer handoff** (concise, print-ready) + **performance linkage** + **backfill** (prioritized, resumable, idempotent, cost-gated, flag-controlled).

Provider-independent throughout: every model is data in `mos_settings.ai_roles`; no vendor is hardcoded. Built ON the sibling Script-Writer-v2 AI-role adapter + facts/claims modules (reused, not duplicated).

## 2. Architecture (final)
- **Intelligence layer** (ingestion/backfill): `visual_design_reads` (slide+post, embedding-ready), the file metadata/rights layer, the brand kit + writer rules as settings.
- **Generation layer** (queued): `mos_creative_jobs` → worker `creativeJobsLane` → `runDirector` (concepts→package→derivatives, validate + one retry) → `mos_creative_packages`/`_derivatives`/`_refs`. AI images → `generation_jobs kind='creative-image'` → `runCreativeImageJob`. Design reads → `claude_jobs kind='mkt_visual_design_slide|_post'` (runner) or the worker path.
- **API**: ~40 actions in `api/marketing-os.ts` + `api/marketing.ts`, handlers under `api/_lib/marketing/creative/`.
- **UI**: a `creative` tab on the content page + «اكتب بوست» button, four settings pages, and the Competitor-Watch design-read chip.

## 3. Agents / workstreams (11 Kimi coders, lead = Claude)
A-DB (migrations), A-AI (roles/image/runner providers + eval), A-FACTS (grounding + placement specs), A-BRAND (brand kit), A-GEN (director core), A-WORKER (lanes + IO), A-VIS (design reads + backfill), A-ASSETS (enrichment + rights + picker), A-API (endpoints + clients), A-UI (creative tab + settings). Lead: canonical contracts, all migration application + fixes, cross-package integration, and the final verification.

## 4. Migrations applied (prod `zhqqsxwealdwqzrbpwyv`)
`2026-09-02_20`..`_26` + `_29` — all applied and verified. Lead corrections before apply: `_25` rebased on the LIVE `claude_job_claim_next` (repo copy would have dropped the aqar lane); `_22` `mkt_creative_references` given `search_path 'public','extensions'` (pgvector `<=>`) + `check_function_bodies=off`. `_29`'s `business_files_search` re-emit verified against the live body first.

## 5. Feature flags (all OFF)
`mos_settings.creative_writer` = {post_enabled:false, ai_image_execution:false, design_reads_enabled:false, asset_enrich_v2:false, backfill_enabled:false}. `brand_kit` = draft/advisory. `role_map` = montage/marketing_manager. `creative_backfill` = all disabled. Wassel org registered, 4 accounts, collection OFF. Rollback = flip a flag; the code path is inert until then.

## 6. Test results
- Typecheck: **root 0, api 0, worker 0**.
- Tests: **worker 283/283**, **root (creative + placement + files) 84/84**.
- DB smoke: reference retrieval (8 ranked, 8/8 previews, 0 internal leak), candidate assets (13 for أكنان 25, rights-ranked), design-read targets present, performance view live, search baseline unchanged (7,897), aspect-family filter works.

## 7. Model-comparison data
None yet — by design. The eval harness is built (`scripts/eval/creative-*.mjs`, sets in `docs/eval/`); model comparison runs after deploy. Design-read pilot is $0 on the runner; the director eval (concepts/package) uses the Anthropic API — estimate **~$6–10 per full 20-brief run per model config** (opus-5 package role dominates); comparing N configs ≈ N×.

## 8. Remaining (needs operator decisions — NOT done)
1. **Deploy** (git push → Vercel app + `fly deploy` worker + runner). Commit the creative files only — exclude the `docs/prd/models|workflows` churn (session-start `sync:prds` regeneration, not this feature).
2. **Eval pilot** — design-read pilot ($0, runner) + director eval (report the ~$6–10 estimate and get the OK before spending).
3. **5-project end-to-end** — post + carousel, organic/paid/both, multi-aspect adaptations, grounding, references-with-previews, carousel slide order, competitor-never-production, unclear-rights confirmation, AI-recommend→approve, designer handoff, flag rollback, job retries. Needs the deploy.
4. **Brand-kit review** (Rayyan / marketing manager) → flips it to `constraint`. Open questions in `docs/brand/brand-kit-notes.md` (esp. website dark surfaces + Tajawal, recorded secondhand).
5. **Backfill tiers** — pilot first, report cost, run runner-only ($0) tiers; no substantial API spend without an estimate.
6. **Wassel account collection** stays OFF until you enable it per account.

## 9. Preserved (nothing removed)
`mos_script_jobs`, `/marketing/posts`, the unused `mkt_*` v2 schema, and competitor media (still PUBLIC) are all untouched — cleanup, if ever, is a separate approved task after parity. No routes removed, no tables dropped, no storage privatized.
