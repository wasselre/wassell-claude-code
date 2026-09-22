-- ============================================================================
-- Plan-driven task assignment — 6/6: TRANSITION of the running month.
-- 2026-09-22. 07-decisions.md: D1 (the two publishing steps leave the live
-- workflow definition; in-flight items are re-pinned), D3/D8 (no in-place date
-- correction: the operator re-plans September once the engine is live), A (the
-- early-started launch designs keep their deadlines), D9 (archived content
-- closes its tasks — applied retroactively to the phantom).
--
-- Idempotent. Runs under the ledger lock with the crons paused by design (the
-- planning sweep only calls into the same lock).
-- ============================================================================

BEGIN;
SELECT public.mos_ledger_lock();

-- ── W1: remove `scheduling` / `publish_check` from the LIVE definitions ──────
-- The 14 Sep release split shortened the VERSIONS but not `workflows.metadata`;
-- a labels-only migration on 17 Sep touched the metadata and the versioning
-- trigger snapshotted the 7-step path back as post_std v9 (90 items pinned).
DO $$
DECLARE w record; v_steps jsonb; v_n int := 0;
BEGIN
  FOR w IN
    SELECT id, metadata FROM public.workflows
     WHERE metadata ->> 'key' IN ('post_std','video_std')
       AND jsonb_typeof(metadata -> 'steps') = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(metadata -> 'steps') s
                    WHERE s ->> 'key' IN ('scheduling','publish_check'))
  LOOP
    SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb) INTO v_steps
      FROM jsonb_array_elements(w.metadata -> 'steps') WITH ORDINALITY t(s, ord)
     WHERE s ->> 'key' NOT IN ('scheduling','publish_check');
    UPDATE public.workflows SET metadata = jsonb_set(metadata, '{steps}', v_steps), updated_at = now()
     WHERE id = w.id;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'W1: % live workflow definition(s) shortened', v_n;
END $$;

-- Make sure a shortened LATEST version exists for each of the two workflows
-- (the versioning trigger normally snapshots it; this is the belt to that brace).
DO $$
DECLARE w record; v_latest record; v_next int;
BEGIN
  FOR w IN SELECT id, metadata FROM public.workflows WHERE metadata ->> 'key' IN ('post_std','video_std') LOOP
    SELECT v.id, v.definition INTO v_latest FROM public.workflow_versions v
     WHERE v.workflow_id = w.id ORDER BY v.version_no DESC LIMIT 1;
    IF v_latest.id IS NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_latest.definition -> 'metadata' -> 'steps') s
                   WHERE s ->> 'key' IN ('scheduling','publish_check')) THEN
      SELECT COALESCE(max(version_no), 0) + 1 INTO v_next FROM public.workflow_versions WHERE workflow_id = w.id;
      INSERT INTO public.workflow_versions (workflow_id, version_no, definition)
      VALUES (w.id, v_next,
              jsonb_set(COALESCE(v_latest.definition, '{}'::jsonb), '{metadata}',
                        COALESCE(v_latest.definition -> 'metadata', '{}'::jsonb) || jsonb_build_object('steps', w.metadata -> 'steps')));
      RAISE NOTICE 'W1: % gets shortened version %', w.metadata ->> 'key', v_next;
    END IF;
  END LOOP;
END $$;

-- Re-pin in-flight subjects to the shortened latest version of their workflow.
-- Safe by construction: no open task sits on a tail step (asserted).
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.workflow_role_tasks
   WHERE status = 'open' AND step_key IN ('scheduling','publish_check');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'W1: % open task(s) still sit on a publishing step — close them before re-pinning', v_bad;
  END IF;
END $$;

WITH latest AS (
  SELECT DISTINCT ON (v.workflow_id) v.workflow_id, v.id AS version_id
    FROM public.workflow_versions v
    JOIN public.workflows w ON w.id = v.workflow_id AND w.metadata ->> 'key' IN ('post_std','video_std')
   ORDER BY v.workflow_id, v.version_no DESC)
