-- 2026-09-30 — A failed handoff is retried a few times, then waits for a person.
--
-- WHAT HAPPENED (29–30 Sep). The release sweep was written to leave a failed
-- release alone "because a person has been asked" — it skipped any release
-- with an open publish TASK. Publishing tasks are off (operator rule,
-- 2026-09-27): a failure records a HOLD on the release instead, and a hold is
-- not a task. So nothing told the sweep to stop. When bundle.social's plan
-- caps refused the three يمام 17 posts (6 releases) on the evening of 29 Sep,
-- the sweep re-sent all six every five minutes through the night. Each attempt
-- uploads the design to bundle BEFORE the post is created, so by 02:20 UTC the
-- month's 200-upload quota was gone too — spent on retries that could not
-- succeed. No notification was sent and nothing was posted twice; the cost was
-- the quota and roughly 800 pointless retries (an estimate: ~164 ticks, five
-- releases reached per tick before the 25-second stop). The same loop would
-- hammer bundle on any outage.
--
-- THE RULE NOW.
--   • mos_publications.publish_attempts counts failed handoffs.
--   • mos_release_open_task('publish_failed') increments it on every call.
--   • mos_release_due stops offering a release once it has failed
--     planning.release_max_attempts times (default 3 → three ticks, ~15 min —
--     enough for a blip, bounded for a real refusal). It then waits on the
--     month page's «يحتاج قرارك» for «انشر الآن» or a new time.
--   • Anything that changes the release's status, time or bundle post clears
--     the hold AND resets the count (the existing hold-clear trigger).
--   • A REFUSAL (still in production, not approved, approval changed, a design
--     missing, the rulebook) is NOT a failed handoff: nothing is uploaded, it
--     costs nothing to re-check, and it clears itself on approval. It keeps
--     being re-checked every tick and is never counted.
--
-- ALSO HERE, TEMPORARY: an Instagram STORY release is not offered to the sweep
-- at all. The publisher had no story type — every 'story' release went out as
-- a caption-less FEED post (seven on the company account, 29–30 Sep). The fix
-- ships in the same commit as this file; `2026-09-30_05` removes this clause
-- and is applied only once that code is live.
--
-- Nothing here raises SQLSTATE 40001/40P01.
BEGIN;

ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.mos_publications.publish_attempts IS
  'Failed automatic handoffs since the release last changed status / time / bundle post. mos_release_due stops offering it at planning.release_max_attempts (default 3).';

-- ── the hold-clear trigger also resets the count ──────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_tg_publication_hold_clear()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     OR NEW.bundle_post_id IS DISTINCT FROM OLD.bundle_post_id THEN
    IF NEW.hold_reason IS NOT NULL THEN
      NEW.hold_reason := NULL;
      NEW.hold_detail := NULL;
      NEW.hold_at := NULL;
    END IF;
    -- A new time, a new status or a handoff is a fresh start.
    NEW.publish_attempts := 0;
  END IF;
  RETURN NEW;
END $function$;

