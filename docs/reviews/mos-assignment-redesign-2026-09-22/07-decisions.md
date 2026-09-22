# Operational decisions taken — 2026-09-22 (afternoon)

Governing with `01-plan-v9.md`: where this file changes a §10A item or simplifies a section, this file wins. Technical review (six rounds, Codex) approved the technical design; every item below is the operator's own choice (Rayan), recorded verbatim in substance.

## Decisions

| # | Decision | Effect on the plan |
|---|---|---|
| D1 | The two publishing steps (`scheduling`, `publish_check`) are removed from the live workflow definition; publishing is seen only on the existing publishing page; no task is ever created for it. Target hours cover the five production steps: writing 4, writer review 2, design 4, designer-writer check 2, final approval 2. | **New work item W1**: remove the two steps from `workflows.metadata.steps` for `post_std` (a new version is snapshotted), re-pin in-flight organic items to it. Root cause recorded: the 14 Sep release split shortened the versions but not the live definition; the 17 Sep labels-only migration touched the live definition and the versioning snapshot re-created the 7-step path as version 9 (90 items pinned, incl. the 21 launch creatives). |
| D2 | Planned work is never held back by a capacity counter at hand-out time; the confirmed month plan is the only cap. | §3/§4 as written (dispatch capacity gate removed; `OR used = 0` removed). |
| D3 | Rule: work started early keeps its planned deadline. Existing bookings: **re-plan the running month** instead of correcting dates in place. "Remove whatever we had before and re-plan; delete it and change the dates." | §2 one-shot correction **dropped**. The re-plan must run AFTER the scheduler comparator fix and the new commit path are live, or it reproduces the same inversions. **Carry-forward extended to materialised creatives** (by `content_key` within the same campaign/execution) so a re-plan re-dates P-471…491 and keeps their records, captions and designs; the old plan's bookings are retired (`superseded`) and the new plan's bookings replace them. In-progress (assigned) work keeps its record; follow-up A sets the three early-started launch designs to their planned deadline in the transition. |
| D4 | No caption approval. The caption approved at writing review is the caption; the manager's final approval launches the ad. **Hashtags removed entirely** (field, screens, composition, and stripped from old records). | §5f simplified: the AI caption phase, the caption task, the manager caption approval, the `caption_review` state, the `caption.approve` event and decisions 22/23/24 are **dropped**. Meta jobs are `create` only. At final approval the caption must be writer-confirmed and its hash must equal the approval's `caption_hash`; otherwise the final approval is refused with «ثبّت الكابشن أولًا». Built text = the approved caption exactly; `built_text_hash = approval_hash` by construction. 7 of the 21 launch creatives currently lack a confirmed caption and need it before launch. **New work item W2**: remove `hashtags` from the content field schema, the writing UI, `writeCaption` inputs, the ad composition, and the organic release composition (`releaseMaterial.ts`, «hashtags are folded in at publish»); strip `data.hashtags` from existing records. |
| D5 | The first-batch exception stays as it is. | §4g unchanged. |
| D6 | Option A: risk is judged per item; the person's total load is shown beside it. | §1c unchanged. |
| D7 | Horizon 14 days; the «قادم حسب الخطة» band is **hidden by default** and the person can open it. | §4a: Band C collapsed by default, one toggle; setting `planning.band_c_horizon_days = 14`. |
| D8 | The four 27 Sep writing tasks (P-488…491) are handled by the re-plan, not by special migration treatment. | §6c step 6 for the four: no special-casing beyond what the re-plan carry-forward does (they are carried as bound-unassigned and re-dated). |
| D9 | Archiving content closes its open tasks. ("close") | As proposed. |
| D10 | A plan with no campaign link commits as a fresh campaign; overlap is caught loudly by the guard. | As proposed. |
| D11 | Started work is not moved by a re-plan; the planner compiles around it. If the workload moved between preview and confirm, the commit refuses and the operator re-plans; no automatic transfer. (Operator: "how will they have work from the old plan if we re-plan?" — they keep only what they already started.) | Guard as written; refusal names the person and day. |
| D12 | Required work arriving takes back an open early offer. | §4d step 3 as written. |
| D12b | Tasks without reservations are assigned before early work is offered. | §4d step 2 before step 5, as written. |
| D15 | A finished post with no publish date reads `unscheduled`. (Publish dates come from the confirmed plan; the label can only appear on content created outside a plan.) | As proposed. |
| D16 | Unstarted work carried into a re-plan takes the new dates. ("new") | As proposed. |
| D17 | Start-early re-checks correctness only; the click is the person's decision. ("no" to further refusals) | §4f as written. |
| D18 | Deferred to backend behavior by the operator ("I'm not the one creating ads, it is the backend"): retry creates a fresh job; bulk push de-duplicates per ad. | §5f per-path rule, minus the caption phase. |
| D19 | A stalled item reads `at_risk` with reason `stalled`. ("yes") | As proposed. |
| A | The three early-started launch designs keep their current deadlines; no reset in the transition. ("leave them") | Migration: the 17 assigned tasks are stamped with `plan_*`, and `due_at` is left unchanged for the three launch designs (they read late until closed). |
| B | No hashtags anywhere, organic posts included. ("confirm") | Part of W2. |

