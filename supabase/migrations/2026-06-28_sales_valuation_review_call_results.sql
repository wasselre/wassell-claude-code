-- ============================================================================
-- Sales Valuation — selectable "call results that require a review"
-- ============================================================================
-- Adds a manager-configurable list of follow-up call results (outcomes) that,
-- when a follow-up completes with one of them, force a valuation review to be
-- created. This generalises the three fixed toggles (not-interested / lost /
-- offer-requests) into an explicit, per-outcome selection.
--
-- Storage: settings record key `review_call_results` = array of call_result
-- values (the same `value` slugs used by the followups model's call_result
-- dropdown). Empty / absent = no extra outcomes selected (zero behaviour change
-- from before this migration — purely additive).
--
-- Touches:
--   1. The Sales Valuation settings model schema (...0005) — adds a `multiselect`
--      field `review_call_results` whose options are SOURCED from the live
--      followups.call_result dropdown (so they never drift). Unfrozen model →
--      the `models_view_sync` trigger refreshes v_sales_valuation_settings.
--   2. svr_create_review_on_followup_complete — adds the selected-results
--      condition to the mandatory-review test.
-- ============================================================================

BEGIN;

-- 1. Settings schema: add the multiselect field (idempotent; options mirror the
--    live followups call_result options).
UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', '5a1e7a10-0f05-4000-8000-000000000001',
        'name', 'review_call_results',
        'label_ar', 'نتائج المكالمات التي تستوجب مراجعة',
        'label_en', 'Call results that require a review',
        'type', 'multiselect',
        'required', false,
        'order', 99,
        'section_id', '5a1e7a10-0f00-4000-8000-000000000001',
        'width', 'full',
        'show_in_table', false,
        'options', (
          SELECT f->'options'
          FROM public.models fm,
               jsonb_array_elements(fm.schema->'sections') s,
               jsonb_array_elements(s->'fields') f
          WHERE fm.name = 'followups' AND f->>'name' = 'call_result'
          LIMIT 1
        )
      )
    )
WHERE id = '5a1e7a10-0000-4000-8000-000000000005'
  AND NOT (schema->'sections'->0->'fields' @> '[{"name":"review_call_results"}]'::jsonb);

-- 2. Re-create the review-creation trigger function with the new condition.
CREATE OR REPLACE FUNCTION public.svr_create_review_on_followup_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  s jsonb; cr text; ftype text; notes text; client_id text; rep text; cname text;
  sched timestamptz; actual timestamptz; visit_id text;
  flags text[] := ARRAY[]::text[];
  f_weak boolean; f_mismatch boolean; f_unregvisit boolean; f_late boolean; f_missing boolean;
  is_mandatory boolean; is_flagged boolean; is_sample boolean; src text; prio text;
BEGIN
  IF NEW.data->>'followup_status' IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.data->>'followup_status' = 'completed' THEN RETURN NEW; END IF;

  SELECT data INTO s FROM public.records WHERE model_id = '5a1e7a10-0000-4000-8000-000000000005' LIMIT 1;
  IF s IS NULL OR coalesce((s->>'is_enabled')::boolean, false) = false THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM public.records
              WHERE model_id = '5a1e7a10-0000-4000-8000-000000000001'
                AND data->>'follow_up' = NEW.id::text) THEN
    RETURN NEW;  -- dedup: one review per follow-up
  END IF;

  cr := NEW.data->>'call_result';
  ftype := NEW.data->'followup_type'->>0;
  notes := NEW.data->>'outcome_notes';
  client_id := nullif(NEW.data->>'client_id','');
  rep := nullif(NEW.data->>'sales_rep','');
  sched := nullif(NEW.data->>'scheduled_datetime','')::timestamptz;
  actual := nullif(NEW.data->>'actual_datetime','')::timestamptz;
  visit_id := nullif(NEW.data->>'visit','');
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
                     WHERE model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63' AND id <> NEW.id
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
    OR (coalesce((s->>'review_lost_clients')::boolean,false) AND (cr IN ('not_interested','offer_rejected','appointment_cancelled_lost') OR nullif(NEW.data->>'lost_reason','') IS NOT NULL))
    OR (coalesce((s->>'review_offer_requests')::boolean,false) AND cr = 'request_offer')
    OR (coalesce((s->>'review_visits')::boolean,false) AND ftype = 'follow_up_call_after_visit')
    OR (coalesce((s->>'review_missing_next_step')::boolean,false) AND f_missing)
    -- NEW: manager-selected call results that always require a review
    OR (cr IS NOT NULL AND jsonb_typeof(s->'review_call_results') = 'array' AND (s->'review_call_results') ? cr);
  is_flagged := coalesce(array_length(flags,1),0) > 0;
  is_sample  := (random()*100) < coalesce((s->>'normal_sample_percentage')::numeric, 0);
  IF NOT (is_mandatory OR is_flagged OR is_sample) THEN RETURN NEW; END IF;

  src := CASE WHEN is_mandatory THEN 'mandatory' WHEN is_flagged THEN 'flagged' WHEN is_sample THEN 'sampled' ELSE 'manual' END;
  prio := CASE WHEN cr IN ('not_interested','offer_rejected','appointment_cancelled_lost') OR f_mismatch OR f_unregvisit THEN 'high' ELSE 'normal' END;

  INSERT INTO public.records (id, model_id, data, created_by_user_id)
  VALUES (gen_random_uuid(), '5a1e7a10-0000-4000-8000-000000000001',
    jsonb_build_object(
      'follow_up', NEW.id::text, 'client', client_id, 'client_name_snapshot', cname,
      'sales_rep', rep, 'followup_type', ftype, 'follow_up_result', cr,
      'review_status', 'pending_review', 'review_priority', prio, 'review_source', src,
      'review_flags', to_jsonb(flags), 'requires_correction', false, 'dispute_status', 'none'
    ), NULL);
  RETURN NEW;
END $$;

COMMIT;
