# A-WORKER — report (Post Creative Director worker lanes + pipeline)

*2026-09-02. Briefs: `docs/creative-director/briefs/_COMMON.md` + `A-WORKER.md`. Contract: `docs/creative-director-contracts.md`.*

## Files created

| File | What |
|---|---|
| `worker/src/creative/lanes/types.ts` | **Written first.** `LaneDeps { supabase, env, workerId, sleep(ms), isShuttingDown(), log(msg, extra?) }`, `LaneLoop = (deps) => Promise<void>` (contracts §3). Peer lanes (A-VIS designReadLane, A-ASSETS assetMetaLane) declared structurally identical local copies, so one deps bag fits all four loops. |
| `worker/src/creative/io.ts` | ALL DB access for the mos_creative_jobs pipeline. See exports below. |
| `worker/src/creative/runCreativeJob.ts` | The four job kinds + stage heartbeats + persist guards + error classification. |
| `worker/src/creative/lanes/creativeJobsLane.ts` | `creativeJobsLoop` + `claimAndRunOneCreativeJob` — flag-gated (`creative_writer.post_enabled`), 4 s poll, watchdog every 5 min. |
| `worker/src/creative/runCreativeImageJob.ts` | The `creative-image` executor (flag gate, §7 re-check, provider exec, re-host, files/media_assets/mos_assets writes, package patch). |
| `worker/src/creative/lanes/creativeImageLane.ts` | `creativeImageLoop` + `claimAndRunOneCreativeImage` — flag-gated (`creative_writer.ai_image_execution`; sleeps 30 s when off so approved executions stay queued), 4 s poll, no watchdog (the image loop's `generation_jobs_watchdog()` sweeps all kinds). |
| `worker/src/creative/__tests__/io.test.ts` | 21 tests. |
| `worker/src/creative/__tests__/runCreativeJob.test.ts` | 12 tests. |
| `worker/src/creative/__tests__/runCreativeImageJob.test.ts` | 16 tests. |

## Files changed (owned)

| File | Change |
|---|---|
| `worker/src/index.ts` | Imports for the four loops + a marked `// ── creative director lanes ──` region at the end of the `Promise.all` block: one shared `LaneDeps` object; `creativeJobsLoop`, `creativeImageLoop`, `designReadLoop`, `assetMetaLoop` (imported as `assetMetaLaneLoop as assetMetaLoop`) pushed into `loops`. Always registered (in the normal — non-`WORKFLOW_PROOF_ONLY` — branch); every lane re-reads its flag each tick and sleeps 30 s while off, and all four flags ship OFF, so the registration is inert until an operator flips a flag. Peer lane files existed at typecheck time, so plain static imports (no guarded dynamic import needed). |

`worker/src/env.ts` — **not touched**: no new env keys were needed (`MODAL_CV_URL` is read directly from `process.env` per the brief; fal/Anthropic keys are already required).

## Exported signatures

### `lanes/types.ts`
```ts
export interface LaneDeps { supabase: SupabaseClient; env: WorkerEnv; workerId: string;
  sleep(ms: number): Promise<void>; isShuttingDown(): boolean; log(msg: string, extra?: unknown): void }
export type LaneLoop = (deps: LaneDeps) => Promise<void>;
```

### `io.ts`
```ts
export interface CreativeJobLike { id; content_id; kind: CreativeJobKind; params; requested_by: string|null; attempts }
export interface CreativeContentSlice { id; title; language; content_type_key; project_id; project_ids; campaign_id; organic_platforms }
export interface CreativeJobContext { content; brief; facts: CreativeFacts; brandKit; writerRules; flags: CreativeFlags;
  targets: DerivativeTarget[]; specs: PlacementSpec[]; referenceRows: CreativeReferenceRow[]; assetRows: CandidateAssetRow[];
  qvec: number[]|null; recipe: string|null; intendedUse: IntendedUse|null;
  toDirectorInput(extra?: Partial<DirectorInput>): DirectorInput }
export async function loadCreativeFlags(sb): Promise<CreativeFlags>
export async function loadWriterRules(sb): Promise<WriterRules>            // missing row → EMPTY rules + console.error
export function parseTargets(params): DerivativeTarget[]                   // malformed entry → plain Error (terminal)
export async function enrichTargetRefs(sb, contentId, targets)             // fills publication_id / execution ids when unambiguous
export function specsForTargets(targets): PlacementSpec[]                  // dedupe; unknown placement logged, never silent
export async function resolveFileUrl(sb, bucket, path): Promise<string|null>   // public bucket → public URL; else signed (600 s)
export async function intentVector(sb, assetRows, log?): Promise<number[]|null> // embed('embed_image') on top candidate; MODAL_CV_URL-gated, never fatal
export async function loadJobContext(sb, job, opts?: { onStage?, concept?, log? }): Promise<CreativeJobContext>
export async function loadPackageRow(sb, packageId): Promise<CreativePackageRow|null>
export async function loadPackageTargets(sb, packageId): Promise<DerivativeTarget[]>
export async function nextVersion(sb, contentId): Promise<number>          // rpc mos_creative_package_next_version
export async function insertPackage(sb, args: InsertPackageArgs): Promise<string>
export async function insertDerivatives(sb, packageId, derivatives): Promise<void>
export async function insertRefs(sb, packageId, base: BasePackage): Promise<void>  // references + selected assets w/ rights_snapshot
export async function supersedePackage(sb, packageId): Promise<void>
export async function rejectPackage(sb, packageId, note): Promise<void>
export async function patchPackage(sb, packageId, path: string[], value): Promise<void> // rpc mos_creative_package_patch
export async function notifyRequester(sb, { requestedBy, contentId, contentTitle, stage }): Promise<void> // event 'post_creative_ready', best-effort
```

### `runCreativeJob.ts`
```ts
export type CreativeErrorKind = 'provider'|'transient'|'facts_insufficient'|'validation_unrepaired'|'rights_blocked'|'policy_blocked'|'budget_exceeded'|'unknown'
export function classifyCreativeError(err): { message; kind }   // prefix map + network-regex → transient; else unknown
export interface CreativeJobIo { … }        // test seam (default = io.ts + mos_creative_job_stage RPC)
export interface CreativeDirector { runConcepts; runPackage; runRegenerate; runDerivatives }  // test seam (default = A-GEN runDirector + callCreativeRole)
export interface CreativeJobOutcome { result: { package_id, stage, needs_attention, retried, validation }; roles; cost_usd: number|null }
export async function runCreativeJob({ supabase, env, job, io?, director?, log? }): Promise<CreativeJobOutcome>
```

### `lanes/creativeJobsLane.ts`
```ts
export async function claimAndRunOneCreativeJob(deps: LaneDeps): Promise<boolean>
export const creativeJobsLoop: LaneLoop
```

### `runCreativeImageJob.ts`
```ts
export interface CreativeImageJob { id; recordId; userId; params; attempts }
export interface CreativeImageParams { package_id; index; mode: AiMode; prompt; source_file_ids; aspect; must_keep; must_change; approved_by }
export function parseCreativeImageParams(raw): CreativeImageParams
export function roleForMode(mode: AiMode): ImageRoleKey          // remove_text→image_remove_text, supporting_visual→image_generate, else image_edit
export interface CreativeImageIo { … }                           // test seam (default = makeCreativeImageIo())
export function makeCreativeImageIo(): CreativeImageIo
export async function runCreativeImageJob({ supabase, env, job, io?, providerFactory?, fetchOutput?, log? }): Promise<CreativeImageOutcome>
```

### `lanes/creativeImageLane.ts`
```ts
export async function claimAndRunOneCreativeImage(deps: LaneDeps): Promise<boolean>
export const creativeImageLoop: LaneLoop
```

## Behavior notes (per the brief)

- **Stage heartbeats**: `mos_creative_job_stage` fires at every step (brief→facts→brand→references→assets→targets→concepts|package|derivatives→validate→persist). A failed heartbeat is logged and never fails the job (observability only).
- **Failure atomicity**: a failed job writes nothing to `mos_content` and leaves existing packages untouched. The one possible half-write (package inserted, derivatives/refs failed) marks that package `rejected` with `revision_note='persist_failed: …'` and rethrows — never a silent orphan draft.
- **Validation unrepaired** (after the director's one retry) never throws: the draft persists with warnings and the job completes with `result.needs_attention=true` (contracts §8).
- **Error kinds**: `mos_creative_job_fail` requeues only `provider`/`transient` while `attempts < max_attempts`; everything else is terminal. `classifyCreativeError` maps the stable prefixes (message-prefix or mid-message `' prefix'`), network/REST-ish failures to `transient`, everything else to `unknown`.
- **Roles + cost** land on the job row (`p_roles`, `p_cost_usd` — stage-keyed when several stages ran) AND the package row. Cost is `null` when any stage's cost was unknown (never a guessed number).
- **notifyRequester**: `notify_emit` event `post_creative_ready`, in-app bell to the requester, `/m/content/<id>` — the runScriptJob posture (no `notification_rules` row by design, per the `_25` migration note). RPC-returned errors are logged (PostgREST returns, not throws); never thrown.
- **Image job**: flag re-checked inside the job (race between claim and flip); §7 `checkAiRecommendation` re-checked on the frozen params; `request_photo` never executes; competitor/`restricted`/`do_not_use` sources → `rights_blocked:`. Output → `marketing-assets/creative/<content_id>/<uuid>.<ext>` → `media_assets` (provenance prompt/model/settings{package_id,index,source_file_ids,mode}) → `files` (`usage_rights='needs_review'`, `asset_nature ai_edited|ai_generated`, `production_state='edited'`, `acquisition_source='internal'`, `primary_category='ai_content'`, title `AI · <mode> · <content title>`, `uploaded_by_user_id = approved_by`) → `mos_assets` find-or-create (the minimal `asset_link_from_file` insert) → `mos_asset_links` `role='reference'` — **never `role='final'`**. Package patched via `mos_creative_package_patch` for BOTH `ai_recommendations[index].execution` and `ai_recommendations[index].status` (completed/failed).
- **`media_assets.created_by_user_id`** = `generation_jobs.user_id` (auth.users id — matches the runCleanTextJob posture); **`files.uploaded_by_user_id` / `mos_assets.created_by_user_id`** = `params.approved_by` (public.users id).

## Judgment calls (deviations to note — no contract change requested)

1. **`post_regenerate` re-runs derivatives.** The brief says "previous package + revision_note → new version; old → superseded" and mentions derivatives only for `post_package`. I regenerate derivatives for the SAME targets (previous package's derivative rows; `params.targets` overrides), because the contract defines no endpoint that enqueues `post_derivatives` for the new version — a base-only regenerated version would silently lose the deliverable's derivatives. If the lead prefers base-only regenerate, deleting one block in `runCreativeJob.ts` reverts it.
2. **`post_derivatives` does NOT supersede the previous version** (regenerate explicitly does, per the brief). A derivatives version EXTENDS the deliverable to new targets; the old version may carry applied captions/creative and its `applied` status must survive.
3. **`enrichTargetRefs`** fills paid ids only when exactly ONE non-archived `mos_execution_ads` row exists for the content (the table has no platform column to disambiguate multiple rows). Organic fills the LATEST publication matching the platform. Already-stamped `target_ref` values are never overwritten.
4. **`intentVector`** embeds the top-ranked candidate asset (public URL or 600 s service-client signed URL for private buckets). Only when `MODAL_CV_URL` is set; any failure logs and falls back to `p_qvec=null` (never fatal, per the brief).
5. **`notifyRequester` logs RPC-returned errors** (runScriptJob swallows them silently). Small deliberate hardening toward the no-silent-failures rule; behavior otherwise identical.

## Requests for other agents / the lead

- **A-API**: when enqueueing `creative-image`, note `generation_jobs.record_id` is NOT NULL REFERENCES `records(id)` and `message_id` is NOT NULL — the worker ignores both (all context comes from `params`), but the insert must satisfy the FK/NOT NULLs (e.g. a records row the API already owns + `message_id = package_id` or the rec index). Also stamp `params.approved_by` as the **public.users** id of the approver and `user_id` as their **auth.users** id (the two are used for different rows — see above).
- **A-DB**: nothing needed — `_20`/`_21` RPCs match the contract exactly (verified live, below).
- **Lead**: judgment calls 1–2 above — flag if the contract should say otherwise.

## Tests + typecheck (tails)

`cd worker && npm run typecheck`:
```
> wassell-deck-worker@1.0.0 typecheck
> tsc --noEmit
```
(zero errors — the whole worker package typechecks, including index.ts with the four registered lanes)

`cd worker && npx vitest run src/creative`:
```
 Test Files  19 passed (19)
      Tests  283 passed (283)
   Duration  2.97s
```
(49 of those tests are mine: io 21, runCreativeJob 12, runCreativeImageJob 16. The other 15 files are peer suites, all passing.)

Live RPC smoke (service client, prod):
```
mos_creative_job_claim_next → OK []
mos_creative_jobs_watchdog → OK 0
mos_creative_package_next_version → OK 1
generation_job_claim_next (kind='creative-image') → OK []
```

## Migrations written

None — everything I consume landed in `_20`–`_25` (already applied).
