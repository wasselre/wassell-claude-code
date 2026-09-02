# A-FACTS — report (Post Creative Director build)

*2026-09-02. Scope: briefs `_COMMON.md` + `A-FACTS.md`; contracts §0 rules 3–7, §8, §10, §12.*

## Files created

| File | What it is |
|---|---|
| `worker/src/creative/facts.ts` | `loadCreativeFacts` + catalog rendering, built ON the sibling `worker/src/marketing/script/facts.ts` (reused, untouched). |
| `worker/src/creative/grounding.ts` | Pure validators `validateConcepts` / `validateBase` / `validateDerivatives` + `buildViolationFeedback` (contracts §8). |
| `worker/src/creative/placementSpecs.ts` | WORKER COPY of the PLACEMENT_SPECS block appended to `platformRules.ts` (marked as copy; body byte-identical). |
| `worker/src/creative/__tests__/facts.test.ts` | Arabic fixtures: Arabic-Indic + Western digits, catalog line shape, missing-record error. |
| `worker/src/creative/__tests__/grounding.test.ts` | Full rule battery (see below). |
| `worker/src/creative/__tests__/placementSpecs.test.ts` | Spec data, `aspectFamily`, `masterAspectFor`, `adaptationSkeleton` incl. 4:5→9:16 and carousel→story. |
| `src/pages/Marketing/lib/__tests__/placementSpecs.test.ts` | SPA-side twin of the worker placementSpecs test. |

## Files changed

| File | Change |
|---|---|
| `src/lib/marketingOS/platformRules.ts` | **ADDITIVE ONLY** — appended the PLACEMENT_SPECS block after `preflightPublishSet`. No existing line touched; still zero imports (pure for the api bundle). |

No sibling/peer file was created, stubbed, or edited. `worker/src/marketing/script/{types,facts,entities,claims,brief}.ts` reused as-is.

## Exported signatures

### `worker/src/creative/facts.ts`
```ts
export type NumeralStyle = 'arabic_indic' | 'western';
export function toArabicIndic(n: number | string): string;
export function renderFactAr(fact: Pick<Fact, 'rendered_ar'>, opts: { numerals: NumeralStyle }): string;
export function catalogLine(fact: Fact, opts?: { numerals?: NumeralStyle }): string;
export function factsCatalog(facts: Fact[], opts?: { numerals?: NumeralStyle }): string;
export interface CreativeFacts { package: FactsPackage; catalog: string; refs: FactRef[] }
export async function loadCreativeFacts(
  sb: SupabaseClient, projectId: string, opts?: { developerName?: string | null },
): Promise<CreativeFacts>;
```
- Catalog lines: `F5 · price_from · تبدأ من 1,050,000 ر.س (available_price_range.min) [claimable]` (non-claimable → `[context-only]` + note).
- Developer resolution: `opts.developerName` wins; otherwise `resolveLookupName(sb, record.developer)` (uuid → unified_records name, inline text → as-is).
- Missing record throws `facts_insufficient:` (stable prefix).

