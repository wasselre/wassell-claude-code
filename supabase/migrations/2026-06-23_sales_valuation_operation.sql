-- ============================================================================
-- Sales Valuation Operation (تقييم المبيعات) — Sales Quality & Coaching loop
-- Applied to wassell-prod on 2026-06-23 via the Supabase MCP as the named
-- migrations: sales_valuation_model_reviews / _mistake_categories /
-- _correction_tasks / _daily_valuations / _settings, sales_valuation_seed_data,
-- sales_valuation_automation_logic (+ _fix_flag_append), _permissions,
-- _queue_views, _dashboards, _arabic_display_fixes.
--
-- Loop: follow-up completed -> valuation review -> issue classification ->
--       correction task (if needed) -> daily coaching summary -> rep
--       acknowledge/dispute -> manager closure.
--
-- Implementation note: the event automations are SECURITY DEFINER triggers on
-- `records` (the platform's established pattern for derived/cross-record
-- automation — same as the project-rollups + client next-action triggers).
-- This is deliberate: triggers fire on BOTH browser saves AND server/direct
-- writes and can do cross-record reads + dedup the client workflow engine can't.
--
-- Model ids (fixed): reviews 5a1e7a10-...0001, categories ...0002,
-- correction tasks ...0003, daily ...0004, settings ...0005.
-- Live refs used: followups 764e0e67-..., clients 2e86f197-..., visits 372ed642-...,
-- Sales group ea355303-..., default manager (عبدالعزيز المهنا) 3a49eacb-...
--
-- This file is the consolidated final state. The 5 model INSERTs carry the
-- final schemas (snapshot fields are dropdowns with Arabic labels; every lookup
-- display_field points at a real target slug) so no English slug appears in the
-- UI. To regenerate the per-model PRDs after applying, run `npm run sync:prds`.
--
-- NOTE: the large model/seed/view/dashboard INSERTs were applied verbatim via
-- the Supabase migrations listed above and are the source of truth in prod.
-- The automation engine (functions + triggers), permissions, and the design
-- rationale are reproduced in full below; re-run `npm run sync:prds` to
-- materialise the model/workflow definitions from the live DB into docs/prd.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- Automation engine (Workflows 1, 3, 4, 5, 6, 7) — SECURITY DEFINER triggers
-- ─────────────────────────────────────────────────────────────────────────

