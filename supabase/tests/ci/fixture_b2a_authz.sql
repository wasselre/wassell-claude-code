-- Production-shaped authorization surface for the B2A tests.
--
-- fixture_b1_authz.sql models a SIMPLIFIED predicate (uploader / grant / flat
-- folder) which was enough to prove B1 changed no reach. B2A rewrites the real
-- predicate, so it needs the real shape: the recursive folder cascade, the
-- marketing capability clause, and personas for every branch.
--
-- Sizes mirror production as measured on 2026-08-16: 15 explicit file grants
-- held by ONE user, 3 folder grants across three users, 468 foldered files,
-- 1,270 marketing-linked files, and ~6,600 files with no folder, grant or
-- marketing row at all. That distribution is the whole reason B2A's hoisted
-- flags pay off, so the fixture has to reproduce it rather than spread grants
-- evenly.

CREATE TABLE IF NOT EXISTS public.file_permissions (
  file_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
  PRIMARY KEY (file_id, user_id));
CREATE TABLE IF NOT EXISTS public.folder_permissions (
  folder_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
  PRIMARY KEY (folder_id, user_id));
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_admin boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE);
CREATE TABLE IF NOT EXISTS public.role_capabilities (role_id uuid, capability text);
ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS parent_folder_id uuid;
ALTER TABLE public.users   ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE public.users   ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.users   ADD COLUMN IF NOT EXISTS auth_uid uuid;

INSERT INTO public.profiles (id, is_admin) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', true),
  ('aaaaaaaa-0000-0000-0000-00000000000b', false)
ON CONFLICT (id) DO NOTHING;

