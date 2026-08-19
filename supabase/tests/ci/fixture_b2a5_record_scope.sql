-- ============================================================================
-- Production-shaped RECORD-authorization surface for the B2A.5 test.
--
-- Why this fixture exists at all: fixture_file_links.sql stubs records RLS with
--   USING (id::text = ANY(string_to_array(current_setting('test.visible_records'),',')))
-- and fixture_b2a3_edges.sql swaps it for a `data->>'visible_to'` match. Both
-- are deliberate simplifications that were fine for the batches that used them,
-- and both are useless here: B2A.5 changes how `wassell_can_view_record` is
-- REACHED, so a fixture that never calls it proves nothing. Testing this change
-- against those stubs would be precisely the "fixture gentler than production"
-- mistake that put B2A.1 on production.
--
-- So this fixture builds the real thing: `profiles.model_permissions` with real
-- view_scope rules, `users` with auth_uid/is_active, `models` carrying real
-- schemas, and the ACTUAL wassell_user_has_action / wassell_record_passes_scope
-- / wassell_can_view_record — which the runner extracts from supabase/schema.sql
-- rather than copying here, so this fixture cannot drift from the authority it
-- is supposed to be testing.
--
-- Scale mirrors production as measured 2026-08-19: 39,972 records across 49
-- models (2 of them holding 88% of the rows), 9,856 file_links edges, 24 of
-- which are orphans pointing at records that no longer exist. The orphans are
-- load-bearing — they are why the record half cannot be reduced to "the model
-- is visible" and must keep probing for existence.
--
-- PERSONA MATRIX — every branch of the scope classifier, and both sides of the
-- one lemma B2A.5 rests on ('all' => can_view_record is constant true):
--
--   uid       profile                                             expected
--   9999…     is_admin                                            every row
--   1111…     view + view_scope absent            (=> 'all')       whole models
--             view + mode='all'                   (=> 'all')
--             view + mode='filtered', 0 conditions(=> 'all')   <-- the trap
--   2222…     view + mode='filtered', created_by  (=> 'filtered') PARTIAL
--   3333…     view + mode='filtered', matches none(=> 'filtered') ZERO on m03
--             view + mode='all' on m04            (=> 'all')      whole model
--   4444…     'edit' but NOT 'view'               (=> 'none')      nothing
--   5555…     is_active = false                                    nothing
--   6666…     mixed: all / filtered-by-data-field / none           mixture
--   0000…ff   no users row at all                                  nothing
--
-- 1111… is the important one for the widening test: a `mode='filtered'` rule
-- carrying zero conditions must classify as 'all', because that is what
-- wassell_record_passes_scope actually returns. Get that branch wrong in either
-- direction and this persona's row set moves.
--
-- 2222… and 6666… are the non-vacuity guards: if the 'filtered' branch ever
-- became constant, their row sets would jump to whole models and the suite's
-- fingerprint comparison would fail.
-- ============================================================================

-- ── auth.uid() ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.uid', true), '')::uuid;
$$;

