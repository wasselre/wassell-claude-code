-- ============================================================================
-- The designer could not upload a single design. 2026-09-17.
--
-- mos_tg_asset_link_locked_guard refused every final / final_square /
-- final_vertical link on a post that had ANY approval (mos_content_is_locked).
-- The writing-review approval is an approval, so the moment writing was
-- approved and design opened, the design slots were already locked:
-- «دورك في التسويق لا يسمح بهذا الإجراء» on every «ارفع الملف».
-- Reproduced live as سارة (montage) on P-271, whose batch has an open design
-- task: MOS:LOCKED design slot final_square.
--
-- The writing lock after writing review (mos_tg_content_locked_guard) is
-- intended and unchanged. The design slots now stay writable while a design
-- task is open on the post or on its social media batch; once design is handed
-- in and approved they lock exactly as before (verified in the same rolled-back
-- test: design open → upload OK; design closed → MOS:LOCKED).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_tg_asset_link_locked_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_content uuid; v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_content := COALESCE(NEW.content_id, OLD.content_id);
  v_role    := COALESCE(NEW.role, OLD.role);
  IF v_role NOT IN ('final','final_square','final_vertical') THEN RETURN COALESCE(NEW, OLD); END IF;
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
    RAISE EXCEPTION 'MOS:LOCKED design slot % — open a revision (content_revise) first', v_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $function$;

COMMIT;
