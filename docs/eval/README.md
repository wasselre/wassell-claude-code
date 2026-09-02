# Eval harness — Script Writer v2 + Competitor Visual Intelligence

Owner: EVAL. Contracts: `docs/marketing-script-visual-contracts.md` (§1 schema,
§4 roles, §5 types, §6 vocabulary). Everything here runs from the repo root
with Node ≥ 20 and `.env.local` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
`ANTHROPIC_API_KEY` for real pipeline runs; `MODAL_CV_URL` + `MODAL_CV_TOKEN`
for the search eval). `docs/eval/asr-ab/` belongs to agent ASR and is not
covered here.

## Files

| Path | What |
|---|---|
| `script-eval-set.json` | 20 script briefs (real projects × recipes) with `expected` facts — **generated** by `scripts/eval/build-eval-sets.mjs --script` |
| `cv-golden-30.json` | 30 stored competitor videos for shot-detection / ingest / search gates — **generated** by `build-eval-sets.mjs --cv`; human `boundaries_ms` + ffmpeg `pseudo_boundaries_ms` live here |
| `cv-golden-30-labeling.md` | how a human marks shot boundaries; pseudo-label caveats |
| `cv-queries-20.json` | 20 AR/EN visual-search queries with an empty `judgments` map |
| `cv-queries-20-judging.md` | how to judge search results (0–3 scale, nDCG) |
| `results/` | dated outputs: `<date>-<role>.json/.md`, `<date>-cv-ingest.md/.json`, `<date>-search-candidates.json`, `ocr-spot-verdicts.json` (human) |
| `scripts/eval/build-eval-sets.mjs` | rebuilds both golden inputs from the live DB (preserves labels) |
| `scripts/eval/cv-pseudo-label.mjs` | ffmpeg scene detection → `pseudo_boundaries_ms` |
| `scripts/eval/run-role-matrix.mjs` | role × model comparison harness (script_writer, script_reviewer, frame_describer, shot_analyzer) |
| `scripts/eval/score-scripts.mjs` | interactive 1–5 human rubric for script drafts, side by side |
| `scripts/eval/cv-eval.mjs` | ingest gates (boundaries P/R, frames, keyframes, OCR spot check, storage, cost) + `--search-eval` (nDCG@10, distinct videos) |
| `scripts/eval/_lib/` | `env.mjs` (env loader, service client, no-truncation pager), `text.mjs` (normAr, Jaccard, number/phone extraction), `pipeline-bridge.ts` (tsx child that calls the worker entry points) |

## 1. Script writer / reviewer

### Rebuild the brief set
```
node scripts/eval/build-eval-sets.mjs --script
```
Reads `unified_records` (all_projects, developers, marketers) and
`mos_content_v`; writes `docs/eval/script-eval-set.json`. Re-run when
prices/availability change so `expected.hard_facts` stay honest.

Composition (2026-09-02): 5 recipes × 4 briefs = 20. Readiness: 10 ready,
9 off-plan, 1 status conflict (سديم فلل: `project_status=sold_out` with 16
available units and a price); 2 sold-out (يمام فلورز 8 — 12/0 units, no
available price → `expect_pipeline_refusal` for the `offer` recipe; and the
conflict case); 1 UAE/AED project (Binghatti Skyrise); 1 near-sold-out
(المشرقية 2 — 1 of 468). Only 2 briefs are bound to real `mos_content`
rows (V-041, V-042 → أكنان 25) because those are the only video content
items with a `project_id` in the DB.

**Synthesised briefs.** 18 of 20 entries have `content_id: null`. The harness
passes `{content_id:null, project_id, recipe, duration_sec}` and
`runScriptEval` must build the `Brief` from the project record alone:
`language:'ar'`, `purpose:'unknown'`, `platforms:[]`, `cta` = the default
Wassel CTA from `script_writer_rules`, `existing_scenes:[]`,
`assets_summary:{count:0,kinds:{}}`, `funnel` per recipe default. Nothing is
written to `mos_content` / `mos_script_drafts` for a synthesised brief
(`content_id` is null; the entry must run in a no-persist mode). This is the
only way to evaluate 5 recipes across 15+ projects with the two real content
items that exist.

`expected.readiness` rule (`deriveReadiness` in `build-eval-sets.mjs`):
`sold_out` = status `sold_out` OR (units > 0 AND available = 0);
`conflict` = off-plan status with `construction_status=ready`, or `sold_out`
with available > 0; `off_plan` = `available_on_map | under_construction |
upcoming`; `ready` = status `available` OR construction `ready`; else
`unknown`. If W-SCRIPT's `facts.ts` disagrees, the matrix reports
`readiness≠` per run — resolve by fixing whichever side is wrong, then
re-run.

`expected.must_not_contain`: the marketer's name/phone when the record has a
marketer (none do today), the **developer's phone/email** (developer *name*
is allowed — `allow_developer_name: true`), and any phone found in the
record's free-text fields. The harness additionally treats *any* phone
number in a script as an entity hit.

