-- ============================================================================
-- Auto Meta ad on manager approval (2026-09-10)
--
-- After the marketing manager approves the design of a paid creative, the app
-- writes the ad caption with AI and creates the ad inside the campaign's Meta
-- ad set — no scheduling / publish-check steps for a paid-only item. This
-- migration lands the data pieces:
--
--   1. generation_jobs.kind gains 'meta-ad' (the Fly worker lane that uploads
--      the square + vertical designs, writes the caption, and creates the ad).
--   2. mos_asset_links.role gains 'final_square' / 'final_vertical' — the two
--      design SLOTS the Materials tab now asks the designer for (1:1 for the
--      Instagram feed, 9:16 for stories / reels / WhatsApp status).
--   3. workflow_advance_role_path gains p_finish: close the current task and
--      open NOTHING (the item is done) — used when the approval hands the rest
--      of the path to the ad automation. Existing 5-arg callers keep working
--      through the default.
--   4. mos_promote_approval_asset must not demote a slot link back to 'final'.
--   5. notification_rules for ad_created / ad_failed (manager channels on).
--   6. The `auto_meta_ad` step flag is backfilled onto the manager's design
--      review step of the two shipped paths — on the live workflow rows AND
--      on the pinned versions in-flight items follow (additive; the engine
--      ignores unknown step keys, so nothing else changes for them).
-- ============================================================================
BEGIN;

-- ── 1. generation_jobs kind ──────────────────────────────────────────────────
ALTER TABLE public.generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs ADD CONSTRAINT generation_jobs_kind_check
  CHECK (kind IN ('image','video','audio','clean-text','video-convert','listing-mirror','creative-image','meta-ad'));

-- ── 2. asset link roles ──────────────────────────────────────────────────────
ALTER TABLE public.mos_asset_links DROP CONSTRAINT IF EXISTS mos_asset_links_role_check;
ALTER TABLE public.mos_asset_links ADD CONSTRAINT mos_asset_links_role_check
  CHECK (role IN ('source','final','reference','final_square','final_vertical'));

