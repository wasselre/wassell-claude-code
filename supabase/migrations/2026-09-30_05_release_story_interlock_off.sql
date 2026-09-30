-- 2026-09-30 — Instagram stories are handed off by the sweep again.
--
-- `2026-09-30_04` stopped the sweep from offering any Instagram STORY release,
-- because the publisher could not send one: it knew only POST and REEL, so a
-- release whose destination was 'story' went out as a caption-less FEED post
-- (seven on the company account, 29–30 Sep). The publisher now sends
-- `type: 'STORY'` (api/_lib/marketing/bundleSocial.ts `buildPlatformData`,
-- proven live on P-150: instagram.com/stories/wassel.re/…).
--
-- ORDER MATTERS: apply this ONLY after that code is deployed. Applied earlier,
-- the old publisher would post the next due story to the feed.
--
-- The function is otherwise identical to `2026-09-30_04` (the retry cap stays).
BEGIN;

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
     AND r.due_at IS NOT NULL
     AND r.due_at <= now() + make_interval(
           mins => COALESCE(p_horizon_minutes,
                            (public.mos_planning_cfg() ->> 'release_sweep_horizon_minutes')::int,
                            15))
   ORDER BY r.due_at;
$function$;

DO $assert$
DECLARE v_due text;
BEGIN
  v_due := pg_get_functiondef('public.mos_release_due(integer)'::regprocedure);
  IF position('placement_variant' IN v_due) > 0 THEN
    RAISE EXCEPTION 'STORY_INTERLOCK: mos_release_due still withholds Instagram stories';
  END IF;
  IF position('publish_attempts' IN v_due) = 0 THEN
    RAISE EXCEPTION 'STORY_INTERLOCK: the retry cap was lost while removing the interlock';
  END IF;
END $assert$;

COMMIT;