### Run the matrix
```
node scripts/eval/run-role-matrix.mjs --role script_writer \
  --models claude-opus-5,claude-sonnet-5,claude-sonnet-4-6 \
  --set docs/eval/script-eval-set.json --limit 20 \
  --out docs/eval/results/2026-09-02-script_writer.json

node scripts/eval/run-role-matrix.mjs --role script_reviewer --writer claude-opus-5 \
  --models claude-sonnet-5,claude-haiku-4-5-20251001
```
Flags: `--only S01,S07` · `--concurrency 2` · `--timeout-min 15` ·
`--dry-run` (plan only) · model spec `provider:model` for non-Anthropic
(`openai_compat:deepseek-chat`). Each (brief × model) is one child process
(`worker/node_modules/tsx` running `scripts/eval/_lib/pipeline-bridge.ts`)
that imports `worker/src/marketing/script/evalEntry.ts` and calls
`runScriptEval(input, roleOverrides)` → `{draft, review, cost_usd,
latency_ms, roles}`. **If the entry does not exist yet** the harness prints
"pipeline not available yet", still validates the data, and records every run
as `unavailable` — never a crash, never a fake score.

Per run the harness records: status (`ok` / `refused` = `facts_insufficient:`
/ `error` / `unavailable`), whether a refusal was expected, validator claim
verdicts by class (FAIL / REVIEW), **hard-class FAILs** (price, area,
unit_count, date, distance, duration, availability, guarantee, payment),
entity hits (validator entities + `must_not_contain` + any phone in the
text), numbers ≥ 1000 not traceable to a project fact (±1 %), rhetorical
check pass rate (validator `checks`), judge scores, `repaired` / `final`,
readiness + sold_out agreement, scene count, total vs target duration,
exemplar leakage (max Jaccard of the voiceover vs every exemplar transcript
+ shared 5-grams), latency and cost. The full scenes are stored for the
human rubric. Output: JSON + markdown (per-model summary, per-brief cells,
flagged claims).

**Reviewer comparisons.** `--role script_reviewer` fixes the writer and
varies the reviewer, but the assumed entry regenerates the draft per call, so
writer variance remains. If W-SCRIPT exposes a `draft_id` passthrough in
`roleOverrides` later, the harness should reuse one draft per brief — noted
as a follow-up, not implemented.

### Human rubric
```
node scripts/eval/score-scripts.mjs --results docs/eval/results/2026-09-02-script_writer.json --rater rayan --blind
```
Shows all models' drafts for a brief side by side, asks 1–5 for **script
quality**, **Saudi-Arabic quality**, **editing required** (5 = none), writes
`runs[].human`, per-model means into `summary`, and a "Human ratings" section
into the .md. `--blind` hides model names (A/B/C), `--resume` skips already
rated, `--entry S03` / `--model …` narrow.

### Script gates (per model, whole set)
| gate | threshold |
|---|---|
| hard-class claim FAILs after repair | **0** |
| entity hits (marketer/phone/competitor names, any phone) | **0** |
| rhetorical checks passing | **≥ 95 %** |
| exemplar leakage | max Jaccard **< 0.3** and < 3 shared 5-grams vs any exemplar |
| judge overall = pass | **≥ 80 %** of drafts |
| expected refusals | every `expect_pipeline_refusal` brief refused with `facts_insufficient:`; no unexpected refusals |
| human rubric (advisory) | script quality ≥ 4.0, Saudi-Arabic ≥ 4.0, editing required ≥ 3.5 |

A model passes when all hard gates hold; cost and p50 latency decide between
passing models.

## 2. Competitor visual intelligence

### Rebuild the golden set
```
node scripts/eval/build-eval-sets.mjs --cv
node scripts/eval/cv-pseudo-label.mjs          # needs ffmpeg on PATH
```
Selection (deterministic — candidates walked in sha1(id) order under quotas):
duration 10–120 s, ≤ 50 MB, enrichment `content_type` ∈ walkthrough /
project_launch / offer / teaser / brand / event, ≤ 6 per org (+2 in the last
relaxation pass), ≥ 10 silent (empty transcript). Composition (2026-09-02):
instagram 12 · tiktok 10 · youtube 8; walkthrough 7 · project_launch 6 ·
brand 5 · offer 4 · teaser 4 · event 4; 7 orgs (Riva 7, Almajdiah 6, Alajlan
Riviera 5, الرمز 5, مجبب 3, Menaco 2, عزوم الأعمار 2); durations 10–30 s 10 ·
30–60 s 12 · 60–120 s 8; 11 silent / 19 with transcript. Pseudo-labels:
30/30 videos, 227 cuts at threshold 0.4 (ffmpeg 8.1.2); 4 videos have 0
pseudo cuts (single takes or all-dissolve edits — human label needed).

