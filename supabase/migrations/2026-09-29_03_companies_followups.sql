-- ============================================================================
-- Companies follow-ups (2026-09-29, after _01 / _02)
-- ----------------------------------------------------------------------------
-- Operator decisions on the open questions from the Companies restructure:
--   1. Abah is a DEVELOPER (not a marketer). It goes back to being the developer
--      of Shuqaq Samawa and «D»; Shuqaq Samawa keeps Riva as its marketer.
--   2. Riva markets Adwar Jadeel Al Rimal (developer Al Ramz). Safe since
--      c10bf7e4: we deal with Al Ramz directly (its own portal + officer), so the
--      developer-first rule keeps every lead going to Al Ramz only; the marketer
--      entry is information (Competitor Watch) only.
--   3. Pickers show only the right kind of company: every developer lookup lists
--      developer companies, every marketer lookup lists marketer companies
--      (field.lookup_filter, honoured by the SPA's lookup picker).
--   4. The old separate Marketers model is deleted — verified unreferenced: no
--      lookup field, no record value, no workflow points at it. Its one leftover
--      permission row on the Administrator profile is removed. History rows in
--      activity_log are kept. Model + records are in
--      _backup_20260929_company_models / _backup_20260929_company_records.
--
-- Changing a project's developer fires records_rescore_on_project_update, which
-- re-queues EVERY competitor post (~3,500). As in _01, this transaction's rerun
-- jobs are dropped and only companies whose active project links changed are
-- re-checked.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

CREATE TEMP TABLE _links_before ON COMMIT DROP AS
  SELECT organization_id, project_id, relationship_type
    FROM public.mkt_project_organizations WHERE is_active;

-- ── 1. Abah is a developer again ─────────────────────────────────────────────
UPDATE public.records
   SET data = data || '{"company_type":"developer"}'::jsonb
 WHERE id = '08454e67-1ff1-4bcb-983f-50d035800f1d'
   AND model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND data->>'company_type' IS DISTINCT FROM 'developer';

-- Shuqaq Samawa: developer Abah, marketer Riva.  «D»: developer Abah.
UPDATE public.records p
   SET data = p.data
     || jsonb_build_object('developer', '08454e67-1ff1-4bcb-983f-50d035800f1d')
     || jsonb_build_object('marketer', CASE
          WHEN p.id = '95c0edd3-1d85-4149-b050-72edf35ee302'
            THEN jsonb_build_array((SELECT developer_record_id::text FROM public.mkt_organizations
                                     WHERE id = '6db1c2e9-527a-4d9f-97f5-ebe971088d40'))
          ELSE 'null'::jsonb END)
 WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
   AND p.id IN ('95c0edd3-1d85-4149-b050-72edf35ee302', 'c21e0b70-0794-4796-963a-f7052a2d5d9a');

-- ── 2. Riva markets Adwar Jadeel Al Rimal ────────────────────────────────────
UPDATE public.records p
   SET data = p.data || jsonb_build_object('marketer', jsonb_build_array(
         (SELECT developer_record_id::text FROM public.mkt_organizations WHERE id = '6db1c2e9-527a-4d9f-97f5-ebe971088d40')))
 WHERE p.id = '5271e833-bc92-408b-97b9-7ca613b7a7b5'
   AND p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
   AND cardinality(public.mkt_record_id_list(p.data->'marketer')) = 0;

-- ── 3. developer pickers list developers, marketer pickers list marketers ────
UPDATE public.models m
   SET schema = jsonb_set(m.schema, '{sections}', (
         SELECT jsonb_agg(s || jsonb_build_object('fields', coalesce((
                  SELECT jsonb_agg(CASE
                           WHEN f->>'lookup_model_id' = '11bade2c-7da9-4d00-b045-eaab37153da2'
                                AND f->>'name' IN ('developer', 'developer_id')
                             THEN f || '{"lookup_filter":{"field":"company_type","value":"developer"}}'::jsonb
                           WHEN f->>'lookup_model_id' = '11bade2c-7da9-4d00-b045-eaab37153da2'
                                AND f->>'name' = 'marketer'
                             THEN f || '{"lookup_filter":{"field":"company_type","value":"marketer"}}'::jsonb
                           ELSE f END ORDER BY fi)
                    FROM jsonb_array_elements(s->'fields') WITH ORDINALITY ff(f, fi)), '[]'::jsonb)) ORDER BY si)
           FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY ss(s, si)))
 WHERE m.id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f',   -- all_projects
                '026855a4-02cb-41de-b9b5-91c0eee331a9',   -- project_officers
                '1ead0000-0000-4000-8000-000000000001',   -- lead_portals
                '7ca3014d-f658-418e-9c53-2d279c97f009');  -- units

-- ── 4. retire the old Marketers model ────────────────────────────────────────
UPDATE public.profiles
   SET model_permissions = (SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb)
                              FROM jsonb_array_elements(model_permissions) WITH ORDINALITY x(e, o)
                             WHERE e->>'model_id' IS DISTINCT FROM '37f4905c-bc64-4993-a0c4-07e4f54463e2')
 WHERE jsonb_typeof(model_permissions) = 'array'
   AND model_permissions::text LIKE '%37f4905c-bc64-4993-a0c4-07e4f54463e2%';

