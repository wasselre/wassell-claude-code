-- Fixture for the Phase 1 file-link projection smoke.
--
-- Reproduces the production SHAPES that matter, not production volume:
--   * a file shared across many records (fan-out)
--   * an edge proven by two mechanisms at once (collapse)
--   * a legacy files.record_id pair on a triple with ONE field role (corroborates)
--   * a legacy files.record_id pair on a triple with TWO field roles (AMBIGUOUS —
--     must get its own role-neutral edge, never an arbitrary one)
--   * a legacy files.record_id pair with NO field role (own role-neutral edge)
--   * a frozen model whose file fields must be excluded
--   * the same record UUID present under TWO different models, one visible and
--     one not — the case that makes model-scoped identity load-bearing
--   * real anomalies: a raw URL, a dangling uuid, an unmapped field
-- All three Supabase roles, because the migration REVOKEs from `anon` too and a
-- fixture missing it would make the migration fail here but pass in production —
-- the exact asymmetry that lets a CI green badge mean nothing.
DO $r$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
DO $r$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
-- REPRODUCE SUPABASE'S DEFAULT PRIVILEGES.
-- A hosted Supabase project carries ALTER DEFAULT PRIVILEGES granting ALL on
-- every new table in `public` to anon/authenticated/service_role. A bare
-- Postgres has none, so a migration that only does `REVOKE ... FROM PUBLIC`
-- looks perfectly locked down in CI and lands wide open in production — which
-- is exactly what happened on the first production apply. Grant the same
-- defaults here so the smoke's grant assertions test the real thing.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('test.uid', true),'')::uuid $$;

CREATE TABLE public.models (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text, schema jsonb, is_hardcoded boolean DEFAULT false);
CREATE TABLE public.records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid, data jsonb, created_by_user_id uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), version int DEFAULT 1);
CREATE TABLE public.files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid, model_id uuid, record_id uuid, uploaded_by_user_id uuid,
  original_name text, mime_type text, size_bytes bigint,
  storage_bucket text, storage_path text, kind text);
CREATE TABLE public.document_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid, model_id uuid, record_id uuid, created_by_user_id uuid, created_at timestamptz DEFAULT now(),
  -- The REAL identity of a manual link, mirrored from the production schema.
  -- The manual source key is derived from this triple, not from `id`.
  UNIQUE (file_id, model_id, record_id));
CREATE TABLE public.mos_assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text, file_id uuid, project_id uuid, url text);
-- folders exist so a value that resolves to a FOLDER can be told apart from one
-- that resolves to a FILE. A folder is a different resource; manufacturing a
-- file relationship from one would be a fabrication.
CREATE TABLE public.folders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);

-- A FROZEN model's dedicated physical table. This is what makes a record uuid
-- collision across models possible at all: `records.id` is a primary key, so a
-- duplicate can only come from a frozen model's own table being UNIONed in.
CREATE TABLE public.market_listings (id uuid PRIMARY KEY, title text);

-- records RLS: a record is visible when test.visible_records contains its id
ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.records TO authenticated;
CREATE POLICY records_select ON public.records FOR SELECT TO authenticated
  USING (id::text = ANY(string_to_array(coalesce(current_setting('test.visible_records',true),''),',')));

-- frozen table RLS: driven by its OWN guc, so a test can make the colliding
-- uuid visible under one model and hidden under the other.
ALTER TABLE public.market_listings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.market_listings TO authenticated;
CREATE POLICY ml_select ON public.market_listings FOR SELECT TO authenticated
  USING (id::text = ANY(string_to_array(coalesce(current_setting('test.visible_frozen',true),''),',')));

-- unified_records: records UNION the frozen model's jsonb-shape view, exactly
-- like prod, and security_invoker so each half applies the caller's own RLS.
CREATE VIEW public.market_listings_v WITH (security_invoker=true) AS
  SELECT m.id, (SELECT id FROM public.models WHERE name='market_listings') AS model_id,
         jsonb_build_object('title', m.title) AS data,
         NULL::uuid AS created_by_user_id, now() AS created_at, now() AS updated_at, 1 AS version
    FROM public.market_listings m;
CREATE VIEW public.unified_records WITH (security_invoker=true) AS
  SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version FROM public.records
  UNION ALL
  SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version FROM public.market_listings_v;
-- `models` is readable by authenticated in production, and market_listings_v
-- resolves its model_id through it under security_invoker.
GRANT SELECT ON public.unified_records, public.market_listings_v, public.models TO authenticated;