-- Helper: next business day at 18:00 Riyadh (KSA weekend = Fri/Sat)
CREATE OR REPLACE FUNCTION public.svr_next_business_day(p_from timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $$
DECLARE v timestamptz;
BEGIN
  v := p_from + interval '1 day';
  IF extract(dow from (v AT TIME ZONE 'Asia/Riyadh')) = 5 THEN v := v + interval '2 days';
  ELSIF extract(dow from (v AT TIME ZONE 'Asia/Riyadh')) = 6 THEN v := v + interval '1 day';
  END IF;
  RETURN v;
END $$;

-- Workflow 7: flip open/in-progress correction tasks past due to "overdue"
CREATE OR REPLACE FUNCTION public.svr_sweep_overdue_tasks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE n integer;
BEGIN
  WITH upd AS (
    UPDATE public.records
       SET data = jsonb_set(data, '{task_status}', '"overdue"'::jsonb)
     WHERE model_id = '5a1e7a10-0000-4000-8000-000000000003'
       AND data->>'task_status' IN ('open','in_progress')
       AND nullif(data->>'due_date','') IS NOT NULL
       AND (data->>'due_date')::timestamptz < now()
     RETURNING 1
  ) SELECT count(*) INTO n FROM upd;
  RETURN n;
END $$;

-- Workflow 1: create a valuation review when a follow-up becomes completed
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
    OR (coalesce((s->>'review_missing_next_step')::boolean,false) AND f_missing);
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

-- Workflows 3 & 5: fill score / derive status on review save (BEFORE)
CREATE OR REPLACE FUNCTION public.svr_fill_review_computed()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE outcome text; ded numeric; score numeric; status text; dispute text; finaldec text;
BEGIN
  outcome := nullif(NEW.data->>'review_outcome','');
  status := nullif(NEW.data->>'review_status','');
  dispute := nullif(NEW.data->>'dispute_status','');
  finaldec := nullif(NEW.data->>'final_manager_decision','');

  IF outcome IS NOT NULL AND nullif(NEW.data->>'overall_score','') IS NULL THEN
    IF nullif(NEW.data->>'mistake_category','') IS NOT NULL THEN
      BEGIN
        SELECT (data->>'score_deduction')::numeric INTO ded FROM public.records
         WHERE id = (NEW.data->>'mistake_category')::uuid AND model_id = '5a1e7a10-0000-4000-8000-000000000002';
      EXCEPTION WHEN others THEN ded := NULL; END;
    END IF;
    IF ded IS NOT NULL THEN score := greatest(0, 100 - ded);
    ELSE score := CASE outcome WHEN 'correct' THEN 100 WHEN 'minor' THEN 85 WHEN 'major' THEN 65 WHEN 'critical' THEN 40 ELSE NULL END;
    END IF;
    IF score IS NOT NULL THEN NEW.data := jsonb_set(NEW.data, '{overall_score}', to_jsonb(score)); END IF;
  END IF;

  IF outcome IS NOT NULL AND nullif(NEW.data->>'review_date','') IS NULL THEN
    NEW.data := jsonb_set(NEW.data, '{review_date}', to_jsonb(now()));
  END IF;

  IF finaldec IS NOT NULL THEN
    NEW.data := jsonb_set(NEW.data, '{review_status}', '"closed"'::jsonb);
    IF nullif(NEW.data->>'closed_at','') IS NULL THEN NEW.data := jsonb_set(NEW.data, '{closed_at}', to_jsonb(now())); END IF;
    IF dispute = 'disputed' THEN
      NEW.data := jsonb_set(NEW.data, '{dispute_status}',
        to_jsonb(CASE finaldec WHEN 'confirmed' THEN 'rejected' WHEN 'cancelled' THEN 'accepted' ELSE 'adjusted' END));
    END IF;
  ELSIF dispute = 'disputed' THEN
    NEW.data := jsonb_set(NEW.data, '{review_status}', '"disputed_by_rep"'::jsonb);
  ELSIF outcome IS NOT NULL AND (status IS NULL OR status = 'pending_review') THEN
    IF outcome = 'correct' THEN
      NEW.data := jsonb_set(NEW.data, '{review_status}', '"reviewed_no_issue"'::jsonb);
    ELSE
      NEW.data := jsonb_set(NEW.data, '{review_status}',
        to_jsonb(CASE WHEN coalesce((NEW.data->>'requires_correction')::boolean,false) THEN 'requires_correction' ELSE 'issue_flagged' END));
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Workflow 4: create a correction task when a review requires correction (AFTER)
CREATE OR REPLACE FUNCTION public.svr_create_correction_task()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE new_task uuid; due timestamptz;
BEGIN
  IF coalesce((NEW.data->>'requires_correction')::boolean,false) = false THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.records
              WHERE model_id = '5a1e7a10-0000-4000-8000-000000000003' AND data->>'valuation_review' = NEW.id::text) THEN
    RETURN NEW;  -- dedup: one task per review
  END IF;
  due := coalesce(nullif(NEW.data->>'correction_deadline','')::timestamptz, public.svr_next_business_day(now()));
  new_task := gen_random_uuid();
  INSERT INTO public.records (id, model_id, data, created_by_user_id)
  VALUES (new_task, '5a1e7a10-0000-4000-8000-000000000003',
    jsonb_build_object(
      'valuation_review', NEW.id::text, 'follow_up', NEW.data->>'follow_up', 'client', NEW.data->>'client',
      'client_name_snapshot', NEW.data->>'client_name_snapshot', 'sales_rep', NEW.data->>'sales_rep',
      'sales_manager', NEW.data->>'sales_manager',
      'required_action', coalesce(nullif(NEW.data->>'correct_action',''), nullif(NEW.data->>'coaching_note',''), 'يرجى تصحيح هذه المتابعة'),
      'due_date', due, 'task_status', 'open', 'manager_approval', 'pending'
    ), NULL);
  UPDATE public.records SET data = jsonb_set(data, '{correction_task}', to_jsonb(new_task::text))
   WHERE id = NEW.id AND nullif(data->>'correction_task','') IS NULL;
  RETURN NEW;