DO $guard$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
   WHERE f::text LIKE '%37f4905c-bc64-4993-a0c4-07e4f54463e2%';
  IF v > 0 THEN RAISE EXCEPTION 'OLD_MARKETERS_STILL_REFERENCED_BY_FIELDS: %', v; END IF;
  SELECT count(*) INTO v FROM public.records r
   WHERE r.model_id <> '37f4905c-bc64-4993-a0c4-07e4f54463e2'
     AND r.data::text ~ '(1d556755-7462-4390-8a13-f3af415a62d7|ca30b211-15c7-417b-af8f-107f21c1eae6)';
  IF v > 0 THEN RAISE EXCEPTION 'OLD_MARKETERS_STILL_REFERENCED_BY_RECORDS: %', v; END IF;
  SELECT count(*) INTO v FROM public.workflows w WHERE w::text LIKE '%37f4905c-bc64-4993-a0c4-07e4f54463e2%';
  IF v > 0 THEN RAISE EXCEPTION 'OLD_MARKETERS_STILL_REFERENCED_BY_WORKFLOWS: %', v; END IF;
END $guard$;

DELETE FROM public.models
 WHERE id = '37f4905c-bc64-4993-a0c4-07e4f54463e2' AND name = 'marketers' AND is_system IS NOT TRUE;

-- ── 5. re-check posts only where a company's project links changed ───────────
DELETE FROM public.mkt_collection_jobs
 WHERE kind = 'content_process' AND status = 'queued'
   AND params->>'from' = 'attribution_rerun'
   AND created_at = now();

WITH after AS (
  SELECT organization_id, project_id, relationship_type
    FROM public.mkt_project_organizations WHERE is_active
), changed AS (
  SELECT organization_id FROM (SELECT * FROM _links_before EXCEPT SELECT * FROM after) a
  UNION
  SELECT organization_id FROM (SELECT * FROM after EXCEPT SELECT * FROM _links_before) b
)
SELECT public.mkt_enqueue_attribution_rerun(c.organization_id, 10000)
  FROM (SELECT DISTINCT organization_id FROM changed) c
  JOIN public.mkt_organizations o ON o.id = c.organization_id;

-- ── 6. assertions ────────────────────────────────────────────────────────────
DO $assert$
DECLARE v int; v_txt text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2') THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.models WHERE id = '37f4905c-bc64-4993-a0c4-07e4f54463e2') THEN
    RAISE EXCEPTION 'OLD_MARKETERS_MODEL_NOT_DELETED';
  END IF;

  SELECT string_agg(p.data->>'project_name', ', ') INTO v_txt
    FROM public.records p JOIN public.records c ON c.id::text = p.data->>'developer'
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f' AND c.data->>'company_type' <> 'developer';
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'NON_DEVELOPER_AS_DEVELOPER: %', v_txt; END IF;

  SELECT string_agg(DISTINCT p.data->>'project_name', ', ') INTO v_txt
    FROM public.records p
    CROSS JOIN LATERAL unnest(public.mkt_record_id_list(p.data->'marketer')) e
    LEFT JOIN public.records c ON c.id::text = e AND c.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
     AND (c.id IS NULL OR c.data->>'company_type' <> 'marketer' OR e = p.data->>'developer');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'BAD_MARKETER_ENTRY: %', v_txt; END IF;

  SELECT count(*) INTO v FROM public.mkt_organizations o
    JOIN public.records r ON r.id = o.developer_record_id
   WHERE o.org_type IN ('developer', 'marketer') AND o.org_type <> r.data->>'company_type';
  IF v > 0 THEN RAISE EXCEPTION 'WATCH_TYPE_MISMATCH: %', v; END IF;

  SELECT count(*) INTO v
    FROM public.records p
    CROSS JOIN LATERAL unnest(public.mkt_record_id_list(p.data->'marketer')) e
    JOIN public.mkt_organizations o ON o.developer_record_id::text = e
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
     AND NOT EXISTS (SELECT 1 FROM public.mkt_project_organizations po
                      WHERE po.project_id = p.id AND po.organization_id = o.id
                        AND po.relationship_type = 'authorized_marketer' AND po.is_active);
  IF v > 0 THEN RAISE EXCEPTION 'RELATIONSHIP_SYNC_INCOMPLETE: %', v; END IF;

  SELECT count(*) INTO v
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
   WHERE m.id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9',
                  '1ead0000-0000-4000-8000-000000000001', '7ca3014d-f658-418e-9c53-2d279c97f009')
     AND f->>'lookup_model_id' = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND f->'lookup_filter' IS NULL;
  IF v > 0 THEN RAISE EXCEPTION 'COMPANY_LOOKUP_WITHOUT_FILTER: %', v; END IF;
END $assert$;

COMMIT;
