-- ══════════════════════════════════════════════════════════════════════════
-- 2026-07-29: Listing photo mirror — our own copy of every Aqar listing photo
-- ══════════════════════════════════════════════════════════════════════════
--
-- WHY: Aqar's Cloudflare blocklists datacenter egress by ASN. Around 2026-07-24
-- it began 403-ing Fly's ranges, which broke the listing-photo cleaning lane:
-- worker/src/runCleanTextJob.ts downloaded each photo from images.aqar.fm to
-- re-host it for fal, and that download started failing BEFORE fal was ever
-- called — every photo in the cleaning grid showed فشل. Measured 2026-07-29 on
-- one image: laptop 200, me-central1 VM 200, Fly bom 200, but Fly sin (4 of 5
-- deck-worker machines) 403, a freshly-provisioned Fly fra 403, and Fly sjc
-- (the scanner's own region) 403. Region-hopping is not a fix.
--
-- The 2026-07-29 stopgap (commit 74bd44e2) routed refused downloads through a
-- token-gated proxy on the me-central1 WAHA VM. That works, but it keeps a
-- USER-FACING action (clean this listing's photos) coupled to Aqar's willingness
-- to serve us at that exact moment, and Aqar can blocklist the proxy IP too.
--
-- THE DURABLE FIX (this migration): mirror a listing's photos into a bucket we
-- own at SCAN/IMPORT time — when the market_listings record is created or its
-- image_urls change — and record our URLs on the record next to the originals.
-- The clean lane then reads OUR bucket and never touches Aqar's CDN. If a
-- mirror is missing the lane still falls back to the direct→proxy path, so this
-- is strictly additive: worst case is today's behaviour.
--
-- SHAPE (mirrors the established data.video_mp4_map cache exactly):
--   records.data.image_mirror_map = { "<aqar source url>": "<our public url>" }
-- Keyed by SOURCE URL, not by index, so it is order-independent and idempotent
-- on re-scan: a re-scan returning the same URLs finds them present and does no
-- work; only genuinely new photos are fetched. The originals in image_urls are
-- never modified.
--
-- SAFE FROM THE WEEKLY RECONCILE: the scanner updates listings through
-- market_listing_merge (data = data || jsonb_strip_nulls(patch)), a MERGE, so
-- keys it doesn't know about — image_mirror_map, video_mp4_map,
-- original_image_urls, the REGA lookup fields — survive. Do not "simplify" that
-- back to a PATCH on records; it replaces the whole JSONB column.
--
-- COST (measured 2026-07-29): 53,488 listings / 51,333 with photos / 408,399
-- photos, averaging 36 KB (Aqar serves 750px webp) => ~14 GB for a complete
-- mirror. Storage is not the constraint. The constraint is that every mirror
-- fetch from Fly must currently traverse the me-central1 proxy, which shares a
-- small VM with the WhatsApp gateway — so the historical backfill is a
-- deliberately throttled, resumable, OPERATOR-RUN pass
-- (scripts/backfill-listing-mirrors.mjs), never an automatic stampede. Only
-- new/changed listings mirror automatically, via the trigger below.
-- ══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- 1. Storage bucket
-- ────────────────────────────────────────────────────────────────────────
-- Dedicated bucket rather than a prefix inside marketing-assets, because:
--   * ~400k disposable objects would swamp the bucket that holds generated,
--     NON-disposable assets, and make any future bulk operation there risky;
--   * retention differs — a mirror is a cache that can be re-derived from Aqar
--     (or pruned when a listing sells), a generated asset cannot;
--   * it keeps storage cost attributable to this feature.
-- Public read is REQUIRED: fal.ai fetches the input bytes server-side, and the
-- whole point is to hand it a URL that is not Aqar's.
INSERT INTO storage.buckets (id, name, public)
VALUES ('listing-photos', 'listing-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "listing_photos_public_read" ON storage.objects;
CREATE POLICY "listing_photos_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'listing-photos');

-- No insert/update/delete policies on purpose: only the Fly worker writes here,
-- and it uses the service role (which bypasses RLS). A browser must never be
-- able to write into the mirror.

-- ────────────────────────────────────────────────────────────────────────
-- 2. generation_jobs gains kind='listing-mirror'
-- ────────────────────────────────────────────────────────────────────────
-- Rides the existing queue + claim/complete/fail RPCs, exactly like
-- kind='video-convert' (2026-07-19), which is the same shape: keyed to the
-- LISTING record, message_id NULL, caches a map on the listing.
ALTER TABLE public.generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs
  ADD  CONSTRAINT generation_jobs_kind_check
  CHECK (kind IN ('image','video','audio','clean-text','video-convert','listing-mirror'));

-- A mirror job has NO user: it is enqueued by a trigger on a scanner write, and
-- market_listings rows have no creator (2 of 53,488 carry created_by_user_id).
-- Widen user_id to allow NULL, but keep the NOT-NULL invariant for every other
-- kind so a user-initiated job can still never be created anonymous.
ALTER TABLE public.generation_jobs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_user_required_check;
ALTER TABLE public.generation_jobs
  ADD  CONSTRAINT generation_jobs_user_required_check
  CHECK (user_id IS NOT NULL OR kind = 'listing-mirror');

-- The owner-select RLS policy (user_id = auth.uid()) simply never matches a
-- NULL user_id, so system mirror jobs are invisible to every user. Correct:
-- they are infrastructure, drained and inspected by the service role only.

-- ────────────────────────────────────────────────────────────────────────
-- 3. Settings — an in-DB kill switch, so cost/pressure can be changed
--    without a deploy
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listing_mirror_settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Master switch for AUTOMATIC (trigger-driven) mirroring of new/changed
  -- listings. Turning this off does not affect already-mirrored photos, the
  -- clean lane's fallback, or a manually-run backfill.
  is_enabled              boolean NOT NULL DEFAULT true,
  -- Optional per-listing photo cap (NULL = mirror them all). A lever for the
  -- rare 49-photo listing if storage ever becomes a concern; a partially
  -- mirrored listing degrades gracefully (the uncovered photos fall back).
  max_photos_per_listing  int,
  -- BACKPRESSURE. Refuse to enqueue when this many mirror jobs are already
  -- waiting. Without it a single scanner catch-up run is an uncontrolled burst:
  -- the 2,121 listings discovered-but-unextracted on 2026-07-29 would insert in
  -- one batch and queue ~16,000 photo downloads, all of which currently
  -- traverse the me-central1 proxy that shares a VM with the WhatsApp gateway.
  -- Nothing is lost by refusing — the backlog lives in the DATA
  -- (image_mirror_map), not in the queue, so a listing turned away here is
  -- picked up by the next scan-update, the backfill script, or the clean lane's
  -- lazy self-heal. This bounds proxy exposure permanently, for every caller.
  max_queue_depth         int     NOT NULL DEFAULT 200,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.listing_mirror_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.listing_mirror_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "listing_mirror_settings_read" ON public.listing_mirror_settings;
CREATE POLICY "listing_mirror_settings_read"
  ON public.listing_mirror_settings FOR SELECT TO authenticated USING (true);
-- Writes: service role only (bypasses RLS). Flip it with an UPDATE from a
-- trusted context, not from the browser.

-- ────────────────────────────────────────────────────────────────────────
-- 4. Model-id helper (idiom copied from _rollups_units_model_id)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._listing_mirror_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'market_listings' LIMIT 1;
$fn$;

-- ────────────────────────────────────────────────────────────────────────
-- 5. listing_mirror_map_patch — merge mirrored URLs onto the listing
-- ────────────────────────────────────────────────────────────────────────
-- Same lesson as clean_text_entry_patch (2026-07-19): do the read-modify-write
-- INSIDE one row-locked UPDATE instead of a whole-data record_save with a
-- version check. A mirror job only ever ADDS keys to one sub-object, so it
-- never needs the rest of `data` and never needs a version check — which means
-- it can never convoy on the listing row against the scanner's merge, the REGA
-- lookup worker, or the video-convert cache write.
CREATE OR REPLACE FUNCTION public.listing_mirror_map_patch(
  p_listing_id uuid,
  p_patch      jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'listing_mirror_map_patch: p_patch must be a jsonb object';
  END IF;

  UPDATE public.records r
  SET data = jsonb_set(
        r.data,
        '{image_mirror_map}',
        COALESCE(r.data->'image_mirror_map', '{}'::jsonb) || p_patch
      ),
      updated_at = now()
  WHERE r.id = p_listing_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Listing deleted mid-run. Loud abort, never a silent no-op (CLAUDE.md).
    RAISE EXCEPTION 'listing_mirror_map_patch: listing % not found', p_listing_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.listing_mirror_map_patch(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_mirror_map_patch(uuid, jsonb) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 6. listing_mirror_enqueue — idempotent job creation
-- ────────────────────────────────────────────────────────────────────────
-- Returns the job id, or NULL when nothing was enqueued (already covered, no
-- photos, disabled, or a job is already in flight). Callers: the trigger below,
-- the backfill script, and the clean lane's lazy self-heal.
CREATE OR REPLACE FUNCTION public.listing_mirror_enqueue(
  p_listing_id uuid,
  p_reason     text DEFAULT 'manual'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_job_id  uuid;
  v_data    jsonb;
  v_missing int;
  v_depth   int;
  v_cap     int;
BEGIN
  SELECT r.data INTO v_data
  FROM public.records r
  WHERE r.id = p_listing_id AND r.model_id = public._listing_mirror_model_id();
  IF v_data IS NULL THEN
    RETURN NULL;  -- not a market listing (or gone) — nothing to mirror
  END IF;

  -- How many of this listing's photos are NOT yet mirrored? Counting here (not
  -- in the worker) keeps a fully-mirrored listing from ever costing a job claim.
  SELECT count(*) INTO v_missing
  FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(v_data->'image_urls') = 'array'
              THEN v_data->'image_urls' ELSE '[]'::jsonb END) AS u(url)
  WHERE u.url ~ '^https?://'
    AND COALESCE(v_data->'image_mirror_map', '{}'::jsonb) -> u.url IS NULL;

  IF v_missing = 0 THEN
    RETURN NULL;
  END IF;

  -- One active job per listing. Partial-index-free guard: cheap because
  -- generation_jobs_record_idx covers (record_id, created_at DESC) and the
  -- in-flight tail is tiny.
  IF EXISTS (
    SELECT 1 FROM public.generation_jobs
    WHERE record_id = p_listing_id
      AND kind = 'listing-mirror'
      AND status IN ('queued','running')
  ) THEN
    RETURN NULL;
  END IF;

  -- Backpressure: never let the mirror queue grow unbounded (see the
  -- max_queue_depth comment on listing_mirror_settings). Counting only 'queued'
  -- — running jobs are already being drained and are bounded by the fleet.
  SELECT s.max_queue_depth INTO v_cap FROM public.listing_mirror_settings s WHERE s.id;
  IF COALESCE(v_cap, 0) > 0 THEN
    SELECT count(*) INTO v_depth
    FROM public.generation_jobs
    WHERE kind = 'listing-mirror' AND status = 'queued';
    IF v_depth >= v_cap THEN
      RETURN NULL;
    END IF;
  END IF;

  v_job_id := gen_random_uuid();
  INSERT INTO public.generation_jobs (id, record_id, message_id, user_id, kind, status, prompt, params)
  VALUES (
    v_job_id, p_listing_id, NULL, NULL, 'listing-mirror', 'queued', NULL,
    jsonb_build_object('listing_id', p_listing_id, 'reason', p_reason, 'missing_at_enqueue', v_missing)
  );
  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.listing_mirror_enqueue(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_mirror_enqueue(uuid, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 7. The scan-time hook — a trigger on records
-- ────────────────────────────────────────────────────────────────────────
-- Fires for market_listings only, on INSERT and on any UPDATE that actually
-- CHANGES image_urls. The weekly full reconcile touches ~3,000 listings with
-- price/sold updates whose image_urls are unchanged — IS DISTINCT FROM makes
-- those free. A day's new listings (~250, occasionally ~2,000) each enqueue one
-- job carrying ~7.6 photos.
--
-- AFTER, not BEFORE: enqueueing is a side effect on another table, and we only
-- want it once the listing row is actually committed-visible to the worker.
CREATE OR REPLACE FUNCTION public.records_enqueue_listing_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._listing_mirror_model_id() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.data->'image_urls' IS NOT DISTINCT FROM OLD.data->'image_urls' THEN
    RETURN NULL;
  END IF;

  SELECT s.is_enabled INTO v_enabled FROM public.listing_mirror_settings s WHERE s.id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NULL;
  END IF;

  -- listing_mirror_enqueue is itself idempotent and returns NULL when there is
  -- nothing to do, so this is safe to call unconditionally here.
  PERFORM public.listing_mirror_enqueue(NEW.id, CASE WHEN TG_OP = 'INSERT' THEN 'scan-insert' ELSE 'scan-update' END);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS records_enqueue_listing_mirror ON public.records;
CREATE TRIGGER records_enqueue_listing_mirror
AFTER INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.records_enqueue_listing_mirror();

-- ────────────────────────────────────────────────────────────────────────
-- 8. listing_mirror_backlog — what the operator backfill walks
-- ────────────────────────────────────────────────────────────────────────
-- Listings with at least one un-mirrored photo, newest first, active-only by
-- default (a sold listing will never be sent to a client, so it is not worth
-- storage). Returns the missing-photo count so the script can report real
-- progress and estimate proxy load before it starts.
CREATE OR REPLACE FUNCTION public.listing_mirror_backlog(
  p_limit       int     DEFAULT 500,
  p_active_only boolean DEFAULT true
) RETURNS TABLE (listing_id uuid, external_id text, missing int, total int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT r.id,
         r.data->>'external_id',
         (SELECT count(*)::int
            FROM jsonb_array_elements_text(r.data->'image_urls') AS u(url)
           WHERE u.url ~ '^https?://'
             AND COALESCE(r.data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL),
         jsonb_array_length(r.data->'image_urls')
  FROM public.records r
  WHERE r.model_id = public._listing_mirror_model_id()
    AND jsonb_typeof(r.data->'image_urls') = 'array'
    AND jsonb_array_length(r.data->'image_urls') > 0
    AND (NOT p_active_only OR COALESCE((r.data->>'is_active')::boolean, true))
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(r.data->'image_urls') AS u(url)
      WHERE u.url ~ '^https?://'
        AND COALESCE(r.data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL
    )
  ORDER BY r.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.listing_mirror_backlog(int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_mirror_backlog(int, boolean) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 9. listing_mirror_stats — whole-backlog totals for reporting
-- ────────────────────────────────────────────────────────────────────────
-- One aggregate over the model, so the backfill script's --dry-run stays
-- instant on 51k listings and does not have to walk rows (or borrow the
-- ops-only claude_runner_sql backdoor) just to print a number.
CREATE OR REPLACE FUNCTION public.listing_mirror_stats(
  p_active_only boolean DEFAULT true
) RETURNS TABLE (
  listings_total     int,
  listings_pending   int,
  photos_total       int,
  photos_mirrored    int,
  photos_pending     int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  WITH per_listing AS (
    SELECT
      (SELECT count(*)
         FROM jsonb_array_elements_text(r.data->'image_urls') AS u(url)
        WHERE u.url ~ '^https?://')::int AS total,
      (SELECT count(*)
         FROM jsonb_array_elements_text(r.data->'image_urls') AS u(url)
        WHERE u.url ~ '^https?://'
          AND COALESCE(r.data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL)::int AS missing
    FROM public.records r
    WHERE r.model_id = public._listing_mirror_model_id()
      AND jsonb_typeof(r.data->'image_urls') = 'array'
      AND jsonb_array_length(r.data->'image_urls') > 0
      AND (NOT p_active_only OR COALESCE((r.data->>'is_active')::boolean, true))
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE missing > 0)::int,
         COALESCE(sum(total), 0)::int,
         COALESCE(sum(total - missing), 0)::int,
         COALESCE(sum(missing), 0)::int
  FROM per_listing;
$$;

REVOKE ALL ON FUNCTION public.listing_mirror_stats(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_mirror_stats(boolean) TO service_role;

COMMIT;
