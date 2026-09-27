-- ============================================================================
-- Competitor relationships follow the project records (2026-09-27)
-- ----------------------------------------------------------------------------
-- mkt_project_organizations says which competitor company develops / markets
-- which project. The attribution matcher, ten SQL functions and the marketing
-- API all read it. Developer links were already kept in step with the project
-- record by mkt_sync_developer_relationships (records trigger + org trigger).
-- MARKETER links never were: a one-off import on 2026-07-22 copied them once
-- and nothing touched them again. Measured before this migration:
--
--   * 16 projects whose record says ريفا is the marketer had no ريفا link —
--     11 of them are in our_projects (أكنان 23/25, أوشن ريزيدنس1, زنك 8,
--     يمام 15/16/17, يمام بارك 10/11/14, يمام فلورز 12). So ريفا's posts about
--     them needed the full project name spelled out to be recognised.
--   * 38 links where the import wrote the project's DEVELOPER in as its
--     "authorized marketer" (e.g. يمام للأستثمار as marketer of يمام 9).
--   * 15 developer links to projects that no longer exist.
--   All 39 import marketer rows carry human_confirmed=true with NO confirmer:
--   the import set that flag itself. It is not treated as a human decision.
--
-- The project record is the source of truth for what it records:
--   developer           ← all_projects.data.developer via mkt_organizations.developer_record_id
--   authorized_marketer ← all_projects.data.marketer  via mkt_organizations.marketer_record_id (NEW)
-- The table keeps what a single-value field cannot say — extra marketers seen
-- in posts (observed_marketer), former marketers, confidence, evidence.
--
-- Rules the sync applies. "CRM copy" = a developer/authorized_marketer row
-- whose evidence.source is one of: developer_field_sync, all_projects.developer,
-- our_projects_portfolio, crm_marketer_field — and that no person confirmed
-- (confirmed_by IS NULL).
--   1. add / re-activate every link the project record implies
--   2. a CRM-copy authorized_marketer the record no longer names, whose company
--      is not the project's developer → re-labelled former_marketer (the claim is
--      kept: a marketer that loses a mandate is still a real former marketer)
--   3. any other CRM copy the record no longer supports → is_active = false,
--      with the reason written into evidence
--   4. a former_marketer produced by rule 2 is retired again if the record
--      names that marketer once more
--   Never touched: observed / internal / human-confirmed rows.
--
-- Backfilled marketer links carry first_observed_at = the project record's
-- created_at, not now(): mkt_generate_trend_insights reads first_observed_at to
-- announce "new marketer on a project", and stamping today would announce that
-- ريفا took over 16 projects it has marketed for months.
-- ============================================================================
BEGIN;

-- ── 1. link a competitor company to its entry in the CRM marketers list ─────
ALTER TABLE public.mkt_organizations
  ADD COLUMN IF NOT EXISTS marketer_record_id uuid;
COMMENT ON COLUMN public.mkt_organizations.marketer_record_id IS
  'records.id in the CRM marketers model. all_projects.data.marketer points here; mkt_sync_developer_relationships turns it into authorized_marketer links.';
CREATE INDEX IF NOT EXISTS mkt_organizations_marketer_record_idx
  ON public.mkt_organizations (marketer_record_id) WHERE marketer_record_id IS NOT NULL;

-- Name key for matching a CRM marketer to a competitor company: folds alef /
-- taa marbuta / alef maqsura, drops diacritics and the generic words that the
-- two lists spell differently («ريفا» vs «ريفا العقارية»).
CREATE OR REPLACE FUNCTION public.mkt_org_name_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(
             translate(regexp_replace(coalesce(p, ''), '[\u064B-\u0652\u0640]', '', 'g'),  -- harakat U+064B..U+0652 + tatweel U+0640
                       'أإآةى', 'اااهي'),
             '(للتسويق العقاري|التسويق العقاري|للتسويق|العقاريه|العقاري|شركه|مؤسسه)', '', 'g'),
           '[[:space:]_.،,|-]+', '', 'g');
$$;

