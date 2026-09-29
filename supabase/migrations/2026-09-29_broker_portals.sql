-- Broker portals: a no-login page that shows ONE developer's projects, units,
-- payment plans, floor plans, photos, videos, marketing library and documents
-- to outside brokers (first one: الرمز / Al-Ramz, a gift from Wassel).
--
-- The table is readable ONLY by admins through RLS. Anonymous access goes
-- exclusively through /api/broker-portal, which resolves the token with the
-- service role and returns a whitelisted projection of the data (internal
-- fields like project_analysis / source_notes never leave the server).
--
-- Turning a link off = UPDATE broker_portals SET is_active=false. A wrong,
-- inactive or expired token all return the same 404.

BEGIN;

CREATE TABLE IF NOT EXISTS public.broker_portals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token              text NOT NULL UNIQUE
                       DEFAULT translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', '-_'),
  developer_id       uuid NOT NULL,
  title_ar           text,
  title_en           text,
  is_active          boolean NOT NULL DEFAULT true,
  expires_at         timestamptz,
  view_count         integer NOT NULL DEFAULT 0,
  last_viewed_at     timestamptz,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_portals_developer_idx ON public.broker_portals (developer_id);

ALTER TABLE public.broker_portals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broker_portals_admin_all ON public.broker_portals;
CREATE POLICY broker_portals_admin_all ON public.broker_portals
  FOR ALL TO authenticated
  USING (public.wassell_is_admin(auth.uid()))
  WITH CHECK (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.broker_portals FROM anon;

-- Service-role-only view bump (called by the API after a token resolves).
CREATE OR REPLACE FUNCTION public.broker_portal_record_view(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.broker_portals
     SET view_count = view_count + 1, last_viewed_at = now()
   WHERE id = p_id;
$$;
REVOKE ALL ON FUNCTION public.broker_portal_record_view(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broker_portal_record_view(uuid) TO service_role;

-- Seed the Al-Ramz portal (idempotent: only when the developer exists and has
-- no portal yet — the migration must replay on a fresh DB with no records).
INSERT INTO public.broker_portals (developer_id, title_ar, title_en)
SELECT r.id, 'مشاريع الرمز العقارية', 'Al-Ramz Real Estate Projects'
  FROM public.records r
 WHERE r.id = 'dfe055a2-de6a-49e6-8502-14d10d6d6b62'
   AND NOT EXISTS (SELECT 1 FROM public.broker_portals b WHERE b.developer_id = r.id);

COMMIT;
