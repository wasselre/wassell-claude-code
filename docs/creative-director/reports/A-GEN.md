# A-GEN — report (Post Creative Director build)

*2026-09-02. Scope: briefs `_COMMON.md` + `A-GEN.md`; contracts §0, §5–§8, §10, §12; skills `.claude/skills/writing-post/SKILL.md` (full) + `writing-video-script` Decisions Log.*

## Files created (all under the A-GEN ownership boundary)

| File | What it is |
|---|---|
| `worker/src/creative/director/types.ts` | `DirectorInput` — the one input bag every stage receives (`brief`, `content{language,title,content_type_key}`, `facts`, `brandKit`, `rules`, `targets`, `specs`, `referenceRows`, `assetRows`, `recipe?`, `intendedUse?`, `conceptChoice?`, `concepts?`, `basePackage?`, `previousPackage?`, `revisionNote?`). |
| `worker/src/creative/director/schemas.ts` | JSON Schemas `CONCEPTS_OUTPUT_SCHEMA` / `BASE_PACKAGE_SCHEMA` / `DERIVATIVES_OUTPUT_SCHEMA` mirroring `contracts.ts` exactly (every enum an `enum`, every contract field in `required`, `additionalProperties:false` throughout, nullable fields as `type:[…,'null']`). `AiRecommendation.execution` deliberately absent — the image lane writes it via `mos_creative_package_patch`. |
| `worker/src/creative/director/prompts.ts` | Provider-neutral system prompts (Arabic primary, stable cacheable prefix first) `conceptsSystem/packageSystem/derivativesSystem(ctx)` + user builders `conceptsUser/packageUser/derivativesUser/regenerateUser(input)`. Recipes `POST_RECIPES` (feature_spec, lifestyle, offer, event, occasion, launch — offer+launch `requires_price`). All 15 hard rules embedded (name-lead, 1–4 headlines, fact_refs on any number anywhere, readiness both ways, Wassel+developer only, our hashtags, Saudi dialect, Arabic-Indic numerals, no «بدون سعي», language preserved, organic/paid split, competitor=inspiration, full VisualAdaptation, palette discipline, §7 AI policy, punchy hook). |
| `worker/src/creative/director/policy.ts` | §7 image policy, PURE: `checkAiRecommendation(rec) → {ok, reason}`, AR+EN fabrication verb/noun lists (`FABRICATION_VERBS_AR/EN`, `PROJECT_NOUNS_AR/EN`), `ALLOWED_AI_MODES`, `findFabrication`, `namesProjectFeature`. `request_photo` always ok; supporting_visual bans project nouns outright; cleanup/crop/color_correct + `must_keep` architecture exempted. Ready to mirror verbatim into `src/lib/creative/policy.ts` (A-API). |
| `worker/src/creative/director/adaptation.ts` | `planAdaptations(base, targets, specs)` (deterministic skeleton per selected target via A-FACTS `adaptationSkeleton` + real carousel slide mapping) and `finalizeAdaptation(model, planned, slideCount)` — skeleton facts (aspect/px/safe_zones/requires_separate_design/image_change) authoritative over the model; every prose string guaranteed non-empty (explicit «لا تغيير — …» wording or deterministic crop/extend/separate-design wording); model slide mapping kept only when it covers every master slide. Also `deterministicSlideMapping`, `specLimits`, `targetKey`. |
| `worker/src/creative/director/references.ts` | `CreativeReferenceRow` (RPC `mkt_creative_references` shape) + `selectReferences(rows, intent, {max=4, picks?})` — hallucination guard (unknown ids dropped with reason), org diversity ≤2/org, carousels get ≥1 post-level reference (best candidate promoted in; warning when none exists), preview_url/level/post_id always from the ROW, deterministic fallback text when no model picks. |
| `worker/src/creative/director/assets.ts` | `CandidateAssetRow` (RPC `creative_candidate_assets` shape) + `rankCandidateAssets(rows, intent)` (mirrors the RPC ORDER: verified+trusted rights → developer/internal → raw → real/cgi → recency; competitor + restricted/do_not_use EXCLUDED) + `sanitizeAssetPicks(picks, rows)` — hallucination guard, competitor/blocked-rights rejection, rights fields COPIED from rows (the model never decides rights), `needs_rights_confirmation = !rights_verified`, first-pick-wins dedup. |
| `worker/src/creative/director/runDirector.ts` | The orchestrator: `runConcepts`, `runPackage`, `runDerivatives`, `runRegenerate` + `sanitizeBasePackage`, `finalizeDerivatives`, `buildGroundingCtx`, `assertFactsViable`. |
| `worker/src/creative/director/__tests__/{policy,adaptation,references,assets,schemas,runDirector}.test.ts` | 54 tests, all green. |