-- Links CRM marketers to competitor companies ONLY when exactly one
-- marketer/agency company matches the name. Ambiguous or unmatched marketers are
-- left unlinked (reported by the assertion block below), never guessed.
CREATE OR REPLACE FUNCTION public.mkt_link_marketer_records(p_marketer_record uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n int;
BEGIN
  WITH mk AS (
    SELECT r.id, public.mkt_org_name_key(r.data->>'name') AS k
      FROM public.records r
     WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'marketers')
       AND (p_marketer_record IS NULL OR r.id = p_marketer_record)
       AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.marketer_record_id = r.id)
  ), cand AS (
    SELECT mk.id AS marketer_record_id, o.id AS org_id,
           count(*) OVER (PARTITION BY mk.id) AS n_orgs
      FROM mk
      JOIN public.mkt_organizations o
        ON o.marketer_record_id IS NULL
       AND o.org_type IN ('marketer', 'agency')
       AND public.mkt_org_name_key(o.name_ar) = mk.k
     WHERE mk.k <> ''
  )
  UPDATE public.mkt_organizations o
     SET marketer_record_id = c.marketer_record_id
    FROM cand c
   WHERE c.org_id = o.id AND c.n_orgs = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_link_marketer_records(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_link_marketer_records(uuid) TO service_role;

-- Set the links now. The existing org trigger only watches developer_record_id,
-- so this does not fire a sync yet — the dated backfill below has to land first.
SELECT public.mkt_link_marketer_records(NULL);

-- ── 2. dated backfill of the missing marketer links ────────────────────────
INSERT INTO public.mkt_project_organizations
  (project_id, organization_id, relationship_type, confidence, evidence,
   human_confirmed, is_active, first_observed_at, last_observed_at)
SELECT r.id, o.id, 'authorized_marketer', 1,
       jsonb_build_object('source', 'crm_marketer_field', 'synced_at', now(),
                          'backfill', '2026-09-27',
                          'first_observed_is', 'project record created_at'),
       false, true, r.created_at, now()
  FROM public.records r
  JOIN public.mkt_organizations o
    ON o.marketer_record_id IS NOT NULL
   AND o.marketer_record_id::text = r.data->>'marketer'
 WHERE r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
ON CONFLICT (project_id, organization_id, relationship_type) DO NOTHING;

-- ── 3. the sync: developer + marketer, and it now corrects stale copies ─────
-- Same name and signature as before: records_sync_developer_relationship and
-- mkt_organizations_sync_developer_relationships call it with (project, org).
CREATE OR REPLACE FUNCTION public.mkt_sync_developer_relationships(p_project uuid DEFAULT NULL::uuid, p_org uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int := 0;
  k int;
  c_all_projects constant uuid := '220c49b9-de57-492d-9eca-c0d9f54fd40f';
  v_mk text;
BEGIN
  -- 0. a project naming a CRM marketer that no competitor company is linked to
  --    yet: try to link it (unambiguous name match only). Guarded cast — a
  --    malformed value must never break a project save.
  IF p_project IS NOT NULL THEN
    SELECT data->>'marketer' INTO v_mk
      FROM public.records WHERE id = p_project AND model_id = c_all_projects;
    IF v_mk ~ '^[0-9a-fA-F-]{36}$'
       AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations WHERE marketer_record_id::text = v_mk) THEN
      PERFORM public.mkt_link_marketer_records(v_mk::uuid);
    END IF;
  END IF;

  -- 1. developer links (behaviour unchanged)
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

  -- 2. marketer links (NEW)
  INSERT INTO public.mkt_project_organizations
    (project_id, organization_id, relationship_type, confidence, evidence, human_confirmed, is_active)
  SELECT r.id, o.id, 'authorized_marketer', 1,
         jsonb_build_object('source', 'crm_marketer_field', 'synced_at', now()), false, true
    FROM public.records r
    JOIN public.mkt_organizations o
      ON o.marketer_record_id IS NOT NULL
     AND o.marketer_record_id::text = r.data->>'marketer'
   WHERE r.model_id = c_all_projects
     AND (p_project IS NULL OR r.id = p_project)
     AND (p_org IS NULL OR o.id = p_org)
  ON CONFLICT (project_id, organization_id, relationship_type) DO UPDATE
     SET is_active = true, last_observed_at = now(), updated_at = now();
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- 3. rule 4: the record names this marketer again → retire its demoted copy
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

  -- 4. rules 2 + 3: CRM copies the record no longer supports
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
         r.id IS NOT NULL AND (
              (po.relationship_type = 'developer'
               AND o.developer_record_id IS NOT NULL
               AND o.developer_record_id::text = r.data->>'developer')
           OR (po.relationship_type = 'authorized_marketer'
               AND o.marketer_record_id IS NOT NULL
               AND o.marketer_record_id::text = r.data->>'marketer')))
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
               THEN 'written as marketer by the 2026-07-22 import, but it is the project''s developer; the record names no such marketer'
             ELSE 'the project record no longer names this organization' END)
    FROM stale s
   WHERE po.id = s.id
     AND po.id NOT IN (SELECT id FROM demoted);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) TO service_role;

