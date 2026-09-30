-- ============================================================================
-- Remove placeholder companies (2026-09-30)
-- ----------------------------------------------------------------------------
-- Six rows in the Companies list are not companies: «A28», «A30», «A8», «A9»,
-- «المطور» ("the developer") and «لايوجد معلومات» ("no information"). Measured
-- before removal: none has a social account or a collected post; 12 units with
-- NO project point at A28/A30/A8, and 4 projects (all themselves named
-- "unknown…" / a bare code) point at «لايوجد معلومات».
--
-- A placeholder as a developer says "we know the developer" when we do not, so
-- the references are cleared (developer = empty) and the rows deleted. Their
-- Competitor Watch entries go with them — they hold nothing.
-- Pre-change copies: _placeholder_companies_removed_20260930 (RLS on, no grants).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

CREATE TEMP TABLE _ph ON COMMIT DROP AS
SELECT id FROM public.records
 WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND id IN ('802655b0-2f3b-4b12-88aa-e8ce12b6830d',   -- A28
              '29604cab-7802-4b6d-9a14-a5fe6aa4bcc4',   -- A30
              '808b935a-abd9-4661-a78a-e91d4bc4ab29',   -- A8
              '4c573bf2-ba1c-4f39-9214-cd4674a25042',   -- A9
              '9a1e1490-aa4d-465d-9859-c308b3f28d53',   -- «المطور»
              'b6e7f171-12d8-423d-803b-2413ead171a8');  -- «لايوجد معلومات»

CREATE TABLE IF NOT EXISTS public._placeholder_companies_removed_20260930 AS
SELECT r.* FROM public.records r
 WHERE r.id IN (SELECT id FROM _ph)
    OR (r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f' AND r.data->>'developer' IN (SELECT id::text FROM _ph))
    OR (r.model_id = '7ca3014d-f658-418e-9c53-2d279c97f009' AND r.data->>'developer_id' IN (SELECT id::text FROM _ph));
ALTER TABLE public._placeholder_companies_removed_20260930 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._placeholder_companies_removed_20260930 FROM anon, authenticated;

-- Refuse to run if a placeholder turned out to be real: it has accounts/posts,
-- or is named as a marketer / officer / portal company.
DO $guard$
DECLARE v int;
BEGIN
  SELECT (SELECT count(*) FROM public.mkt_social_accounts a JOIN public.mkt_organizations o ON o.id = a.organization_id WHERE o.developer_record_id IN (SELECT id FROM _ph))
       + (SELECT count(*) FROM public.mkt_content_posts c JOIN public.mkt_organizations o ON o.id = c.organization_id WHERE o.developer_record_id IN (SELECT id FROM _ph))
       + (SELECT count(*) FROM public.records r
           WHERE r.model_id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '026855a4-02cb-41de-b9b5-91c0eee331a9', '1ead0000-0000-4000-8000-000000000001')
             AND public.mkt_record_id_list(r.data->'marketer') && ARRAY(SELECT id::text FROM _ph))
       + (SELECT count(*) FROM public.records r
           WHERE r.model_id IN ('026855a4-02cb-41de-b9b5-91c0eee331a9', '1ead0000-0000-4000-8000-000000000001')
             AND r.data->>'developer' IN (SELECT id::text FROM _ph))
    INTO v;
  IF v > 0 THEN RAISE EXCEPTION 'PLACEHOLDER_IS_IN_USE: % reference(s) — not removing', v; END IF;
END $guard$;

UPDATE public.records
   SET data = data || '{"developer": null}'::jsonb
 WHERE model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
   AND data->>'developer' IN (SELECT id::text FROM _ph);

UPDATE public.records
   SET data = data || '{"developer_id": null}'::jsonb
 WHERE model_id = '7ca3014d-f658-418e-9c53-2d279c97f009'
   AND data->>'developer_id' IN (SELECT id::text FROM _ph);

-- Watch entries first (they hold only project links), then the company rows.
DELETE FROM public.mkt_organizations WHERE developer_record_id IN (SELECT id FROM _ph);
DELETE FROM public.records WHERE id IN (SELECT id FROM _ph) AND model_id = '11bade2c-7da9-4d00-b045-eaab37153da2';

-- Clearing a project's developer fires records_rescore_on_project_update, which
-- re-queues every competitor post. Nothing with posts changed here — drop them.
DELETE FROM public.mkt_collection_jobs
 WHERE kind = 'content_process' AND status = 'queued'
   AND params->>'from' = 'attribution_rerun'
   AND created_at = now();

DO $assert$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.records r
   WHERE r.model_id IN ('220c49b9-de57-492d-9eca-c0d9f54fd40f', '7ca3014d-f658-418e-9c53-2d279c97f009')
     AND (r.data->>'developer' IN (SELECT id::text FROM public._placeholder_companies_removed_20260930 WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2')
       OR r.data->>'developer_id' IN (SELECT id::text FROM public._placeholder_companies_removed_20260930 WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'));
  IF v > 0 THEN RAISE EXCEPTION 'PLACEHOLDER_STILL_REFERENCED: %', v; END IF;
  SELECT count(*) INTO v FROM public.records r
   WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND (SELECT count(*) FROM public.mkt_organizations o WHERE o.developer_record_id = r.id) <> 1;
  IF v > 0 THEN RAISE EXCEPTION 'COMPANY_WATCH_ENTRY: %', v; END IF;
END $assert$;

COMMIT;