UPDATE public.mos_content c
   SET workflow_version_id = l.version_id, updated_at = now()
  FROM public.workflow_versions old
  JOIN latest l ON l.workflow_id = old.workflow_id
 WHERE c.workflow_version_id = old.id AND c.workflow_version_id <> l.version_id
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(old.definition -> 'metadata' -> 'steps') s
                WHERE s ->> 'key' IN ('scheduling','publish_check'));

WITH latest AS (
  SELECT DISTINCT ON (v.workflow_id) v.workflow_id, v.id AS version_id
    FROM public.workflow_versions v
    JOIN public.workflows w ON w.id = v.workflow_id AND w.metadata ->> 'key' IN ('post_std','video_std')
   ORDER BY v.workflow_id, v.version_no DESC)
UPDATE public.mos_content_rows r
   SET workflow_version_id = l.version_id, updated_at = now()
  FROM public.workflow_versions old
  JOIN latest l ON l.workflow_id = old.workflow_id
 WHERE r.workflow_version_id = old.id AND r.workflow_version_id <> l.version_id
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(old.definition -> 'metadata' -> 'steps') s
                WHERE s ->> 'key' IN ('scheduling','publish_check'));

-- Open tasks keep pointing at the version they were opened under; the advance
-- function reads the pinned steps off the SUBJECT, so they follow the re-pin.
UPDATE public.workflow_role_tasks t
   SET workflow_version_id = public.mos_subject_version_id(t.subject_table, t.subject_id)
 WHERE t.status = 'open'
   AND t.workflow_version_id IS DISTINCT FROM public.mos_subject_version_id(t.subject_table, t.subject_id)
   AND public.mos_subject_version_id(t.subject_table, t.subject_id) IS NOT NULL;

-- ── D9 retroactively: open tasks on archived / rejected / on-hold subjects ───
UPDATE public.workflow_role_tasks t
   SET status = 'skipped', late_flag = false, closed_at = now(), updated_at = now(),
       note = COALESCE(t.note, '') || ' subject inactive (transition 2026-09-22)'
 WHERE t.status = 'open' AND t.subject_table IN ('mos_content','mos_content_rows')
   AND public.mos_subject_inactive(t.subject_table, t.subject_id);

-- ── the single accounting rule: open UNASSIGNED tasks hold a BOUND booking ──
UPDATE public.mos_task_reservations r
   SET status = 'bound', updated_at = now()
  FROM public.workflow_role_tasks t
 WHERE t.id = r.consumed_task_id AND r.status = 'consumed'
   AND t.status = 'open' AND t.assignee_user_id IS NULL;
UPDATE public.workflow_role_tasks
   SET offered_to_user_id = NULL, offered_at = NULL, waiting_reason = NULL, waiting_since = NULL,
       due_at = NULL, updated_at = now()
 WHERE status = 'open' AND assignee_user_id IS NULL AND reservation_id IS NOT NULL;

-- ── planned handoff + deadline stamped on every open reservation-backed task ─
-- Informational for assigned work (A: no deadline is changed), the target for
-- unassigned work. The re-plan will restamp them through the same chain.
UPDATE public.workflow_role_tasks t
   SET plan_handoff_at = (SELECT ch.plan_handoff_at FROM public.mos_plan_chain(t.subject_table, t.subject_id) ch
                           WHERE ch.step_key = t.step_key LIMIT 1),
       plan_due_at     = (SELECT ch.plan_due_at FROM public.mos_plan_chain(t.subject_table, t.subject_id) ch
                           WHERE ch.step_key = t.step_key LIMIT 1)
 WHERE t.status = 'open' AND t.reservation_id IS NOT NULL;

-- ── one refill, one risk sweep, one conformance check ───────────────────────
DO $$
DECLARE v_refill jsonb; v_risk jsonb; v_bad int;
BEGIN
  v_refill := public.mos_refill(NULL);
  v_risk   := public.mos_risk_sweep();
  v_bad    := public.mos_assert_ledger_conformance();
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'transition: % consumed reservation(s) still behind an open unassigned task', v_bad;
  END IF;
  RAISE NOTICE 'transition: refill % | risk %', v_refill, v_risk;
END $$;

COMMIT;
