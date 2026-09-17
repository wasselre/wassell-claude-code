-- ============================================================================
-- A final approval stopped halfway, so the Meta ad was never queued. 2026-09-17.
--
-- P-306 (paid): the final approval committed, then task_complete called
-- mos_promote_approval_asset, which INSERTs a 'final' link … ON CONFLICT DO
-- UPDATE. A BEFORE INSERT trigger fires before conflict detection, so the
-- design-slot lock saw a NEW 'final' link on an approved post and raised
-- MOS:LOCKED (logged 12:31:33 UTC). task_complete returned that error BEFORE
-- its auto-Meta-ad block, so no ad row and no job were ever created — the item
-- showed approved with no ad.
--
-- 1. mos_promote_approval_asset does nothing when the approved asset already
--    sits in a final slot (final / final_square / final_vertical) — the normal
--    case since designs are uploaded straight into the two slots.
-- 2. The lock lets a no-op UPDATE through, and now judges a change by BOTH the
--    old and the new role: moving an approved final_square to 'source' used to
--    escape the lock because only the new role was checked (proved in the same
--    rolled-back test: before → not blocked; after → locked).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_promote_approval_asset(p_content_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_asset uuid;
BEGIN
  SELECT approval_asset_id INTO v_asset FROM public.mos_content WHERE id = p_content_id;
  IF v_asset IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.mos_asset_links
     WHERE content_id = p_content_id AND asset_id = v_asset
  ) THEN
    RETURN NULL;
  END IF;
  -- Already approved material in a final slot: nothing to promote.
  IF EXISTS (SELECT 1 FROM public.mos_asset_links
              WHERE content_id = p_content_id AND asset_id = v_asset AND role LIKE 'final%') THEN
    RETURN v_asset;
  END IF;
  INSERT INTO public.mos_asset_links (asset_id, content_id, role)
    VALUES (v_asset, p_content_id, 'final')
    ON CONFLICT (asset_id, content_id) DO UPDATE
      SET role = CASE WHEN mos_asset_links.role LIKE 'final%' THEN mos_asset_links.role ELSE 'final' END;
  RETURN v_asset;
END $function$;

CREATE OR REPLACE FUNCTION public.mos_tg_asset_link_locked_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_content uuid; v_final boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  -- A write that changes nothing is never an edit.
  IF TG_OP = 'UPDATE'
     AND NEW.asset_id IS NOT DISTINCT FROM OLD.asset_id
     AND NEW.content_id IS NOT DISTINCT FROM OLD.content_id
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.superseded_at IS NOT DISTINCT FROM OLD.superseded_at THEN
    RETURN NEW;
  END IF;
  v_content := COALESCE(NEW.content_id, OLD.content_id);
  -- A design slot is touched if the link WAS one or BECOMES one.
  v_final := (TG_OP <> 'INSERT' AND OLD.role IN ('final','final_square','final_vertical'))
          OR (TG_OP <> 'DELETE' AND NEW.role IN ('final','final_square','final_vertical'));
  IF NOT v_final THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Design is the step being worked on: its slots are the designer's to fill.
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks t
              WHERE t.status = 'open' AND t.step_key = 'design'
                AND ((t.subject_table = 'mos_content' AND t.subject_id = v_content)
                  OR (t.subject_table = 'mos_content_rows'
                      AND t.subject_id = (SELECT c.row_id FROM public.mos_content c WHERE c.id = v_content)))) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF public.mos_content_is_locked(v_content) THEN
    RAISE EXCEPTION 'MOS:LOCKED design slot % — open a revision (content_revise) first', COALESCE(OLD.role, NEW.role)
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

COMMIT;
