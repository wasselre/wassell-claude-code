-- ============================================================================
-- Creating a creative and publishing it become two different jobs.
-- ----------------------------------------------------------------------------
-- Until now every content record ran ONE linear chain that ended in
-- `scheduling` (writer) + `publish_check` (ops_supervisor). Measured on the live
-- system on 2026-09-14, that produced three separate defects:
--
--   * a creative cross-posted to two platforms got 2 publications but ONE
--     scheduling task and ONE publish check, so the second destination had no
--     owner, no date and no way to be completed — closing the single task
--     declared the whole creative published;
--   * a two-week ten-creative Meta campaign booked TWENTY publishing tasks that
--     can never be performed, because an ad's path closes at final approval and
--     the ad is built by the worker. `scheduling` draws on the writer's
--     PRODUCTION budget, so phantom publishing work displaced real design work;
--   * production held three `publish_check` tasks open since 2026-09-12, all
--     unassigned, because NOBODY holds mos_ops_supervisor.
--
-- So: the content path now ENDS at the manager's final approval, and putting a
-- creative out becomes a RELEASE — one job per destination per date, charged to
-- its own `publishing` bucket.
--
-- THE RULE THAT MAKES THIS AN IMPROVEMENT — and the reason this is not just a
-- bigger pile of orphans: a release only becomes a TASK when a person is
-- actually needed. Where a connected account can publish by itself the sweep
-- schedules the post and asks nobody. A task is raised only when the account
-- cannot publish, when the platform preflight blocks, or when a publish
-- actually failed.
--
-- Backward compatible by construction: content already in flight keeps its
-- PINNED workflow version, so anything mid-production still walks its old
-- chain, including its scheduling/publish_check tail. Only content pinned from
-- now on gets the shortened path.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Settings — every knob is operator data, none of it is a deploy
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.mos_settings (key, value)
VALUES ('planning', jsonb_build_object(
          'release_auto_publish',   true,
          'release_effort_days',    0.25,
          'release_owner_role',     'mos_writer',
          'release_manual_platforms', '[]'::jsonb,
          'release_sweep_horizon_minutes', 15,
          -- A release more than this far past its moment is NOT auto-posted.
          -- Publishing is outward-facing and irreversible: a row dated last
          -- month must not suddenly appear on the real account because a sweep
          -- noticed it. Past this window it becomes a task and a person decides.
          'release_stale_hours', 24))
ON CONFLICT (key) DO UPDATE
  -- merge UNDER the stored value so an operator's existing edits win
  SET value = EXCLUDED.value || public.mos_settings.value;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. The publishing capacity bucket
-- ----------------------------------------------------------------------------
-- `mos_user_capacity.bucket` is free text on purpose, so this is a data seed,
-- not DDL. Everyone who can hold a release gets a default budget; the Capacity
-- screen edits it like any other bucket.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.mos_user_capacity (user_id, bucket, daily_slots)
SELECT DISTINCT u.id, 'publishing', 8::numeric
  FROM public.users u
  JOIN public.roles r
    ON r.key LIKE 'mos\_%' ESCAPE '\'
   AND r.id::text IN (SELECT e ->> 'role_id'
                        FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
 WHERE u.is_active
ON CONFLICT (user_id, bucket) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Manual-task kinds — `publish` joins the four system kinds
-- ────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mos_manual_tasks_kind_check') THEN
    ALTER TABLE public.mos_manual_tasks DROP CONSTRAINT mos_manual_tasks_kind_check;
  END IF;
  ALTER TABLE public.mos_manual_tasks ADD CONSTRAINT mos_manual_tasks_kind_check
    CHECK (kind IN ('manual','caption_review','refresh_decision','plan_conflict','ad_failed','publish'));
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Can this platform publish by itself?
-- ----------------------------------------------------------------------------
-- TRUE requires BOTH a connected account that is allowed to publish AND that
-- the operator has not deliberately kept the platform manual. It is never
-- inferred from the platform NAME: "instagram" says nothing about whether this
-- tenant's Instagram is actually connected.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_platform_automatable(p_platform text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((public.mos_planning_cfg() ->> 'release_auto_publish')::boolean, true)
     AND NOT COALESCE(
           public.mos_planning_cfg() -> 'release_manual_platforms' @> to_jsonb(p_platform), false)
     AND EXISTS (SELECT 1 FROM public.mos_platform_accounts a
                  WHERE a.platform = p_platform
                    AND a.archived_at IS NULL
                    AND a.is_connected IS TRUE
                    AND a.can_publish IS TRUE);
$$;

/** The map the planner reads: every platform we know about → automatable. */
CREATE OR REPLACE FUNCTION public.mos_platform_automatable_map()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_object_agg(p.platform, public.mos_platform_automatable(p.platform)), '{}'::jsonb)
    FROM (SELECT DISTINCT platform FROM public.mos_platform_accounts WHERE archived_at IS NULL) p;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. mos_release_v — ONE read that answers a publication task's three sections
