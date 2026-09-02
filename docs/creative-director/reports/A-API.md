# A-API — Post Creative Director API + clients (report)

*2026-09-02. Migrations _20.._26 were already applied; all RPCs used below are live.*

## Files created

| File | What it is |
|---|---|
| `api/_lib/marketing/creative/wake.ts` | Shared plumbing: `CreativeCtx {sb, svc, body, userId}`, `cStr`, `jsonFail` (bilingual `{error, error_ar}`), `requireSvc`, `resolveAppUserId`, `wakeWorker(kind)` (copy of the clean-listing-images wake), `resolveRefPreview` (competitor media → public `stored_url`; our files → 1 h signed URL; wassel_content → final asset url). |
| `api/_lib/marketing/creative/targets.ts` | `creativeTargets` — organic (organic_platforms ∪ publications, defaults instagram feed/carousel by content type, tiktok photo_mode, snapchat story, x/website post), paid (same campaign→executions→ad sets→ads walk as `paid_placement_targets`, content's campaign first, meta→ad_feed, google→ad_display), `selected` = row exists, `suggested_master_aspect` via `masterAspectFor` (selected targets, else all). Also pure `defaultOrganicPlacement` / `defaultPaidPlacement`. |
| `api/_lib/marketing/creative/packages.ts` | `writePostCreative` (flag gate → project required → type ∈ post\|carousel → `mos_creative_job_enqueue` kind `post_concepts`, 409 on `active_job_exists`), `creativeConceptSelect` (`post_package`), `creativeRegenerate` (`post_regenerate`, revision note required), `creativeJobStatus`, `creativePackageList`, `creativePackageGet` (+ derivatives/refs/previews), `creativePackageSave` (NEW version `generated_by='human'`, old draft superseded only after the successor exists; derivatives carried forward with edits; refs verbatim), `creativeAssetReplace` (re-snapshots rights via `classifyRights` + `mos_creative_package_patch`). Also `readCreativeFlags`. |
| `api/_lib/marketing/creative/apply.ts` | `creativePackageApply` (stage package + status draft; `recheckRightsForFinal` on `is_production` assets → 422 `rights_blocked` / `rights_unconfirmed` unless `confirm_unverified_rights`; `applied_snapshot` BEFORE any write; content data merge — headlines APPEND generated lines, carousel lines prefixed «١/٦ », `design_brief`/hashtags/`design_reference_file_ids` only-if-empty unless `overwrite`; organic derivatives → `content_caption_save` lazy-upsert semantics; paid → `content_ad_creative_save` semantics (waiting ad when only `execution_id`); production assets → `asset_link_from_file` find-or-create + `role='source'` link; mid-way failure restores from snapshot and returns 500 with `restored`/`restore_failed`), `creativePackageRevert`, `creativeAiApprove` (flag `ai_image_execution`, status `recommended`, §7 policy re-check via `src/lib/creative/policy.ts`, `generation_jobs` kind `creative-image` insert `record_id=content_id`, `message_id='<package_id>:<index>'`, patch via `mos_creative_package_patch`, /wake), `creativeAiDismiss`. Pure helpers `generatedHeadlines`, `renderDesignBrief` (unit-tested). |
| `api/_lib/marketing/creative/handoff.ts` | `creativeHandoff` — latest applied package (fallback latest draft, `draft:true`), asset previews + names (signed), targets with dims + `requires_separate_design`, adaptations, approved/executed AI production only + `ai_suggested_not_approved` count, `role_map` (default `{design_owner:'montage'}`). |
| `api/_lib/marketing/creative/settings.ts` | `creativeFlags`/`creativeFlagsSave` (merge, never reset siblings), `brandKitGet`/`brandKitSave` (a save NEVER promotes — status/mode/reviewed_* preserved; version only moves on review)/`brandKitReview` (status reviewed, mode constraint, version+1, reviewed_by/at), `writerRulesGet/Save`, `roleMapGet/Save`, `aiRolesGet/Save` (shape-validated `{provider, model, params?}` per key; MERGE — never drops keys). |
| `api/_lib/marketing/creative/examples.ts` | `designExampleSet` (upsert on `(subject_kind, subject_id)`; `retire:true` flips `retired_at`; competitor_post ⇒ study_only pre-validated), `designExampleList` (active examples + previews). |
| `api/_lib/marketing/creative/performance.ts` | `creativePerformance` — `mos_content_performance_v` row (read as the caller) + latest applied package summary + derivative count. |
| `api/_lib/marketing/creative/reads.ts` | For `api/marketing.ts`: `designReadGet`, `designReadsStatus`, `creativeBackfillStatus`, `creativeBackfillControl` (admin gate in the dispatch block, like `run_*`), `wasselInternalStatus`. |
| `src/lib/creative/policy.ts` | Mirror of `worker/src/creative/director/policy.ts` — identical logic; only the imports differ (types from `./contracts`; `normAr` inlined, marked as the twin of `worker/src/marketing/script/entities.ts`). |
| `src/lib/creative/__tests__/policy.test.ts` | 14 tests — mirror of the worker policy tests + extras. |
| `src/lib/creative/__tests__/applyHelpers.test.ts` | 5 tests for the pure apply helpers (carousel «١/٦ » prefixes, brief render AR/EN). |
| `src/lib/marketingOS/creativeClient.ts` | All 27 wrappers: `fetchCreativeFlags, fetchCreativeTargets, writePostCreative, selectCreativeConcept, regenerateCreative, fetchCreativeJobStatus, listCreativePackages, fetchCreativePackage, saveCreativePackage, replaceCreativeAsset, applyCreativePackage, revertCreativePackage, approveCreativeAi, dismissCreativeAi, fetchCreativeHandoff, fetchCreativePerformance, fetchBrandKit, saveBrandKit, reviewBrandKit, fetchWriterRules, saveWriterRules, fetchRoleMap, saveRoleMap, saveCreativeFlags, fetchAiRoles, saveAiRoles, setDesignExample, listDesignExamples` + payload/row types (`CreativeTargetsResult`, `CreativeHandoffResult`, `CreativePerformanceResult`, `AiRoleConfig`, `DesignExampleRow`, …). |

## Files changed

- `api/marketing-os.ts` — creative handler imports; one marked block `/* ── creative director ── */` with a `case` per §4 action (gates: `read` / `write_content` / `view_content_body` / `manage_settings` / `approve_creative` exactly per the contract table) delegating with `{sb, svc: makeServiceClient('api:marketing-os:creative'), body, userId}`; the 3-line best-effort `enqueueWasselReadsOnPublish` call after a successful `publication_publish` and on `publication_sync` → `published` (each wrapped: hook failure logs, never fails the publish).
- `api/marketing.ts` — marked block with `design_read_get`, `design_reads_status`, `creative_backfill_status`, `wassel_internal_status` (service client, like `content_library`) and `creative_backfill_control` (`wassell_is_admin` gate, like `run_*`).
- `src/lib/marketingOS/client.ts` — exactly one line added: `export { call as mosCall, authHeader as mosAuthHeader };`
- `src/lib/competitorWatch/client.ts` — `fetchDesignRead, fetchDesignReadsStatus, fetchCreativeBackfillStatus, controlCreativeBackfill, fetchWasselInternalStatus` (+ row types).

## Exported handler signatures

Every handler: `(ctx: CreativeCtx) => Promise<Response>` with `CreativeCtx = { sb: SupabaseClient; svc: SupabaseClient | null; body: Record<string, unknown>; userId: string }`. The dispatch blocks own the capability gate; handlers own validation + the service-client work.

## Migrations

None written — `_20.._26` (applied) cover everything used: `mos_creative_job_enqueue`, `mos_creative_package_next_version`, `mos_creative_package_patch`, `creative_candidate_assets` (not needed by the API), `mos_content_performance_v`, `creative_backfill_runs`, `mos_design_examples`, `visual_design_reads`, `generation_jobs` kind `creative-image` (already re-listed in `_25`), `files_rights_v`.

## Contract deviations (proposed / noted)

1. **`creative_backfill_control` op travels as `op`, not `action`** — `action` is the dispatch envelope key of `api/marketing.ts` itself; a literal `{action:'start'}` payload would be consumed as the dispatch action and never reach the handler. The wrapper sends `{kind, op, tier?}`.
2. **Hashtags overwrite flag** — the contract's `overwrite` object has no `hashtags` key; apply sets `data.hashtags` only when empty, or when `overwrite.headlines` is set (the content-copy overwrite).
3. **`creative_package_save` supersede ordering** — the old draft is superseded only AFTER the new version insert succeeds (a failed insert must not leave zero drafts). The unique `(content_id, version)` is untouched.
4. **`creative_ai_approve` refuses non-`recommended` recommendations with 409** (contract says "recommendation status='recommended'" — made explicit).
5. `generation_jobs.user_id` = the auth uid (matches the existing video-convert/clean-text inserts; the column comments say auth.users id).

## Tests + typecheck

```
$ npx vitest run src/lib/creative
 ✓ src/lib/creative/__tests__/policy.test.ts (14 tests) 6ms
 ✓ src/lib/creative/__tests__/applyHelpers.test.ts (5 tests) 3ms
 Test Files  2 passed (2)
      Tests  19 passed (19)

$ npx tsc --noEmit -p tsconfig.api.json   → clean (no output)
$ npx tsc --noEmit -p tsconfig.json       → clean (no output)
```

## For other agents / the lead

- **A-UI** consumes `src/lib/marketingOS/creativeClient.ts` + the five `src/lib/competitorWatch/client.ts` wrappers. Response shapes are typed there; bilingual errors arrive as `{error, error_ar}` (MosApiError already prefers `error_ar` on Arabic UI). `creative_package_apply` 422s carry `{blocked}` or `{unconfirmed}` arrays for the rights dialog (`confirm_unverified_rights: true` retries).
- **A-WORKER**: job params enqueued are — `post_concepts: {targets, recipe, intended_use, language}`, `post_package: {package_id, concept_id | custom}`, `post_regenerate: {package_id, revision_note}`. `creative-image` generation job params: `{package_id, index, mode, source_file_ids, aspect, must_keep, must_change, constraints}` with `record_id=content_id`, `message_id='<package_id>:<index>'` — the lane should patch `ai_recommendations[index].execution` via `mos_creative_package_patch` (never JS read-modify-write).
- **Peer files consumed, unmodified**: `brandKit.ts` (`loadBrandKit`), `rights.ts` (`recheckRightsForFinal`, `classifyRights`), `onPublished.ts` (`enqueueWasselReadsOnPublish`), `platformRules.ts` (`masterAspectFor`, `PLACEMENT_SPECS`).
- **Lead**: no migrations requested. `post_creative_ready` notification emission is the worker's job (rule seeded per `_25` note — in-app bell needs no rule row).
