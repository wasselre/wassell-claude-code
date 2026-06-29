-- Sales Valuation — add an optional "include auto-flagged follow-ups" choice to
-- the retroactive backfill (follow-up to 2026-06-29_sales_valuation_retroactive_backfill.sql).
--
-- By default backfill applies ONLY the manager-configured criteria. This adds a
-- p_include_flags switch so the manager can also pull in follow-ups caught by
-- the always-on system flags (weak notes / late / mismatch / unregistered visit
-- / missing-next-step-as-flag). The random sample is STILL never retroactive
-- (non-deterministic, not a chosen criterion).
--
-- Signature change: svr_eval_review_for_followup gains a 4th defaulted param and
-- svr_backfill_reviews gains a 2nd. Drop the old arities first (a defaulted
-- overload would make the trigger's 3-arg call ambiguous).

BEGIN;

DROP FUNCTION IF EXISTS public.svr_backfill_reviews(boolean);
DROP FUNCTION IF EXISTS public.svr_eval_review_for_followup(public.records, boolean, boolean);

CREATE OR REPLACE FUNCTION public.svr_eval_review_for_followup(
  fu public.records,
  p_backfill      boolean DEFAULT false,
  p_dry_run       boolean DEFAULT false,
  p_include_flags boolean DEFAULT false
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  s jsonb; cr text; ftype text; notes text; client_id text; rep text; cname text;
  sched timestamptz; actual timestamptz; visit_id text;
  flags text[] := ARRAY[]::text[];
  f_weak boolean; f_mismatch boolean; f_unregvisit boolean; f_late boolean; f_missing boolean;
  is_mandatory boolean; is_flagged boolean; is_sample boolean; should_create boolean;
  src text; prio text; v_created timestamptz; new_id uuid;
BEGIN
  SELECT data INTO s FROM public.records WHERE model_id = '5a1e7a10-0000-4000-8000-000000000005' LIMIT 1;
  IF s IS NULL OR coalesce((s->>'is_enabled')::boolean, false) = false THEN RETURN NULL; END IF;

  IF EXISTS (SELECT 1 FROM public.records
              WHERE model_id = '5a1e7a10-0000-4000-8000-000000000001'
                AND data->>'follow_up' = fu.id::text) THEN
    RETURN NULL;
  END IF;

  cr := fu.data->>'call_result';
  ftype := fu.data->'followup_type'->>0;
  notes := fu.data->>'outcome_notes';
  client_id := nullif(fu.data->>'client_id','');
  rep := nullif(fu.data->>'sales_rep','');
  sched := nullif(fu.data->>'scheduled_datetime','')::timestamptz;
  actual := nullif(fu.data->>'actual_datetime','')::timestamptz;
  visit_id := nullif(fu.data->>'visit','');
  IF client_id IS NOT NULL THEN
    SELECT data->>'client_name' INTO cname FROM public.records WHERE id = client_id::uuid;
  END IF;

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

  IF f_missing    THEN flags := array_append(flags, 'missing_next_step'); END IF;
  IF f_weak       THEN flags := array_append(flags, 'weak_notes'); END IF;
  IF f_mismatch   THEN flags := array_append(flags, 'result_mismatch'); END IF;
  IF f_unregvisit THEN flags := array_append(flags, 'unregistered_visit'); END IF;
  IF f_late       THEN flags := array_append(flags, 'late_followup'); END IF;

  is_mandatory :=
       coalesce((s->>'review_all_followups')::boolean,false)
    OR (coalesce((s->>'review_not_interested')::boolean,false) AND cr = 'not_interested')
    OR (coalesce((s->>'review_lost_clients')::boolean,false) AND (cr IN ('not_interested','offer_rejected','appointment_cancelled_lost') OR nullif(fu.data->>'lost_reason','') IS NOT NULL))
    OR (coalesce((s->>'review_offer_requests')::boolean,false) AND cr = 'request_offer')
    OR (coalesce((s->>'review_visits')::boolean,false) AND ftype = 'follow_up_call_after_visit')
    OR (coalesce((s->>'review_missing_next_step')::boolean,false) AND f_missing)
    OR (cr IS NOT NULL AND jsonb_typeof(s->'review_call_results') = 'array' AND (s->'review_call_results') ? cr);
  is_flagged := coalesce(array_length(flags,1),0) > 0;
  is_sample  := (NOT p_backfill) AND (random()*100) < coalesce((s->>'normal_sample_percentage')::numeric, 0);

  -- Going-forward: criteria OR flags OR sample.
  -- Backfill: configured criteria, plus flags ONLY when the manager opts in.
  IF p_backfill THEN
    should_create := is_mandatory OR (p_include_flags AND is_flagged);
  ELSE
    should_create := is_mandatory OR is_flagged OR is_sample;
  END IF;
  IF NOT should_create THEN RETURN NULL; END IF;

  IF p_dry_run THEN RETURN fu.id; END IF;

  src := CASE WHEN is_mandatory THEN 'mandatory' WHEN is_flagged THEN 'flagged' WHEN is_sample THEN 'sampled' ELSE 'manual' END;
  prio := CASE WHEN cr IN ('not_interested','offer_rejected','appointment_cancelled_lost') OR f_mismatch OR f_unregvisit THEN 'high' ELSE 'normal' END;
  v_created := CASE WHEN p_backfill THEN coalesce(actual, sched, fu.created_at) ELSE now() END;

  INSERT INTO public.records (id, model_id, data, created_by_user_id, created_at)
  VALUES (gen_random_uuid(), '5a1e7a10-0000-4000-8000-000000000001',
    jsonb_build_object(
      'follow_up', fu.id::text, 'client', client_id, 'client_name_snapshot', cname,
      'sales_rep', rep, 'followup_type', ftype, 'follow_up_result', cr,
      'review_status', 'pending_review', 'review_priority', prio, 'review_source', src,
      'review_flags', to_jsonb(flags), 'requires_correction', false, 'dispute_status', 'none'
    ), NULL, v_created)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION public.svr_backfill_reviews(
  p_dry_run       boolean DEFAULT false,
  p_include_flags boolean DEFAULT false
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE r public.records; n int := 0;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.wassell_user_has_action(auth.uid(), '5a1e7a10-0000-4000-8000-000000000001'::uuid, 'create') THEN
    RAISE EXCEPTION 'not authorized to backfill sales valuation reviews';
  END IF;

  FOR r IN
    SELECT * FROM public.records
     WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
       AND data->>'followup_status' = 'completed'
  LOOP
    IF public.svr_eval_review_for_followup(r, true, p_dry_run, p_include_flags) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.svr_eval_review_for_followup(public.records, boolean, boolean, boolean) FROM public;
REVOKE ALL ON FUNCTION public.svr_backfill_reviews(boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.svr_backfill_reviews(boolean, boolean) TO authenticated;

COMMIT;
