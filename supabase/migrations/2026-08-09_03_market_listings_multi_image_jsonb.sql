-- ─────────────────────────────────────────────────────────────────────────
-- market_listings: multi_image / multi_video columns text -> jsonb
--
-- THE BUG. freeze_model has no entry for the `multi_image` / `multi_video`
-- field types, so they fell through to its `text` default. image_urls and
-- video_urls became text columns holding a JSON array STRING, and the
-- generated market_listings_v therefore emitted data.image_urls as a jsonb
-- *string*, not an array. Every consumer gates on Array.isArray(...), which is
-- false for a string — so collectSourceUrls() in the mirror worker returned []
-- and the photo-cleaning lane saw no images. Same root cause as `location`.
--
-- Fixing the storage shape rather than each consumer: with jsonb columns the
-- generated view emits real arrays and no application code has to know.
--
-- ─────────────────────────────────────────────────────────────────────────
-- HOW THIS WAS RUN (and why it is not one ALTER)
--
-- ALTER COLUMN ... TYPE rewrites the entire table. market_listings is 4.5 GB
-- (1.27 GB heap + TOAST, source_payload alone is 1.55 GB), so an in-place
-- change means minutes of ACCESS EXCLUSIVE on the busiest table in the app —
-- a real outage. It also exceeded the client timeout when attempted.
--
-- So: shadow columns added (catalog-only, instant), backfilled in batches
-- under ordinary row locks, then a catalog-only rename swap. Phases 1 and 2
-- are online and resumable; phase 3 is the only locking step and it touches
-- no heap pages.
--
-- Applied to wassell-prod 2026-08-09 as three steps. Verified after phase 2:
-- 0 unparseable, 0 non-array, and 0 rows differing from a fresh parse of the
-- originals, across 314,052 image_urls and 64,582 video_urls.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Phase 1 — shadow columns (catalog-only) ──────────────────────────────
ALTER TABLE public.market_listings
  ADD COLUMN IF NOT EXISTS image_urls_j jsonb,
  ADD COLUMN IF NOT EXISTS video_urls_j jsonb;

-- ── Phase 2 — online batched backfill ────────────────────────────────────
-- Batched so no single statement holds locks for long and each chunk commits.
-- try_jsonb returns NULL on a parse failure, which would be silent data loss,
-- so phase 3 refuses to swap unless every row matches exactly.
DO $$
DECLARE n int;
BEGIN
  LOOP
    UPDATE public.market_listings m
       SET image_urls_j = public.try_jsonb(m.image_urls),
           video_urls_j = public.try_jsonb(m.video_urls)
     WHERE m.id IN (
       SELECT id FROM public.market_listings
        WHERE (image_urls IS NOT NULL AND image_urls_j IS NULL)
           OR (video_urls IS NOT NULL AND video_urls_j IS NULL)
        LIMIT 25000);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    RAISE NOTICE 'backfilled % rows', n;
  END LOOP;
END $$;

-- ── Phase 3 — the swap (catalog-only, one transaction) ───────────────────
BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.market_listings
   WHERE image_urls_j IS DISTINCT FROM public.try_jsonb(image_urls)
      OR video_urls_j IS DISTINCT FROM public.try_jsonb(video_urls);
  IF n > 0 THEN
    RAISE EXCEPTION 'aborting swap: % row(s) drifted between text and jsonb copies', n;
  END IF;
END $$;

-- Dependency graph, MEASURED — deeper than the CLAUDE.md note, which lists
-- only v_our_projects_scope. Re-derive it before any future frozen-table DDL;
-- it grows every time someone stacks a reporting view on unified_records.
--   market_listings   <- market_listings_v, market_listings_summary, v_market_listings
--   market_listings_v <- unified_records
--   unified_records   <- v_market_properties, v_our_projects_scope, v_website_public
DROP VIEW IF EXISTS public.v_website_public;
DROP VIEW IF EXISTS public.v_our_projects_scope;
DROP VIEW IF EXISTS public.v_market_properties;
DROP VIEW IF EXISTS public.unified_records;
DROP VIEW IF EXISTS public.market_listings_v;
DROP VIEW IF EXISTS public.market_listings_summary;
DROP VIEW IF EXISTS public.v_market_listings;