-- ── the world ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.models (
  id     uuid PRIMARY KEY,
  name   text NOT NULL,
  schema jsonb NOT NULL DEFAULT '{"sections":[]}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id                 uuid PRIMARY KEY,
  is_admin           boolean NOT NULL DEFAULT false,
  model_permissions  jsonb   NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.users (
  id               uuid PRIMARY KEY,
  email            text,
  auth_uid         uuid,
  profile_id       uuid REFERENCES public.profiles(id),
  is_active        boolean NOT NULL DEFAULT true,
  role_assignments jsonb   NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id            uuid NOT NULL,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS records_model_idx ON public.records (model_id);

CREATE TABLE IF NOT EXISTS public.file_links (
  file_id   uuid NOT NULL,
  model_id  uuid NOT NULL,
  record_id uuid NOT NULL,
  role      text,
  PRIMARY KEY (file_id, model_id, record_id)
);
CREATE INDEX IF NOT EXISTS file_links_record_idx ON public.file_links (record_id, model_id);

-- unified_records: security_invoker, exactly as production, so that reading it
-- lands on the records_view policy. That indirection IS the thing under test.
CREATE OR REPLACE VIEW public.unified_records WITH (security_invoker=true) AS
  SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version
    FROM public.records;

-- ── models ─────────────────────────────────────────────────────────────────
-- m01/m02 carry 88% of the corpus, mirroring units + all_projects on production.
INSERT INTO public.models (id, name, schema) VALUES
  ('10000000-0000-4000-8000-000000000001','m01_units',        '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000002','m02_all_projects', '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000003','m03_tasks',        '{"sections":[{"id":"s1","fields":[{"id":"f-owner","name":"owner"}]}]}'),
  ('10000000-0000-4000-8000-000000000004','m04_clients',      '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000005','m05_our_projects', '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000006','m06_details',      '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000007','m07_snippets',     '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000008','m08_presets',      '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-000000000009','m09_offers',       '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-00000000000a','m10_reservations', '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-00000000000b','m11_secret',       '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}'),
  ('10000000-0000-4000-8000-00000000000c','m12_misc',         '{"sections":[{"id":"s1","fields":[{"id":"f-region","name":"region"}]}]}')
ON CONFLICT (id) DO NOTHING;

-- ── profiles ───────────────────────────────────────────────────────────────
INSERT INTO public.profiles (id, is_admin, model_permissions) VALUES

  -- admin
  ('a0000000-0000-4000-8000-00000000000a', true, '[]'::jsonb),

  -- 1111… : the three spellings of "unrestricted" that must all classify 'all'
  ('a0000000-0000-4000-8000-00000000000b', false, jsonb_build_array(
     -- no view_scope key at all
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000001',
                        'permissions', jsonb_build_array('view','edit')),
     -- explicit mode='all'
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000002',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','all','conditions', jsonb_build_array())),
     -- mode='filtered' with ZERO conditions -> passes_scope returns true
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000004',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','filtered','conditions', jsonb_build_array())),
     -- an unknown mode string -> passes_scope's `<> 'filtered'` branch -> true
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000005',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','something_else','conditions', jsonb_build_array()))
   )),

  -- 2222… : a REAL filtered rule (created_by = me) -> genuinely per-row
  ('a0000000-0000-4000-8000-00000000000c', false, jsonb_build_array(
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000001',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','filtered','conditions', jsonb_build_array(
                          jsonb_build_object('field', jsonb_build_object('kind','created_by'),
                                             'operator','equals',
                                             'source', jsonb_build_object('kind','current_user')))))
   )),

  -- 3333… : filtered rule that matches NOTHING on m03, plus an 'all' on m04.
  --         Guards the "filtered collapsed to true" failure mode from the
  --         zero-visible side.
  ('a0000000-0000-4000-8000-00000000000d', false, jsonb_build_array(
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000003',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','filtered','conditions', jsonb_build_array(
                          jsonb_build_object('field', jsonb_build_object('kind','field','field_slug','owner'),
                                             'operator','equals',
                                             'source', jsonb_build_object('kind','literal','value','nobody-at-all'))))),
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000004',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','all'))
   )),

  -- 4444… : 'edit' but NOT 'view' -> user_has_action false -> 'none'
  ('a0000000-0000-4000-8000-00000000000e', false, jsonb_build_array(
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000001',
                        'permissions', jsonb_build_array('edit','delete'))
   )),

  -- 6666… : a mixture, including a filtered rule addressed by field_id rather
  --         than field_slug, which forces passes_scope through its models.schema
  --         lookup path.
  ('a0000000-0000-4000-8000-00000000000f', false, jsonb_build_array(
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000002',
                        'permissions', jsonb_build_array('view')),
     jsonb_build_object('model_id','10000000-0000-4000-8000-000000000001',
                        'permissions', jsonb_build_array('view'),
                        'view_scope', jsonb_build_object('mode','filtered','conditions', jsonb_build_array(
                          jsonb_build_object('field', jsonb_build_object('kind','field','field_id','f-region'),
                                             'operator','equals',
                                             'source', jsonb_build_object('kind','literal','value','riyadh')))))
     -- m11_secret deliberately absent -> model_perm NULL -> 'none'
   ))
ON CONFLICT (id) DO NOTHING;