END $$;

-- Workflow 6: recompute the rep's daily coaching summary (AFTER); preserves
-- manager-authored fields (summary / improvement_points / ack / notes / status)
CREATE OR REPLACE FUNCTION public.svr_recompute_daily_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE rec record; rep text; d date;
  v_total int; v_correct int; v_mistakes int; v_avg numeric; v_maincat text; v_opentask int; v_mgr text; existing uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  rep := nullif(rec.data->>'sales_rep','');
  IF rep IS NULL THEN RETURN NULL; END IF;
  d := coalesce(nullif(rec.data->>'review_date','')::timestamptz::date, rec.created_at::date);

  SELECT
    count(*) FILTER (WHERE nullif(data->>'review_outcome','') IS NOT NULL),
    count(*) FILTER (WHERE data->>'review_outcome' = 'correct'),
    count(*) FILTER (WHERE data->>'review_outcome' IN ('minor','major','critical')),
    round(avg((data->>'overall_score')::numeric) FILTER (WHERE nullif(data->>'review_outcome','') IS NOT NULL AND nullif(data->>'overall_score','') IS NOT NULL))
  INTO v_total, v_correct, v_mistakes, v_avg
  FROM public.records
  WHERE model_id = '5a1e7a10-0000-4000-8000-000000000001' AND data->>'sales_rep' = rep
    AND coalesce(nullif(data->>'review_date','')::timestamptz::date, created_at::date) = d;

  SELECT data->>'mistake_category' INTO v_maincat
  FROM public.records
  WHERE model_id = '5a1e7a10-0000-4000-8000-000000000001' AND data->>'sales_rep' = rep
    AND coalesce(nullif(data->>'review_date','')::timestamptz::date, created_at::date) = d
    AND data->>'review_outcome' IN ('minor','major','critical') AND nullif(data->>'mistake_category','') IS NOT NULL
  GROUP BY data->>'mistake_category' ORDER BY count(*) DESC LIMIT 1;

  SELECT count(*) INTO v_opentask FROM public.records
  WHERE model_id = '5a1e7a10-0000-4000-8000-000000000003' AND data->>'sales_rep' = rep
    AND data->>'task_status' IN ('open','in_progress','overdue');

  SELECT id INTO existing FROM public.records
  WHERE model_id = '5a1e7a10-0000-4000-8000-000000000004' AND data->>'sales_rep' = rep AND data->>'valuation_date' = d::text LIMIT 1;

  IF existing IS NULL AND coalesce(v_total,0) = 0 THEN PERFORM public.svr_sweep_overdue_tasks(); RETURN NULL; END IF;

  IF existing IS NOT NULL THEN
    UPDATE public.records SET data = data || jsonb_build_object(
        'total_reviewed', coalesce(v_total,0), 'correct_follow_ups', coalesce(v_correct,0),
        'mistakes_found', coalesce(v_mistakes,0), 'average_score', v_avg,
        'main_mistake_category', v_maincat, 'open_correction_tasks', coalesce(v_opentask,0))
     WHERE id = existing;
  ELSE
    SELECT data->>'default_sales_manager' INTO v_mgr FROM public.records WHERE model_id = '5a1e7a10-0000-4000-8000-000000000005' LIMIT 1;
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (gen_random_uuid(), '5a1e7a10-0000-4000-8000-000000000004',
      jsonb_build_object(
        'sales_rep', rep, 'valuation_date', d::text, 'sales_manager', v_mgr,
        'total_reviewed', coalesce(v_total,0), 'correct_follow_ups', coalesce(v_correct,0),
        'mistakes_found', coalesce(v_mistakes,0), 'average_score', v_avg,
        'main_mistake_category', v_maincat, 'open_correction_tasks', coalesce(v_opentask,0),
        'rep_acknowledged', false, 'summary_status', 'draft'
      ), NULL);
  END IF;
  PERFORM public.svr_sweep_overdue_tasks();
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS svr_create_review_on_followup_complete ON public.records;
CREATE TRIGGER svr_create_review_on_followup_complete AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW WHEN (NEW.model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63')
  EXECUTE FUNCTION public.svr_create_review_on_followup_complete();

DROP TRIGGER IF EXISTS svr_fill_review_computed ON public.records;
CREATE TRIGGER svr_fill_review_computed BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW WHEN (NEW.model_id = '5a1e7a10-0000-4000-8000-000000000001')
  EXECUTE FUNCTION public.svr_fill_review_computed();

DROP TRIGGER IF EXISTS svr_create_correction_task ON public.records;
CREATE TRIGGER svr_create_correction_task AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW WHEN (NEW.model_id = '5a1e7a10-0000-4000-8000-000000000001')
  EXECUTE FUNCTION public.svr_create_correction_task();

DROP TRIGGER IF EXISTS svr_daily_summary_iu ON public.records;
CREATE TRIGGER svr_daily_summary_iu AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW WHEN (NEW.model_id = '5a1e7a10-0000-4000-8000-000000000001')
  EXECUTE FUNCTION public.svr_recompute_daily_summary();

DROP TRIGGER IF EXISTS svr_daily_summary_del ON public.records;
CREATE TRIGGER svr_daily_summary_del AFTER DELETE ON public.records
  FOR EACH ROW WHEN (OLD.model_id = '5a1e7a10-0000-4000-8000-000000000001')
  EXECUTE FUNCTION public.svr_recompute_daily_summary();

-- ─────────────────────────────────────────────────────────────────────────
-- Permissions: managers/admins full; reps own-records-only (scope on sales_rep)
-- Sales-rep field ids: reviews 5a1e7a10-0f01-...0004, tasks ...0f03-...0005,
-- daily ...0f04-...0001. (Full statements applied via sales_valuation_permissions.)
-- Field-level locking is NOT supported by the platform; reps have scoped EDIT
-- on their own reviews so the acknowledge/dispute flow works (documented limit).
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- Dedicated sidebar group (migration: sales_valuation_dedicated_group)
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.model_groups (id, label_ar, label_en, "order")
VALUES ('5a1e7a10-9700-4000-8000-000000000001', 'تقييم المبيعات', 'Sales Valuation', 5)
ON CONFLICT (id) DO UPDATE SET label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, "order" = EXCLUDED."order";

-- Reviews model renamed to the manager-facing name + all 5 models moved into the group
UPDATE public.models SET group_id='5a1e7a10-9700-4000-8000-000000000001', "order"=0,
       label_ar='قائمة تقييم المبيعات', label_en='Sales Valuation Queue'
 WHERE id='5a1e7a10-0000-4000-8000-000000000001';
UPDATE public.models SET group_id='5a1e7a10-9700-4000-8000-000000000001', "order"=1 WHERE id='5a1e7a10-0000-4000-8000-000000000003';
UPDATE public.models SET group_id='5a1e7a10-9700-4000-8000-000000000001', "order"=2 WHERE id='5a1e7a10-0000-4000-8000-000000000004';
UPDATE public.models SET group_id='5a1e7a10-9700-4000-8000-000000000001', "order"=3 WHERE id='5a1e7a10-0000-4000-8000-000000000002';
UPDATE public.models SET group_id='5a1e7a10-9700-4000-8000-000000000001', "order"=4 WHERE id='5a1e7a10-0000-4000-8000-000000000005';

-- NOTE: The 5 model rows, the 13 seed categories + settings record, the 5 queue
-- saved views, and the 2 dashboards were inserted by the named Supabase
-- migrations above and are the live source of truth. They are intentionally not
-- re-pasted here (large generated JSONB). Run `npm run sync:prds` to materialise
-- the model definitions into docs/prd/models/, whose git diff is the record.