No peer/sibling file created, stubbed, or edited. Reused (untouched): `worker/src/ai/**`, `worker/src/marketing/script/{types,facts,claims,entities}.ts`, peer modules `worker/src/creative/{roles,facts,grounding,placementSpecs,brandKit}.ts` (real exports imported, no local re-declaration was needed — all peers existed).

## Exported signatures (runDirector.ts — the integration surface)

```ts
export type DirectorCallRole = <T>(key: CreativeRoleKey, req: CallRequest) => Promise<CreativeCallResult<T>>;
export interface DirectorDeps {
  callRole: DirectorCallRole;            // A-WORKER binds (key, req) => callCreativeRole(key, req, { sb })
  ledger?: RoleUseLedger;                // fresh per stage when absent
  log?: (msg: string, extra?: unknown) => void;
}
export interface DirectorStageResult<T> {
  output: T;
  validation: ValidationResult;          // from A-FACTS grounding
  needs_attention: boolean;              // true = errors remain after the one retry — save draft, never throw
  retried: boolean;
  rolesJson: Record<string, unknown>;    // ledgerToJson — model/cost/token provenance for the job row
  cost_usd: number | null;               // null when any call's cost unknown (never a guessed number)
}
export function runConcepts(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<ConceptsOutput>>;
export function runPackage(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>>;
export function runDerivatives(input: DirectorInput & { basePackage: BasePackage }, deps: DirectorDeps): Promise<DirectorStageResult<DerivativesOutput>>;
export function runRegenerate(input: DirectorInput, deps: DirectorDeps): Promise<DirectorStageResult<BasePackage>>;
export function assertFactsViable(input: DirectorInput): void;   // throws facts_insufficient:
export function buildGroundingCtx(input: DirectorInput): GroundingCtx;
export function sanitizeBasePackage(input: DirectorInput, raw: BasePackage): BasePackage;
```

**Stage contract** (all four): prompt → role call with the stage schema (`creative_concepts` / `creative_package` / `creative_derivatives`) → post-process (assets sanitized, references guarded, §7 policy dismissals, deterministic adaptation geometry, master_aspect/language/intended_use corrections) → validators → on errors retry ONCE with `buildViolationFeedback` (feedback appended to the SAME user prompt) → `{output, validation, needs_attention, retried, rolesJson, cost_usd}`. Validation failure after the retry NEVER throws — it returns `needs_attention:true` + the error list and logs `validation_unrepaired` via console.error. Throws only `facts_insufficient:` (non-viable facts package, or offer/launch recipe without a claimable price fact).

**Policy handling decision (deviation from a literal reading of §8):** the §7 policy check is NOT injected into grounding's `policyCheck` slot (which would make violations retryable errors). Instead the orchestrator dismisses violating recommendations deterministically (`status:'dismissed'` + `policy_blocked:` warning in `base.warnings`) — exactly what contracts §7 prescribes ("emitted with status 'dismissed' + warning, never queued"). The grounding `policyCheck` injection point remains for A-WORKER if a stricter posture is ever wanted.

## Migrations written

None — no DB changes in the A-GEN scope.

## Tests + typecheck