### `worker/src/creative/grounding.ts`
```ts
export interface Violation { path: string; rule: string; detail: string }
export interface ValidationResult { ok: boolean; errors: Violation[]; warnings: Violation[] }
export interface AssetMetaEntry { rights: UsageRights | string | null; rights_verified: boolean; nature: AssetNature | string | null }
export interface GroundingCtx {
  facts: FactsPackage; refs: FactRef[]; language: string;
  selectedTargets: DerivativeTarget[]; specs: PlacementSpec[]; brandKit: BrandKit | null;
  rules: WriterRules; blocklist: BlockEntry[]; allowedTerms: string[];
  competitorMediaIds: Set<string>; assetMeta: Map<string, AssetMetaEntry>;
  policyCheck?: (rec: AiRecommendation) => { ok: boolean; reason: string };
}
export function prohibitedPhrases(rules: WriterRules): string[];
export function validateConcepts(out: ConceptsOutput, ctx: GroundingCtx): ValidationResult;
export function validateBase(base: BasePackage, ctx: GroundingCtx): ValidationResult;
export function validateDerivatives(out: DerivativesOutput, ctx: GroundingCtx): ValidationResult;
export function buildViolationFeedback(errors: Violation[]): string;
```
Rules implemented (contracts §8 + brief): claim gate via sibling `extractMentions → classifyMention → gateByClass` (fail → `claim_unverified` error, review → warning, pass-but-uncited → `fact_ref_missing` error, unknown ref → `fact_ref_unknown`); readiness wording vs `facts.readiness` (`readiness_mismatch`); entity gate via sibling `detectEntities` with blocklist + `allowedTerms` (`entity_org/phone/url/handle/license/...`); captions only for selected organic targets (`target_not_selected`, `copy_kind`), `caption_max` / `hashtags_max` from the spec, blocklisted hashtag/org hashtags (`hashtag_blocked`); paid copy only for paid targets; assets — competitor ids (`asset_competitor`), `restricted`/`do_not_use` (`rights_blocked`), `!rights_verified` requires `needs_rights_confirmation` (`rights_confirmation`, error for production / warning for reference-only); palette ⊂ brand kit or in `deviations` — advisory → warning, constraint → error (`palette_off_brand`); language = record (`language_mismatch`); prohibited phrases from writer_rules (`prohibited_phrase`); `project_name_lead` = project name (normAr) or its Latin (`project_name_lead`); headline counts (`headline_count`, `slide_headline`, `slides_missing`); derivative dimensions vs spec (`aspect_not_allowed`, `px_mismatch`, `max_slides`, `spec_missing` warning); AI recommendations — allowed §7 modes (`ai_mode`), known non-competitor sources (`ai_source_unknown`), injected `policyCheck` (`policy_blocked`).

### `platformRules.ts` additions (and the identical worker copy)
```ts
export type PlacementType = /* same union as contracts.ts */;
export interface PlacementSpec { /* structural twin of contracts.ts */ }
export const HASHTAG_MAX: Record<string, number>;       // { instagram: 30 }
export const PLACEMENT_SPECS: PlacementSpec[];          // 12 entries, see below
export function placementSpec(platform: string, type: PlacementType | string): PlacementSpec | undefined;
export type AspectFamily = 'square' | 'portrait' | 'vertical' | 'landscape' | 'wide' | 'other';
export function aspectFamily(aspect: string): AspectFamily;
export interface PlacementTargetRef { platform: string; placement_type: string }
export function masterAspectFor(targets: PlacementTargetRef[]): string;
export interface AdaptationSkeleton { aspect; px; safe_zones; requires_separate_design; image_change; slide_mapping }
export function adaptationSkeleton(masterAspect: string, spec: PlacementSpec, masterPlacementType?: string): AdaptationSkeleton;
```
Specs: instagram feed (4:5/1:1 → 1080×1350/1080×1080, caption 2000, hashtags 30), carousel (same + max_slides 10), story (9:16 1080×1920, safe 250/250), tiktok photo_mode (9:16/3:4, jpg/webp, max 10, caption 2200), snapchat story (9:16, one file, caption 160), x post (16:9/1:1/4:5, max 4, manual), website post (16:9, manual), meta ad_feed (1:1/4:5), ad_story (9:16, safe 250), ad_carousel (1:1, max 10), ad_reels (9:16), google ad_display (1.91:1/1:1, manual).

## Decisions / contract interpretations (no deviations requested)

