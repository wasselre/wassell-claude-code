-- ============================================================================
-- Content operations: duplicate a package, and bulk operations.
--
-- WHY THE DUPLICATE LIVES IN THE DATABASE
--
-- Copying a package touches four tables and has to stay consistent: a brief, its
-- deliverables, the tasks each deliverable's FORMAT calls for, and optionally
-- the text. Doing that from the API means a dozen round trips with no
-- transaction around them, so a failure halfway leaves a half-copied package
-- that looks real. One function, one transaction, one result.
--
-- WHAT A COPY MUST NOT INHERIT
--
--   * approvals — an approved artifact is stamped with WHO approved it and
--     WHEN. Copying that stamp onto new work would fabricate an approval that
--     nobody gave. Text is copied as a fresh DRAFT; the approval is not.
--   * publications and results — they belong to something that actually went
--     out. A copy has published nothing and measured nothing.
--   * publish times and due dates — a copy is new work on a new schedule.
--   * `needs_classification` and the legacy marker — recomputed, not inherited.
--
-- WHAT IT MUST INHERIT
--
--   * the strategic argument (scope, strategy version, plan, goal, audience,
--     message, evidence, prohibitions) — that is the point of duplicating.
--   * a REAL lineage edge: parent_content_item_id + reuse_kind, which is what
--     the brief asked for instead of a free-text note.
--
-- Idempotent in the DDL sense: re-running replaces the functions.
-- ============================================================================
BEGIN;

