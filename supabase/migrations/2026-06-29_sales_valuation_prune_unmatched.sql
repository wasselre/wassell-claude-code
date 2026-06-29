-- Sales Valuation — prune reviews whose follow-up no longer matches the criteria.
--
-- Companion to the backfill: when the manager narrows the criteria (e.g. "only
-- interested"), existing auto-generated reviews for follow-ups that no longer
-- qualify should be removable. This adds:
--   * svr_followup_matches_criteria(fu, p_include_flags) — the SINGLE definition
--     of "does this follow-up match the current criteria", shared by the create
--     path and the prune so they can never disagree (create-then-delete loops).
--   * svr_prune_unmatched_reviews(p_dry_run, p_include_flags) — deletes (or, in
--     dry-run, counts) ONLY reviews that are BOTH non-matching AND untouched
--     (still pending, no manager outcome / note / correction / dispute / close).
--     Already-evaluated reviews are ALWAYS kept (no manager work is ever lost).
--
-- Safety:
--   * Deleted rows are copied to public._backup_sv_pruned_reviews first.
--   * Gated to users with DELETE permission on the reviews model.
--   * No-op when the operation is disabled (never mass-delete while paused).
--
-- The mandatory/flags expressions here MUST stay identical to those in
-- svr_eval_review_for_followup (2026-06-29_sales_valuation_backfill_flags_option.sql).
-- They are two readers of the same recipe; verified equal at deploy
-- (criteria-only 184 / +flags 300 over unreviewed completed follow-ups).

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_sv_pruned_reviews (
  id uuid, model_id uuid, data jsonb, created_by_user_id uuid, created_at timestamptz,
  pruned_at timestamptz DEFAULT now(), pruned_by uuid
);

-- Pure criteria-match predicate (no is_enabled gate, no dedup, no random sample).
CREATE OR REPLACE FUNCTION public.svr_followup_matches_criteria(
  fu public.records,
  p_include_flags boolean DEFAULT false
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  s jsonb; cr text; ftype text; notes text; client_id text;
  sched timestamptz; actual timestamptz; visit_id text;
  f_weak boolean; f_mismatch boolean; f_unregvisit boolean; f_late boolean; f_missing boolean;
  is_mandatory boolean; is_flagged boolean;
BEGIN
  IF fu.id IS NULL THEN RETURN false; END IF;
  SELECT data INTO s FROM public.records WHERE model_id = '5a1e7a10-0000-4000-8000-000000000005' LIMIT 1;
  IF s IS NULL THEN RETURN false; END IF;

  cr := fu.data->>'call_result';
  ftype := fu.data->'followup_type'->>0;
  notes := fu.data->>'outcome_notes';
  client_id := nullif(fu.data->>'client_id','');
  sched := nullif(fu.data->>'scheduled_datetime','')::timestamptz;
  actual := nullif(fu.data->>'actual_datetime','')::timestamptz;
  visit_id := nullif(fu.data->>'visit','');

  f_weak := notes IS NULL OR length(btrim(notes)) < 15;
  f_mismatch := notes IS NOT NULL
    AND notes ~* '(مهتم|يرغب|يريد|طلب|عرض|معلومات|اتصل|زيار|موعد|متابعة)'
    AND cr IN ('not_interested','unanswered_request','invalid_number','no_answer');
  f_unregvisit := ftype = 'follow_up_call_after_visit' AND visit_id IS NULL AND client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.records
                     WHERE model_id = '372ed642-3753-40b4-9dd7-e8390f91b1f8' AND data->>'client_id' = client_id);
  f_late := sched IS NOT NULL AND actual IS NOT NULL AND actual > sched + interval '1 day';
  f_missing := cr IN ('recontact_later','still_interested','needs_financing_info','family_discussion','waiting_decision','requested_another_visit','wrong_time')
    AND client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.records
                     WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63' AND id <> fu.id
                       AND data->>'client_id' = client_id
                       AND data->>'followup_status' IN ('open','scheduled','in_progress')
                       AND coalesce(nullif(data->>'scheduled_datetime','')::timestamptz, now()) > now());

  is_mandatory :=
       coalesce((s->>'review_all_followups')::boolean,false)
    OR (coalesce((s->>'review_not_interested')::boolean,false) AND cr = 'not_interested')
    OR (coalesce((s->>'review_lost_clients')::boolean,false) AND (cr IN ('not_interested','offer_rejected','appointment_cancelled_lost') OR nullif(fu.data->>'lost_reason','') IS NOT NULL))
    OR (coalesce((s->>'review_offer_requests')::boolean,false) AND cr = 'request_offer')
    OR (coalesce((s->>'review_visits')::boolean,false) AND ftype = 'follow_up_call_after_visit')
    OR (coalesce((s->>'review_missing_next_step')::boolean,false) AND f_missing)
    OR (cr IS NOT NULL AND jsonb_typeof(s->'review_call_results') = 'array' AND (s->'review_call_results') ? cr);
  is_flagged := f_weak OR f_mismatch OR f_unregvisit OR f_late OR f_missing;

  RETURN is_mandatory OR (p_include_flags AND is_flagged);
