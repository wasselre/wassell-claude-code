# A-AI report — Creative roles + image/runner providers + eval harness

*2026-09-02. Worktree `marketing-writing-posts-590cfc`. Brief: `docs/creative-director/briefs/A-AI.md`.*

## Files created (all owned by A-AI; nothing else touched)

| File | What |
|---|---|
| `worker/src/creative/roles.ts` | `CREATIVE_ROLE_KEYS` (the nine §5 keys), `CREATIVE_DEFAULTS` (DATA defaults, non-final), `resolveCreativeRoles`, `mergeCreativeRoles`, `callCreativeRole`, `recordCreativeRoleUse`, ledger re-exports. |
| `worker/src/creative/imageProvider.ts` | `ImageProvider` (generate/edit/combine/removeText), `createImageProvider`, `resolveImageProvider`, `mapAspectToFal`, injectable `ImageTransport`. |
| `worker/src/creative/runnerProvider.ts` | `enqueueRunnerRead`, `awaitRunnerJob`, `callViaRunner`, `RunnerJobKind`, `RunnerOptions`. |
| `worker/src/creative/__tests__/roles.test.ts` | 22 tests, fake settings client + fake LLM provider, no network. |
| `worker/src/creative/__tests__/imageProvider.test.ts` | 16 tests, fake transport capturing env at call time, no network. |
| `worker/src/creative/__tests__/runnerProvider.test.ts` | 12 tests, fake `claude_jobs` table, no network. |
| `scripts/eval/creative-build-sets.mjs` | Builds `docs/eval/creative-eval-set.json` + `docs/eval/creative-design-read-pilot.json` (read-only PostgREST). |
| `scripts/eval/creative-run.mjs` | Runs A-GEN's pure director per brief via a generated tsx driver; JSONL results; NO DB writes. |
| `scripts/eval/creative-compare.mjs` | Comparison table across `docs/eval/results/*.jsonl`. |
| `docs/eval/README-creative.md` | Usage, file formats, requirements, result-line schema. |

No migrations written (none in my lane — A-DB owns the `ai_roles` additive seed and the `claude_jobs` kind CHECK widening).

## Exported signatures

```ts
// roles.ts
CREATIVE_ROLE_KEYS: readonly ['creative_concepts','creative_package','creative_derivatives',
  'design_read_slide','design_read_post','asset_enrich_v2','image_edit','image_generate','image_remove_text']
type CreativeRoleKey, type ImageRoleKey, isImageRoleKey(key)
type CreativeProviderKind = ProviderKind | 'runner' | 'fal'
interface CreativeRoleConfig { provider: CreativeProviderKind; model: string; version?: string; params?: RoleParams }
CREATIVE_DEFAULTS: Readonly<Record<CreativeRoleKey, CreativeRoleConfig>>   // contracts §5, NON-FINAL
CREATIVE_ROLES_CACHE_TTL_MS = 60_000
resolveCreativeRoles(sb: SettingsClient, {force?, now?}?) → Record<CreativeRoleKey, CreativeRoleConfig>
mergeCreativeRoles(defaults, settings: unknown) → Record<…>                // pure, exported for tests
resetCreativeRolesState(): void                                            // test hook
interface CreativeCallResult<T> { output; usage; cost_usd: number|null; provider: CreativeProviderKind; model; version; latency_ms; structured_via? }
interface CreativeAiContext extends AiContext { creativeRoles?: Partial<Record<CreativeRoleKey, CreativeRoleConfig>>; runner?: RunnerOptions }
RUNNER_KIND_BY_ROLE = { design_read_slide: 'mkt_visual_design_slide', design_read_post: 'mkt_visual_design_post' }
callCreativeRole<T>(key: CreativeRoleKey, req: CallRequest, ctx?: CreativeAiContext) → CreativeCallResult<T>
recordCreativeRoleUse(ledger, role, result: CreativeCallResult<unknown>) → RoleUseLedger
// re-exports: createRoleLedger, recordRoleUse, ledgerToJson, resolveRoles (+ types)

// imageProvider.ts
interface ImageProvider { kind: 'fal'|'stub'; model: string;
  generate(req:{prompt, aspect, n}) → ImageResult;
  edit(req:{prompt, sources: string[], aspect?, keepFraming?}) → ImageResult;
  combine(req:{prompt, sources: {url, role}[]}) → ImageResult;
  removeText(req:{source}) → ImageResult }
interface ImageResult { urls: string[]; provider: 'fal'|'stub'; model: string; cost_usd: number|null; latency_ms: number }
createImageProvider(cfg: CreativeRoleConfig /*provider must be 'fal'*/, deps?: ImageProviderDeps) → ImageProvider
resolveImageProvider(roleKey: ImageRoleKey, sb: SettingsClient, deps?) → Promise<ImageProvider>   // reads ai_roles (60 s cache)
mapAspectToFal(aspect) → ChatAspectRatio                                    // '4:5'→'3:4', '1.91:1'→'16:9', loud
interface ImageTransport { chat(...); textRemoval(...); poll(...) }         // injectable; default wraps imageGen.ts

// runnerProvider.ts
type RunnerJobKind = 'mkt_visual_design_slide' | 'mkt_visual_design_post'
enqueueRunnerRead(sb, kind, items: unknown[], params?) → Promise<string /*jobId*/>
awaitRunnerJob(sb, jobId, {timeoutMs=30*60_000, pollMs=5_000, sleep?, now?}?) → {status:'ready', result, attempts}
callViaRunner<T>(kind, req: CallRequest, opts?: RunnerOptions) → CreativeCallResult<T>
```