-- ----------------------------------------------------------------------------
-- The task screen shows exactly three things and nothing else:
--   (a) the final ready content   — the approved asset + the caption
--   (b) where it is going          — platform, account, date, time
--   (c) what that platform demands — checked by the shared rulebook in the API
-- so this view carries (a) and (b) plus the facts (c) needs, and deliberately
-- carries NO brief, references, revision history or approval state.
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.mos_release_v;
CREATE VIEW public.mos_release_v
WITH (security_invoker = true) AS
SELECT p.id                                   AS release_id,
       'organic'::text                        AS kind,
       p.content_id,
       c.ref                                  AS content_ref,
       c.title                                AS content_title,
       c.project_id,
       p.campaign_id,
       p.execution_id,
       p.batch_id,
       -- (b) where it is going
       p.platform,
       p.account_id,
       a.handle                               AS account_handle,
       a.is_connected                         AS account_connected,
       a.can_publish                          AS account_can_publish,
       COALESCE(p.scheduled_at, p.planned_at) AS due_at,
       p.scheduled_timezone,
       p.status,
       p.published_at,
       p.external_url,
       p.bundle_post_id,
       p.bundle_status,
       p.bundle_error,
       -- (a) the final ready content
       COALESCE(NULLIF(p.caption, ''), c.data ->> 'caption') AS caption,
       -- `asset_ids` is uuid[]; the legacy single `asset_id` is folded in so a
       -- release always reports its material one way.
       COALESCE(NULLIF(p.asset_ids, '{}'::uuid[]),
                CASE WHEN p.asset_id IS NULL THEN '{}'::uuid[]
                     ELSE ARRAY[p.asset_id] END)             AS asset_ids,
       p.file_id,
       -- readiness inputs
       public.mos_platform_automatable(p.platform)           AS automatable,
       (SELECT t.id FROM public.mos_manual_tasks t
         WHERE t.kind = 'publish' AND t.ref_id = p.id AND t.status = 'open'
         LIMIT 1)                                            AS open_task_id
  FROM public.mos_publications p
  JOIN public.mos_content c ON c.id = p.content_id
  LEFT JOIN public.mos_platform_accounts a ON a.id = p.account_id;

