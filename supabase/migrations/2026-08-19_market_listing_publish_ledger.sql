-- Market-ingest Phase 3, Increment 1: the PUBLISH LEDGER (allowlist authority).
--
-- The gate between "a field has been ruled" (source_field_mappings) and "the field
-- flows to the live market_listings column". A canonical_field is live only when its
-- ledger row is `released`. Increment 1 builds the ledger + the toggle RPC + the
-- cockpit control plane; the STAGING enforcement + dry-run diff + backfill land in
-- Increment 2 (market_listing_publish). This migration is standalone (a new table),
-- so it does NOT touch the frozen market_listings view chain.
--
-- GRANDFATHER: every canonical_field currently mapped for a platform is seeded
-- `released`, because those fields are ALREADY live (the adapter writes them today).
-- Without this, turning the gate on would read every live field as "held" and imply
-- they should be pulled — a false regression. A field with no ledger row is treated
-- as `held` by readers (default-deny for anything new).
--
-- Applied to prod (wassell-prod) 2026-08-19.

CREATE TABLE IF NOT EXISTS public.market_listing_publish_ledger (
  platform         text NOT NULL,
  canonical_field  text NOT NULL,
  status           text NOT NULL DEFAULT 'held' CHECK (status IN ('held','released')),
  released_at      timestamptz,
  released_by      text,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, canonical_field)
);

ALTER TABLE public.market_listing_publish_ledger ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user (the cockpit lists the ledger for every role, same
-- posture as source_field_mappings). Writes go through the RPC only.
DROP POLICY IF EXISTS publish_ledger_read ON public.market_listing_publish_ledger;
CREATE POLICY publish_ledger_read ON public.market_listing_publish_ledger
  FOR SELECT TO authenticated USING (true);

-- Grandfather the already-live mapped fields as released, per platform.
INSERT INTO public.market_listing_publish_ledger
  (platform, canonical_field, status, released_at, released_by, reason)
SELECT DISTINCT m.platform, m.canonical_field, 'released', now(), 'system:grandfather',
       'grandfathered — live before the publish gate existed'
FROM public.source_field_mappings m
WHERE m.status = 'mapped_existing_field' AND m.canonical_field IS NOT NULL
ON CONFLICT (platform, canonical_field) DO NOTHING;

-- Toggle a field's publish status. SECURITY DEFINER; reviewer from the JWT.
-- released_at is set when releasing, cleared when holding.
CREATE OR REPLACE FUNCTION public.market_listing_publish_set(
  p_platform text,
  p_canonical_field text,
  p_status text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_actor text := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text, 'operator');
BEGIN
  IF p_status NOT IN ('held','released') THEN
    RAISE EXCEPTION 'invalid publish status: %', p_status;
  END IF;
  IF nullif(p_canonical_field, '') IS NULL THEN
    RAISE EXCEPTION 'canonical_field is required';
  END IF;

  INSERT INTO public.market_listing_publish_ledger AS l
    (platform, canonical_field, status, released_at, released_by, reason, updated_at)
  VALUES
    (p_platform, p_canonical_field, p_status,
     CASE WHEN p_status='released' THEN now() END,
     v_actor, nullif(p_reason,''), now())
  ON CONFLICT (platform, canonical_field) DO UPDATE
    SET status      = EXCLUDED.status,
        released_at = CASE WHEN EXCLUDED.status='released' THEN now() ELSE NULL END,
        released_by = v_actor,
        reason      = EXCLUDED.reason,
        updated_at  = now();
END $$;

REVOKE ALL ON FUNCTION public.market_listing_publish_set(text,text,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.market_listing_publish_set(text,text,text,text) TO authenticated, service_role;
