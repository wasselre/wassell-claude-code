-- Appointment no-show auto-close + recovery (added 2026-06-21)
--
-- Requirement: 24 hours after an appointment's scheduled date/time, if the
-- appointment is still "open" (status scheduled / confirmed / unset) and was
-- never updated by a human, automatically set its status to "no_show" AND run
-- the same recovery the manual no-show path (W5) runs — so an automatic no-show
-- is indistinguishable downstream from a manual one. A human update (completed /
-- cancelled / rescheduled / no_show) must NEVER be overridden.
--
-- This ships two pieces:
--   1. `appointments_due_for_noshow()` — the candidate selector, the appointments
--      analogue of the `data->>'scheduled_datetime' <= now()` query the followups
--      sweeper runs. It is the ONLY thing here that is appointments-specific; the
--      actual work is performed by a real `on_due` workflow (below) through the
--      existing server-side workflow engine (api/_lib/workflowSweeper.ts).
--   2. A new `on_due` workflow on the appointments model whose single branch
--      reproduces W5 ("No-Show Recovery", id f7864a0d-...) exactly:
--        a. flip the appointment -> no_show (self-update, version-guarded);
--        b. set the linked client -> "لم يحضر الموعد";
--        c. create a `no_show_recovery_call` follow-up.
--      ─────────────────────────────────────────────────────────────────────────
--      KEEP IN SYNC WITH W5: actions (b) + (c) are a deliberate copy of W5's two
--      actions (workflows can't share logic — they're JSONB rows). If W5's
--      recovery changes (client status value, follow-up type/fields/scheduling),
--      mirror it here so the manual and automatic no-show paths stay identical.
--      ─────────────────────────────────────────────────────────────────────────
--      The version-guarded flip (a) runs FIRST: if a human changed the
--      appointment since it was selected, the engine skips (a) with
--      `version_conflict` and ABORTS (b)+(c) too (see workflowSweeper.runWorkflow),
--      so a lost race never produces a spurious client move or recovery task.
--
-- The cron endpoint `api/sweep-appointment-noshows.ts` calls the function every
-- 30 min and feeds each due row to the workflow engine.
--
-- @see api/sweep-appointment-noshows.ts
-- @see api/_lib/workflowSweeper.ts  (runOnDueForRecord)
-- @see docs/prd/workflow-automation.md  ("on_due" trigger)

BEGIN;