-- The four generated policies embed image_urls in their scope jsonb, so they
-- block the column drop ("cannot alter type of a column used in a policy
-- definition"). regenerate_frozen_model_artifacts recreates all four.
DROP POLICY IF EXISTS "frozen_view"   ON public.market_listings;
DROP POLICY IF EXISTS "frozen_insert" ON public.market_listings;
DROP POLICY IF EXISTS "frozen_update" ON public.market_listings;
DROP POLICY IF EXISTS "frozen_delete" ON public.market_listings;

ALTER TABLE public.market_listings DROP COLUMN image_urls;
ALTER TABLE public.market_listings DROP COLUMN video_urls;
ALTER TABLE public.market_listings RENAME COLUMN image_urls_j TO image_urls;
ALTER TABLE public.market_listings RENAME COLUMN video_urls_j TO video_urls;

-- freeze_apply_row must be patched IN THIS SAME TRANSACTION. Patching earlier
-- would make every save assign jsonb to a still-text column; patching later
-- leaves a window assigning text to a now-jsonb column. It previously sent
-- anything outside its jsonb list through `%I = $1->>'name'` (TEXT), so
-- multi_image/multi_video hit the ELSE branch. Re-emitted verbatim from the
-- live definition with only that one branch changed:
--
--   ELSIF v_ftype IN ('notes','section_mirror','section_selector','assignee',
--                     'multi_image','multi_video') THEN     -- <-- two added
--
-- (Full body applied live; see migration
--  market_listings_multi_image_video_jsonb_swap_v3.)
--
-- regenerate_frozen_model_artifacts needs NO change: its ELSE branch emits
-- `t.image_urls` uncast into the view, so a jsonb column yields a real array,
-- and `image_urls::text` into the RLS scope jsonb, which is still fine.
SELECT public.regenerate_frozen_model_artifacts('8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid);
SELECT public.rebuild_unified_records();

-- NOTE: regenerate_model_view() cannot rebuild v_market_listings — it returns
-- early for frozen models (`IF v_model.is_hardcoded THEN RETURN`). The v_<name>
-- passthrough must be recreated by hand. (This cost one failed attempt.)
--
-- The four hand-written views are recreated with their captured definitions.
-- reloptions are load-bearing and restored exactly:
--   market_listings_summary  invoker=false  (the 2026-07-17 scope-class fast path)
--   v_market_listings        (none)
--   v_market_properties      invoker=true
--   v_our_projects_scope     (none) — a DEFINER view; making it an invoker view
--                            silently changes whose RLS gates the website feed
--   v_website_public         invoker=false  (embeds its own two-key gate)
--
-- Grants: Supabase's ALTER DEFAULT PRIVILEGES grants anon/authenticated on any
-- new view in public, which WIDENS access on the three that did not have it —
-- so the exact pre-drop grant sets are restored:
--   REVOKE ALL ON market_listings_summary FROM anon;
--   REVOKE ALL ON v_market_listings       FROM anon, authenticated;
--   REVOKE ALL ON v_market_properties     FROM anon, authenticated;
--
-- The three listing_mirror_* helpers are also updated in this transaction:
-- they read m.image_urls directly now, because try_jsonb(text) no longer
-- resolves against a jsonb argument.

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- VERIFIED AFTER (prod, 2026-08-09)
--   image_urls / video_urls           jsonb
--   shadow columns remaining          0
--   views present                     7 of 7      policies 4 of 4
--   rows                              314,070     unified_records 314,070
--   data.image_urls via the view      array (5 elems on the probe listing)
--   data.image_urls[0] -> mirror map  resolves to the listing-photos URL
--   record_save round-trip            OK — title changed, arrays intact,
--                                     custom_data.image_mirror_map survived
--   summary view, 1,000-row page      35.2 ms (invoker=false preserved)
--   listing-mirror jobs spawned       0
--
-- STILL OPEN: freeze_model's own type map is unchanged, so the NEXT model
-- frozen with a multi_image / multi_video field repeats this bug. Fixing that
-- means teaching freeze_model (and freeze_check_coercion) to map both types to
-- jsonb. Tracked separately — it is a platform fix, not a market_listings one.
-- ─────────────────────────────────────────────────────────────────────────
