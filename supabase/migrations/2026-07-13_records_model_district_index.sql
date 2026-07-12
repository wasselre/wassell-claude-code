-- Expression index for district-scoped record queries (Project Finder market scan).
--
-- Why: wassell_market_candidates_json filters market_listings by
-- (data->'location'->>'district') = ANY(p_district_ids). Without an index that is
-- a full scan + JSONB detoast of all ~51k market rows (~4.5s), and the per-row
-- wassell_can_view_record() RLS check then ran on top — the whole RPC measured
-- ~30s for a 3-district request (النرجس/العارض/القيروان), blowing past
-- /api/project-finder's 25s function ceiling. Every finder search for a client
-- with district location_items 504'd, and the SPA rendered the timeout as
-- "لا توجد مشاريع مطابقة" (live incident 2026-07-13, client سراج الجهني).
--
-- With the index the district filter is an index cond (~6.3k rows for those three
-- districts) and the RPC drops to ~2s. Benefits every district-scoped query on
-- `records`, not just market listings.
--
-- APPLIED LIVE 2026-07-13 with CREATE INDEX CONCURRENTLY (no write lock).
-- This file is the committed record; IF NOT EXISTS makes a re-run a no-op.

CREATE INDEX IF NOT EXISTS idx_records_model_district
ON public.records (model_id, ((data -> 'location' ->> 'district')));
