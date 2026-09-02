# A-VIS — report (Post Creative Director: static design reads)

*2026-09-02. Scope: skills, runner handlers, validator, worker design-read
path, backfill controller, design-read lane, reads-on-publish hook, vocab doc.*

## Files created

| File | What |
|---|---|
| `.claude/skills/visual-design-read-slide/SKILL.md` | Headless skill: manifest → one `SlideRead` per image. Full controlled vocabulary inline. |
| `.claude/skills/visual-design-read-post/SKILL.md` | Headless skill: ALL slides of a post in carousel order (+ existing slide reads as evidence) → one `PostRead`. |
| `scripts/lib/visual-design-validate.mjs` | Pure validators: `validateSlideReads(raw, manifest)`, `validatePostReads(raw, posts)`, `slideReadProblems(read, path)`, `postReadProblems(read, path, slideCount)`. REJECTS bad enums (never coerces — a coerced enum would corrupt the ranking generated columns), drops hallucinated ids, PostRead sequence sanity (slide_count vs manifest, role_sequence/content_density_profile lengths, cta_slide_index range, relations range, hex/range checks). |
| `scripts/lib/visual-design-validate.test.mjs` | 13 vitest cases (valid accept, hallucinated id, enum rejection, duplicates, missing-entry, sequence sanity, single-image post). |
| `worker/src/creative/designRead/schemas.ts` | `SLIDE_READ_SCHEMA`, `POST_READ_SCHEMA` (structured-output JSON schemas) + TS runtime validators (PORT of the .mjs — worker can't import scripts/) + `assertValidRead(level, read, slideCount)` (throws `validation_unrepaired:`). |
| `worker/src/creative/designRead/prompts.ts` | `SLIDE_READ_SYSTEM` / `POST_READ_SYSTEM`, `slideReadUserPrompt(ctx)`, `postReadUserPrompt(slides, ctx)` (slide reads included as evidence). |
| `worker/src/creative/designRead/persist.ts` | `DESIGN_READ_RULE_VERSION = 'v1'`; `upsertDesignRead(sb, args)` → `visual_design_read_upsert` RPC (embedding passed in `'[…]'` text form). |
| `worker/src/creative/designRead/readSlide.ts` | `SlideReadItem`, `DesignReadDeps` (sb / ctx / callRole / embedImage / log — all injectable), `ReadOutcome`, `readSlide(item, deps)` → `callCreativeRole('design_read_slide', …)` with the public `stored_url` image → validate → optional SigLIP-2 embed via `embed('embed_image')` when `MODAL_CV_URL` set (catch scoped + `console.error`, read persists without vector — never fatal) → upsert with `model_used = '<provider>:<model>'` from the result + cost recorded. |
| `worker/src/creative/designRead/readPost.ts` | `PostReadPost`, `PostReadSlide`, `readPost(post, slides, deps)` — slides sorted by carousel_index, all sent as images, slide reads in the prompt; validates against the real slide count; upserts level 'post'. |
| `worker/src/creative/designRead/wasselOnPublish.ts` | `subjectKindForOrgType(level, orgType)` (internal → `wassel_file`/`wassel_content`), `wasselReadTargets(sb, level, modelUsed, ruleVersion, limit)` (tier 5), `resolveWasselPublicationSubjects(sb, publicationId)` (publication → internal-org collected post → verify stored media → subjects). |
| `worker/src/creative/backfill.ts` | Shared controller (A-ASSETS reuses): `BackfillConfig`, `readBackfillConfig(sb, kind)`, `BackfillKindHandler<TTarget>`, `BackfillBatchResult`, `runBackfillBatch(handler, deps)`. Config from `mos_settings.creative_backfill.<kind>` re-read EVERY batch (interruptible); pilot = only `pilot_ids` (tier 0); tier walk in config order; cost gate worker-lane-only (`approved_cost_usd >= items × estimated_cost_per_item`, else `console.error` + `skipped:'cost_gate'`, no run opened); run rows via `creative_backfill_run_start/finish` (failed runs closed `status:'failed'` and the error rethrown). |
| `worker/src/creative/lanes/designReadLane.ts` | `designReadLoop: LaneLoop` + `designReadTick` (exported for tests). Flag `creative_writer.design_reads_enabled` (30 s sleep when off). Per tick: (a) incremental competitor slides then posts (tiers 1–4, newest first), (b) Wassel tier 5 both levels, (c) one `runBackfillBatch` when `creative_backfill.design_reads.enabled`. Runner lane → `enqueueRunnerRead` (never awaited; in-flight dedup from `claude_jobs` payloads; self-select jobs pause further enqueue; high-water 8 jobs/kind). Worker lane → direct `readSlide`/`readPost`. A role resolving to provider 'runner' forces the runner path (`effectiveLane`). `modelUsedFor` keeps targets + upserts on the same `model_used` string. Local `LaneDeps`/`LaneLoop` copy — see Deviations. |
| `api/_lib/marketing/creative/onPublished.ts` | `enqueueWasselReadsOnPublish(svc, publicationId)` — no new tables, no job writes: verifies the publication's collected internal-org post + stored media exist and returns `{ok, reason?, publication_id, post_id, subjects}` (post subject first, then per-slide `wassel_file` subjects). Reasons: `publication_not_found | wassel_org_not_registered | no_external_ref | not_collected_yet | assets_not_stored_yet` — the state-driven lane picks it up later. |
| `docs/creative-director/design-read-vocab.md` | Controlled vocabulary (identical to contracts.ts enums) + subject mapping table + reading rules. Both skills link here. |

## Files changed

- `scripts/claude-study-runner.mjs` — ADDITIVE only: import of the new validator; constants `DESIGN_READ_RULE_VERSION='v1'`, `DESIGN_READ_MODEL='claude-runner:design-read'`; new section with `handleMktVisualDesignSlide` (items from `payload.manifest_items` `{media_id, post_id, stored_url, carousel_index, org, subject_kind?}`, else self-select ≤24 via `creative_design_read_targets` tier walk; `{stored_url}`-only items resolved via `mkt_content_media.stored_url`; stage → `/visual-design-read-slide` → validate → upsert `p_model_task='design_read_slide'`, `p_cost_usd=0`) and `handleMktVisualDesignPost` (≤6 posts, ALL stored slides each + latest stored slide reads as evidence; subject_kind resolved via `mkt_organizations.org_type`); both registered in `HANDLERS`. Job result `{processed, failed, ids, validation_errors}`. Existing handlers untouched.
  - **Lane mapping:** nothing to add in the runner — the kind→lane table is DB-side (`v_ocr_kinds` in the claimer), and migration `_25` already lists both kinds there. Verified against `2026-07-29_aqar_listing_extract_lane.sql`.

## Exported signatures (key ones)

```ts
// worker/src/creative/designRead/readSlide.ts
readSlide(item: SlideReadItem, deps: DesignReadDeps): Promise<ReadOutcome>
// worker/src/creative/designRead/readPost.ts
readPost(post: PostReadPost, slides: PostReadSlide[], deps: DesignReadDeps): Promise<ReadOutcome>
// worker/src/creative/designRead/persist.ts
upsertDesignRead(sb, args: DesignReadUpsertArgs): Promise<string>
// worker/src/creative/backfill.ts
runBackfillBatch<T>(handler: BackfillKindHandler<T>, deps: BackfillDeps): Promise<BackfillBatchResult>
// worker/src/creative/lanes/designReadLane.ts
designReadLoop: LaneLoop; designReadTick(sb, log, workerId): Promise<void>
designReadsBackfillHandler(args: DesignReadsBackfillArgs): BackfillKindHandler<DesignBackfillTarget>
// api/_lib/marketing/creative/onPublished.ts
enqueueWasselReadsOnPublish(svc, publicationId): Promise<WasselReadsOnPublishResult>
```

## Tests + typecheck (all commands run, tails pasted)

- `cd worker && npm run typecheck` — **my files clean.** Remaining errors are all in peer A-AI's `src/creative/imageProvider.ts` (5× TS2345 `Promise<ImageGenStartResult>` not awaited) — not mine to fix.
- `cd worker && npx vitest run src/creative` — `Tests 4 failed | 233 passed (237)`. The 4 failures are peer-owned: `assetMeta.test.ts` (A-ASSETS, sharp fixture), `imageProvider.test.ts` ×2 (A-AI), `placementSpecs.test.ts` (A-FACTS). My files: `backfill.test.ts` 11/11, `designRead.test.ts` 7/7.
- `npx vitest run scripts/lib/visual-design-validate.test.mjs` — 13/13 pass (run via root vitest, same as the existing `scripts/lib/*.test.mjs`).
- `npx tsc --noEmit -p tsconfig.api.json` — clean (onPublished included).
- `node --check scripts/claude-study-runner.mjs` — OK.
- Live RPC probe (read-only + one self-cleaned probe run row):
  `creative_design_read_targets` slide tier 1 → real rows with subject_kind/stored_url; post tier 2 → rows; `creative_backfill_run_start/finish` → created + completed run `ef8fbe04-…` (kind `design_reads_probe`, note "probe — safe to delete"); `mos_settings.creative_backfill` seed confirmed (`design_reads` lane runner, disabled).

## Contract deviations / decisions to note

1. **`model_used` on the worker lane is `'<provider>:<model>'`** (e.g. `anthropic:claude-sonnet-5`), on the runner lane the constant `claude-runner:design-read` (matches the runner handler). `modelUsedFor()` in the lane keeps the targets RPC and the upsert on the same string — without that, reads would never mark targets done.
2. **Lane-mode source:** the lane reads `mos_settings.creative_backfill.design_reads.lane` for BOTH incremental and backfill work (the brief names this config for backfill; the incremental sweep needs the same runner/worker decision and no second knob exists). A role whose provider is `'runner'` forces the runner path regardless.
3. **Backfill `lane` vs role mismatch:** if config says `worker` but the role resolves to `runner`, the lane enqueues runner jobs rather than blocking the loop on a 30-min poll (callViaRunner awaits).
4. **Pilot ids are `mkt_content_posts` ids** (post-level pilot; slides derived). A-AI's `docs/eval/creative-design-read-pilot.json` should contain post ids.
5. **Local `LaneDeps`/`LaneLoop`** declared in `designReadLane.ts` — identical to the contracted `worker/src/creative/lanes/types.ts` (A-WORKER, absent at build time). When it lands, delete the local block and import from `./types.js`.
6. **Runner handler upserts only `status='done'` rows** — failures throw/retry at the job level, so a failed read never blocks reprocessing (the targets RPC ignores row status). The worker path throws per item and retries next tick, same posture.
7. **`enqueueWasselReadsOnPublish` enqueues nothing** (despite the name, per the brief: "verifies the published assets exist and returns the subjects the sweep will pick up"). The sweep owns the actual work.

## What others must do

- **A-WORKER:** register `designReadLoop` from `worker/src/creative/lanes/designReadLane.ts` in `worker/src/index.ts` (lane contract `LaneDeps` matches §3 verbatim); when `lanes/types.ts` lands, tell me (or the lead) to swap the local type copy for an import.
- **A-API:** call `enqueueWasselReadsOnPublish(svc, publicationId)` from the publish path (best-effort; log the reason when `!ok`).
- **A-AI:** `docs/eval/creative-design-read-pilot.json` should contain `mkt_content_posts` ids (post-level pilot, deviation 4). `imageProvider.ts` currently fails worker typecheck (5× missing `await`) — flagged, not mine.
- **A-ASSETS:** reuse `runBackfillBatch` + `BackfillKindHandler` from `worker/src/creative/backfill.ts` for `asset_meta` / `asset_enrich`; your config keys are already seeded.
- **Lead:** the probe run row `ef8fbe04-448b-498e-ac1d-05e4d8907062` (kind `design_reads_probe`) in `creative_backfill_runs` can be deleted. Deploy note: the two new `claude_jobs` kinds run on the OCR lane (`v_ocr_kinds` already updated by `_25`) — the Fly `wassel-claude-runner` needs a redeploy to pick up the new handlers before `design_reads_enabled` is flipped.
