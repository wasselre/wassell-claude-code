-- ============================================================================
-- Two bugs found by running the acceptance suite against production on
-- 2026-07-28, immediately after applying the v2 schema. Both are also fixed at
-- source in the 2026-08-22 files, so a FRESH replay is correct from the start;
-- this file exists so a database that already ran the originals gets corrected
-- too. Applying both is harmless — each is CREATE OR REPLACE.
--
-- Recorded in production as:
--   mkt_v2_fix_plan_rank_strictly_shorter
--   mkt_v2_fix_missing_context_array_append
-- ============================================================================

-- ── 1. Plan nesting allowed equal ranks ─────────────────────────────────────
-- The rule is "a parent must cover a LONGER period", but the check was
-- rank(child) > rank(parent). rank(annual)=4 is not > 4, so an annual plan
-- nested happily under another annual plan, and custom under custom.
--
-- >= restores the documented rule: a child must be STRICTLY shorter. project
-- and custom share rank 1, so custom-under-custom is blocked too — deliberately
-- conservative; loosening that later should be a decision, not an accident.
CREATE OR REPLACE FUNCTION public.mkt_tg_plan_hierarchy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p record; hops int := 0; cur uuid;
BEGIN
  IF NEW.parent_plan_id IS NOT NULL THEN
    SELECT plan_type, period_start, period_end INTO p
      FROM public.mkt_plans WHERE id = NEW.parent_plan_id;
    IF p IS NULL THEN
      RAISE EXCEPTION 'parent plan does not exist' USING ERRCODE='foreign_key_violation';
    END IF;
    IF public.mkt_plan_rank(NEW.plan_type) >= public.mkt_plan_rank(p.plan_type) THEN
      RAISE EXCEPTION
        'a % plan cannot sit under a % plan — a parent must cover a longer period',
        NEW.plan_type, p.plan_type
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.period_start < p.period_start OR NEW.period_end > p.period_end THEN
      RAISE EXCEPTION 'child plan period (% .. %) must fall inside its parent (% .. %)',
        NEW.period_start, NEW.period_end, p.period_start, p.period_end
        USING ERRCODE='check_violation';
    END IF;
    cur := NEW.parent_plan_id;
    WHILE cur IS NOT NULL AND hops < 20 LOOP
      IF cur = NEW.id THEN
        RAISE EXCEPTION 'plan hierarchy would form a cycle' USING ERRCODE='check_violation';
      END IF;
      SELECT parent_plan_id INTO cur FROM public.mkt_plans WHERE id = cur;
      hops := hops + 1;
    END LOOP;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ── 2. The approval gate raised gibberish whenever it fired ─────────────────
-- `missing := missing || 'literal'` is ambiguous: Postgres prefers
-- anyarray || anyarray and tried to parse the string as an array literal, so
-- the function raised 22P02 "malformed array literal" the moment ANY context
-- was missing — i.e. every single time it was actually needed. A user blocked
-- from approving would have seen a parser error instead of the list of what to
-- fill in. It never surfaced earlier because the function only appends when
-- something IS missing, and every prior call had complete context.
--
-- array_append is unambiguous.
CREATE OR REPLACE FUNCTION public.mkt_content_missing_context(p_content_item_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE c record; missing text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO c FROM public.mkt_content_items WHERE id = p_content_item_id;
  IF c IS NULL THEN RETURN ARRAY['content item not found']; END IF;

  IF c.strategic_purpose IS NULL OR btrim(c.strategic_purpose) = '' THEN
    missing := array_append(missing, 'strategic_purpose'); END IF;
  IF c.plan_id IS NULL           THEN missing := array_append(missing, 'plan'); END IF;
  IF c.primary_goal_id IS NULL   THEN missing := array_append(missing, 'primary_goal'); END IF;
  IF c.origin_kind IS NULL       THEN missing := array_append(missing, 'origin'); END IF;
  IF c.primary_pillar_id IS NULL THEN missing := array_append(missing, 'primary_pillar'); END IF;
  IF c.target_audience IS NULL OR btrim(c.target_audience) = '' THEN
    missing := array_append(missing, 'audience'); END IF;
  IF c.cta_destination IS NULL AND (c.cta IS NULL OR btrim(c.cta) = '') THEN
    missing := array_append(missing, 'intended_result_or_cta'); END IF;

  RETURN missing;
END $$;

REVOKE ALL ON FUNCTION public.mkt_content_missing_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_missing_context(uuid) TO authenticated, service_role;
