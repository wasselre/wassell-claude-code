# Column promotion — turning a `candidate_new_field` into a live column

_Last updated: 2026-08-19 · Phase 3 Increment 3_

When the operator rules a source field `candidate_new_field` ("a genuinely new
universal concept worth a column"), the cockpit surfaces it under **Pending columns**
(Publish tab). Promoting it to a real, releasable `market_listings` column is a
**reviewed, repo-side action** — deliberately not a one-click, because it requires a
frozen-table migration (the highest-risk DDL in this system: `market_listings` is
~4.85 GB and the finder + website read its dependent views) plus an
extractor/adapter change to actually populate the column.

This runbook is the exact procedure. Do the steps in order.

---

## Prerequisites

- The source field is ruled `candidate_new_field` and appears under **Pending
  columns** in `/market-automation`.
- You've chosen a **column name** (snake_case, the CRM field slug), a **type**
  (text / numeric / boolean / timestamptz / jsonb), and bilingual labels.
- You know which raw source path feeds it (e.g. `listing.furnished`) and its shape.

---

## Step 1 — Add the physical column (frozen view-chain migration)

`market_listings` is frozen, so a new column must be added AND `models.schema`
updated AND the frozen artifacts regenerated — which requires unwinding the view
chain. Follow CLAUDE.md → "Frozen models" → the migration template and "Unwinding the
view chain" verbatim. The load-bearing points:

1. **Re-derive the dependency graph first** (it grows):
   ```sql
   SELECT DISTINCT dependent.relname FROM pg_depend d
   JOIN pg_rewrite r ON r.oid = d.objid
   JOIN pg_class dependent ON dependent.oid = r.ev_class
   JOIN pg_class source ON source.oid = d.refobjid
   WHERE source.relname = 'unified_records' AND dependent.relname <> 'unified_records';
   ```
   As of 2026-08-19: `v_market_properties`, `v_our_projects_scope`, `v_website_public`
   depend on `unified_records`; `market_listings_v`, `market_listings_summary`,
   `v_market_listings` depend on `market_listings`.
2. **Capture each dependent view's `pg_get_viewdef`, `reloptions`, AND grants BEFORE
   dropping** — `reloptions` (`security_invoker`) and grants are load-bearing;
   recreating a view without them silently changes whose RLS applies / widens `anon`
   access. `v_our_projects_scope` and `v_website_public` are NOT `security_invoker`;
   `v_website_public` must keep its exact grants (two-key anon rule).
3. In ONE transaction: drop the dependents + `unified_records` + `market_listings_v`
   in dependency order → `ALTER TABLE public.market_listings ADD COLUMN <name> <type>`
   → `UPDATE public.models SET schema = jsonb_set(...)` to add the field to
   `sections[0].fields` → `SELECT regenerate_frozen_model_artifacts((SELECT id FROM
   models WHERE name='market_listings'))` → `SELECT rebuild_unified_records()` →
   recreate `v_market_listings` passthrough (regenerate_model_view returns early for
   frozen — recreate by hand) → recreate every dependent view with its **exact**
   captured def + reloptions, then REVOKE grants back to the captured set.
4. `ADD COLUMN` itself is metadata-only (instant, no table rewrite) — the risk is
   entirely in faithfully restoring the views. Verify after: the 6 views exist,
   `market_listings_v` emits the new column, `reloptions` match, grants match, and a
   test `record_save`/`market_listing_write` can write the new column.

Write it as `supabase/migrations/YYYY-MM-DD_promote_<field>.sql`, apply it yourself
(standing rule), and verify.

## Step 2 — Seed the publish ledger as `held`

A freshly-promoted column has no live data and no consumers yet, so it starts gated:
```sql
INSERT INTO public.market_listing_publish_ledger (platform, canonical_field, status)
VALUES ('<platform>', '<field>', 'held')
ON CONFLICT DO NOTHING;
```
(Or leave it absent — readers treat a missing row as `held`.) Its scraped values will
land in `market_listing_staging` until you release it in Step 5.

## Step 3 — Capture the field in the EXTRACTOR (scraper repo)

The extractor only lifts fields it's told to. In `aqar-scraper/src/rsc.ts` (or the
portal's extractor), read the raw value and carry it on the listing — RAW, no
coercion (that's the adapter's job). Add it to the `Listing` type + `emptyListing` in
`schema.ts` if it's a new top-level field. Follow the
[extraction-playbook](./extraction-playbook.md).

## Step 4 — Emit it in the ADAPTER (scraper repo)

In `crmClient.ts` `build()`, map the raw value into the new column with the field
rules (e.g. `num(l.<x>) || null` for a count, `str(l.<x>)` for text). No derived
values. Follow the [adapter-playbook](./adapter-playbook.md). Then also re-rule the
source field in the cockpit from `candidate_new_field` → `mapped_existing_field`
pointing at the new column (the `source_field_decide` RPC / Decisions tab), so the
governance record matches reality.

**Deploy the scraper to Fly** (`fly deploy --app aqar-sync-rayan`). New scrapes now
produce the field; because the ledger says `held`, `market_listing_write` routes it
to staging, not the live column.

## Step 5 — Release

In the cockpit Publish tab, the new field now shows as **Held**. Click **Release** —
the dry-run shows how many rows have a staged value; confirm to backfill the live
column from staging, flip the ledger to `released`, and let it flow live from then on.

---

## Why not a self-service button?

Auto-running the view-chain unwind from a UI would remove the human review from the
single highest-stakes operation in the system (a bug corrupts the finder + website +
RLS for the whole model). Both the spec and CLAUDE.md require promotion to be a
reviewed repo-side migration. The cockpit's job is to **surface** the pending column
and its evidence; a person writes and applies the migration.

## Checklist

- [ ] Column name + type + bilingual labels chosen.
- [ ] Dependency graph re-derived; view defs + reloptions + grants captured.
- [ ] Migration: drop chain → ADD COLUMN → schema update → regenerate → rebuild →
      recreate views with exact defs/reloptions/grants. One transaction. Applied + verified.
- [ ] Ledger row seeded `held`.
- [ ] Extractor captures the raw field; adapter emits it (0→null rules, no derived).
- [ ] Source field re-ruled `mapped_existing_field` → the new column.
- [ ] Scraper deployed to Fly.
- [ ] Released via the Publish tab (dry-run → backfill).
