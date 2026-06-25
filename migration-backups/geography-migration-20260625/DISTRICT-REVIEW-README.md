# District review queue — how to clear the last 97

This is the prerequisite for ever retiring the legacy district names: get every project that has district data onto a `district_lookup`, so nothing depends on text anymore.

## What's in the queue
**97 projects** the auto-backfill could NOT confidently link (`district_lookup` is empty). They still match on legacy text under dual-read, so nothing is broken — this is cleanup.

- File: `district-review-queue.csv` (UTF-8, opens in Excel; sorted best-suggestion first).
- Live table: `public._geo_review_queue` (same data, always re-queryable).
- In-app: the all_projects list now shows a **"حالة مطابقة الحي" (district_match_status)** column — filter it to `needs_manual_review` / `ambiguous_match` / `outside_known_boundary` to see the same 97.

## CSV columns
| Column | Meaning |
|---|---|
| `project_name` | the project |
| `legacy_district` / `legacy_city` | the old text values (what to judge by) |
| `match_status` | why it's unresolved (needs_manual_review / ambiguous_match / outside_known_boundary) |
| `lat` / `lng` | project pin, if any |
| `name_suggestion` (+ `_city`, `name_similarity` 0–1) | best district by name similarity — **≥0.7 is usually a safe typo/variant fix** |
| `coord_suggestion` (+ `_city`, `coord_km`) | nearest district to the pin (only useful when `coord_km` is small) |
| `chosen_district_id` | **you fill this** (or tell me) — the district to link, or leave blank for "no SPL district fits" |
| `name_cand_id` / `coord_cand_id` | the ids behind the two suggestions (handy to paste into `chosen_district_id`) |

## The realistic outcome
Only **7** of the 97 have a strong name suggestion and **0** are within 3 km of a centroid. Most of the rest are projects in **cities outside SPL's district coverage** (SPL has districts for 152 cities) or genuinely odd legacy values — for those the right answer is **"leave on legacy text"** (no SPL district exists yet). So expect to *link a handful* and *leave most* until district coverage expands.

## How to resolve (pick one)
**A. Tell me the decisions.** Easiest: skim the CSV and say e.g. "accept all name suggestions ≥0.7", or "link these 12, leave the rest." I apply them.

**B. In-app, project by project.** Open a queued project → the **"الحي المرتبط" (District Lookup)** field is on the form → pick the district → save. (Use this for one-offs; I'll then re-sync the denormalized name.)

**C. Mark the CSV / table yourself.** Put a district id in `chosen_district_id` for each row you want linked, then I run the apply.

## Applying decisions (what I run)
Decisions are committed by `public.geo_apply_review_decisions()` — it reads every queue row with a `chosen_district_id` and sets the project's `district_lookup` + `district_name` + `city_lookup` + `region_lookup` together (so cards/mirrors stay correct) and marks it `manual_selected`. Shortcuts to stage decisions in bulk before applying:
```sql
-- accept strong name suggestions
UPDATE public._geo_review_queue SET chosen_district_id = name_cand_id WHERE name_similarity >= 0.7;
-- accept very-close coordinate suggestions
UPDATE public._geo_review_queue SET chosen_district_id = coord_cand_id WHERE coord_km <= 2;
SELECT public.geo_apply_review_decisions();  -- returns how many projects were linked
```

## When the queue is empty enough
Once the text-only projects (currently 96) are near zero, we can: flip the engine to lookup-only, switch the assistant's "district" fact to the lookup, then rename+hide the legacy fields for one cycle, and finally drop them. Until then, **keep the legacy names.**