-- ── 1. Duplicate a package ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_content_duplicate(
  p_source_id      uuid,
  p_title          text    DEFAULT NULL,
  p_reuse_kind     text    DEFAULT 'refresh',
  p_copy_artifacts boolean DEFAULT false,
  p_actor          uuid    DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  src record; v_new uuid; d record; v_del uuid; v_tasks int := 0; n int;
  v_dels int := 0; v_arts int := 0; a record;
BEGIN
  SELECT * INTO src FROM public.mkt_content_items WHERE id = p_source_id;
  IF src IS NULL THEN
    RAISE EXCEPTION 'content item not found' USING ERRCODE='no_data_found';
  END IF;

  -- The copy starts as an IDEA whatever the source reached. Inheriting
  -- "approved" would mean a package nobody has looked at is already past its
  -- own gate; the fields are all there, so activating it is one click and one
  -- decision rather than a silent promotion.
  INSERT INTO public.mkt_content_items (
    title, content_type, status, priority, purpose, project_id, campaign_id,
    owner_user_id, language, target_audience, content_pillar,
    hook, main_idea, cta, reference_links, production_notes,
    organic_or_paid, funnel_stage, content_angle, offer_message, cta_destination,
    plan_id, primary_goal_id, primary_pillar_id, strategic_purpose,
    origin_kind, origin_program_id, origin_campaign_id,
    strategy_version_id, scope_kind, scope_note,
    audience_insight, core_promise, evidence, desired_action,
    mandatory_info, prohibited_claims, always_on_reason,
    parent_content_item_id, reuse_kind,
    created_by_user_id
  ) VALUES (
    COALESCE(NULLIF(btrim(p_title), ''), src.title || ' — نسخة'),
    src.content_type, 'idea', src.priority, src.purpose, src.project_id, src.campaign_id,
    src.owner_user_id, src.language, src.target_audience, src.content_pillar,
    src.hook, src.main_idea, src.cta, src.reference_links, src.production_notes,
    src.organic_or_paid, src.funnel_stage, src.content_angle, src.offer_message, src.cta_destination,
    src.plan_id, src.primary_goal_id, src.primary_pillar_id, src.strategic_purpose,
    src.origin_kind, src.origin_program_id, src.origin_campaign_id,
    src.strategy_version_id, src.scope_kind, src.scope_note,
    src.audience_insight, src.core_promise, src.evidence, src.desired_action,
    src.mandatory_info, src.prohibited_claims, src.always_on_reason,
    p_source_id, COALESCE(p_reuse_kind, 'refresh'),
    p_actor
  ) RETURNING id INTO v_new;

  -- Deliverables: the SHAPE of each output, never its schedule or its state.
  FOR d IN SELECT * FROM public.mkt_content_deliverables
            WHERE content_item_id = p_source_id AND archived_at IS NULL
            ORDER BY deliverable_number
  LOOP
    INSERT INTO public.mkt_content_deliverables (
      content_item_id, label, platform, social_account_id, distribution, format,
      language, aspect_ratio, target_seconds, owner_user_id,
      primary_kpi, kpi_unit, kpi_target, workflow_template_key,
      cta_destination, destination_url, notes,
      needs_classification, created_by_user_id
    ) VALUES (
      v_new, d.label, d.platform, d.social_account_id, d.distribution, d.format,
      d.language, d.aspect_ratio, d.target_seconds, d.owner_user_id,
      d.primary_kpi, d.kpi_unit, d.kpi_target, d.workflow_template_key,
      d.cta_destination, d.destination_url, d.notes,
      (d.platform IS NULL), p_actor
    ) RETURNING id INTO v_del;
    v_dels := v_dels + 1;

    -- Fresh tasks from the template. Copying the source's tasks would carry
    -- over their completion state, so a brand-new package would open already
    -- half-done.
    BEGIN
      v_tasks := v_tasks + public.mkt_generate_deliverable_tasks(v_del, false);
    EXCEPTION WHEN no_data_found THEN
      -- format 'other' has no template. Not fatal: the deliverable exists and
      -- somebody picks a workflow. Silence here would be the bug.
      RAISE NOTICE 'deliverable % (%): no workflow template, no tasks generated', v_del, d.format;
    END;

    IF p_copy_artifacts THEN
      -- The APPROVED text of each artifact, re-entered as a draft v1. The
      -- approval itself is not copied — see the header.
      FOR a IN
        SELECT * FROM public.mkt_content_versions
         WHERE deliverable_id = d.id AND approval_state = 'approved'
           AND payload ? 'text' AND btrim(COALESCE(payload->>'text','')) <> ''
      LOOP
        INSERT INTO public.mkt_content_versions (
          content_item_id, deliverable_id, version_type, payload,
          change_summary, owner_user_id, parent_version_id, approval_state, created_by_user_id
        ) VALUES (
          v_new, v_del, a.version_type, a.payload,
          format('copied from %s v%s', src.content_number, a.version_number),
          p_actor, a.id, 'draft', p_actor
        );
        v_arts := v_arts + 1;
      END LOOP;
    END IF;
  END LOOP;

  -- Role assignments carry over: the same people usually make the next one.
  INSERT INTO public.mkt_content_roles (content_item_id, user_id, role_key, is_reviewer,
                                        is_final_approver, note, created_by_user_id)
  SELECT v_new, r.user_id, r.role_key, r.is_reviewer, r.is_final_approver, r.note, p_actor
    FROM public.mkt_content_roles r
   WHERE r.content_item_id = p_source_id AND r.deliverable_id IS NULL
  ON CONFLICT DO NOTHING;

  -- Source assets are LINKED, not copied — that is the whole point of a library.
  INSERT INTO public.mkt_asset_links (asset_id, target_type, target_id, role, note, created_by_user_id)
  SELECT l.asset_id, 'content_item', v_new, l.role,
         format('linked from %s', src.content_number), p_actor
    FROM public.mkt_asset_links l
   WHERE l.target_type = 'content_item' AND l.target_id = p_source_id
     AND l.role IS DISTINCT FROM 'final'
  ON CONFLICT (asset_id, target_type, target_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  RETURN jsonb_build_object(
    'id', v_new,
    'content_number', (SELECT content_number FROM public.mkt_content_items WHERE id = v_new),
    'source_id', p_source_id,
    'source_number', src.content_number,
    'deliverables', v_dels,
    'tasks', v_tasks,
    'artifacts_copied', v_arts,
    'assets_linked', n);
END $$;

-- ── 2. Bulk assignment ──────────────────────────────────────────────────────
-- A single statement, so RLS decides row by row and the caller is told the
-- difference rather than being shown a success for rows that did not move.
CREATE OR REPLACE FUNCTION public.mkt_content_bulk_assign(
  p_ids               uuid[],
  p_owner_user_id     uuid,
  p_also_deliverables boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_items int; v_dels int := 0;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no content items given' USING ERRCODE='no_data_found';
  END IF;

  -- SECURITY INVOKER deliberately: this must run under the caller's RLS so a
  -- viewer cannot reassign work by calling it. A definer function here would
  -- be a permission bypass wearing a convenience label.
  UPDATE public.mkt_content_items
     SET owner_user_id = p_owner_user_id, updated_at = now()
   WHERE id = ANY(p_ids);
  GET DIAGNOSTICS v_items = ROW_COUNT;

  IF p_also_deliverables THEN
    UPDATE public.mkt_content_deliverables
       SET owner_user_id = p_owner_user_id, updated_at = now()
     WHERE content_item_id = ANY(p_ids) AND archived_at IS NULL;
    GET DIAGNOSTICS v_dels = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'requested', array_length(p_ids, 1),
    'items_updated', v_items,
    'deliverables_updated', v_dels,
    -- Non-zero means RLS refused some rows. Saying "12 updated" when 15 were
    -- asked for is the kind of quiet partial success this codebase has been
    -- bitten by before.
    'refused', array_length(p_ids, 1) - v_items);
END $$;

-- ── 3. Bulk scheduling ──────────────────────────────────────────────────────
-- Scheduling is per DELIVERABLE, because that is the thing that goes out. This
-- sets the planned time and staggers it; it does NOT force publications through
-- the gate. A deliverable whose media or copy is not approved keeps its slot in
-- the calendar and keeps saying what it is missing, which is more useful than
-- either failing the whole batch or silently skipping it.
CREATE OR REPLACE FUNCTION public.mkt_deliverable_bulk_schedule(
  p_ids           uuid[],
  p_start_at      timestamptz,
  p_interval_mins integer DEFAULT 1440
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  d record; i int := 0; v_set int := 0; v_ready int := 0;
  v_blocked jsonb := '[]'::jsonb; v_when timestamptz; v_blk text[];
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no deliverables given' USING ERRCODE='no_data_found';
  END IF;
  IF p_start_at IS NULL THEN
    RAISE EXCEPTION 'a start time is required' USING ERRCODE='invalid_parameter_value';
  END IF;

  -- Ordered so the stagger is deterministic: the same selection always lands
  -- in the same slots, whatever order the client sent the ids in.
  FOR d IN
    SELECT dv.id, dv.content_item_id, dv.deliverable_number, dv.platform,
           c.content_number, c.title
      FROM public.mkt_content_deliverables dv
      JOIN public.mkt_content_items c ON c.id = dv.content_item_id
     WHERE dv.id = ANY(p_ids) AND dv.archived_at IS NULL
     ORDER BY c.content_number, dv.deliverable_number
  LOOP
    v_when := p_start_at + (i * COALESCE(p_interval_mins, 1440) || ' minutes')::interval;

    UPDATE public.mkt_content_deliverables
       SET planned_publish_at = v_when, updated_at = now()
     WHERE id = d.id;
    IF FOUND THEN v_set := v_set + 1; END IF;

    v_blk := public.mkt_deliverable_schedule_blockers(d.id);
    IF array_length(v_blk, 1) IS NULL THEN
      v_ready := v_ready + 1;
    ELSE
      v_blocked := v_blocked || jsonb_build_object(
        'deliverable_id', d.id,
        'label', d.content_number || ' / D' || d.deliverable_number,
        'blockers', to_jsonb(v_blk));
    END IF;
    i := i + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'requested', array_length(p_ids, 1),
    'scheduled', v_set,
    'ready_to_publish', v_ready,
    'still_blocked', v_blocked,
    'refused', array_length(p_ids, 1) - v_set);
END $$;

COMMIT;
