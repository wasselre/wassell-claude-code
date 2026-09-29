-- ============================================================================
-- Companies → Competitor Watch trigger (2026-09-29, follows _01)
-- ----------------------------------------------------------------------------
-- 2026-09-29_01 gave every company in the Companies list exactly one Competitor
-- Watch entry (mkt_organizations.developer_record_id). This keeps it true for
-- companies added, renamed, retyped or deleted in the CRM from now on, and
-- removes the separate CRM-marketer link (marketer_record_id) that _01 folded
-- into developer_record_id.
--
-- Table DDL only, kept apart from _01's data changes: DROP COLUMN takes an
-- exclusive lock on mkt_organizations and CREATE TRIGGER blocks writes to
-- records while it runs. lock_timeout makes a busy moment fail fast (retry)
-- instead of queueing behind — or deadlocking with — live traffic.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

-- 1. the separate CRM-marketer link is gone
CREATE OR REPLACE TRIGGER mkt_organizations_sync_developer_relationships
  AFTER INSERT OR UPDATE OF developer_record_id, org_type, name_ar
  ON public.mkt_organizations
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_org_sync_developer_relationships();
DROP FUNCTION IF EXISTS public.mkt_link_marketer_records(uuid);
ALTER TABLE public.mkt_organizations DROP COLUMN IF EXISTS marketer_record_id;
COMMENT ON COLUMN public.mkt_organizations.developer_record_id IS
  'records.id of this company in the CRM Companies list (model slug ''developers''). Every company — developer or marketer — has exactly one watch entry; org_type follows the company''s company_type. Maintained by the records_company_to_org trigger.';

-- 2. a company created / renamed / retyped / deleted in the CRM updates its
--    watch entry. Only a CHANGE of name or type is pushed, so a routine save of
--    an unchanged company writes nothing. The website is copied only when the
--    watch entry is created: several company records hold a project page in
--    their website field, and an existing watch website is curated.
CREATE OR REPLACE FUNCTION public.mkt_tg_company_to_org()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org  public.mkt_organizations%ROWTYPE;
  v_type text;
  v_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.mkt_organizations
       SET developer_record_id = NULL, status = 'archived',
           metadata = metadata || jsonb_build_object('archived_reason', 'company record deleted',
                                                     'company_record_id', OLD.id, 'archived_at', now())
     WHERE developer_record_id = OLD.id;
    RETURN OLD;
  END IF;

  v_type := CASE NEW.data->>'company_type' WHEN 'developer' THEN 'developer' WHEN 'marketer' THEN 'marketer' END;
  v_name := nullif(btrim(NEW.data->>'name'), '');

  SELECT * INTO v_org FROM public.mkt_organizations WHERE developer_record_id = NEW.id;
  IF NOT FOUND THEN
    IF v_name IS NULL THEN RETURN NEW; END IF;
    INSERT INTO public.mkt_organizations (name_ar, org_type, website, developer_record_id, status, metadata)
    VALUES (v_name, coalesce(v_type, 'developer'), nullif(btrim(NEW.data->>'website'), ''), NEW.id, 'active',
            jsonb_build_object('source', 'companies_list', 'company_record_id', NEW.id));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_name IS NULL OR NOT (OLD.data->>'name' IS DISTINCT FROM NEW.data->>'name') THEN
      v_name := v_org.name_ar;
    END IF;
    v_type := coalesce(v_type, v_org.org_type);
    IF v_name IS DISTINCT FROM v_org.name_ar OR v_type IS DISTINCT FROM v_org.org_type THEN
      UPDATE public.mkt_organizations SET name_ar = v_name, org_type = v_type WHERE id = v_org.id;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_tg_company_to_org() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER records_company_to_org
  AFTER INSERT OR UPDATE OF data ON public.records
  FOR EACH ROW WHEN (NEW.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2')
  EXECUTE FUNCTION public.mkt_tg_company_to_org();
CREATE OR REPLACE TRIGGER records_company_to_org_delete
  AFTER DELETE ON public.records
  FOR EACH ROW WHEN (OLD.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2')
  EXECUTE FUNCTION public.mkt_tg_company_to_org();

-- 3. a company added between _01 and this migration gets its entry too
INSERT INTO public.mkt_organizations (name_ar, org_type, website, developer_record_id, status, metadata)
SELECT btrim(r.data->>'name'), coalesce(nullif(r.data->>'company_type', ''), 'developer'),
       nullif(btrim(r.data->>'website'), ''), r.id, 'active',
       jsonb_build_object('source', 'companies_list', 'company_record_id', r.id)
  FROM public.records r
 WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND coalesce(btrim(r.data->>'name'), '') <> ''
   AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.developer_record_id = r.id);

DO $assert$
DECLARE v int;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'mkt_organizations' AND column_name = 'marketer_record_id') THEN
    RAISE EXCEPTION 'MARKETER_RECORD_ID_STILL_PRESENT';
  END IF;
  SELECT count(*) INTO v FROM pg_trigger
   WHERE tgrelid = 'public.records'::regclass AND tgname IN ('records_company_to_org', 'records_company_to_org_delete');
  IF v <> 2 THEN RAISE EXCEPTION 'COMPANY_TRIGGERS_MISSING: % of 2', v; END IF;
  SELECT count(*) INTO v FROM public.records r
   WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND coalesce(btrim(r.data->>'name'), '') <> ''
     AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.developer_record_id = r.id);
  IF v > 0 THEN RAISE EXCEPTION 'COMPANY_WITHOUT_WATCH_ENTRY: %', v; END IF;
END $assert$;

COMMIT;
