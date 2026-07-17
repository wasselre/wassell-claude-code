-- market_listings_summary: stop tripping the authenticated statement timeout.
--
-- SYMPTOM (2026-07-17): every app.wassel.re page load toasts
-- "Server sync failed (market_listings_summary): canceling statement due to
-- statement timeout" — the background SUMMARY load (appStore.loadSummaryRecords →
-- supabaseLoad keyset walk: 16 concurrent id-range shards, pages of 1000)
-- dies mid-walk, so the slim market_listings store never fills.
--
-- ROOT CAUSE (measured live before the fix): the view was security_invoker = true
-- over public.records, so every page ran the records_view RLS policy —
-- wassell_can_view_record(auth.uid(), r.*) — per scanned row. Two compounding
-- problems, from EXPLAIN ANALYZE as the authenticated role:
--   1. No (model_id, id) index existed, so each page's `ORDER BY id LIMIT 1000`
--      needed a top-N sort — the scan read EVERY market row remaining in the
--      shard's id range (3,245 rows for shard 1 page 1, not 1000) and ran the
--      RLS function on each (~1.8ms/row: users JOIN profiles + a
--      model_permissions jsonb scan, per row).
--   2. ONE page = 5,767 ms uncontended. With 16 shard walkers in flight on a
--      shared-CPU instance, statements queue past the authenticated role's 8s
--      statement_timeout. Same disease as the finder market scan fixed in
--      2026-07-13_market_candidates_fast_path.sql.
--
-- FIX — the same scope-class fast path, adapted to a VIEW (the SPA keyset-pages
-- this relation through PostgREST, so it must stay a view, not an RPC):
--   • security_invoker = false → the view reads records with the view owner's
--     rights (postgres, table owner, RLS not FORCEd) — the per-row records_view
--     policy no longer fires.
--   • The access gate is explicit instead: wassell_view_scope_class(auth.uid(),
--     <model>) in a scalar subquery — an uncorrelated InitPlan, evaluated ONCE
--     per statement, NOT per row:
--        'all'      → constant-true; zero per-row auth work (every live profile
--                     with market access today classifies as 'all')
--        'filtered' → per-row wassell_can_view_record, EXACT records_view
--                     semantics preserved for scoped profiles
--        'none'     → constant-false → zero rows, same as RLS returning nothing
--     CASE (not OR/AND) so the expensive per-row call is GUARANTEED skipped for
--     'all' — same posture as wassell_market_candidates_json.
--   • idx_records_model_id_id (model_id, id): pages index-seek straight to the
--     keyset cursor, emit rows already in id order, and LIMIT stops the scan at
--     1000 — no sort, no whole-range rescan.
--   • The slim `data` projection uses ONE jsonb_each pass filtered by key,
--     NOT 26 separate `data->'k'` extractions — per-key `->` re-detoasts the
--     ~2.4KB blob per key (measured 1,907 ms/page vs 460 ms/page here; same
--     gotcha documented in the 2026-07-13 fast-path migration). Note
--     jsonb_object_agg omits ABSENT keys instead of emitting them as null —
--     equivalent for the SPA (slimSummaryData / all readers are `in`/undefined
--     tolerant). The key list is the HARD-SYNCED PAIR of
--     SUMMARY_DATA_KEYS.market_listings in src/lib/lazyModels.ts.
--
-- MEASURED after (EXPLAIN ANALYZE as authenticated, same shard-1 page):
--   5,767 ms → 460 ms (12.5×), scan stops at 1000 rows, InitPlan rows=1.
--   Verified: admin sees 51,483 rows = bare records count; unknown auth.uid →
--   scope class 'none' → 0 rows.
--
-- Rows returned are IDENTICAL to before for every class of user; only the
-- constant-true per-row re-proof for unrestricted users is skipped. If
-- wassell_user_has_action / wassell_record_passes_scope semantics ever change,
-- wassell_view_scope_class must change with them (standing warning next to those
-- functions in schema.sql).
--
-- Applied to wassell-prod via the dashboard SQL editor on 2026-07-17; this file
-- is the committed record.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_records_model_id_id
  ON public.records (model_id, id);

DROP VIEW IF EXISTS public.market_listings_summary;

CREATE VIEW public.market_listings_summary
WITH (security_invoker = false) AS
SELECT
  r.id, r.model_id, r.created_by_user_id, r.created_at, r.updated_at,
  (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
     FROM jsonb_each(r.data) e
    WHERE e.key = ANY (ARRAY[
      'external_id','source','title','listing_type','category','property_type',
      'price','price_per_m2','area','bedrooms','bathrooms',
      'location','latitude','longitude',
      'is_active','main_image_url','advertiser_name','image_count','video_count',
      'advertiser_phone','rega_lookup_status','rega_lookup_error','rega_lookup_at',
      'advertiser','quality_score','quality_grade'
    ])) AS data
FROM public.records r
WHERE r.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
  AND (CASE (SELECT public.wassell_view_scope_class(auth.uid(), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid))
         WHEN 'all'  THEN true
         WHEN 'none' THEN false
         ELSE public.wassell_can_view_record(auth.uid(), r.*)
       END);

GRANT SELECT ON public.market_listings_summary TO authenticated;

COMMIT;