-- file access: test.visible_files contains the id (stands in for the real resolver)
CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT p_file_id::text = ANY(string_to_array(coalesce(current_setting('test.visible_files',true),''),',')) $$;

-- ---- data ----------------------------------------------------------------
INSERT INTO public.models (id,name,schema) VALUES
('11111111-0000-0000-0000-000000000001','units', '{"sections":[{"fields":[{"name":"unit_plan","type":"image"}]}]}'),
('11111111-0000-0000-0000-000000000002','all_projects','{"sections":[{"fields":[{"name":"project_images","type":"multi_image"},{"name":"main_image","type":"image"},{"name":"project_videos","type":"multi_video"},{"name":"developer_content","type":"attachment"}]}]}'),
('11111111-0000-0000-0000-000000000003','clients','{"sections":[{"fields":[{"name":"mystery_doc","type":"attachment"}]}]}'),
-- multi_file: a declared file-bearing field. In production `tasks.files` has
-- ZERO stored values, so the fixture is where its parsing is actually proven.
('11111111-0000-0000-0000-000000000005','tasks','{"sections":[{"fields":[{"name":"files","type":"multi_file"}]}]}');
-- a FROZEN model whose file fields must be EXCLUDED (scraped listing media)
INSERT INTO public.models (id,name,schema,is_hardcoded) VALUES
('11111111-0000-0000-0000-000000000004','market_listings','{"sections":[{"fields":[{"name":"image_urls","type":"multi_image"}]}]}', true);

INSERT INTO public.files (id, original_name, model_id, record_id) VALUES
('f0000000-0000-0000-0000-00000000000a','type-villa-layout.webp', NULL, NULL),        -- high fanout
('f0000000-0000-0000-0000-00000000000b','brochure.pdf', NULL, NULL),                  -- AMBIGUOUS legacy pair
('f0000000-0000-0000-0000-00000000000c','secret-contract.pdf', NULL, NULL),           -- privacy case
('f0000000-0000-0000-0000-00000000000d','gallery1.jpg', NULL, NULL),
('f0000000-0000-0000-0000-00000000000e','gallery2.jpg', NULL, NULL),
('f0000000-0000-0000-0000-00000000000f','loose-scan.pdf', NULL, NULL),                -- legacy pair, NO field role
('f0000000-0000-0000-0000-000000000010','collision-doc.pdf', NULL, NULL),             -- uuid-collision case
('f0000000-0000-0000-0000-000000000011','promo-clip.mp4', NULL, NULL),                -- canonical video in a MIXED array
('f0000000-0000-0000-0000-000000000012','dev-spec.pdf', NULL, NULL),                  -- object-shaped {id,type:file}
('f0000000-0000-0000-0000-000000000013','task-attach.pdf', NULL, NULL),               -- multi_file
('f0000000-0000-0000-0000-000000000014','task-attach2.pdf', NULL, NULL);              -- multi_file, array

-- a real FOLDER: developer_content mixes {type:'file'} and {type:'folder'}
INSERT INTO public.folders (id, name) VALUES
('d0000000-0000-0000-0000-000000000001','Developer pack');

-- project record. brochure.pdf is BOTH main_image and (below) a legacy pair →
-- two distinct field roles on one triple would be ambiguous, so we give it a
-- second field role by also listing it in project_images.
INSERT INTO public.records (id, model_id, data) VALUES
('a0000000-0000-0000-0000-000000000f01','11111111-0000-0000-0000-000000000002',
 jsonb_build_object('project_images', jsonb_build_array(
    'f0000000-0000-0000-0000-00000000000d','f0000000-0000-0000-0000-00000000000e',
    'f0000000-0000-0000-0000-00000000000b'),
   'main_image','f0000000-0000-0000-0000-00000000000b',
   -- MIXED array: a canonical file uuid at index 0, external URLs after it.
   -- The canonical entry must be projected AND keep its true index; the URLs
   -- must be reported as external resources, never as anomalies.
   'project_videos', jsonb_build_array(
      'f0000000-0000-0000-0000-000000000011',
      'https://www.youtube.com/watch?v=abc123',
      '//cdn.example.com/clip.mp4'),
   -- OBJECT-shaped values with an explicit discriminator. type='file' is a
   -- canonical file; type='folder' is a different resource entirely.
   'developer_content', jsonb_build_array(
      jsonb_build_object('id','f0000000-0000-0000-0000-000000000012','type','file'),
      jsonb_build_object('id','d0000000-0000-0000-0000-000000000001','type','folder'))));

