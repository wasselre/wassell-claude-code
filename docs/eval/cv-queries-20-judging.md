# Judging the 20 visual-search queries (Gate C)

`docs/eval/cv-queries-20.json` holds 20 queries a marketer would type into the
competitor Visual Library (10 Arabic, 10 English). Search quality is measured
as **nDCG@10** over human relevance judgments, plus **distinct videos in the
top-10** (variety). Until you judge, every shot counts as relevance 0 and the
report says "no judgments yet" instead of a number.

## Procedure (≈ 30–45 min for all 20 queries)

1. Run the search once so there are candidates to judge (needs
   `MODAL_CV_URL` + `MODAL_CV_TOKEN` in `.env.local`):
   ```
   node scripts/eval/cv-eval.mjs --search-eval docs/eval/cv-queries-20.json
   ```
   This writes `docs/eval/results/<date>-search-candidates.json` — for each
   query the top-10 shots (raw order **and** the ≤ 1-per-video diversified
   order, merged), each with `shot_id`, a representative frame URL, the shot's
   time range, the competitor org and the original post URL.
2. For each query, open every candidate's `frame` URL (and the `post_url` at
   `start_ms` if the frame is ambiguous) and give it a score:

   | score | meaning |
   |---|---|
   | 3 | exact — this is the shot the query describes (subject, setting, graphic kind, and mood all match) |
   | 2 | relevant — a marketer would keep it as a reference for this query even if one element is off (e.g. golden hour vs day) |
   | 1 | marginal — same broad setting but wrong subject or graphic kind (a static map for an "animated map" query) |
   | 0 | not relevant |

   Judge the **shot**, not the whole video. The `hints` on each query list the
   controlled-vocabulary labels (contracts §6) the query implies — use them as
   a checklist, not as the sole criterion.
3. Enter the scores in `cv-queries-20.json` under that query's `judgments`
   as `"<shot_id>": <score>`. Include zeros — a judged 0 is information, an
   absent key is "unjudged". Put anything you want to remember in `notes`.
4. Re-run the command from step 1. The report (`<date>-cv-ingest.md`, section
   "Search eval") now shows nDCG@10 per query and the mean, the number of
   still-unjudged shots in each top-10, and the gate verdicts.

## Gates

- mean nDCG@10 (raw RPC order) **≥ 0.70**
- **≥ 8 distinct videos** in every raw top-10 (the API layer additionally caps
  per org and applies MMR; the report shows the diversified number too so you
  can see how much the cap contributes)

## Notes for judges

- Judge what is *visible*. A shot whose summary text sounds right but whose
  frame shows something else is a 0 — that is exactly the failure mode the
  eval must catch.
- If two candidates are the same moment from duplicate uploads of one video,
  score both; the distinct-videos metric handles the redundancy.
- Re-running the search after ingest changes can surface new shots. Old
  judgments stay valid (they are keyed by shot id, which is stable); only the
  new shots need scoring. The report always tells you how many are unjudged.
- Two judges disagreeing by one step is normal; by two steps, discuss and
  record the reason in `notes`.