-- ── 4. company-side trigger: also react to the marketer link ────────────────
-- Runs unconditionally now (it used to skip companies without a developer
-- link, so a marketer-only company like ريفا could never trigger a sync).
CREATE OR REPLACE FUNCTION public.mkt_tg_org_sync_developer_relationships()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.org_type IN ('marketer', 'agency') AND NEW.marketer_record_id IS NULL THEN
    PERFORM public.mkt_link_marketer_records(NULL);
  END IF;
  PERFORM public.mkt_sync_developer_relationships(NULL, NEW.id);
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS mkt_organizations_sync_developer_relationships ON public.mkt_organizations;
CREATE TRIGGER mkt_organizations_sync_developer_relationships
  AFTER INSERT OR UPDATE OF developer_record_id, marketer_record_id, org_type, name_ar
  ON public.mkt_organizations
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_org_sync_developer_relationships();

-- ── 5. full pass: demote / deactivate the stale copies ─────────────────────
SELECT public.mkt_sync_developer_relationships(NULL, NULL);

-- ── 6. org-level attribution ignored is_active; re-emitted verbatim with ONLY
--      `AND l.is_active` added, so a retired link stops attributing posts ───────
CREATE OR REPLACE FUNCTION public.mkt_content_org_attribute(p_post uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.mkt_content_posts WHERE id = p_post;
  IF v_org IS NULL THEN RETURN; END IF;
  PERFORM public.mkt_attribution_upsert(
            p_post, l.project_id,
            CASE WHEN l.relationship_type = 'developer' THEN 'developer_account' ELSE 'marketer_assignment' END,
            0.40,
            jsonb_build_object('source','org_level','relationship', l.relationship_type),
            '{}'::text[], false)
  FROM public.mkt_project_organizations l
  WHERE l.organization_id = v_org
    AND l.is_active
    AND l.relationship_type IN ('developer','authorized_marketer')
    AND l.project_id IN (
      SELECT (data->>'project')::uuid FROM public.unified_records
      WHERE model_id='6609286a-f95a-45db-94e6-48cfa915ccbd' AND data->>'project' ~ '^[0-9a-fA-F-]{36}$'
    );
END $function$;

-- ── 7. assertions (guarded: an empty database has nothing to violate) ──────
DO $assert$
DECLARE v_missing int; v_stale int;
BEGIN
  -- every project whose record names a LINKED marketer has that link, active
  SELECT count(*) INTO v_missing
    FROM public.records r
    JOIN public.mkt_organizations o ON o.marketer_record_id::text = r.data->>'marketer'
   WHERE r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
     AND NOT EXISTS (SELECT 1 FROM public.mkt_project_organizations po
                      WHERE po.project_id = r.id AND po.organization_id = o.id
                        AND po.relationship_type = 'authorized_marketer' AND po.is_active);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'RELATIONSHIP_SYNC_INCOMPLETE: % project(s) name a linked marketer with no active link', v_missing;
  END IF;

  -- no active CRM-copy marketer link contradicts its project record
  SELECT count(*) INTO v_stale
    FROM public.mkt_project_organizations po
    JOIN public.mkt_organizations o ON o.id = po.organization_id
    JOIN public.records r ON r.id = po.project_id
   WHERE po.is_active AND po.relationship_type = 'authorized_marketer' AND po.confirmed_by IS NULL
     AND coalesce(po.evidence->>'source','') IN ('our_projects_portfolio','crm_marketer_field')
     AND (o.marketer_record_id IS NULL OR o.marketer_record_id::text IS DISTINCT FROM r.data->>'marketer');
  IF v_stale > 0 THEN
    RAISE EXCEPTION 'RELATIONSHIP_SYNC_STALE: % active marketer link(s) contradict their project record', v_stale;
  END IF;
END $assert$;

COMMIT;