Design points honored from the brief/contracts:

- **Sibling adapter untouched.** `callCreativeRole` delegates to the sibling `callRole` with an EXPLICIT `RoleConfig` object; the sibling `RoleKey`/`ProviderKind` unions are not extended. Creative-only providers are handled before any sibling call: `'fal'` → `provider:fal role '<key>' is an image role — use imageProvider`; `'runner'` → `callViaRunner`; `'modal'` → use `embed()`.
- **Same settings row, my keys only.** `resolveCreativeRoles` reads `mos_settings.ai_roles`, merges ONLY the nine creative keys over `CREATIVE_DEFAULTS` (sibling keys in the same row are skipped silently — no warn); validation mirrors the sibling `mergeRoles` (console.error + keep default on malformed; `null` param unsets a knob); 60 s cache + inflight coalescing + stale-on-read-error, all tested.
- **imageProvider never edits imageGen.ts.** Model routing rides the env overrides imageGen.ts already reads synchronously (`FAL_CHAT_T2I_MODEL_ID` / `FAL_CHAT_MODEL_ID` / `FAL_CLEAN_TEXT_MODEL_ID` / `FAL_CLEAN_TEXT_PROMPT`), set/restored around the synchronous env-capture window. `keepFraming` + single source → the text-removal submit path (it omits `aspect_ratio`, the verified keep-source-framing behavior) with OUR prompt; multi-source + keepFraming logs a loud console.error and re-aspects. `removeText` deliberately keeps imageGen's tuned CLEAN_TEXT_PROMPT. Stub when `FAL_KEY==='stub'`. `cost_usd: null` always (fal pricing unknown — never a guessed number).
- **Runner manifest contract.** `enqueueRunnerRead` inserts ONE `claude_jobs` row `{kind, status:'pending', payload:{...params, manifest_items: items}}`. `awaitRunnerJob` maps `ready`→ok; `failed`/`cancelled`/`blocked`→`provider:runner …`; timeout→`provider:runner … did not finish within`. `callViaRunner` packages `req.images` (URL→`{stored_url, carousel_index}`, base64→`{base64, mime, carousel_index}`) + `prompt/system/schema` payload params, and returns `cost_usd: 0` (subscription — same convention as the runner handlers' `p_cost: 0`; not null, which means unknown).

## Tests + typecheck — NOT RUN (sandbox blocked all execution)

Every attempt to execute `node` / `npx` / `npm` / `tsc` / `vitest` in this session
was refused by the permission layer (`This command requires approval`), including
the exact brief commands. Only read-only shell (`ls`, `cat`, `grep`, `cmp`) was
permitted. **The lead must run:**

```bash
cd worker && npm run typecheck
cd worker && npx vitest run src/creative
node scripts/eval/creative-build-sets.mjs        # produces docs/eval/creative-*.json
```

The three test files (50 tests total) were written against the sibling
`roles.test.ts` conventions and reviewed statically against the implementations;
the two eval scripts were desk-checked line-by-line. That is not a substitute
for a green run — treat the above commands as the gate.

Environment gaps found in THIS worktree (the _COMMON brief's "deps are
installed" does not hold here): `worker/node_modules` is **absent**, and `tsx`
is in **neither** root nor worker `node_modules` (root has `typescript` +
`vitest` + the runtime deps the worker imports, so the typecheck/vitest should
work once allowed). `creative-run.mjs` probes root → worker → `npx tsx` and
tells the operator to `npm --prefix worker install` if all miss.

`docs/eval/creative-eval-set.json` / `creative-design-read-pilot.json` were NOT
generated (build script blocked) — run `creative-build-sets.mjs` once; it is
idempotent and read-only.

## Contract deviations / notes for the lead

1. **Sibling curated project ids unreadable.** The brief allowed reusing
   `…/elegant-albattani-c38c42/scripts/eval/build-eval-sets.mjs` READ-ONLY, but
   the sandbox refuses all reads outside this worktree. `creative-build-sets.mjs`
   instead AUTO-SELECTS the four projects (ready / off_plan / sold_out /
   conflict) from live `all_projects` using the same `deriveReadiness` +
   sold-out rules as `worker/src/marketing/script/facts.ts`, best-quality-score
   first with a sha1(id) tiebreak — deterministic per DB state, ids recorded in
   the JSON's `meta.projects`.
2. **`claude_jobs` column is `payload`, not `params`.** The A-VIS brief says
   "items from `job.params.manifest_items`" — there is no `params` column on
   `claude_jobs` (that's `mos_creative_jobs`). My enqueue writes
   `payload.manifest_items`; **A-VIS's handlers must read
   `job.payload.manifest_items`** (every existing handler reads `job.payload.*`).
   Flagged in my runnerProvider header too.
3. **Aspect approximations.** `ChatAspectRatio` in imageGen.ts has no `4:5` /
   `1.91:1`; the adapter maps them to `3:4` / `16:9` and logs loudly (design
   step crops). Widening `ChatAspectRatio` is the sibling owner's call — propose
   to the lead if native 4:5 matters (it will for feed masters).
4. **`recordCreativeRoleUse` cast.** The sibling ledger types `provider:
   ProviderKind`; creative-only provider strings ('runner'/'fal') are recorded
   via a documented cast in MY file rather than widening the reused module.
5. **Eval role-override field.** The override lives on `ctx.creativeRoles`
   (not `ctx.roles`) because `CreativeAiContext extends AiContext` and the
   sibling's `roles` field is keyed/typed for its own RoleKey union. A-GEN:
   `deps.callRole` as `(key, req) => callCreativeRole(key, req, ctx)` works
   unchanged.

## What other agents / the lead must do

- **A-VIS** — consume `enqueueRunnerRead(sb, kind, items, params?)` /
  `awaitRunnerJob(sb, jobId, opts)`; read `job.payload.manifest_items`
  (+ optional `payload.prompt/system/schema` when the call came via
  `callViaRunner`). `callCreativeRole('design_read_*', req, {sb})` is ready
  for the worker lane.
- **A-GEN** — `callCreativeRole<T>(key, req, ctx)` per contracts; ledger via
  `createRoleLedger` + `recordCreativeRoleUse` (accepts runner/fal results).
- **A-DB** — nothing new from me beyond the contracted seeds: `ai_roles`
  additive merge of my nine keys and the `claude_jobs` kind CHECK widening
  (+ the OCR-lane kind array) for `mkt_visual_design_slide|post`.
- **LEAD** — run the three commands above; install worker deps
  (`npm --prefix worker install`) so `tsx` exists for `creative-run.mjs`;
  generate + commit `docs/eval/creative-*.json`.