-- ── 1. Candidate selector ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.appointments_due_for_noshow()
RETURNS TABLE (
  id                 uuid,
  model_id           uuid,
  data               jsonb,
  created_by_user_id uuid,
  created_at         timestamptz,
  updated_at         timestamptz,
  version            integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH due AS (
    SELECT
      r.id, r.model_id, r.data, r.created_by_user_id, r.created_at, r.updated_at, r.version,
      -- appointment_date is stored as a Riyadh-local datetime-local string
      -- ("2026-06-17T18:02", no timezone). KSA is a fixed UTC+3 with no DST, so
      -- interpreting the wall-clock AS Asia/Riyadh yields the true instant. The
      -- regex (in WHERE) guarantees only well-formed values reach this cast, so a
      -- single malformed row can never error the whole sweep.
      (
        (substring(r.data->>'appointment_date' from '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')::timestamp)
          AT TIME ZONE 'Asia/Riyadh'
      ) + interval '24 hours' AS due_at
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'appointments'
    WHERE r.data->>'appointment_date' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
      -- "Still open" = scheduled / confirmed / unset. The moment a human moves it
      -- to completed / cancelled / rescheduled / no_show, the row drops out of
      -- this set on the next sweep — so a manual update is never overridden.
      AND (
        r.data->>'appointment_status' IS NULL
        OR r.data->>'appointment_status' = ''
        OR r.data->>'appointment_status' IN ('scheduled', 'confirmed')
      )
  )
  SELECT id, model_id, data, created_by_user_id, created_at, updated_at, version
  FROM due
  WHERE due_at <= now()
    -- Going-forward cutoff: appointments whose 24h-due moment had already passed
    -- when this feature shipped (2026-06-21) are excluded forever, so the
    -- pre-existing backlog is never retroactively flipped to no_show.
    AND due_at >= '2026-06-21T00:00:00Z'::timestamptz
  ORDER BY due_at
  LIMIT 500;  -- safety cap; cron runs every 30 min, any backlog drains over ticks
$$;

COMMENT ON FUNCTION public.appointments_due_for_noshow() IS
  'Appointments past (appointment_date + 24h, Riyadh-local) still in an open status (scheduled/confirmed/unset), excluding the pre-2026-06-21 backlog. Candidate set for the no-show auto-close cron (api/sweep-appointment-noshows.ts).';

REVOKE ALL ON FUNCTION public.appointments_due_for_noshow() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.appointments_due_for_noshow() FROM anon, authenticated;

-- ── 2. The on_due workflow: flip -> client status -> recovery follow-up ───────
DO $do$
DECLARE
  v_conditions jsonb := jsonb_build_array(
    jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819221','field_id','appointment_status','operator','equals','value','scheduled'),
    jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819222','field_id','appointment_status','operator','equals','value','confirmed'),
    jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819223','field_id','appointment_status','operator','is_empty','value', null)
  );
  v_actions jsonb := jsonb_build_array(
    -- (a) flip the appointment itself -> no_show. Self-update (filter on id =
    --     trigger id); the sweeper version-guards this write. MUST stay first.
    jsonb_build_object(
      'id',                     'b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819230',
      'type',                   'update_record',
      'target_model_id',        'b032a675-6237-4436-9783-a1a253855f74',  -- appointments
      'filter_field_id',        'id',
      'filter_value_source',    'trigger_field',
      'filter_trigger_field_id','id',
      'filter_value',           '',
      'field_mappings', jsonb_build_array(
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819240','target_field_id','appointment_status','source_type','static','static_value','no_show','trigger_field_id','')
      )
    ),
    -- (b) move the linked client -> "لم يحضر الموعد" (copy of W5 action 1).
    jsonb_build_object(
      'id',                     'b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819250',
      'type',                   'update_record',
      'target_model_id',        '2e86f197-385f-4853-908f-b4cb7237f7d8',  -- clients
      'filter_field_id',        'id',
      'filter_value_source',    'trigger_field',
      'filter_trigger_field_id','client_id',
      'filter_value',           '',
      'field_mappings', jsonb_build_array(
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819251','target_field_id','client_status','source_type','static','static_value','لم يحضر الموعد','trigger_field_id','')
      )
    ),
    -- (c) create the no_show_recovery_call follow-up (copy of W5 action 2).
    jsonb_build_object(
      'id',              'b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819260',
      'type',            'create_record',
      'target_model_id', '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',  -- followups
      'skip_if_exists',  false,
      'field_mappings', jsonb_build_array(
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819261','target_field_id','client_id','source_type','trigger_field','trigger_field_id','client_id','static_value',''),
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819262','target_field_id','followup_type','source_type','static','static_value', jsonb_build_array('no_show_recovery_call'),'trigger_field_id',''),
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819263','target_field_id','appointment_id','source_type','record_id','static_value','','trigger_field_id',''),
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819264','target_field_id','scheduled_datetime','source_type','date_expression','date_base','current_date','date_expression','+0d','static_value','','trigger_field_id',''),
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819265','target_field_id','followup_status','source_type','static','static_value','open','trigger_field_id',''),
        jsonb_build_object('id','b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819266','target_field_id','sales_rep','source_type','trigger_field','trigger_field_id','sales_rep','static_value','')
      )
    )
  );
BEGIN
  INSERT INTO public.workflows (
    id, label_ar, label_en, trigger_model_id, trigger_event,
    group_id, is_active, metadata, branches, conditions, actions
  )
  VALUES (
    'b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819203',
    'إغلاق الموعد تلقائياً كـ«لم يحضر» بعد ٢٤ ساعة',
    'Auto-close appointment as No-Show after 24h',
    'b032a675-6237-4436-9783-a1a253855f74',  -- appointments model
    'on_due',
    'f1e1d1c1-5a1e-4000-8000-000000000001',  -- "Sales Lifecycle" group
    true,
    jsonb_build_object(
      'managed_by',    'sales_process_studio',
      'sales_stage',   'موعد زيارة',
      'activity_type', 'appointment_no_show_autoclose',
      'compatibility', 'simple'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id',             'b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819210',
        'label_ar',       'الموعد مازال مفتوحاً',
        'label_en',       'Appointment still open',
        'condition_mode', 'any',
        'conditions',     v_conditions,
        'actions',        v_actions
      )
    ),
    v_conditions,  -- legacy flat mirror (engine prefers `branches`; columns NOT NULL)
    v_actions
  )
  ON CONFLICT (id) DO UPDATE SET
    label_ar         = EXCLUDED.label_ar,
    label_en         = EXCLUDED.label_en,
    trigger_model_id = EXCLUDED.trigger_model_id,
    trigger_event    = EXCLUDED.trigger_event,
    group_id         = EXCLUDED.group_id,
    is_active        = EXCLUDED.is_active,
    metadata         = EXCLUDED.metadata,
    branches         = EXCLUDED.branches,
    conditions       = EXCLUDED.conditions,
    actions          = EXCLUDED.actions,
    updated_at       = now();
END
$do$;

COMMIT;