-- 3 units sharing ONE type layout (fan-out), one of which ALSO has files.record_id
INSERT INTO public.records (id, model_id, data) VALUES
('a0000000-0000-0000-0000-000000000f11','11111111-0000-0000-0000-000000000001','{"unit_plan":"f0000000-0000-0000-0000-00000000000a"}'),
('a0000000-0000-0000-0000-000000000f12','11111111-0000-0000-0000-000000000001','{"unit_plan":"f0000000-0000-0000-0000-00000000000a"}'),
('a0000000-0000-0000-0000-000000000f13','11111111-0000-0000-0000-000000000001','{"unit_plan":"f0000000-0000-0000-0000-00000000000a"}');

-- UNAMBIGUOUS legacy pair: exactly ONE field role (floor_plan) on this triple,
-- so the legacy attachment CORROBORATES it → one edge, two sources.
UPDATE public.files SET model_id='11111111-0000-0000-0000-000000000001',
       record_id='a0000000-0000-0000-0000-000000000f11'
 WHERE id='f0000000-0000-0000-0000-00000000000a';

-- AMBIGUOUS legacy pair: TWO field roles (main_image + gallery_image) on the
-- same triple. The legacy column proves association only, so it must get its
-- OWN role-neutral 'attachment' edge — never one of the two arbitrarily.
UPDATE public.files SET model_id='11111111-0000-0000-0000-000000000002',
       record_id='a0000000-0000-0000-0000-000000000f01'
 WHERE id='f0000000-0000-0000-0000-00000000000b';

-- NO field role at all → its own role-neutral 'attachment' edge.
UPDATE public.files SET model_id='11111111-0000-0000-0000-000000000002',
       record_id='a0000000-0000-0000-0000-000000000f01'
 WHERE id='f0000000-0000-0000-0000-00000000000f';

-- anomalies: dangling uuid, raw url, unmapped field
INSERT INTO public.records (id, model_id, data) VALUES
('a0000000-0000-0000-0000-000000000f14','11111111-0000-0000-0000-000000000001',
 '{"unit_plan":"f0000000-0000-0000-0000-0000deadbee5"}'),
('a0000000-0000-0000-0000-000000000f15','11111111-0000-0000-0000-000000000001',
 '{"unit_plan":"https://example.com/legacy.jpg"}'),
('a0000000-0000-0000-0000-000000000f21','11111111-0000-0000-0000-000000000003',
 '{"mystery_doc":"f0000000-0000-0000-0000-00000000000c"}');

-- multi_file, both shapes: a bare scalar string and a two-element array.
INSERT INTO public.records (id, model_id, data) VALUES
('a0000000-0000-0000-0000-000000000f41','11111111-0000-0000-0000-000000000005',
 '{"files":"f0000000-0000-0000-0000-000000000013"}'),
('a0000000-0000-0000-0000-000000000f42','11111111-0000-0000-0000-000000000005',
 '{"files":["f0000000-0000-0000-0000-000000000013","f0000000-0000-0000-0000-000000000014"]}');

-- frozen model row: its FIELD values must be ignored entirely
INSERT INTO public.records (id, model_id, data) VALUES
('a0000000-0000-0000-0000-000000000f31','11111111-0000-0000-0000-000000000004',
 '{"image_urls":["f0000000-0000-0000-0000-00000000000d"]}');

-- ── THE UUID COLLISION ────────────────────────────────────────────────────
-- The SAME record uuid exists under two different models: as a `units` row in
-- `records`, and as a frozen `market_listings` row in its own table. One file
-- is linked to BOTH. A caller who may see only the units side must NOT learn
-- that the market_listings side exists.
INSERT INTO public.records (id, model_id, data) VALUES
('c0111de0-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',
 '{"unit_plan":"f0000000-0000-0000-0000-000000000010"}');
INSERT INTO public.market_listings (id, title) VALUES
('c0111de0-0000-0000-0000-000000000001','a listing the caller may not see');
INSERT INTO public.document_links (file_id, model_id, record_id) VALUES
('f0000000-0000-0000-0000-000000000010','11111111-0000-0000-0000-000000000004','c0111de0-0000-0000-0000-000000000001');

INSERT INTO public.document_links (file_id, model_id, record_id) VALUES
('f0000000-0000-0000-0000-00000000000b','11111111-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000f01');

INSERT INTO public.mos_assets (title, file_id, project_id) VALUES
('library photo','f0000000-0000-0000-0000-00000000000d','a0000000-0000-0000-0000-000000000f01');
