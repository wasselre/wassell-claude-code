-- Market-ingest Phase 3, Increment 2: the REAL publish gate — staging + enforcement
-- + dry-run diff + backfill-on-release.
--
-- A canonical_field flows to its live market_listings column only when its publish
-- ledger row is `released`. A GOVERNED field (a mapping target) that is NOT released
-- is HELD: its proposed value lands in market_listing_staging instead of the live
-- column. Non-governed / operational fields (external_id, source, is_active,
-- last_seen, …) are never mapping targets, so they always write live.
--
-- SAFETY: every currently-mapped field is grandfathered `released` (Increment 1), so
-- the split below routes the ENTIRE patch to the live write and staging stays empty —
-- i.e. behaviour is byte-identical to the pre-gate path until an operator actually
-- holds a field. Verified before wiring the scraper.
--
-- Applied to prod (wassell-prod) 2026-08-19.

-- 1. Staging store. RPC-only (SECURITY DEFINER) + service_role; no public policies.
CREATE TABLE IF NOT EXISTS public.market_listing_staging (
  record_id  uuid PRIMARY KEY,
  platform   text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_listing_staging ENABLE ROW LEVEL SECURITY;

-- 2. The single gated write. Routes released fields live (merge, preserving
-- enrichment via strip_nulls, exactly like the old market_listing_merge), and held
-- fields to staging. Handles create-or-update: v_cur is empty for a new id.
CREATE OR REPLACE FUNCTION public.market_listing_write(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_model    uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_platform text := coalesce(p_patch->>'source',
                             (SELECT source FROM public.market_listings WHERE id = p_id), 'aqar');
  v_held     text[];
  v_live     jsonb;
  v_staged   jsonb := '{}'::jsonb;
  v_cur      jsonb;
  v_created  uuid;
BEGIN
  -- Serialize against concurrent single-key patch writers (REGA / mirror / clean).
  PERFORM 1 FROM public.market_listings WHERE id = p_id FOR UPDATE;

  -- Governed-but-not-released canonical fields = HELD.
  SELECT coalesce(array_agg(sfm.canonical_field), ARRAY[]::text[]) INTO v_held
  FROM public.source_field_mappings sfm
  WHERE sfm.platform = v_platform
    AND sfm.status = 'mapped_existing_field'
    AND sfm.canonical_field IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.market_listing_publish_ledger l
      WHERE l.platform = v_platform AND l.canonical_field = sfm.canonical_field
        AND l.status = 'released');

  -- Split the patch into live vs staged.
  IF array_length(v_held, 1) IS NOT NULL THEN
    SELECT coalesce(jsonb_object_agg(k, val), '{}'::jsonb) INTO v_staged
      FROM jsonb_each(p_patch) e(k, val) WHERE k = ANY(v_held);
    v_live := p_patch - v_held;
  ELSE
    v_live := p_patch;
  END IF;

  -- Live write: merge onto current, route through the record_save dispatcher.
  SELECT data, created_by_user_id INTO v_cur, v_created
    FROM public.market_listings_v WHERE id = p_id;
  PERFORM public.record_save(v_model, p_id,
                             coalesce(v_cur, '{}'::jsonb) || jsonb_strip_nulls(v_live),
                             v_created, NULL);

  -- Staged write: merge held values into staging (never touches the live column).
  IF v_staged <> '{}'::jsonb THEN
    INSERT INTO public.market_listing_staging (record_id, platform, data, updated_at)
    VALUES (p_id, v_platform, jsonb_strip_nulls(v_staged), now())
    ON CONFLICT (record_id) DO UPDATE
      SET data = coalesce(public.market_listing_staging.data, '{}'::jsonb) || EXCLUDED.data,
          platform = EXCLUDED.platform, updated_at = now();
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.market_listing_write(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_write(uuid, jsonb) TO service_role;

-- 3. market_listing_merge now delegates to the gated write (so any caller is gated,
--    and the scraper's patch() path needs no change).
CREATE OR REPLACE FUNCTION public.market_listing_merge(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM public.market_listing_write(p_id, p_patch);
END $$;

REVOKE ALL ON FUNCTION public.market_listing_merge(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_merge(uuid, jsonb) TO service_role;

-- 4. The publisher: dry-run diff, or release (backfill live from staging + flip the
--    ledger + clear staging for the field). Returns the number of differing rows.
--    canonical_field is validated against real columns before any dynamic SQL.
CREATE OR REPLACE FUNCTION public.market_listing_publish(
  p_platform text,
  p_canonical_field text,
  p_dry_run boolean DEFAULT true
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_col    text;
  v_type   text;
  v_coerce text;
  v_count  integer;
  v_sql    text;
BEGIN
  SELECT column_name, data_type INTO v_col, v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'market_listings' AND column_name = p_canonical_field;
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'not a market_listings column: %', p_canonical_field;
  END IF;

  v_coerce := CASE
    WHEN v_type IN ('numeric','double precision','integer','bigint','real') THEN 'public.try_numeric'
    WHEN v_type IN ('timestamp with time zone','timestamp without time zone') THEN 'public.try_timestamptz'
    WHEN v_type = 'boolean' THEN 'public.try_boolean'
    ELSE '' END;

  -- Count rows where staging holds this field and it differs from the live column.
  IF v_type = 'jsonb' THEN
    v_sql := format('SELECT count(*) FROM public.market_listing_staging s JOIN public.market_listings m ON m.id=s.record_id WHERE s.data ? %L AND (s.data->%L) IS DISTINCT FROM m.%I',
                    p_canonical_field, p_canonical_field, v_col);
  ELSIF v_coerce <> '' THEN
    v_sql := format('SELECT count(*) FROM public.market_listing_staging s JOIN public.market_listings m ON m.id=s.record_id WHERE s.data ? %L AND %s(s.data->>%L) IS DISTINCT FROM m.%I',
                    p_canonical_field, v_coerce, p_canonical_field, v_col);
  ELSE
    v_sql := format('SELECT count(*) FROM public.market_listing_staging s JOIN public.market_listings m ON m.id=s.record_id WHERE s.data ? %L AND (s.data->>%L) IS DISTINCT FROM m.%I',
                    p_canonical_field, p_canonical_field, v_col);
  END IF;
  EXECUTE v_sql INTO v_count;

  IF p_dry_run THEN
    RETURN v_count;
  END IF;

  -- Release: backfill live from staging (set-based), for this field only.
  IF v_type = 'jsonb' THEN
    v_sql := format('UPDATE public.market_listings m SET %I = s.data->%L FROM public.market_listing_staging s WHERE s.record_id=m.id AND s.data ? %L',
                    v_col, p_canonical_field, p_canonical_field);
  ELSIF v_coerce <> '' THEN
    v_sql := format('UPDATE public.market_listings m SET %I = %s(s.data->>%L) FROM public.market_listing_staging s WHERE s.record_id=m.id AND s.data ? %L',
                    v_col, v_coerce, p_canonical_field, p_canonical_field);
  ELSE
    v_sql := format('UPDATE public.market_listings m SET %I = s.data->>%L FROM public.market_listing_staging s WHERE s.record_id=m.id AND s.data ? %L',
                    v_col, p_canonical_field, p_canonical_field);
  END IF;
  EXECUTE v_sql;

  PERFORM public.market_listing_publish_set(p_platform, p_canonical_field, 'released', 'released via publisher');

  -- Clear the now-live field from staging; drop staging rows that emptied out.
  UPDATE public.market_listing_staging SET data = data - p_canonical_field WHERE data ? p_canonical_field;
  DELETE FROM public.market_listing_staging WHERE data = '{}'::jsonb;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.market_listing_publish(text,text,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_publish(text,text,boolean) TO authenticated, service_role;
