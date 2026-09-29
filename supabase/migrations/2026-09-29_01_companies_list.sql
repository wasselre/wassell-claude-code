-- ============================================================================
-- One Companies list (2026-09-29)
-- ----------------------------------------------------------------------------
-- Until now a company could live in THREE places that did not agree:
--   * the CRM Developers model (records, model 'developers')
--   * the CRM Marketers model (records, model 'marketers' — 2 rows: ريفا, آبه)
--   * Competitor Watch (mkt_organizations — 243 rows, 43 of them in neither list)
-- and a project could name only ONE marketer.
--
-- The operator's rule (2026-09-29):
--   * one list of companies; every company is EITHER a developer OR a marketer,
--     never both
--   * a project has exactly one developer and any number of marketers; the
--     developer markets its own project implicitly, so it is never listed as a
--     marketer
--   * Competitor Watch uses that same list — competitors are companies too
--
-- What this migration does:
--   1. the Developers model becomes «الشركات / Companies» (same model id and
--      slug, so every lookup, view and API keeps working) with a required
--      company_type dropdown: developer «مطوّر» / marketer «مسوّق»
--   2. types every existing company: developer, except ذراع العقارية and آبه
--      (marketers — ذراع's own site lists 13 projects it markets; the operator
--      confirmed آبه is a marketer of شقق سماوة alongside ريفا)
--   3. creates a Companies record for every Competitor Watch company that had
--      none (34 developers + 7 marketers; the agency دارة التطوير and our own
--      وصل are deliberately left out) and links it
--   4. all_projects.marketer becomes a MULTI lookup on Companies. Values are
--      converted from the old Marketers model and extended with the evidence
--      stored on the project record itself: a project_page_url on a marketer's
--      own site (thiraa.sa / rakez.sa / madaproperties / tqres.sa / revenue.sa /
--      riva.sa, plus riva.sa in update_source_url) means that company markets it
--   5. projects whose recorded DEVELOPER is a marketer (ذراع ×9, آبه ×2) get
--      the real developer where it is known, NULL where it is not, and the
--      marketer moves into the marketers list
--   6. merges 9 duplicate company sets (11 duplicate rows) onto one record each
--   7. project_officers.marketer and lead_portals.marketer retarget to Companies
--   8. Competitor Watch follows Companies: every company gets exactly one
--      watch entry whose type follows the company's; the relationship sync
--      reads marketers from the project's marketers list. (The trigger that
--      keeps this true for FUTURE companies, and removing the now-unused
--      marketer_record_id column, are in 2026-09-29_02 — kept apart so this
--      data migration takes no exclusive lock on records; the first dry run of
--      a combined version deadlocked against live reads of v_all_projects.)
--
-- Backups (RLS on, no anon/authenticated grants): _backup_20260929_*.
-- The old Marketers model and its 2 records are LEFT IN PLACE, unreferenced,
-- until the operator OKs removing them.
-- ============================================================================
BEGIN;
-- Row writes only; fail fast rather than queue behind a busy row or view.
SET LOCAL lock_timeout = '8s';

-- ── 0. backups ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_20260929_company_records AS
  SELECT * FROM public.records
   WHERE model_id IN ('11bade2c-7da9-4d00-b045-eaab37153da2',   -- developers → companies
                      '37f4905c-bc64-4993-a0c4-07e4f54463e2',   -- marketers (retiring)
                      '220c49b9-de57-492d-9eca-c0d9f54fd40f',   -- all_projects
                      '026855a4-02cb-41de-b9b5-91c0eee331a9',   -- project_officers
                      '1ead0000-0000-4000-8000-000000000001');  -- lead_portals
CREATE TABLE IF NOT EXISTS public._backup_20260929_mkt_organizations AS
  SELECT * FROM public.mkt_organizations;
CREATE TABLE IF NOT EXISTS public._backup_20260929_mkt_project_organizations AS
  SELECT * FROM public.mkt_project_organizations;
CREATE TABLE IF NOT EXISTS public._backup_20260929_company_models AS
  SELECT * FROM public.models
   WHERE name IN ('developers', 'marketers', 'all_projects', 'project_officers', 'lead_portals');