Technical parameters (§10B) stand as proposed: recovery cron every 1–2 min; 403 before 409; completion events kept; `retry_later` parking after ~60 attempts with the `ad_failed` alert. With D4 the `retry_later` path can only arise from a create job on a row before its start state, which no longer exists — it is kept as a guard, never expected to fire.

## Implementation order (nothing deployed until "push")

1. **S1 — scheduler comparator** (`schedule.ts:271`, `min` not `max`) + saturated-designer test. Prerequisite for any re-plan.
2. **S2 — database layer** (backward-compatible migration; applied to prod per the standing rule): statuses `bound`/`superseded` + provenance; `target_hours`; task columns; partial live-set unique index; ledger arms; `mos_completion_events` + `notifications.dedupe_key`; settings; new functions and rewired RPCs; CI fixture.
3. **S3 — API + worker**: completion contract and runner; Meta enqueue RPC (create-only) and worker build from the approved payload with the approval-hash check and ownership guard; refill, bands, start-early endpoints; commit result consumer.
4. **S4 — SPA**: event ids per action; three bands (C hidden by default); start-early; plan dates and risk chips.
5. **S5 — W1 workflow fix + W2 hashtag removal + transition**: remove the two steps and re-pin; strip hashtags; migrate open tasks (17 assigned stamped, the three launch designs reset per A); then the operator re-plans September in the app.

## Implementation status — 2026-09-22 (evening)

| Slice | State | Proof |
|---|---|---|
| S1 scheduler comparator | done | `successorCap.test.ts` fails before / passes after; suite green |
| S2 database layer | done, **applied to production** (migrations `2026-09-22_01..06`, one transaction, dry-run with assertions first) | smoke report: conformance 0, refill idempotent, launch creatives not `on_track`, versions `post_std` v10 / `video_std` v8 without publishing steps |
| S3 API + worker | done (committed locally, not pushed) | `tsc` clean for api / src / worker; `npm test` 2728 passed |
| S4 SPA | done (bands A/B/C, event ids per action, transport replay, `AdFailedCard`) | same |
| S5 W1 workflow fix (in 06) + W2 hashtags (`2026-09-22_07`, **applied**: 15 records + `post` type stripped) + PRDs | done | `SELECT count(*) … data ? 'hashtags'` = 0 for content and versions |

Not yet done, by the operator's instruction: **push / deploy** (Vercel + `fly deploy` of the worker for the Meta-ad changes), then **the September re-plan in the app** (D3/D8/D16 — the existing bookings are corrected by that re-plan, never in place).