Human labels: follow `cv-golden-30-labeling.md`. The builder preserves
`boundaries_ms` / `labeling_status` / pseudo fields across rebuilds for
videos that stay in the set.

### Ingest eval (Gate B)
```
node scripts/eval/cv-eval.mjs                         # → docs/eval/results/<date>-cv-ingest.md
node scripts/eval/cv-eval.mjs --tolerance 250 --interval-ms 500
```
Reads `mkt_cv_videos / mkt_cv_shots / mkt_cv_frames / mkt_cv_cost_ledger`
for the 30 `content_media_id`s. Reports per video: shots (micro), frames vs
expected (`⌊duration/500⌋ + 1 + boundaries`), keyframes per shot, shots
without any frame, reference kind (H human / P pseudo), boundary precision /
recall at ±250 ms, storage MB, cost $. Lists 50 OCR frames (seeded, spread
across videos) with their `public_url` for a human to verify; record
`{"<frame_id>": true|false}` in `docs/eval/results/ocr-spot-verdicts.json`
and re-run to get OCR accuracy. Before ingest runs the report says "not
ingested" for every row — that is the expected state today.

### Search eval (Gate C)
```
node scripts/eval/cv-eval.mjs --search-eval docs/eval/cv-queries-20.json
```
Embeds each query via Modal `/embed_query`, calls the RPC `mkt_cv_search`
directly (API-free: no org cap / MMR — the report also shows a ≤ 1-shot-per-
video diversified view), computes nDCG@10 from `judgments` and distinct
videos in the top-10, and writes the candidates for judging
(`cv-queries-20-judging.md`). Skips with a note when the Modal env is absent.

### Role matrix for the vision roles
```
node scripts/eval/run-role-matrix.mjs --role frame_describer --models claude-haiku-4-5-20251001,claude-sonnet-5 --limit 30
node scripts/eval/run-role-matrix.mjs --role shot_analyzer  --models claude-sonnet-5,claude-opus-5 --limit 30
```
Items = representative frames / non-micro shots of the golden videos already
in `mkt_cv_*` (round-robin across videos so `--limit 30` is not 30 shots of
G01). Calls `worker/src/marketing/cv/evalEntry.ts` `runCvEval({role,
frame_id|shot_id, video_id}, {[role]: {provider, model}})` → `{output,
cost_usd, latency_ms, roles}` — same graceful "pipeline not available yet"
behaviour. Scores: controlled-vocabulary compliance of `output.labels`
(§6 `group:value`), off-vocab labels, summary length, cross-model label
agreement (pairwise Jaccard on the same item), latency, cost.

### CV gates
| gate | threshold |
|---|---|
| shot-boundary precision at ±250 ms | **≥ 90 %** (vs human labels; vs pseudo-labels the number is indicative) |
| shot-boundary recall at ±250 ms | **≥ 85 %** vs human labels only (pseudo-label recall is a lower bound, not gated) |
| every non-micro shot has ≥ 1 frame | **0** shots without a frame |
| OCR spot check | **≥ 90 %** of 50 judged frames correct |
| frame count | within 0.8–1.3 × expected per video (advisory, listed) |
| search nDCG@10 (raw RPC order) | **≥ 0.70** |
| distinct videos in every top-10 | **≥ 8** |

## 3. Plain-language summary

- The **script eval** asks: given 20 real projects and 5 script recipes, does
  each candidate model write scripts whose numbers all trace back to the
  project record (no invented prices), that never leak a phone number or a
  marketer's name, that don't copy competitor transcripts, and that a judge
  and a human both rate as good Saudi Arabic? A model that fails any hard
  gate is out regardless of how cheap or fast it is.
- The **visual eval** asks: did the pipeline cut the 30 videos into shots
  where a human would cut them (within a quarter of a second), keep at least
  one frame per shot, read the on-screen text correctly, and does searching
  for "drone shot at golden hour" actually return drone shots at golden hour
  from many different videos?
- Everything data-side (the 20 briefs, the 30 videos, ffmpeg pseudo-cuts, the
  20 queries) exists now. Everything that needs the pipeline (drafts, judge
  scores, frames, search) runs the moment the coordinator wires
  `evalEntry.ts`; until then the harness says so and records "unavailable"
  rather than inventing numbers.

## 4. Certain vs assumed

- **Measured:** the data compositions above, pseudo-cut counts, ffmpeg 8.1.2
  present on this machine, `worker/node_modules/tsx` present.
- **Assumed (per coordinator brief, not yet verified against code):** the
  `runScriptEval` / `runCvEval` signatures and the shape of `draft.scenes`,
  `draft.exemplars[].transcript`, `draft.facts.readiness`, `review.validator.
  {claims,entities,checks}`, `review.judge`. The scorer reads them defensively
  (missing → `null`, never a fabricated pass), but a renamed field will show
  up as all-null columns — check the first real run's JSON.
