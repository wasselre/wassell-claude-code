# A-ASSETS — report (Post Creative Director)

*2026-09-02. Scope: asset deterministic meta + enrich v2 + rights classification + picker/library UI + migration `_29`.*

## Files created

| File | What |
|---|---|
| `worker/src/creative/assetMeta/deterministic.ts` | `computeDeterministicMeta(buffer)` (width/height/snapped aspect + top-5 quantized palette via sharp 64px resize; `has_text: null`), `applyDeterministicMeta(sb, fileId, meta)` (UPDATE files; stamps `visual_meta_version='det-v1'` ONLY where the version is still NULL — never downgrades an `enrich-v2` file), plus pure helpers `dominantColorsFromPixels`, `readImageSize` (PNG/JPEG/GIF/WEBP header parser, no-decoder fallback), `snapAspectRatio` (port of `src/lib/files/mediaProbe.ts` — worker can't import src/). |
| `worker/src/creative/assetMeta/rights.ts` | `classifyRights(row)` + `recheckRightsForFinal(sb, fileIds)` per contracts §0.9. Self-contained (only a supabase-js type import) so the api copy is byte-identical. |
| `worker/src/creative/assetMeta/index.ts` | Barrel. |
| `api/_lib/marketing/creative/rights.ts` | **Byte-identical copy** of the worker rights.ts (verified with `diff`). Exports `recheckRightsForFinal` for A-API's final-approval path (`content_set_approval_asset` / `creative_package_apply` with `confirm_unverified_rights`). |
| `worker/src/creative/lanes/assetMetaLane.ts` | `assetMetaLaneLoop` + exported-for-tests `assetMetaTick` + `readAssetMetaFlags`. Tick: (1) deterministic meta pass gated by `creative_backfill.asset_meta.enabled` over `creative_asset_backfill_targets('meta', batch_size)` — downloads each file from its storage bucket, computes + applies meta, **never fails the lane on one file** (per-file try/catch, `console.error`, continues); (2) enrich v2 batch gated by `creative_backfill.asset_enrich.enabled` **AND** `creative_writer.asset_enrich_v2`, delegated to A-VIS's `runBackfillBatch('asset_enrich', …)` (which owns the `approved_cost_usd` gate). Flags re-read every tick; 30 s idle sleep. |
| `worker/src/creative/__tests__/assetMeta.test.ts` | 30 tests (below). |
| `supabase/migrations/2026-09-02_29_asset_enrich_v2_apply.sql` | **WRITTEN, NOT APPLIED** (the lead applies). See below. |
| `docs/creative-director/reports/A-ASSETS.md` | This report. |

## Files changed

| File | Change (all additive) |
|---|---|
| `worker/src/runEnrichmentJob.ts` | Behind `mos_settings.creative_writer.asset_enrich_v2`: images route through `callRole` with an explicit `RoleConfig` resolved from `mos_settings.ai_roles.asset_enrich_v2` (absent/invalid role → logged fallback to the existing Haiku tool path, which is **untouched** when the flag is off — same tool schema, same prompt, same model). The v2 schema adds `has_text` (bool), `headline_space` (none/top/bottom/left/right/center), `ocr_text` (≤500 chars), `scene_subjects[]` (closed 17-value list, exported as `SCENE_SUBJECTS`). After a successful v2 call the new fields go through the `file_enrichment_apply_v2` RPC; an RPC failure **throws** (job fails loudly + retries). Cost/model recorded on `result.enrich_v2`. |
| `src/types/files.ts` | `AspectFamily` type; `LibraryFilters.aspect_family?: AspectFamily[]`; `BusinessFileRow.rights_provenance/rights_verified` (optional — older RPC still types). |
| `src/lib/files/library.ts` | `ASPECT_FAMILIES`, `aspectFamilyLabel(f, isAr)`, `rightsBadgeFor(row)` → `{badge, label_ar, label_en, needs_confirmation}` (client mirror of `classifyRights`). |
| `src/pages/Files/library/FilePickerModal.tsx` | New optional `filters?: FilePickerFilters` prop (`linked_record_id?, primary_category?, asset_nature?, usage_rights?, aspect_family?` — single value or array, normalized into the RPC filter shape; `linked_record_id` → `record_id`) merged into every search; new `showMeta?: boolean` renders nature/source chips + a bilingual rights badge (verified/unverified/blocked/reference_only/ai_review) under each tile. Existing callers unaffected (both props optional). |
| `src/pages/Files/library/LibraryFilterBar.tsx` | Aspect-family `OptionMenu` ("الاتجاه / Orientation") with fixed options landscape/portrait/square — **no facet count** (see deviation 1). |

## Migration `_29` contents (not applied)

1. **Scene-subject vocabulary seed** — the 17 closed `scene_subjects` values inserted into `file_document_types` (bilingual labels, `applies_to_kinds '{image}'`, `ON CONFLICT (value) DO NOTHING`) so the RPC's `file_subjects` inserts are always FK-safe and the values are filterable app-wide.
2. **`file_enrichment_apply_v2(p_file_id, p_has_text, p_headline_space, p_ocr_text, p_subjects, p_model)`** — writes `has_text`/`headline_space`/`ocr_text` (headline_space re-validated against the CHECK set; ocr truncated to 500), stamps `visual_meta_version='enrich-v2'` (even on an all-null pass — "looked, found nothing" is complete), writes `file_metadata_provenance` `ai_suggested` rows per applied field (never overwrites `human_modified`), and inserts vocab-guarded scene subjects into `file_subjects`. SECURITY DEFINER; EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role only.
3. **`business_files_search` CREATE OR REPLACE** — full re-emit of the live body (`2026-08-31_03`) with only: (a) optional `aspect_family` filter (portrait/landscape/square derived from `aspect_ratio` W:H, ±5% = square; absent key = no constraint → every existing caller unaffected); (b) `rights_provenance` + `rights_verified` on each returned row via a LATERAL provenance lookup on the ≤200-row page slice only (`base` is NOT re-scanned → unfiltered-query cost unchanged).

## Exported signatures

- `assetMeta/deterministic.ts`: `computeDeterministicMeta(buffer: Buffer) → Promise<DeterministicMeta>`; `applyDeterministicMeta(sb: FilesWriteClient, fileId: string, meta: DeterministicMeta) → Promise<void>`; `dominantColorsFromPixels(rgba, pixelCount, top?) → DominantColor[]`; `readImageSize(buf) → {width,height} | null`; `snapAspectRatio(w,h) → string | null`; types `DeterministicMeta {width_px, height_px, aspect_ratio, dominant_colors: DominantColor[] | null, has_text: null}`, `DominantColor {hex, share}`.
- `assetMeta/rights.ts` (+ identical api copy): `classifyRights(row: RightsRow) → RightsClassification {selectable_for_production, needs_rights_confirmation, reason, badge: 'verified'|'unverified'|'blocked'|'reference_only'|'ai_review'}`; `recheckRightsForFinal(sb, fileIds) → Promise<{ok, blocked: RightsRecheckItem[], unconfirmed: RightsRecheckItem[]}>` (throws `rights_blocked:` on read error; ids missing from `files_rights_v` count as unconfirmed, never ok).
- `lanes/assetMetaLane.ts`: `assetMetaLaneLoop: LaneLoop`; `assetMetaTick(deps, io?) → Promise<{didWork, meta, enrich}>`; `readAssetMetaFlags(sb)`; `resetAssetMetaLaneState()` (test hook).
- `runEnrichmentJob.ts` (new exports): `SCENE_SUBJECTS`, `HEADLINE_SPACES`, types `SceneSubject`, `HeadlineSpace`.

## Tests + typecheck results

`cd worker && npx vitest run src/creative/__tests__/assetMeta.test.ts`:
```
 Test Files  1 passed (1)
      Tests  30 passed (30)
```
Covers: palette on synthetic RGBA (ranking, shares, transparency, top-5 cap, empty input) + an end-to-end synthetic-PNG palette test gated on sharp availability (skips loudly when absent — see "Lead must do" #1); header parser; aspect snapping; the full rights matrix (12 cases: competitor reference-only, restricted/do_not_use blocked, AI natures → ai_review, internal_only, verified triple, developer unconfirmed candidate, ai_suggested, needs_review, public-source); recheckRightsForFinal (ok / blocked / unconfirmed+missing / empty / loud read-error); lane "flags off = no work" (no targets RPC, no storage download, no backfill call; defaults-off on absent settings rows; enrich batch needs BOTH gates).

`cd worker && npm run typecheck` — my files clean. Pre-existing/peer errors only: `imageProvider.ts` (A-AI, 5×), `runDirector.ts` (A-GEN, unused import), `designRead/readPost.ts` (A-VIS, unused import), `runPushJob.ts` (`web-push` types missing — predates this build).

`npx tsc --noEmit -p tsconfig.json` — clean. `npx tsc --noEmit -p tsconfig.api.json` — clean.

`npx vitest run src/lib/files` — `4 passed (4) / 59 passed (59)`.

Full `cd worker && npx vitest run src/creative` — 200/204 pass; the 4 failures are all peer-owned: `imageProvider.test.ts` (A-AI, 2), `placementSpecs.test.ts` (A-FACTS, 1), `director/schemas.test.ts` (A-GEN, 1). None touch my files.

## Contract deviations (proposed, already implemented — flag if the lead disagrees)

1. **No `aspect_family` FACET in the RPC.** The brief said "aspect family facet/filter", but `2026-08-31_03` documents the live incident: every facet re-scans the RLS-gated `base` CTE and the axis-facet batch tipped the unfiltered query over statement_timeout on 2026-08-23 (the five axis facets were removed for exactly this reason). I shipped the FILTER (RPC WHERE clause) + a fixed-option dropdown in the filter bar (same posture as `primary_category`), no count.
2. **Enrich v2 routes IMAGES only through `callRole`.** `callRole`'s `CallRequest` accepts images, not Anthropic `document` blocks or multi-frame+transcript assemblies; PDF/video/audio keep the existing Haiku tool path even when the flag is on (visual-signal fields are image metadata anyway).
3. **Two extra row fields** (`rights_provenance`, `rights_verified`) in `business_files_search` output — needed for the picker's `showMeta` verified badges; computed on the page slice only.

## What others must do

**Lead:**
1. **Apply `2026-09-02_29_asset_enrich_v2_apply.sql`.** Enable `creative_writer.asset_enrich_v2` / `creative_backfill.asset_meta.enabled` / `creative_backfill.asset_enrich` ONLY after it lands — a missing `file_enrichment_apply_v2` RPC makes v2 enrichment jobs fail loudly + retry (by design).
2. **Add `sharp` to the worker** (`worker/package.json` + Dockerfile). The brief says "sharp is available in the worker" but it is in NEITHER `worker/package.json` NOR the Dockerfile NOR this checkout's node_modules — `deterministic.ts` and the test therefore treat it as a soft dependency exactly like `creativeStore.ts` does: absent → `dominant_colors: null` (logged once, loudly), dims still filled via the header parser.
3. `AspectFamily` is NOT re-exported from `src/types/index.ts` (not my file) — consumers import it from `@/types/files`. Add the re-export if you want it on the barrel.

**A-WORKER:** register `assetMetaLaneLoop` from `worker/src/creative/lanes/assetMetaLane.ts` in `worker/src/index.ts`'s `Promise.all`. My lane declares a LOCAL `LaneDeps` mirror (structurally identical to contracts §3) — once `lanes/types.ts` lands, swap the local interface for the import (one-line change; the loop signature already matches).

**A-VIS:** my lane calls `runBackfillBatch('asset_enrich', deps, { batchSize }) → Promise<{processed, failed, cost_usd: number | null}>` from `worker/src/creative/backfill.ts`, resolved by lazy computed-specifier import (typed locally). If your shipped signature differs, only the `RunBackfillBatchFn` type + one call site in `assetMetaLane.ts` need adjusting. The batch should pull `creative_asset_backfill_targets('enrich', n)` and drive each file through the v2 enrichment path (the `asset_enrich_v2`-flagged `runEnrichmentJob`), gated by `creative_backfill.asset_enrich.approved_cost_usd`, recording `creative_backfill_runs` rows.

**A-API:** `recheckRightsForFinal` in `api/_lib/marketing/creative/rights.ts` is the final-approval rights re-check (contracts §0.9) — wire it into `content_set_approval_asset` and `creative_package_apply` (blocked → refuse with `rights_blocked:`; unconfirmed → require `confirm_unverified_rights: true`).