-- ── users ──────────────────────────────────────────────────────────────────
INSERT INTO public.users (id, email, auth_uid, profile_id, is_active) VALUES
  ('99999999-9999-9999-9999-999999999999','admin@test',   '99999999-9999-9999-9999-999999999999','a0000000-0000-4000-8000-00000000000a', true),
  ('11111111-1111-1111-1111-111111111111','allscope@test','11111111-1111-1111-1111-111111111111','a0000000-0000-4000-8000-00000000000b', true),
  ('22222222-2222-2222-2222-222222222222','mine@test',    '22222222-2222-2222-2222-222222222222','a0000000-0000-4000-8000-00000000000c', true),
  ('33333333-3333-3333-3333-333333333333','zero@test',    '33333333-3333-3333-3333-333333333333','a0000000-0000-4000-8000-00000000000d', true),
  ('44444444-4444-4444-4444-444444444444','noview@test',  '44444444-4444-4444-4444-444444444444','a0000000-0000-4000-8000-00000000000e', true),
  ('55555555-5555-5555-5555-555555555555','inactive@test','55555555-5555-5555-5555-555555555555','a0000000-0000-4000-8000-00000000000b', false),
  ('66666666-6666-6666-6666-666666666666','mixed@test',   '66666666-6666-6666-6666-666666666666','a0000000-0000-4000-8000-00000000000f', true)
ON CONFLICT (id) DO NOTHING;
-- 00000000-…-ff is deliberately absent: an authenticated identity with no app
-- user row.

-- ── corpus: ~40,000 records, production-shaped skew ────────────────────────
-- m01 24,000 / m02 11,000 / the rest small, so the two models that carry the
-- edges also carry the rows, as units + all_projects do on production.
INSERT INTO public.records (id, model_id, data, created_by_user_id)
SELECT gen_random_uuid(),
       '10000000-0000-4000-8000-000000000001',
       jsonb_build_object('region', CASE WHEN i % 3 = 0 THEN 'riyadh' ELSE 'jeddah' END,
                          'n', i),
       -- a tenth of m01 is owned by 2222…, so its created_by filter is a
       -- genuine partial rather than all-or-nothing
       CASE WHEN i % 10 = 0 THEN '22222222-2222-2222-2222-222222222222'::uuid
            ELSE '99999999-9999-9999-9999-999999999999'::uuid END
  FROM generate_series(1, 24000) i;

INSERT INTO public.records (id, model_id, data, created_by_user_id)
SELECT gen_random_uuid(), '10000000-0000-4000-8000-000000000002',
       jsonb_build_object('region','riyadh','n',i),
       '99999999-9999-9999-9999-999999999999'::uuid
  FROM generate_series(1, 11000) i;

INSERT INTO public.records (id, model_id, data, created_by_user_id)
SELECT gen_random_uuid(), m.id,
       jsonb_build_object('region','riyadh','owner','someone','n',i),
       '99999999-9999-9999-9999-999999999999'::uuid
  FROM public.models m,
       LATERAL generate_series(1, 500) i
 WHERE m.id <> '10000000-0000-4000-8000-000000000001'
   AND m.id <> '10000000-0000-4000-8000-000000000002';

-- ── edges: ~9,900, over the two big models, plus 24 orphans ────────────────
INSERT INTO public.file_links (file_id, model_id, record_id, role)
SELECT gen_random_uuid(), r.model_id, r.id, 'gallery_image'
  FROM (SELECT id, model_id FROM public.records
         WHERE model_id IN ('10000000-0000-4000-8000-000000000001',
                            '10000000-0000-4000-8000-000000000002')
         ORDER BY id LIMIT 9800) r;

INSERT INTO public.file_links (file_id, model_id, record_id, role)
SELECT gen_random_uuid(), r.model_id, r.id, 'supporting'
  FROM (SELECT id, model_id FROM public.records
         WHERE model_id NOT IN ('10000000-0000-4000-8000-000000000001',
                                '10000000-0000-4000-8000-000000000002')
         ORDER BY id LIMIT 76) r;

-- 24 orphan edges: the record_id does not exist. Production has exactly 24.
-- They are the reason the record half must keep probing for existence and
-- cannot be reduced to a model-visibility test.
INSERT INTO public.file_links (file_id, model_id, record_id, role)
SELECT gen_random_uuid(), '10000000-0000-4000-8000-000000000001', gen_random_uuid(), 'orphan'
  FROM generate_series(1, 24) i;

ANALYZE public.records;
ANALYZE public.file_links;
ANALYZE public.profiles;
ANALYZE public.users;
ANALYZE public.models;