-- ── 3. workflow_advance_role_path(+ p_finish) ────────────────────────────────
-- Re-emitted VERBATIM from the live definition (pg_get_functiondef, 2026-09-10)
-- with ONE change: p_finish short-circuits the successor lookup. A different
-- argument list is a NEW overload, so the old one is dropped first (otherwise a
-- 5-arg call would be ambiguous).
DROP FUNCTION IF EXISTS public.workflow_advance_role_path(text, uuid, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text,
  p_subject_id uuid,
  p_result text,
  p_note text DEFAULT NULL::text,
  p_targets jsonb DEFAULT '[]'::jsonb,
  p_finish boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
BEGIN
  -- The engine is generic; only the marketing subject is wired up so far.
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT * INTO v_task
    FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table
     AND subject_id    = p_subject_id
     AND status        = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:NO_OPEN_TASK';
  END IF;

  -- Definer rights bypass RLS, so the task-level authorization lives here:
  -- admins and the Marketing Manager may move anyone's task; otherwise the
  -- caller must HOLD the task's role or BE its assignee.
  -- NOTE: the assignee comparison MUST be COALESCE'd — an unassigned task has
  -- assignee_user_id IS NULL, and `NULL = me` is NULL, which would make the
  -- whole OR-chain NULL and `IF NOT (NULL)` fail OPEN (the 2026-08-03 bug).
  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = public.wassell_app_user_id(auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  -- Mirrors the reject-note CHECK so the caller gets a sentence, not a violation.
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  -- The PINNED definition, never the live workflow row.
  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_version, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- Content not bound to a version (no workflow): close and stop — 'done'.
  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 2026-09-10: an approval that hands the rest of the path to the ad
  -- automation finishes the item here — no successor task is opened. Only an
  -- approval may finish (a submit or a return always continues the path).
  IF p_finish AND p_result = 'approved' THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 0-based index of the current step within the pinned array.
  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    -- Back to the LAST step before the current one that creates revisions;
    -- if none does, the first step. The round increments so the loop stays
    -- visible in the task chain rather than overwriting the record it came from.
    SELECT elem INTO v_next
      FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE ord - 1 < COALESCE(v_idx, 0)
       AND COALESCE((elem->>'creates_revision')::boolean, false)
     ORDER BY ord DESC
     LIMIT 1;
    IF v_next IS NULL THEN
      v_next := v_steps -> 0;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;  -- last step: no successor, the record is done
    END IF;
    v_round := v_task.round;
  END IF;

  IF v_next IS NOT NULL THEN
    INSERT INTO public.workflow_role_tasks
      (subject_table, subject_id, workflow_version_id, step_key, role_key,
       round, due_at)
    VALUES
      (p_subject_table, p_subject_id, v_version,
       v_next->>'key', v_next->>'role_key', v_round,
       now() + COALESCE((v_next->>'due_days')::int, 2) * interval '1 day')
    RETURNING id INTO v_new_id;

    -- Performance/load system (2026-08-28): capacity-aware placement + SLA due.
    -- Never breaks the advance — the function traps its own errors.
    PERFORM public.mos_perf_place_open_task(v_new_id);
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$;

REVOKE ALL ON FUNCTION public.workflow_advance_role_path(text, uuid, text, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workflow_advance_role_path(text, uuid, text, text, jsonb, boolean)
  TO authenticated, service_role;

-- ── 4. mos_promote_approval_asset keeps slot roles ───────────────────────────
-- A design uploaded into a slot is already linked as final_square /
-- final_vertical. The approval promote must not overwrite that with the plain
-- 'final' role (which would erase which slot it belongs to).
CREATE OR REPLACE FUNCTION public.mos_promote_approval_asset(p_content_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_asset uuid;
BEGIN
  SELECT approval_asset_id INTO v_asset FROM public.mos_content WHERE id = p_content_id;
  IF v_asset IS NULL THEN RETURN NULL; END IF;
  -- Only promote a material that is actually linked to this item.
  IF NOT EXISTS (
    SELECT 1 FROM public.mos_asset_links
     WHERE content_id = p_content_id AND asset_id = v_asset
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.mos_asset_links (asset_id, content_id, role)
    VALUES (v_asset, p_content_id, 'final')
    ON CONFLICT (asset_id, content_id) DO UPDATE
      SET role = CASE WHEN mos_asset_links.role LIKE 'final%' THEN mos_asset_links.role ELSE 'final' END;
  RETURN v_asset;
END $$;

-- ── 5. notification rules — ad_created / ad_failed ───────────────────────────
-- Same posture as publish_failed (2026-08-20): the manager gets inapp +
-- whatsapp immediately; every other role/channel cell exists DISABLED so the
-- Settings matrix can show and toggle it. Idempotent.
WITH roles5(role_key) AS (
  VALUES ('mos_ceo'), ('mos_marketing_manager'), ('mos_ops_supervisor'),
         ('mos_writer'), ('mos_montage')
),
channels3(channel) AS (
  VALUES ('inapp'), ('push'), ('whatsapp')
),
events2(event) AS (
  VALUES ('ad_created'), ('ad_failed')
),
on_cells(role_key, channel) AS (
  VALUES
  ('mos_marketing_manager', 'inapp'),
  ('mos_marketing_manager', 'whatsapp'),
  ('mos_ceo',               'inapp')
)
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id, ev.event, c.channel, 'immediate', (o.role_key IS NOT NULL)
  FROM roles5 ro
  JOIN public.roles r ON r.key = ro.role_key
 CROSS JOIN channels3 c
 CROSS JOIN events2 ev
  LEFT JOIN on_cells o
    ON o.role_key = ro.role_key AND o.channel = c.channel
ON CONFLICT (role_id, event, channel) DO NOTHING;

DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.notification_rules WHERE event IN ('ad_created','ad_failed');
  IF v_count = 0 THEN
    RAISE EXCEPTION 'NTF:AD_EVENT_SEED_EMPTY — no notification_rules rows landed for ad_created/ad_failed';
  END IF;
END $$;

-- ── 6. auto_meta_ad step flag on the manager's final creative approval ───────
-- post_std: design_review · video_std: review. Applied to the live workflow row
-- (a new version snapshots via the trigger) AND to every existing pinned
-- version so in-flight items pick it up too. Adding a key an older engine
-- ignores is safe by construction (stepsOf drops unknown keys).
CREATE OR REPLACE FUNCTION pg_temp.set_auto_meta_ad(p_steps jsonb, p_key text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' = p_key THEN elem || '{"auto_meta_ad": true}'::jsonb ELSE elem END
    ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(p_steps) WITH ORDINALITY AS e(elem, ord);
$$;

UPDATE public.workflows
   SET metadata = jsonb_set(metadata, '{steps}', pg_temp.set_auto_meta_ad(metadata->'steps', 'design_review'))
 WHERE kind = 'role_path' AND metadata->>'key' = 'post_std'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(metadata->'steps') s
      WHERE s->>'key' = 'design_review' AND (s->>'auto_meta_ad')::boolean IS TRUE);

UPDATE public.workflows
   SET metadata = jsonb_set(metadata, '{steps}', pg_temp.set_auto_meta_ad(metadata->'steps', 'review'))
 WHERE kind = 'role_path' AND metadata->>'key' = 'video_std'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(metadata->'steps') s
      WHERE s->>'key' = 'review' AND (s->>'auto_meta_ad')::boolean IS TRUE);

UPDATE public.workflow_versions v
   SET definition = jsonb_set(definition, '{metadata,steps}',
         pg_temp.set_auto_meta_ad(definition->'metadata'->'steps',
           CASE WHEN definition->'metadata'->>'key' = 'post_std' THEN 'design_review' ELSE 'review' END))
 WHERE definition->'metadata'->>'key' IN ('post_std','video_std')
   AND definition->>'kind' = 'role_path';

DO $$
DECLARE v_ok integer;
BEGIN
  SELECT count(*) INTO v_ok
    FROM public.workflows w, jsonb_array_elements(w.metadata->'steps') s
   WHERE w.kind = 'role_path' AND w.metadata->>'key' IN ('post_std','video_std')
     AND (s->>'auto_meta_ad')::boolean IS TRUE;
  IF v_ok < 2 THEN
    RAISE EXCEPTION 'MOS:AUTO_META_AD_FLAG_MISSING — expected the flag on post_std.design_review and video_std.review, found %', v_ok;
  END IF;
END $$;

COMMIT;