-- Personas. auth_uid == id keeps wassell_app_user_id trivial to reason about.
INSERT INTO public.users (id, email, auth_uid, profile_id, is_active) VALUES
  ('99999999-9999-9999-9999-999999999999','admin@test',   '99999999-9999-9999-9999-999999999999','aaaaaaaa-0000-0000-0000-00000000000a',true),
  ('11111111-1111-1111-1111-111111111111','up.a@test',    '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('22222222-2222-2222-2222-222222222222','up.b@test',    '22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('33333333-3333-3333-3333-333333333333','grants@test',  '33333333-3333-3333-3333-333333333333','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('44444444-4444-4444-4444-444444444444','mkt@test',     '44444444-4444-4444-4444-444444444444','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('55555555-5555-5555-5555-555555555555','noaccess@test','55555555-5555-5555-5555-555555555555','aaaaaaaa-0000-0000-0000-00000000000b',true)
ON CONFLICT (id) DO UPDATE
  SET auth_uid = EXCLUDED.auth_uid, profile_id = EXCLUDED.profile_id, is_active = EXCLUDED.is_active;
-- Persona 7 (00000000-…-ff) is deliberately absent: an authenticated identity
-- that resolves to NO app user, i.e. the deactivated / deleted-row case.

-- ── the real identity + capability helpers ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_app_user_id(auth_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT id FROM users WHERE auth_uid = auth_user_id AND is_active = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.wassell_is_admin(auth_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT COALESCE((
    SELECT p.is_admin FROM profiles p JOIN users u ON u.profile_id = p.id
     WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1), false);
$$;

CREATE OR REPLACE FUNCTION public.wassell_role_satisfies(p_role text, p_kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'view'   THEN p_role IN ('viewer','editor','owner')
    WHEN 'edit'   THEN p_role IN ('editor','owner')
    WHEN 'delete' THEN p_role = 'owner'
    ELSE false END
$$;

-- Verbatim shape of the production recursive cascade.
CREATE OR REPLACE FUNCTION public.wassell_folder_cascade_role(p_folder_id uuid, p_user_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE best_role text;
BEGIN
  IF p_folder_id IS NULL OR p_user_id IS NULL THEN RETURN NULL; END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_folder_id FROM public.folders WHERE id = p_folder_id
    UNION ALL
    SELECT f.id, f.parent_folder_id FROM public.folders f
      JOIN ancestors a ON f.id = a.parent_folder_id)
  SELECT CASE
      WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)=3 THEN 'owner'
      WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)=2 THEN 'editor'
      WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)=1 THEN 'viewer'
      ELSE NULL END
    INTO best_role FROM public.folder_permissions
   WHERE folder_id IN (SELECT id FROM ancestors) AND user_id = p_user_id;
  RETURN best_role;
END $$;

-- Marketing capability: admin, or the mkt persona.
CREATE OR REPLACE FUNCTION public.wassell_mos_can(p_capability text, p_auth_uid uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.wassell_is_admin(p_auth_uid)
      OR (p_capability = 'read'
          AND p_auth_uid = '44444444-4444-4444-4444-444444444444'::uuid);
$$;

-- ── the 8,000-row corpus with a production-shaped grant distribution ───────
INSERT INTO public.files
  (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes,
   storage_bucket, storage_path, created_at, updated_at)
SELECT ('c0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       CASE WHEN i % 7 = 0 THEN 'أبراج المشرقية ' || i || '.png'
            WHEN i % 7 = 3 THEN 'ابراج المشرقية ' || i || '.png'
            WHEN i % 10 = 0 THEN 'مخطط الدور ' || i || '.png'
            ELSE 'Floor Plan Unit ' || i || '.png' END,
       CASE WHEN i % 20 = 0 THEN 'pdf' WHEN i % 37 = 0 THEN 'video' ELSE 'image' END,
       CASE WHEN i % 20 = 0 THEN 'application/pdf' WHEN i % 37 = 0 THEN 'video/mp4' ELSE 'image/png' END,
       CASE WHEN i % 2 = 0 THEN '11111111-1111-1111-1111-111111111111'::uuid
                           ELSE '22222222-2222-2222-2222-222222222222'::uuid END,
       (i * 137) % 5000000, 'wassel-files', 'scale/' || i || '.bin',
       timestamptz '2026-01-01 00:00:00+00' + (i * interval '11 minutes'),
       timestamptz '2026-01-01 00:00:00+00' + (i * interval '11 minutes')
FROM generate_series(1, 8000) i
ON CONFLICT (id) DO NOTHING;

-- A nested folder tree (root -> child) over 468 files, matching production's
-- foldered share, so the RECURSIVE cascade is genuinely exercised.
INSERT INTO public.folders (id, name, parent_folder_id) VALUES
  ('f0000000-0000-0000-0000-0000000000f1','المشاريع', NULL),
  ('f0000000-0000-0000-0000-0000000000f2','صور', 'f0000000-0000-0000-0000-0000000000f1')
ON CONFLICT (id) DO NOTHING;
UPDATE public.files SET folder_id='f0000000-0000-0000-0000-0000000000f2'
 WHERE storage_path LIKE 'scale/%' AND right(id::text,12)::bigint <= 468;

-- 3 folder grants across 3 users; the cascade grant is on the ROOT so it must
-- be inherited by the child folder to be found.
INSERT INTO public.folder_permissions (folder_id, user_id, role) VALUES
  ('f0000000-0000-0000-0000-0000000000f1','33333333-3333-3333-3333-333333333333','viewer'),
  ('f0000000-0000-0000-0000-0000000000f1','22222222-2222-2222-2222-222222222222','editor'),
  ('f0000000-0000-0000-0000-0000000000f2','44444444-4444-4444-4444-444444444444','owner')
ON CONFLICT DO NOTHING;

-- 15 explicit file grants held by ONE user — exactly production's shape, and
-- the reason the hoisted has-grants flag eliminates the probe for everyone else.
-- A mix of viewer/editor/owner so view != edit != delete for this persona.
INSERT INTO public.file_permissions (file_id, user_id, role)
SELECT ('c0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       '33333333-3333-3333-3333-333333333333',
       CASE WHEN i % 3 = 0 THEN 'owner' WHEN i % 3 = 1 THEN 'editor' ELSE 'viewer' END
FROM generate_series(5001, 5015) i
ON CONFLICT DO NOTHING;

-- 1,270 marketing-linked files (view-only reach for the mkt persona).
INSERT INTO public.mos_assets (id, title, file_id)
SELECT ('d0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, 'asset ' || i,
       ('c0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid
FROM generate_series(2001, 3270) i
ON CONFLICT (id) DO NOTHING;

ANALYZE public.files;
ANALYZE public.file_permissions;
ANALYZE public.folder_permissions;
ANALYZE public.mos_assets;