1. **Prohibited phrases from `WriterRules`:** `WriterRules.shared/post` are prose lines, so `prohibitedPhrases` extracts quoted spans («…» / "…") **only from lines that read as prohibitions** (ممنوع / لا تستخدم / تجنّب / never / avoid / …). This is how «بدون سعي» becomes a hard rule without false-positiving affirmative rules like «استخدم صيغة «تبدأ من»» (tested both ways).
2. **Concept numbers:** concepts carry no `fact_refs`, so the citation rule applies from the base package onward; hard claim failures (wrong price, forbidden class) still error at concept stage, ambiguous ones warn.
3. **`masterAspectFor` scoring:** native aspect = 2 pts/target, crop-compatible family = 1 pt/target; ties break by a preference list (`4:5, 1:1, 9:16, 16:9, 3:4, 1.91:1`); empty selection → `4:5`. Crop-compatible pairs: {square, portrait} and {landscape, wide}; `vertical` (9:16) is only self-compatible → any hop to/from 9:16 is `requires_separate_design`.
4. **`adaptationSkeleton`:** taller target (smaller w/h) → `extend`, wider → `crop`; different family → `requires_separate_design: true` (so 4:5→9:16 = separate + extend, 4:5→1:1 = crop, 1:1→4:5 = extend). Added an **optional third param** `masterPlacementType` — `'carousel'` → non-carousel adds the contracted `slide_mapping` PLACEHOLDER and forces separate design. Signature is otherwise as contracted; the param is additive.
5. **`caption_max`/`hashtags_max`** come from the existing `CAPTION_MAX` + a new `HASHTAG_MAX = { instagram: 30 }` (the 30 already enforced in `preflightPublishSet`). X/website/google carry no caption ceiling in the specs (brief didn't specify one; manual-publish paths).
6. **`image_change: 'replace'`** is in the type but never emitted by the skeleton — brief's "extend/replace" for 4:5→9:16 was resolved deterministically to `extend` (outpaint top/bottom), which the model can override to `replace` in its prose if the art direction demands it.
7. **Worker copy difference:** `worker/src/creative/placementSpecs.ts` is byte-identical to the platformRules block EXCEPT the header comment and a 4-line `CAPTION_MAX` twin (platformRules defines it earlier for the preflight). Both headers say to change both together.

## Tests + typecheck — NOT RUN (environment block, lead please run)

Every attempt to execute `npm`/`npx`/`tsc`/`vitest` in this session was refused by the permission gate (only read-only commands were allowed). Exact outputs:

```
$ npx tsc --noEmit -p worker/tsconfig.json
→ This command requires approval
$ node node_modules/vitest/vitest.mjs run worker/src/creative --root worker
→ This command requires approval
$ cd worker && npm run typecheck && npx vitest run src/creative
→ … requires approval: npm run typecheck, npx vitest run src/creative
```

Commands the lead must run (from the brief):
```
cd worker && npm run typecheck && npx vitest run src/creative
npx vitest run src/pages/Marketing/lib/__tests__/placementSpecs.test.ts
npx tsc --noEmit -p tsconfig.json
```
Static verification I did instead: both tsconfigs re-checked by hand (`noUncheckedIndexedAccess` on root — all index accesses in the platformRules block are `??`-guarded or land in optional fields; worker tsconfig excludes `__tests__` so test files don't affect `npm run typecheck`; root excludes `*.test.ts`). All imports in my files resolve to real exports of `worker/src/creative/contracts.ts`, `worker/src/marketing/script/{claims,entities,types,facts}.ts`, and my own `placementSpecs.ts`. Test fixtures were traced through the sibling gate logic (e.g. `١٬٠٥٠٬٠٠٠` unifies to `1,050,000` → price class → matches the claimable `price_from` fact; `0501234567` is skipped by `extractMentions` ≥9-digit rule and caught by `detectEntities`' phone regex; `ر.س` does not trip the URL regex).

## What other agents / the lead must do

- **A-GEN (director/orchestrator):** build `GroundingCtx` per stage; inject `policyCheck` from `director/policy.ts`; on errors, re-prompt ONCE with `buildViolationFeedback(errors)`; unresolved → save package with warnings + `status='draft'` + job result `needs_attention:true` (contracts §8).
- **A-WORKER:** the `facts` stage of `runCreativeJob` = `loadCreativeFacts(sb, projectId)` → store `{catalog, refs}` on the job/package; pass `developerName` through to the blocklist builder (`allowedTerms` when `allow_developer_name`).
- **A-API:** `creative_targets.suggested_master_aspect` = `masterAspectFor(selected targets)`; derivative rows' `limits` = the spec ceilings the validator enforces.
- **LEAD:** run the three commands above; if you ever edit the PLACEMENT_SPECS block in `platformRules.ts`, mirror it into `worker/src/creative/placementSpecs.ts` (headers in both files say so).