END $$;

-- Prune untouched, non-matching reviews. p_dry_run=true counts without deleting.
CREATE OR REPLACE FUNCTION public.svr_prune_unmatched_reviews(
  p_dry_run       boolean DEFAULT false,
  p_include_flags boolean DEFAULT false
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE rev record; furow public.records; untouched boolean; matches boolean; n int := 0; uid uuid;
BEGIN
  uid := auth.uid();
  IF uid IS NOT NULL
     AND NOT public.wassell_user_has_action(uid, '5a1e7a10-0000-4000-8000-000000000001'::uuid, 'delete') THEN
    RAISE EXCEPTION 'not authorized to prune sales valuation reviews';
  END IF;

  -- Never mass-delete while the operation is paused.
  IF NOT EXISTS (SELECT 1 FROM public.records
                  WHERE model_id='5a1e7a10-0000-4000-8000-000000000005'
                    AND coalesce((data->>'is_enabled')::boolean,false) = true) THEN
    RAISE EXCEPTION 'operation is disabled; enable it before pruning';
  END IF;

  FOR rev IN
    SELECT id, data FROM public.records WHERE model_id = '5a1e7a10-0000-4000-8000-000000000001'
  LOOP
    untouched :=
          nullif(rev.data->>'review_outcome','') IS NULL
      AND nullif(rev.data->>'coaching_note','') IS NULL
      AND coalesce(rev.data->>'review_status','pending_review') = 'pending_review'
      AND coalesce((rev.data->>'requires_correction')::boolean,false) = false
      AND coalesce(nullif(rev.data->>'dispute_status',''),'none') = 'none';
    IF NOT untouched THEN CONTINUE; END IF;

    furow := NULL;
    SELECT * INTO furow FROM public.records
      WHERE id = nullif(rev.data->>'follow_up','')::uuid
        AND model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';

    matches := (furow.id IS NOT NULL) AND public.svr_followup_matches_criteria(furow, p_include_flags);
    IF matches THEN CONTINUE; END IF;

    n := n + 1;
    IF NOT p_dry_run THEN
      INSERT INTO public._backup_sv_pruned_reviews (id, model_id, data, created_by_user_id, created_at, pruned_by)
      SELECT id, model_id, data, created_by_user_id, created_at, uid FROM public.records WHERE id = rev.id;
      -- Untouched reviews never have a correction task, but clean up defensively.
      DELETE FROM public.records
        WHERE model_id = '5a1e7a10-0000-4000-8000-000000000003' AND data->>'valuation_review' = rev.id::text;
      DELETE FROM public.records WHERE id = rev.id;
    END IF;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.svr_followup_matches_criteria(public.records, boolean) FROM public;
REVOKE ALL ON FUNCTION public.svr_prune_unmatched_reviews(boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.svr_prune_unmatched_reviews(boolean, boolean) TO authenticated;

COMMIT;