DO $b$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['_backup_20260929_company_records', '_backup_20260929_mkt_organizations',
                           '_backup_20260929_mkt_project_organizations', '_backup_20260929_company_models'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $b$;

-- A value in a lookup field as a list of record ids: an array of ids, a single
-- id string, or nothing. Malformed values yield an empty list, never an error —
-- this runs inside the project-save trigger.
CREATE OR REPLACE FUNCTION public.mkt_record_id_list(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(p)
    WHEN 'array'  THEN coalesce((SELECT array_agg(e ORDER BY o)
                                   FROM jsonb_array_elements_text(p) WITH ORDINALITY x(e, o)
                                  WHERE e <> ''), '{}'::text[])
    WHEN 'string' THEN CASE WHEN p #>> '{}' <> '' THEN ARRAY[p #>> '{}'] ELSE '{}'::text[] END
    ELSE '{}'::text[] END;
$$;

-- Replace one record id inside a lookup value (string or array), de-duplicated.
CREATE FUNCTION pg_temp.swap_id(v jsonb, old_id text, new_id text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'string' THEN CASE WHEN v #>> '{}' = old_id THEN to_jsonb(new_id) ELSE v END
    WHEN 'array'  THEN (SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN e #>> '{}' = old_id THEN to_jsonb(new_id) ELSE e END), '[]'::jsonb)
                          FROM jsonb_array_elements(v) e)
    ELSE v END;
$$;

-- صفا للأستثمار's watch entry pointed at a company record that no longer exists.
UPDATE public.mkt_organizations
   SET developer_record_id = '5ad445a4-4786-437a-87c0-361a3aeaf077'
 WHERE id = '1b40fe54-e0eb-4617-9a79-2efe37d67044'
   AND developer_record_id = '75bc8ebe-1053-4697-83ec-6c13b735e51a'
   AND EXISTS (SELECT 1 FROM public.records WHERE id = '5ad445a4-4786-437a-87c0-361a3aeaf077');

-- ── 2. type every existing company ─────────────────────────────────────────
UPDATE public.records
   SET data = data || jsonb_build_object('company_type',
         CASE WHEN id IN ('209817ec-0535-473c-9cee-15697d8abe3c',    -- ذراع العقارية
                          '08454e67-1ff1-4bcb-983f-50d035800f1d')    -- آبه
              THEN 'marketer' ELSE 'developer' END)
 WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND coalesce(data->>'company_type', '') = '';

-- ── 3. a Companies record for every watched company that has none ──────────
CREATE TEMP TABLE _newco ON COMMIT DROP AS
SELECT o.id AS org_id, gen_random_uuid() AS rec_id, btrim(o.name_ar) AS name,
       nullif(btrim(o.website), '') AS website, o.org_type AS company_type,
       row_number() OVER (ORDER BY CASE o.org_type WHEN 'marketer' THEN 0 ELSE 1 END, o.name_ar) AS rn
  FROM public.mkt_organizations o
 WHERE o.developer_record_id IS NULL
   AND o.org_type IN ('developer', 'marketer')
   AND o.status <> 'archived'
   AND coalesce(btrim(o.name_ar), '') <> '';

WITH mx AS (
  SELECT coalesce(max(NULLIF(regexp_replace(data->>'developer_id', '\D', '', 'g'), '')::int), 0) AS n
    FROM public.records WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2')
INSERT INTO public.records (id, model_id, data)
SELECT c.rec_id, '11bade2c-7da9-4d00-b045-eaab37153da2',
       jsonb_strip_nulls(jsonb_build_object(
         'developer_id', 'م ط' || lpad((mx.n + c.rn)::text, 3, '0'),
         'name', c.name, 'website', c.website, 'company_type', c.company_type))
  FROM _newco c CROSS JOIN mx;

UPDATE public.mkt_organizations o
   SET developer_record_id = c.rec_id
  FROM _newco c WHERE o.id = c.org_id;

-- ── 4. the relationship sync reads marketers from the project's list ──────
-- Same name and signature: records_sync_developer_relationship and the
-- mkt_organizations triggers call it with (project, org). Rules unchanged from
-- 2026-09-27_02 except WHERE a marketer comes from: any company in the
-- project's marketers list, other than the project's own developer.
CREATE OR REPLACE FUNCTION public.mkt_sync_developer_relationships(p_project uuid DEFAULT NULL::uuid, p_org uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int := 0;
  k int;
  c_all_projects constant uuid := '220c49b9-de57-492d-9eca-c0d9f54fd40f';
BEGIN
  -- 1. developer links
  INSERT INTO public.mkt_project_organizations
    (project_id, organization_id, relationship_type, confidence, evidence, human_confirmed, is_active)
  SELECT r.id, o.id, 'developer', 1,
         jsonb_build_object('source', 'developer_field_sync', 'synced_at', now()), false, true
    FROM public.records r
    JOIN public.mkt_organizations o
      ON o.developer_record_id IS NOT NULL
     AND o.developer_record_id::text = r.data->>'developer'
   WHERE r.model_id = c_all_projects
     AND (p_project IS NULL OR r.id = p_project)
     AND (p_org IS NULL OR o.id = p_org)
  ON CONFLICT (project_id, organization_id, relationship_type) DO UPDATE
     SET is_active = true, last_observed_at = now(), updated_at = now();
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- 2. marketer links: every company in the project's marketers list
  INSERT INTO public.mkt_project_organizations
    (project_id, organization_id, relationship_type, confidence, evidence, human_confirmed, is_active)
  SELECT r.id, o.id, 'authorized_marketer', 1,
         jsonb_build_object('source', 'crm_marketer_field', 'synced_at', now()), false, true
    FROM public.records r
    JOIN public.mkt_organizations o
      ON o.developer_record_id IS NOT NULL
     AND o.developer_record_id::text = ANY (public.mkt_record_id_list(r.data->'marketer'))
     AND o.developer_record_id::text IS DISTINCT FROM r.data->>'developer'
   WHERE r.model_id = c_all_projects
     AND (p_project IS NULL OR r.id = p_project)
     AND (p_org IS NULL OR o.id = p_org)
  ON CONFLICT (project_id, organization_id, relationship_type) DO UPDATE
     SET is_active = true, last_observed_at = now(), updated_at = now();
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- 3. the record names this marketer again → retire its demoted copy
  UPDATE public.mkt_project_organizations f
     SET is_active = false, updated_at = now(),
         evidence = f.evidence || jsonb_build_object(
           'deactivated_at', now(),
           'deactivated_reason', 'the project record names this organization as marketer again')
   WHERE f.is_active
     AND f.relationship_type = 'former_marketer'
     AND f.evidence->>'demoted_from' = 'authorized_marketer'
     AND (p_project IS NULL OR f.project_id = p_project)
     AND (p_org IS NULL OR f.organization_id = p_org)
     AND EXISTS (SELECT 1 FROM public.mkt_project_organizations a
                  WHERE a.project_id = f.project_id AND a.organization_id = f.organization_id
                    AND a.relationship_type = 'authorized_marketer' AND a.is_active);

  -- 4. CRM copies the record no longer supports
  WITH stale AS (
    SELECT po.id, po.project_id, po.organization_id, po.relationship_type,
           (r.id IS NULL) AS project_gone,
           (o.developer_record_id IS NOT NULL
            AND o.developer_record_id::text = r.data->>'developer') AS org_is_developer
      FROM public.mkt_project_organizations po
      JOIN public.mkt_organizations o ON o.id = po.organization_id
      LEFT JOIN public.records r ON r.id = po.project_id AND r.model_id = c_all_projects
     WHERE po.is_active
       AND po.relationship_type IN ('developer', 'authorized_marketer')
       AND coalesce(po.evidence->>'source', '') IN
           ('developer_field_sync', 'all_projects.developer', 'our_projects_portfolio', 'crm_marketer_field')
       AND po.confirmed_by IS NULL
       AND (p_project IS NULL OR po.project_id = p_project)
       AND (p_org IS NULL OR po.organization_id = p_org)
       AND NOT (
         r.id IS NOT NULL AND o.developer_record_id IS NOT NULL AND (
              (po.relationship_type = 'developer'
               AND o.developer_record_id::text = r.data->>'developer')
           OR (po.relationship_type = 'authorized_marketer'
               AND o.developer_record_id::text = ANY (public.mkt_record_id_list(r.data->'marketer'))
               AND o.developer_record_id::text IS DISTINCT FROM r.data->>'developer')))
  ), demoted AS (
    UPDATE public.mkt_project_organizations po
       SET relationship_type = 'former_marketer', updated_at = now(),
           evidence = po.evidence || jsonb_build_object(
             'demoted_from', 'authorized_marketer', 'demoted_at', now(),
             'reason', 'the project record no longer names this organization as marketer')
      FROM stale s
     WHERE po.id = s.id
       AND s.relationship_type = 'authorized_marketer'
       AND NOT s.project_gone
       AND NOT s.org_is_developer
       AND NOT EXISTS (SELECT 1 FROM public.mkt_project_organizations x
                        WHERE x.project_id = s.project_id AND x.organization_id = s.organization_id
                          AND x.relationship_type = 'former_marketer')
    RETURNING po.id
  )
  UPDATE public.mkt_project_organizations po
     SET is_active = false, updated_at = now(),
         evidence = po.evidence || jsonb_build_object(
           'deactivated_at', now(),
           'deactivated_reason', CASE
             WHEN s.project_gone THEN 'project record no longer exists'
             WHEN s.relationship_type = 'authorized_marketer' AND s.org_is_developer
               THEN 'the company is the project''s developer; a developer is never listed as its own marketer'
             ELSE 'the project record no longer names this organization' END)
    FROM stale s
   WHERE po.id = s.id
     AND po.id NOT IN (SELECT id FROM demoted);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) TO service_role;

-- ── 5. all_projects.marketer → multi lookup on Companies ───────────────────
-- 5b. old Marketers-model ids → Companies ids
CREATE TEMP TABLE _mk_map ON COMMIT DROP AS
SELECT '1d556755-7462-4390-8a13-f3af415a62d7'::text AS old_id,          -- ريفا
       (SELECT developer_record_id FROM public.mkt_organizations
         WHERE id = '6db1c2e9-527a-4d9f-97f5-ebe971088d40') AS company
UNION ALL
SELECT 'ca30b211-15c7-417b-af8f-107f21c1eae6', '08454e67-1ff1-4bcb-983f-50d035800f1d'::uuid;  -- آبه

-- 5c. a project page on a marketer's own site = that company markets it
CREATE TEMP TABLE _evid ON COMMIT DROP AS
SELECT v.domain, CASE WHEN v.org_id IS NULL THEN v.company
                      ELSE (SELECT developer_record_id FROM public.mkt_organizations WHERE id = v.org_id) END AS company
  FROM (VALUES ('thiraa.sa',       NULL::uuid, '209817ec-0535-473c-9cee-15697d8abe3c'::uuid),   -- ذراع
               ('rakez.sa',        '29c0d733-60f3-43f2-91d3-87e7172b1465'::uuid, NULL::uuid),   -- راكز
               ('madaproperties',  '869de75e-aaa3-4de5-aee5-d0140bf6c067', NULL),               -- مدى
               ('tqres.sa',        '96d4a0fb-58f3-4e55-a318-93f65bac2fd5', NULL),               -- تكريس
               ('revenue.sa',      'c8b307b2-7f7d-43d2-aa19-2c4be05660e1', NULL),               -- صناع الإيرادات
               ('ruya.com.sa',     'bf3cbc7c-2fb9-4a87-9694-73e0c7cf54d9', NULL),               -- رؤية
               ('taraf-estate',    '5f119f7c-d764-4f85-8ebf-a345292ab6aa', NULL),               -- ترف
               ('riva.sa',         '6db1c2e9-527a-4d9f-97f5-ebe971088d40', NULL)                -- ريفا
       ) AS v(domain, org_id, company);

-- 5d. projects whose DEVELOPER is a marketer: the real developer where known
CREATE TEMP TABLE _akt ON COMMIT DROP AS SELECT gen_random_uuid() AS rec_id;
CREATE TEMP TABLE _devfix (project uuid PRIMARY KEY, new_dev uuid) ON COMMIT DROP;
INSERT INTO _devfix VALUES
  ('1ba5ea55-5fdf-42ee-a46d-4be8958a3621', 'ca063baa-8e6f-4d6b-bdf5-8f6ef9ceee38'),  -- متمم 85 → شركة متمم
  ('a2297e20-8036-4d64-9a30-e96b6ed1d514', 'ff5b2c45-4361-4c45-b030-40682ad93b13'),  -- شقق ديار الخزامي → ديار الخزامى
  ('bd04688c-7e5e-4114-b33d-e94a174f96aa', 'ff5b2c45-4361-4c45-b030-40682ad93b13'),  -- أدوار دار الخزامى → ديار الخزامى
  ('555982b1-d0e7-41a1-ba8b-d160d54f92d9', (SELECT rec_id FROM _akt)),                -- أكتان 10 → أكتان العقارية (created in §8)
  ('b79f41af-ce03-40cf-8b49-f6abc38b8d6d', NULL),                                     -- منزل ديم — developer not confirmed
  ('03604c3a-cd81-443c-a2b6-1fe2b4395185', NULL),                                     -- عالية الفيحاء — unknown
  ('664ebca3-3845-446c-9764-71c4afab21ec', NULL),                                     -- أدوار سنا الربوة — unknown
  ('002aa5b5-e3cf-4f02-87d5-4da0166ef220', NULL),                                     -- رحيب — unknown
  ('91f17c59-b3f5-427b-8d3f-627cf0a52490', NULL),                                     -- وارف — unknown
  ('95c0edd3-1d85-4149-b050-72edf35ee302', NULL),                                     -- شقق سماوة — آبه is a marketer
  ('c21e0b70-0794-4796-963a-f7052a2d5d9a', NULL);                                     -- «D» — آبه is a marketer

-- 5e. write the new developer + marketers list, only where something changes
WITH cur AS (
  SELECT p.id, p.data, (d.project IS NOT NULL) AS dev_fixed,
         CASE WHEN d.project IS NOT NULL THEN d.new_dev::text ELSE p.data->>'developer' END AS new_dev,
         p.data->>'developer' AS old_dev
    FROM public.records p
    LEFT JOIN _devfix d ON d.project = p.id
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
), calc AS (
  SELECT c.id, c.data, c.dev_fixed, c.new_dev, c.old_dev,
         coalesce((
           SELECT jsonb_agg(x ORDER BY first_pos, x)
             FROM (
               SELECT x, min(pos) AS first_pos FROM (
                 SELECT coalesce(m.company::text, e) AS x, o AS pos
                   FROM unnest(public.mkt_record_id_list(c.data->'marketer')) WITH ORDINALITY u(e, o)
                   LEFT JOIN _mk_map m ON m.old_id = e
                 UNION ALL
                 SELECT ev.company::text, 1000
                   FROM _evid ev
                  WHERE ev.company IS NOT NULL
                    AND (coalesce(c.data->>'project_page_url', '') ILIKE '%' || ev.domain || '%'
                         OR (ev.domain = 'riva.sa' AND coalesce(c.data->>'update_source_url', '') ILIKE '%riva.sa%'))
                 UNION ALL   -- a marketer that was recorded as the developer stays on as a marketer
                 SELECT c.old_dev, 2000
                  WHERE c.old_dev IN ('209817ec-0535-473c-9cee-15697d8abe3c', '08454e67-1ff1-4bcb-983f-50d035800f1d')
               ) s
              WHERE x IS NOT NULL AND x IS DISTINCT FROM c.new_dev
              GROUP BY x) y), '[]'::jsonb) AS new_mk
    FROM cur c
)
UPDATE public.records p
   SET data = p.data
              || CASE WHEN calc.dev_fixed
                      THEN jsonb_build_object('developer', CASE WHEN calc.new_dev IS NULL THEN 'null'::jsonb ELSE to_jsonb(calc.new_dev) END)
                      ELSE '{}'::jsonb END
              || jsonb_build_object('marketer', CASE WHEN jsonb_array_length(calc.new_mk) = 0 THEN 'null'::jsonb ELSE calc.new_mk END)
  FROM calc
 WHERE p.id = calc.id
   AND (calc.new_dev IS DISTINCT FROM calc.old_dev
        -- a single-id string becomes a one-element list
        OR (jsonb_typeof(calc.data->'marketer') = 'string' AND calc.data->>'marketer' <> '')
        -- the list itself changed (an empty list and a missing value are the same thing)
        OR calc.new_mk IS DISTINCT FROM to_jsonb(public.mkt_record_id_list(calc.data->'marketer')));

-- 5f. project officers + lead portals (single marketer each)
UPDATE public.records r
   SET data = jsonb_set(r.data, '{marketer}', pg_temp.swap_id(r.data->'marketer', m.old_id, m.company::text))
  FROM _mk_map m
 WHERE r.model_id IN ('026855a4-02cb-41de-b9b5-91c0eee331a9', '1ead0000-0000-4000-8000-000000000001')
   AND m.old_id = ANY (public.mkt_record_id_list(r.data->'marketer'));

-- ── 6. merge duplicate companies ───────────────────────────────────────────
CREATE TEMP TABLE _merge (keeper uuid, loser uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _merge VALUES
  ('4c2dcafa-aec1-4796-b955-125028a88216', '7619a4c5-a017-4f23-abf1-42af943eb995'),  -- دار الأركان ← «دار الأركا ن»
  ('4c2dcafa-aec1-4796-b955-125028a88216', '1a55b983-4db1-4f54-8db7-db4261b4ea40'),  -- دار الأركان ← دارا الأركان
  ('7b167d51-6fda-4d44-93f6-c191894e1681', '0690f8a7-99da-44f8-ac0d-cb65f454d4e8'),  -- الزامل العقارية ← الزامل
  ('4a4e9d61-4821-4296-81f2-377dd95e15ee', '663337e3-9b02-40bb-92e5-d863b4455850'),  -- دار وأعمار ← دار واعمار
  ('e98d9940-e6ef-4e66-8a18-9062e64cc2e5', '1621d50c-482d-44c1-bace-284aef7ab793'),  -- أتول العقارية ← أتول العقرية
  ('e98d9940-e6ef-4e66-8a18-9062e64cc2e5', '1c33efb4-ee76-4f04-962e-3d3204167296'),  -- أتول العقارية ← اتول العقارية
  ('45f03f42-1e87-45df-b041-7f8176f691f4', 'ff27efcb-4355-4d56-b341-8f1d6004fae0'),  -- دار بيات ← دار بيات للتطوير والإستثمار
  ('62cf19a2-5ffe-478e-90e2-6ee3a8f801cb', '5790e914-439c-4f9b-8c9c-7f5fdcd0c749'),  -- الأساس ← الأساس للتطوير العقاري
  ('4f813c0f-07ae-4225-acb1-8cffcb4d59da', '92d55bbf-9735-420e-a48f-dca83d32ff14'),  -- أساس مكين ← اساس مكين
  ('29103be4-6549-468b-8d1c-da5c640acbca', '7599ef9c-fec9-43ee-881a-a0512af90186'),  -- ركم ← ركم (short)
  ('d564ca59-91b7-4437-b68e-9620d1029d07', '0c775af9-6192-4e10-bc3c-c0cc70ddddaf');  -- الدرة ← الدارة (same site darahre.com)
DELETE FROM _merge m
 WHERE NOT EXISTS (SELECT 1 FROM public.records WHERE id = m.loser)
    OR NOT EXISTS (SELECT 1 FROM public.records WHERE id = m.keeper);

-- 6a. contact details the keeper lacks come from its duplicates
UPDATE public.records k
   SET data = k.data || f.patch
  FROM (
    SELECT keeper, jsonb_object_agg(key, value) AS patch
      FROM (
        SELECT DISTINCT ON (m.keeper, e.key) m.keeper, e.key, e.value
          FROM _merge m
          JOIN public.records l ON l.id = m.loser
          JOIN public.records kk ON kk.id = m.keeper
          CROSS JOIN LATERAL jsonb_each(l.data) e
         WHERE e.key IN ('phone', 'email', 'website', 'notes')
           AND coalesce(e.value #>> '{}', '') <> ''
           AND coalesce(kk.data->>e.key, '') = ''
         ORDER BY m.keeper, e.key, m.loser) q
     GROUP BY keeper) f
 WHERE k.id = f.keeper;

-- 6b. every reference moves to the keeper
DO $m$
DECLARE r record;
BEGIN
  FOR r IN SELECT keeper::text AS keeper, loser::text AS loser FROM _merge LOOP
    UPDATE public.records
       SET data = jsonb_set(data, '{developer}', pg_temp.swap_id(data->'developer', r.loser, r.keeper))
     WHERE model_id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                        '1ead0000-0000-4000-8000-000000000001')
       AND r.loser = ANY (public.mkt_record_id_list(data->'developer'));
    UPDATE public.records
       SET data = jsonb_set(data, '{marketer}', pg_temp.swap_id(data->'marketer', r.loser, r.keeper))
     WHERE model_id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                        '1ead0000-0000-4000-8000-000000000001')
       AND r.loser = ANY (public.mkt_record_id_list(data->'marketer'));
    UPDATE public.records
       SET data = jsonb_set(data, '{developer_id}', pg_temp.swap_id(data->'developer_id', r.loser, r.keeper))
     WHERE model_id = '7ca3014d-f658-418e-9c53-2d279c97f009'
       AND r.loser = ANY (public.mkt_record_id_list(data->'developer_id'));
  END LOOP;
END $m$;

-- 6c. the duplicates' watch entries hold only project links (rebuilt by the
--     sync for the keeper) — no accounts, posts or ads. Then the duplicate
--     company records go. Both are in the backups above.
DELETE FROM public.mkt_organizations o USING _merge m WHERE o.developer_record_id = m.loser;
DELETE FROM public.records r USING _merge m
 WHERE r.id = m.loser AND r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2';

-- ── 7. Competitor Watch follows Companies ─────────────────────────────────
-- The watch entry's type always follows the company's type.
UPDATE public.mkt_organizations o
   SET org_type = r.data->>'company_type'
  FROM public.records r
 WHERE r.id = o.developer_record_id
   AND r.data->>'company_type' IN ('developer', 'marketer')
   AND o.org_type IS DISTINCT FROM r.data->>'company_type';

-- The org-side trigger function no longer maintains a separate marketer link.
-- (Its trigger definition, which still lists marketer_record_id, and the
-- column itself are replaced/dropped in 2026-09-29_02 — table DDL is kept out
-- of this data migration so it never takes an exclusive lock on a hot table.)
CREATE OR REPLACE FUNCTION public.mkt_tg_org_sync_developer_relationships()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.mkt_sync_developer_relationships(NULL, NEW.id);
  RETURN NEW;
END $function$;

-- ── 8. new company from the ذراع fix, then a watch entry for every company ─
INSERT INTO public.records (id, model_id, data)
SELECT a.rec_id, '11bade2c-7da9-4d00-b045-eaab37153da2',
       jsonb_build_object(
         'developer_id', 'م ط' || lpad((coalesce((SELECT max(NULLIF(regexp_replace(data->>'developer_id', '\D', '', 'g'), '')::int)
                                                    FROM public.records WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'), 0) + 1)::text, 3, '0'),
         'name', 'أكتان العقارية', 'website', 'https://aktan-sa.com/', 'company_type', 'developer')
  FROM _akt a
 WHERE EXISTS (SELECT 1 FROM public.records WHERE id = '555982b1-d0e7-41a1-ba8b-d160d54f92d9');

-- أكتان 10 was written in §5e before its developer record existed; touch it so
-- the relationship sync links it now that the company + watch entry exist.
UPDATE public.records SET data = data WHERE id = '555982b1-d0e7-41a1-ba8b-d160d54f92d9';

INSERT INTO public.mkt_organizations (name_ar, org_type, website, developer_record_id, status, metadata)
SELECT btrim(r.data->>'name'), coalesce(nullif(r.data->>'company_type', ''), 'developer'),
       nullif(btrim(r.data->>'website'), ''), r.id, 'active',
       jsonb_build_object('source', 'companies_list', 'company_record_id', r.id)
  FROM public.records r
 WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND coalesce(btrim(r.data->>'name'), '') <> ''
   AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.developer_record_id = r.id);

-- keep the auto-id counter at or above the highest id in use
UPDATE public.auto_id_counters c
   SET current_value = GREATEST(c.current_value,
         (SELECT max(NULLIF(regexp_replace(data->>'developer_id', '\D', '', 'g'), '')::int)
            FROM public.records WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2')),
       updated_at = now()
 WHERE c.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2' AND c.scope_key = '__global__';

-- ── 9a. model definitions — LAST, because each one regenerates its v_<model>
--      view under an exclusive lock that blocks readers until COMMIT ─────
-- ── 1. the Developers model becomes Companies ──────────────────────────────
UPDATE public.models m
   SET label_ar = 'الشركات', label_en = 'Companies',
       schema = jsonb_set(m.schema, '{sections,0}',
         (m.schema->'sections'->0)
         || jsonb_build_object('label_ar', 'معلومات الشركة', 'label_en', 'Company Info',
              'fields', (
                SELECT jsonb_agg(x.f ORDER BY (x.f->>'order')::numeric, x.f->>'name')
                  FROM (
                    SELECT CASE f->>'name'
                             WHEN 'name'         THEN f || '{"label_ar":"اسم الشركة","label_en":"Company Name"}'::jsonb
                             WHEN 'developer_id' THEN f || '{"label_ar":"معرف الشركة","label_en":"Company ID"}'::jsonb
                             ELSE f || jsonb_build_object('order',
                                         (f->>'order')::int + CASE WHEN (f->>'order')::int >= 2 THEN 1 ELSE 0 END)
                           END AS f
                      FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
                     WHERE f->>'name' <> 'company_type'
                    UNION ALL
                    SELECT jsonb_build_object(
                             'id', 'c0a1c0de-7e5e-4b1a-9c11-000000000001',
                             'name', 'company_type',
                             'type', 'dropdown',
                             'label_ar', 'نوع الشركة', 'label_en', 'Company type',
                             'required', true, 'order', 2, 'width', 'half', 'show_in_table', true,
                             'section_id', m.schema->'sections'->0->>'id',
                             'options', jsonb_build_array(
                               jsonb_build_object('id', 'c0a1c0de-7e5e-4b1a-9c11-000000000002', 'value', 'developer',
                                                  'label_ar', 'مطوّر', 'label_en', 'Developer', 'color', '#B8734F'),
                               jsonb_build_object('id', 'c0a1c0de-7e5e-4b1a-9c11-000000000003', 'value', 'marketer',
                                                  'label_ar', 'مسوّق', 'label_en', 'Marketer', 'color', '#C09B5F')))
                  ) x)))
 WHERE m.id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND jsonb_array_length(m.schema->'sections') = 1;

-- 5a. the field definitions (the per-model views regenerate from this)
UPDATE public.models m
   SET schema = jsonb_set(m.schema, '{sections}', (
         SELECT jsonb_agg(s || jsonb_build_object('fields', coalesce((
                  SELECT jsonb_agg(CASE WHEN f->>'name' = 'marketer'
                                        THEN f || CASE WHEN m.id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
                                                       THEN jsonb_build_object('lookup_model_id', '11bade2c-7da9-4d00-b045-eaab37153da2',
                                                                               'is_multi', true,
                                                                               'label_ar', 'المسوّقون', 'label_en', 'Marketers')
                                                       ELSE jsonb_build_object('lookup_model_id', '11bade2c-7da9-4d00-b045-eaab37153da2') END
                                        ELSE f END ORDER BY fi)
                    FROM jsonb_array_elements(s->'fields') WITH ORDINALITY ff(f, fi)), '[]'::jsonb)) ORDER BY si)
           FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY ss(s, si)))
 WHERE m.id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                '1ead0000-0000-4000-8000-000000000001');

-- ── 9. full relationship pass ──────────────────────────────────────────────
SELECT public.mkt_sync_developer_relationships(NULL, NULL);

-- ── 9b. re-check posts only where a company's project links really changed ─
-- Changing a project's developer (the merges, the ذراع / آبه fixes) fires
-- records_rescore_on_project_update, which re-queues EVERY post in the library
-- (3,505 measured in the dry run) — and a flood of exactly that kind was
-- cancelled by hand on 2026-09-28. Drop what this transaction queued (now() is
-- the transaction's start time, so no other session's job matches) and queue
-- the free narrow-only re-check just for companies whose active project links
-- differ from the backup taken at the top of this migration.
DELETE FROM public.mkt_collection_jobs
 WHERE kind = 'content_process' AND status = 'queued'
   AND params->>'from' = 'attribution_rerun'
   AND created_at = now();

WITH before AS (
  SELECT organization_id, project_id, relationship_type
    FROM public._backup_20260929_mkt_project_organizations WHERE is_active
), after AS (
  SELECT organization_id, project_id, relationship_type
    FROM public.mkt_project_organizations WHERE is_active
), changed AS (
  SELECT organization_id FROM (SELECT * FROM before EXCEPT SELECT * FROM after) a
  UNION
  SELECT organization_id FROM (SELECT * FROM after EXCEPT SELECT * FROM before) b
)
SELECT public.mkt_enqueue_attribution_rerun(c.organization_id, 10000)
  FROM (SELECT DISTINCT organization_id FROM changed) c
  JOIN public.mkt_organizations o ON o.id = c.organization_id;

-- ── 10. assertions (guarded: an empty database has nothing to violate) ─────
DO $assert$
DECLARE v int; v_txt text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v FROM public.records
   WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND coalesce(data->>'company_type', '') NOT IN ('developer', 'marketer');
  IF v > 0 THEN RAISE EXCEPTION 'COMPANIES_UNTYPED: % company record(s) have no type', v; END IF;

  SELECT string_agg(p.data->>'project_name', ', ') INTO v_txt
    FROM public.records p JOIN public.records c ON c.id::text = p.data->>'developer'
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f' AND c.data->>'company_type' = 'marketer';
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'MARKETER_AS_DEVELOPER: %', v_txt; END IF;

  SELECT string_agg(DISTINCT p.data->>'project_name', ', ') INTO v_txt
    FROM public.records p
    CROSS JOIN LATERAL unnest(public.mkt_record_id_list(p.data->'marketer')) e
    LEFT JOIN public.records c ON c.id::text = e AND c.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
     AND (c.id IS NULL OR c.data->>'company_type' <> 'marketer' OR e = p.data->>'developer');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'BAD_MARKETER_ENTRY (not a marketer company, or the project''s own developer): %', v_txt;
  END IF;

  WITH gone AS (
    SELECT coalesce(array_agg(b.id::text), '{}'::text[]) AS ids
      FROM public._backup_20260929_company_records b
     WHERE b.model_id IN ('11bade2c-7da9-4d00-b045-eaab37153da2', '37f4905c-bc64-4993-a0c4-07e4f54463e2')
       AND NOT EXISTS (SELECT 1 FROM public.records x WHERE x.id = b.id AND x.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'))
  SELECT count(*) INTO v FROM public.records r, gone
   WHERE r.model_id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                        '1ead0000-0000-4000-8000-000000000001', '7ca3014d-f658-418e-9c53-2d279c97f009')
     AND (public.mkt_record_id_list(r.data->'developer')    && gone.ids
       OR public.mkt_record_id_list(r.data->'marketer')     && gone.ids
       OR public.mkt_record_id_list(r.data->'developer_id') && gone.ids);
  IF v > 0 THEN RAISE EXCEPTION 'DANGLING_COMPANY_REFERENCE: % record(s) still point at a removed or old-list company', v; END IF;

  SELECT count(*) INTO v FROM public.records r
   WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND (SELECT count(*) FROM public.mkt_organizations o WHERE o.developer_record_id = r.id) <> 1;
  IF v > 0 THEN RAISE EXCEPTION 'COMPANY_WATCH_ENTRY: % company record(s) without exactly one watch entry', v; END IF;

  SELECT count(*) INTO v FROM public.mkt_organizations o
   WHERE o.org_type IN ('developer', 'marketer') AND o.status <> 'archived'
     AND (o.developer_record_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.records r WHERE r.id = o.developer_record_id
                           AND r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
                           AND r.data->>'company_type' = o.org_type));
  IF v > 0 THEN RAISE EXCEPTION 'WATCH_ENTRY_NOT_IN_COMPANIES: % developer/marketer watch entr(ies) have no matching company', v; END IF;

  SELECT count(*) INTO v
    FROM public.records p
    CROSS JOIN LATERAL unnest(public.mkt_record_id_list(p.data->'marketer')) e
    JOIN public.mkt_organizations o ON o.developer_record_id::text = e
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
     AND NOT EXISTS (SELECT 1 FROM public.mkt_project_organizations po
                      WHERE po.project_id = p.id AND po.organization_id = o.id
                        AND po.relationship_type = 'authorized_marketer' AND po.is_active);
  IF v > 0 THEN RAISE EXCEPTION 'RELATIONSHIP_SYNC_INCOMPLETE: % project marketer(s) with no active link', v; END IF;

  SELECT count(*) INTO v
    FROM public.mkt_project_organizations po
    JOIN public.mkt_organizations o ON o.id = po.organization_id
    JOIN public.records r ON r.id = po.project_id
   WHERE po.is_active AND po.relationship_type = 'authorized_marketer' AND po.confirmed_by IS NULL
     AND coalesce(po.evidence->>'source', '') IN ('our_projects_portfolio', 'crm_marketer_field')
     AND NOT (o.developer_record_id::text = ANY (public.mkt_record_id_list(r.data->'marketer')));
  IF v > 0 THEN RAISE EXCEPTION 'RELATIONSHIP_SYNC_STALE: % active marketer link(s) contradict their project record', v; END IF;

  SELECT count(*) INTO v
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
   WHERE m.id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                  '1ead0000-0000-4000-8000-000000000001')
     AND f->>'name' = 'marketer'
     AND f->>'lookup_model_id' IS DISTINCT FROM '11bade2c-7da9-4d00-b045-eaab37153da2';
  IF v > 0 THEN RAISE EXCEPTION 'MARKETER_FIELD_NOT_RETARGETED: % field(s)', v; END IF;
END $assert$;

COMMIT;