-- ── the failure is counted; a refusal is not relabelled ───────────────────────
CREATE OR REPLACE FUNCTION public.mos_release_open_task(p_publication_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rel      record;
  v_existing uuid;
  v_owner    uuid;
  v_role     text := COALESCE(public.mos_planning_cfg() ->> 'release_owner_role', 'mos_writer');
  v_id       uuid;
  v_title    text;
BEGIN
  -- Publishing is not a task (2026-09-27). Off unless the setting says exactly
  -- true: no publish task is opened, by any caller. NULL is the function's own
  -- "nothing to open" answer, which every caller already handles.
  IF COALESCE(public.mos_planning_cfg() ->> 'publish_tasks_enabled', 'false') <> 'true' THEN
    -- Still no task — but never silence (2026-09-29). Until now this RETURNed
    -- and the release sat in 'planned' with nobody told: 12 posts missed their
    -- dates that way. The reason is recorded on the release itself, where the
    -- month page's «يحتاج قرارك» lists it with «انشر الآن / أعد الجدولة / ألغِ».
    -- Written only when it changes, so a 5-minute sweep re-refusing the same
    -- release does not rewrite the row every tick.
    IF p_reason = 'publish_failed' THEN
      -- (2026-09-30) A REFUSAL is not a failed handoff. The material rule has
      -- already recorded why on the release (in production, not approved, …);
      -- the sweep shipped before this date then re-reported the same refusal
      -- as a generic 'publish_failed', which would now be counted and stop the
      -- retries — stranding a post that is merely approved late. A real
      -- handoff failure always carries the platform's own message.
      IF position('bundle.social:' IN COALESCE(p_detail, '')) = 0
         AND EXISTS (SELECT 1 FROM public.mos_publications r
                      WHERE r.id = p_publication_id
                        AND r.hold_reason IN ('in_production', 'not_approved', 'approval_mismatch',
                                              'material_unresolved', 'preflight_blocked')) THEN
        RETURN NULL;
      END IF;
      -- Every failed handoff is COUNTED, including a repeat of the same error:
      -- the count is what stops the retries (see mos_release_due).
      UPDATE public.mos_publications r
         SET publish_attempts = r.publish_attempts + 1
       WHERE r.id = p_publication_id
         AND r.status NOT IN ('published', 'cancelled')
         AND r.bundle_post_id IS NULL;
    END IF;
    UPDATE public.mos_publications p
       SET hold_reason = p_reason,
           hold_detail = COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)),
           hold_at     = now()
     WHERE p.id = p_publication_id
       AND p.status NOT IN ('published', 'cancelled')
       AND p.bundle_post_id IS NULL
       AND (p.hold_reason IS DISTINCT FROM p_reason
            OR p.hold_detail IS DISTINCT FROM
               COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)));
    RETURN NULL;
  END IF;

  SELECT * INTO v_rel FROM public.mos_release_v WHERE release_id = p_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:RELEASE_NOT_FOUND %', p_publication_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_existing FROM public.mos_manual_tasks
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open' LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_rel.status IN ('published','cancelled') THEN RETURN NULL; END IF;

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
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- 3. anyone who works in marketing at all
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key LIKE 'mos\_%' ESCAPE '\'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- Nobody at all. Say so in the log instead of returning a quiet NULL that
  -- reads like "nothing to do": this release cannot go out and no one knows.
  IF v_owner IS NULL THEN
    RAISE WARNING 'MOS:RELEASE_UNASSIGNABLE % (%) — no active marketing user to own it', p_publication_id, p_reason;
    RETURN NULL;
  END IF;

  v_title := 'نشر — ' || COALESCE(v_rel.content_title, v_rel.content_ref, '') ||
             ' · ' || v_rel.platform;

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
END $function$;

-- ── the sweep's list: a release that keeps failing stops being offered ────────
CREATE OR REPLACE FUNCTION public.mos_release_due(p_horizon_minutes integer DEFAULT NULL::integer)
 RETURNS TABLE(release_id uuid, content_id uuid, platform text, account_id uuid, due_at timestamp with time zone, automatable boolean, reason text, open_task_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.release_id, r.content_id, r.platform, r.account_id, r.due_at, r.automatable,
         CASE
           WHEN r.automatable THEN NULL
           -- The switch, named as the switch (2026-09-29). This used to fall
           -- through to 'account_not_connected' while every account was connected.
           WHEN NOT COALESCE((public.mos_planning_cfg() ->> 'release_auto_publish')::boolean, true)
             THEN 'auto_publish_off'
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
     -- Already handed to bundle.social: the platform owns it now. Re-offering it
     -- made the sweep re-publish, get a 409 and log a false failure every tick.
     AND r.bundle_post_id IS NULL
     -- A handoff that has failed too many times is no longer offered (2026-09-30).
     -- It waits for «انشر الآن» or a new time, either of which resets the count.
     AND NOT EXISTS (SELECT 1 FROM public.mos_publications hp
                      WHERE hp.id = r.release_id
                        AND hp.hold_reason = 'publish_failed'
                        AND hp.publish_attempts >= COALESCE(
                              (public.mos_planning_cfg() ->> 'release_max_attempts')::int, 3))
     -- TEMPORARY (2026-09-30): an Instagram STORY is not handed off on its own
     -- until the publisher that can send one is live. Removed by 2026-09-30_05.
     AND NOT EXISTS (SELECT 1 FROM public.mos_publications sp
                      WHERE sp.id = r.release_id AND sp.platform = 'instagram'
                        AND sp.placement_variant = 'story')
     AND r.due_at IS NOT NULL
     AND r.due_at <= now() + make_interval(
           mins => COALESCE(p_horizon_minutes,
                            (public.mos_planning_cfg() ->> 'release_sweep_horizon_minutes')::int,
                            15))
   ORDER BY r.due_at;
$function$;

-- ── assertions ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_due text; v_open text;
BEGIN
  v_due  := pg_get_functiondef('public.mos_release_due(integer)'::regprocedure);
  v_open := pg_get_functiondef('public.mos_release_open_task(uuid, text, text)'::regprocedure);
  IF position('publish_attempts' IN v_due) = 0 THEN
    RAISE EXCEPTION 'RETRY_CAP: mos_release_due does not stop a release that keeps failing';
  END IF;
  IF position('publish_attempts' IN v_open) = 0 THEN
    RAISE EXCEPTION 'RETRY_CAP: mos_release_open_task does not count failed handoffs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'mos_publications'
                    AND column_name = 'publish_attempts') THEN
    RAISE EXCEPTION 'RETRY_CAP: mos_publications.publish_attempts is missing';
  END IF;
END $assert$;

COMMIT;