REVOKE ALL ON public.mos_release_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_release_v TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. mos_release_open_task — raise the publication task, idempotently
-- ----------------------------------------------------------------------------
-- Called ONLY when a person is genuinely needed. `p_reason` is recorded so the
-- task can say why it exists rather than appearing as unexplained work.
--
-- The insert lands on mos_manual_tasks, which already carries a STATEMENT-level
-- ledger-lock trigger, so the advisory protocol has no hole here.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_release_open_task(
  p_publication_id uuid,
  p_reason text,
  p_detail text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rel      record;
  v_existing uuid;
  v_owner    uuid;
  v_role     text := COALESCE(public.mos_planning_cfg() ->> 'release_owner_role', 'mos_writer');
  v_id       uuid;
  v_title    text;
BEGIN
  SELECT * INTO v_rel FROM public.mos_release_v WHERE release_id = p_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:RELEASE_NOT_FOUND %', p_publication_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Already raised, still open → hand back the same task. A release must never
  -- accumulate duplicate tasks across sweep ticks.
  SELECT id INTO v_existing FROM public.mos_manual_tasks
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open' LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- A finished release needs no task.
  IF v_rel.status IN ('published','cancelled') THEN RETURN NULL; END IF;

  -- Owner. `assignee_user_id` AND `created_by_user_id` are both NOT NULL — the
  -- first live run of this split found that immediately — so a release task
  -- cannot "open unassigned". It needs a real owner, resolved through a
  -- fallback chain, and a release that lands on NOBODY is reported LOUDLY
  -- rather than silently skipped: an invisible un-publishable release is
  -- exactly the failure this split exists to remove.

  -- 1. whoever holds the configured release role, most publishing headroom first
  SELECT u.id INTO v_owner
    FROM public.users u
    JOIN public.roles r
      ON r.key = v_role
     AND r.id::text IN (SELECT e ->> 'role_id'
                          FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
   WHERE u.is_active
   ORDER BY public.mos_user_daily_slots(u.id, 'publishing') DESC, u.id
   LIMIT 1;

  -- 2. the marketing manager, who can always reassign it
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key = 'mos_marketing_manager'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active ORDER BY u.id LIMIT 1;
  END IF;

  -- 3. anyone who works in marketing at all
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key LIKE 'mos\_%' ESCAPE '\'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active ORDER BY u.id LIMIT 1;
  END IF;

  IF v_owner IS NULL THEN
    RAISE WARNING 'MOS:RELEASE_UNASSIGNABLE % (%) — no active marketing user to own it', p_publication_id, p_reason;
    RETURN NULL;
  END IF;

  v_title := 'نشر — ' || COALESCE(v_rel.content_title, v_rel.content_ref, '') ||
             ' · ' || v_rel.platform;

  -- `created_by_user_id` mirrors the assignee, the pattern the Meta caption
  -- task already uses for system-created work: the system has no user of its own.
  INSERT INTO public.mos_manual_tasks
    (title, details, assignee_user_id, created_by_user_id, campaign_id, content_id, project_id,
     status, due_at, kind, ref_id, entity_kind, entity_id, action)
  VALUES (
    left(v_title, 200),
    COALESCE(p_detail, CASE p_reason
      WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
      WHEN 'preflight_blocked'        THEN 'متطلبات المنصة غير مستوفاة — عالجها ثم انشر.'
      WHEN 'publish_failed'           THEN 'فشل النشر الآلي — راجع السبب ثم أعد المحاولة.'
      ELSE 'يحتاج النشر إلى تدخل يدوي.' END),
    v_owner, v_owner, v_rel.campaign_id, v_rel.content_id, v_rel.project_id,
    'open', v_rel.due_at, 'publish', p_publication_id, 'publication', p_publication_id, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. mos_release_close_task — a release that went out closes its own task
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_release_close_task(p_publication_id uuid, p_note text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.mos_manual_tasks
     SET status = 'done', closed_at = now(),
         closed_by_user_id = public.wassell_app_user_id(auth.uid()),
         done_note = COALESCE(p_note, done_note)
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- A publication reaching `published` (by the sweep, by bundle's status poll, or
-- by hand) closes its task without anybody remembering to.
CREATE OR REPLACE FUNCTION public.mos_tg_release_close_task()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status IN ('published','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.mos_release_close_task(NEW.id, 'أُغلقت تلقائيًا: ' || NEW.status);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mos_publications_close_release_task ON public.mos_publications;
CREATE TRIGGER mos_publications_close_release_task
  AFTER UPDATE OF status ON public.mos_publications
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_release_close_task();

-- ────────────────────────────────────────────────────────────────────────────
-- 8. mos_release_due — what the sweep should act on
-- ----------------------------------------------------------------------------
-- Returns every release whose moment has arrived, saying for each whether the
-- system can publish it or a person must. The CALLER (api/cron/release-sweep)
-- performs the automatic ones, because publishing goes through bundle.social
-- and SQL cannot reach it; this function never pretends to publish.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_release_due(p_horizon_minutes int DEFAULT NULL)
RETURNS TABLE (
  release_id uuid, content_id uuid, platform text, account_id uuid,
  due_at timestamptz, automatable boolean, reason text, open_task_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.release_id, r.content_id, r.platform, r.account_id, r.due_at, r.automatable,
         CASE
           WHEN r.automatable THEN NULL
           WHEN NOT EXISTS (SELECT 1 FROM public.mos_platform_accounts a
                             WHERE a.platform = r.platform AND a.archived_at IS NULL)
             THEN 'platform_not_automatable'
           WHEN public.mos_planning_cfg() -> 'release_manual_platforms' @> to_jsonb(r.platform)
             THEN 'manual_by_policy'
           ELSE 'account_not_connected'
         END AS reason,
         r.open_task_id
    FROM public.mos_release_v r
   WHERE r.status IN ('planned','draft','scheduled')
     AND r.due_at IS NOT NULL
     AND r.due_at <= now() + make_interval(
           mins => COALESCE(p_horizon_minutes,
                            (public.mos_planning_cfg() ->> 'release_sweep_horizon_minutes')::int,
                            15))
   ORDER BY r.due_at;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. mos_release_sweep — raise tasks for everything a person must do
-- ----------------------------------------------------------------------------
-- Deliberately only the MANUAL half. The automatic half needs an HTTP call to
-- bundle.social and is driven by the cron endpoint, which reports failures back
-- through mos_release_open_task(…, 'publish_failed').
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_release_sweep()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r record; v_opened int := 0; v_seen int := 0; v_unassignable int := 0; v_task uuid;
BEGIN
  PERFORM public.mos_ledger_lock();
  FOR r IN SELECT * FROM public.mos_release_due(NULL) LOOP
    v_seen := v_seen + 1;
    CONTINUE WHEN r.automatable OR r.open_task_id IS NOT NULL;
    v_task := public.mos_release_open_task(r.release_id, COALESCE(r.reason, 'manual'));
    IF v_task IS NOT NULL THEN v_opened := v_opened + 1;
    ELSE v_unassignable := v_unassignable + 1;   -- visible, never a silent gap
    END IF;
  END LOOP;
  RETURN jsonb_build_object('due', v_seen, 'tasks_opened', v_opened,
                            'unassignable', v_unassignable);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. The shortened content paths — new workflow versions
-- ----------------------------------------------------------------------------
-- A NEW version, never an edit of the live one: content already in production
-- is pinned to its version and must keep walking the chain it started on.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r        record;
  v_steps  jsonb;
  v_next   int;
  v_made   int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (v.workflow_id)
           v.workflow_id, v.version_no, v.definition
      FROM public.workflow_versions v
     WHERE v.definition -> 'metadata' ->> 'key' IN ('post_std','video_std')
     ORDER BY v.workflow_id, v.version_no DESC
  LOOP
    -- already shortened? then this migration has run before
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.definition -> 'metadata' -> 'steps') s
                    WHERE s ->> 'key' IN ('scheduling','publish_check')) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb) INTO v_steps
      FROM jsonb_array_elements(r.definition -> 'metadata' -> 'steps')
           WITH ORDINALITY t(s, ord)
     WHERE s ->> 'key' NOT IN ('scheduling','publish_check');

    SELECT COALESCE(max(version_no), 0) + 1 INTO v_next
      FROM public.workflow_versions WHERE workflow_id = r.workflow_id;

    INSERT INTO public.workflow_versions (workflow_id, version_no, definition)
    VALUES (r.workflow_id, v_next,
            jsonb_set(r.definition, '{metadata,steps}', v_steps));
    v_made := v_made + 1;
  END LOOP;
  RAISE NOTICE 'release split: % shortened workflow version(s) created', v_made;
END $$;

-- The final approval must still carry the auto-meta-ad flag and the caption
-- requirement after the rewrite. Loud, because silently losing either would
-- break ad creation or let a caption-less writing task pass.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM (SELECT DISTINCT ON (v.workflow_id) v.definition
            FROM public.workflow_versions v
           WHERE v.definition -> 'metadata' ->> 'key' IN ('post_std','video_std')
           ORDER BY v.workflow_id, v.version_no DESC) latest
   WHERE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(latest.definition -> 'metadata' -> 'steps') s
            WHERE (s ->> 'auto_meta_ad')::boolean IS TRUE)
      OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(latest.definition -> 'metadata' -> 'steps') s
            WHERE s -> 'required_fields' @> '["caption"]'::jsonb);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'MOS:RELEASE_SPLIT_LOST_FLAGS — % latest version(s) lost auto_meta_ad or the caption requirement', v_bad;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 11. The three stranded publish checks
-- ----------------------------------------------------------------------------
-- Open since 2026-09-12, unassigned, owned by a role nobody holds. Their
-- creatives ARE finished; what was missing was a real release. Close each one
-- and let the release path own the work instead.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t record; v_closed int := 0; v_tasks int := 0; v_pub uuid;
BEGIN
  PERFORM public.mos_ledger_lock();
  FOR t IN
    SELECT id, subject_id FROM public.workflow_role_tasks
     WHERE status = 'open' AND step_key IN ('scheduling','publish_check')
  LOOP
    -- Every destination this creative actually has becomes its own release
    -- task, but ONLY where a person is needed — the whole point of the split.
    FOR v_pub IN
      SELECT r.release_id FROM public.mos_release_v r
       WHERE r.content_id = t.subject_id
         AND r.status NOT IN ('published','cancelled')
         AND r.automatable IS FALSE
    LOOP
      IF public.mos_release_open_task(v_pub, 'platform_not_automatable',
           'مُحوَّلة من مهمة «تأكيد النشر» القديمة عند فصل الإنشاء عن النشر.') IS NOT NULL THEN
        v_tasks := v_tasks + 1;
      END IF;
    END LOOP;

    UPDATE public.workflow_role_tasks
       SET status = 'done', result = 'approved', closed_at = now(),
           note = COALESCE(note || ' · ', '') ||
                  'أُغلقت آليًا: صار النشر مهمة مستقلة لكل وجهة (فصل الإنشاء عن النشر، ٢٠٢٦-٠٩-١٤).'
     WHERE id = t.id;
    v_closed := v_closed + 1;
  END LOOP;
  RAISE NOTICE 'release split: closed % stranded publishing task(s), opened % release task(s)', v_closed, v_tasks;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. Grants
-- ────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.mos_platform_automatable(text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_platform_automatable_map()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_release_open_task(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_release_close_task(uuid, text)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_release_due(int)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_release_sweep()                  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.mos_platform_automatable(text)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_platform_automatable_map()       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_release_due(int)                 TO authenticated, service_role;
-- Writers: service_role only. The API calls them after its own capability gate,
-- same posture as the other planning writers.
GRANT EXECUTE ON FUNCTION public.mos_release_open_task(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_release_close_task(uuid, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_release_sweep()                  TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 13. WS409/WS429 assertion — no new function may raise a retryable sqlstate
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('mos_release_open_task','mos_release_close_task','mos_release_sweep',
                       'mos_release_due','mos_platform_automatable','mos_platform_automatable_map',
                       'mos_tg_release_close_task')
     AND (pg_get_functiondef(p.oid) ~ '40001' OR pg_get_functiondef(p.oid) ~ '40P01');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in %', v_bad;
  END IF;
END $$;
