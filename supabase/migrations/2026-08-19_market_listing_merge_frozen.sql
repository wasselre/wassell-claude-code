-- Restore a WORKING market_listing_merge for the now-frozen market_listings.
--
-- BACKGROUND: market_listings froze 2026-08-07. The freeze retired the old
-- market_listing_merge (it was rewritten to RAISE, to stop silent no-op "success")
-- and enabled records_block_frozen_writes. But the aqar-sync scraper still called
-- the retired RPC for updates AND POSTed new rows straight to `records`, so BOTH of
-- its write paths died on 2026-08-07 — the Aqar→CRM ingest went fully dark for ~12
-- days (0 inserts / 0 updates / 0 last_seen touches) while the scanner kept scraping
-- fine into its own SQLite. Confirmed from the scraper's own 2026-08-18 logs:
--   "[push] 0 existing CRM listings … failed=18 … INSERT 400 model market_listings
--    is frozen".
-- (loadMaps read `records` → 0 existing → every listing treated as new → INSERT →
--  blocked by the frozen-write trigger; the merge path was never even reached.)
--
-- FIX: market_listing_merge now merges a jsonb patch into the FROZEN table by
-- reading the current jsonb shape from market_listings_v and applying the SAME
-- semantics the old records-era merge had — data = data || jsonb_strip_nulls(patch)
-- — then routing through the record_save dispatcher (→ freeze_apply_row) so the
-- column/junction mapping is the ONE canonical implementation, not duplicated here.
--
-- WHY strip_nulls IS LOAD-BEARING: the scraper emits deed_number / advertiser_phone
-- as null when it has none, but those are enriched out-of-band (bulkFetch deed,
-- REGA-lookup phone). Stripping null patch keys means a null scraper value never
-- overwrites an enriched one — and the enrichment fields the scraper never emits at
-- all (property_split, image_mirror_map, video_mp4_map, original_image_urls, the
-- rega_lookup_* set) are preserved by `||`. A raw record_save (full REPLACE) would
-- wipe every one of them — exactly the identity-decay the original merge existed to
-- prevent.
--
-- ROW LOCK: FOR UPDATE serializes this against the REGA / listing-mirror / clean-text
-- single-key patch RPCs that touch the same row. Frozen tables have no version column,
-- so record_save gives no optimistic protection here — the lock is the protection.

CREATE OR REPLACE FUNCTION public.market_listing_merge(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_model   uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_cur     jsonb;
  v_created uuid;
BEGIN
  -- Serialize against concurrent single-key patch writers on the same row.
  PERFORM 1 FROM public.market_listings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_listing_merge: no market_listings row %', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Current full jsonb (columns + junctions) via the frozen model's _v view.
  SELECT data, created_by_user_id
    INTO v_cur, v_created
    FROM public.market_listings_v
   WHERE id = p_id;

  -- Merge: patch wins per key, but a null patch value never overwrites (strip_nulls),
  -- and any key the patch omits is preserved. Same semantics as the records-era merge.
  v_cur := coalesce(v_cur, '{}'::jsonb) || jsonb_strip_nulls(p_patch);

  -- Route through the dispatcher so freeze_apply_row does the column/junction mapping.
  PERFORM public.record_save(v_model, p_id, v_cur, v_created, NULL);
END $$;

REVOKE ALL ON FUNCTION public.market_listing_merge(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_merge(uuid, jsonb) TO service_role;
