# Creative Director eval harness

Offline harness for the Post Creative Director (contracts: `docs/creative-director-contracts.md`).
It measures the pure director stages (A-GEN `worker/src/creative/director/runDirector.ts`)
against real project records — **read-only against prod, zero DB writes**.

## Files

| File | Produced by | What it is |
|---|---|---|
| `docs/eval/creative-eval-set.json` | `creative-build-sets.mjs` | 20 briefs = 4 projects (ready / off_plan / sold_out / conflict) × 5 recipes {feature_spec, lifestyle, offer, event, launch} × alternating format {single, carousel}. |
| `docs/eval/creative-design-read-pilot.json` | `creative-build-sets.mjs` | Tier-0 design-read pilot (contracts §9): 60 competitor static slides + 25 carousels (all slides), deterministic sha1 order, org/content-type diverse, internal orgs excluded. `labels` start `null` for later human tagging. |
| `docs/eval/results/<date>-<set>-<model>.jsonl` | `creative-run.mjs` | One JSON line per brief (see schema below). |

## Usage

```bash
# 1. (Re)build the sets from live data (service role, read-only)
node scripts/eval/creative-build-sets.mjs

# 2. Run a stage. Model comes from --provider/--model, else mos_settings.ai_roles,
#    else the non-final CREATIVE_DEFAULTS in worker/src/creative/roles.ts.
node scripts/eval/creative-run.mjs --set creative-eval-set --stage concepts
node scripts/eval/creative-run.mjs --set creative-eval-set --stage package --provider anthropic --model claude-opus-5
node scripts/eval/creative-run.mjs --set creative-eval-set --stage derivatives --limit 4

# 3. Compare result files
node scripts/eval/creative-compare.mjs
node scripts/eval/creative-compare.mjs --glob opus
```

## Requirements

- `.env.local` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (reads only) and,
  when the director runs for real, `ANTHROPIC_API_KEY`.
- **tsx** — the run driver executes the worker's TS modules, which use
  bundler-style `.js` specifiers only tsx resolves. It is a worker devDependency:
  `npm --prefix worker install` if the probe fails. The runner looks for
  `node_modules/tsx` (root), then `worker/node_modules/tsx`, then falls back to `npx tsx`.
- **Peer modules** (optional): A-GEN's `worker/src/creative/director/runDirector.ts`
  and A-FACTS' `worker/src/creative/{grounding,placementSpecs}.ts`. When the
  director is absent the run degrades to **facts + validators only** — every line
  records `director:"missing"` and the facts summary, and the script prints a
  NOTE at the end. A present-but-broken peer import is LOUD (rethrown), never
  mistaken for "missing".

## Result line schema

```json
{
  "set": "creative-eval-set", "item_id": "b01", "project_id": "…", "recipe": "feature_spec",
  "format": "single", "stage": "concepts", "provider": "anthropic", "model": "claude-sonnet-5",
  "director": "ran" /* or "missing" */,
  "facts": { "project_name": "…", "readiness": "ready", "sold_out": false, "viable": true,
             "missing": [], "warnings": [], "fact_count": 21 },
  "validator_pass": true, "grounding_pass": true, "rule_pass": true,
  "errors": [], "warnings": [],
  "latency_ms": 8123, "cost_usd": 0.012, "usage": { "in": 4300, "out": 900 },
  "roles": { "…": "ledgerToJson payload" },
  "output": { "…": "the stage output (ConceptsOutput / BasePackage / DerivativesOutput)" }
}
```

`validator_pass` = the returned validation's `ok` after bucketing; errors are
classified by their `rule` string: claim/fact/readiness → **grounding**,
prohibited/hashtag/caption/language/entity → **rule**, everything else →
**validator**. `cost_usd` is `null` when any call used an unpriced model
(unknown ≠ free — the compare table prints `$x+?`).

## Notes

- The eval-set projects are auto-selected from live `all_projects` with the
  same readiness rules as `worker/src/marketing/script/facts.ts`
  (`deriveReadiness` + sold-out), best-score first with a sha1(id) tiebreak, so
  the set is deterministic for a given DB state. (The sibling worktree's
  curated id list was unreachable from this worktree's sandbox.)
- The pilot list's sha1 ordering over `content_media_id` makes the sample
  stable and reproducible; per-org (6) and per-content-type (15) caps keep one
  big advertiser from filling it.