```
$ cd worker && npx vitest run src/creative/director
 ✓ src/creative/director/__tests__/assets.test.ts (7 tests)
 ✓ src/creative/director/__tests__/schemas.test.ts (5 tests)
 ✓ src/creative/director/__tests__/adaptation.test.ts (11 tests)
 ✓ src/creative/director/__tests__/policy.test.ts (9 tests)
 ✓ src/creative/director/__tests__/references.test.ts (7 tests)
 ✓ src/creative/director/__tests__/runDirector.test.ts (15 tests)
 Test Files 6 passed (6) · Tests 54 passed (54)
```

Coverage includes every brief-required case: single + carousel happy paths; hallucinated asset id dropped; competitor id rejected; number without fact_ref → retry (feedback contains `fact_ref_missing`) → fixed; unrepaired violations → needs_attention (never throws); policy-blocked recommendation dismissed with `policy_blocked:` warning; derivatives only for selected targets (+ `target_missing` retry when the model skips one); language preserved (wrong `strategy.language` corrected); 4:5→9:16 `requires_separate_design:true` with complete adaptation strings; schema key assertions (required arrays, closed objects, no `execution` key).

```
$ cd worker && npm run typecheck
```
**Zero errors in A-GEN files.** Remaining errors (6) are all in files I do NOT own (other agents' in-flight work — listed for the lead, not touched):
- `src/creative/imageProvider.ts` (A-AI): 5× TS2345 `Promise<ImageGenStartResult>` vs `ImageGenStartResult` (missing `await`s around fal chat starts, lines 213/226/240/253/261).
- `src/creative/designRead/readPost.ts` (A-VIS): TS6133 unused `SupabaseClient` import.
- (Earlier in the session `designRead/prompts.ts` and `runPushJob.ts` also errored; both were fixed by their owners while I worked — peers are landing concurrently.)

Peer test-suite failures observed in `npx vitest run src/creative` (also NOT mine, NOT caused by my files — they fail on peer code paths alone): `imageProvider.test.ts` 2 failures (A-AI), `placementSpecs.test.ts` 1 failure (`adaptationSkeleton` carousel→feed slide_mapping placeholder — A-FACTS; my director never relies on that placeholder: `planAdaptations` replaces it with the real deterministic mapping), `assetMeta.test.ts` 1 failure (`sharp` not installed in this worktree — A-ASSETS).

## Contract deviations I propose

1. **Policy-as-dismissal instead of policy-as-validation-error** (above) — matches §7's text; flag for the lead's confirmation. If the lead prefers retryable errors, one-line change: pass `policyCheck: (rec) => checkAiRecommendation(rec)` in `buildGroundingCtx` and drop the dismissal block in `sanitizeBasePackage`.
2. **`target_missing` as an orchestrator-level violation** — grounding's `validateDerivatives` flags non-selected derivatives but not missing ones; `runDerivatives` adds `target_missing` errors (retryable) so every selected target is guaranteed a derivative after a green run.
3. **`master_aspect` correction** — when the model picks an aspect no selected spec carries, it is forced to `masterAspectFor(targets)` with a warning (the contract says the model "chooses"; silently bad geometry would poison every derivative).

## What other agents / the lead must do

- **A-WORKER**: bind `deps.callRole = (key, req) => callCreativeRole(key, req, { sb })`; pass a fresh `createRoleLedger()` per job (or none — one is created per stage); map `DirectorStageResult` onto `mos_creative_job_complete` (`result=output`, `roles=rolesJson`, `cost_usd=cost_usd`, `needs_attention` into the result jsonb); map thrown `facts_insufficient:` to `error_kind='facts_insufficient'`. `runDerivatives` input requires `basePackage` — load the applied/latest base package row.
- **A-API**: mirror `worker/src/creative/director/policy.ts` → `src/lib/creative/policy.ts` verbatim (it is pure and import-free except `normAr` from the sibling entities module — the api bundle needs the same twin; `localizedName.ts` precedent or copy `normAr`'s 12 lines).
- **A-AI / A-VIS**: fix the typecheck errors + failing peer tests listed above before the lead's integration typecheck.
- **A-DB**: nothing requested.
