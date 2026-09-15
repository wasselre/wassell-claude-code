-- ============================================================================
-- CV daily video cap  (2026-09-15)
--
-- Operator decision: the visual pipeline processes at most 10 NEW videos per
-- day. Backfills are what made this system expensive — the entire $53-58 of
-- Modal spend to date came from one batch on 2 September that pushed 653 videos
-- through in two days. At the real inflow rate (~95 competitor videos in
-- August) a 10/day cap is roughly 3x headroom over normal traffic, and a hard
-- stop on ever repeating that batch by accident.
--
-- WHY THE CAP LIVES IN THE CLAIM RPC, not in checkBudget():
-- `checkBudget()` throws `budget_exceeded:`, which mkt_cv_job_fail treats as
-- TERMINAL — no requeue. That is right for a money ceiling (stop spending) and
-- completely wrong for a rate limit: the 11th video of the day would fail
-- permanently instead of waiting for tomorrow. Gating the CLAIM means the job
-- simply is not handed out; it stays `queued`, keeps its place in priority
-- order, and is picked up after midnight Riyadh. Nothing is spent, nothing is
-- lost, and no error is recorded for a video that did nothing wrong.
--
-- WHAT COUNTS AS "A VIDEO":
--   * `cv_process` only — the heavy per-video pipeline (shot detection, frame
--     extraction, embeddings, OCR). This is the kind that costs money.
--   * NOT `cv_analyze` / `cv_describe_frame`: follow-up work on a video the cap
--     already admitted. Blocking those would strand half-processed videos.
--   * NOT `cv_embed_wassel`: our own assets on the cheap embed path (556 rows,
--     averaging 0.5 s — they are stills, not videos). Counting them would let
--     ten thumbnails consume a day of video quota.
--   * DISTINCT video_id, so a retry of the same video does not burn a second
--     slot. Ten videos means ten videos, not ten attempts.
-- ============================================================================

-- Default 10; operator-editable like every other cv.* setting.
INSERT INTO public.mkt_settings (key, value)
VALUES ('cv.max_videos_per_day', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;

/**
 * Distinct videos admitted to the heavy pipeline so far today (Riyadh day, the
 * same boundary mkt_cv_cost_today() uses). Counts CLAIMS rather than
 * completions: a video that is still running has already committed its spend,
 * so it must hold its slot.
 */
CREATE OR REPLACE FUNCTION public.mkt_cv_videos_today()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(DISTINCT video_id)::int
    FROM public.mkt_cv_jobs
   WHERE kind = 'cv_process'
     AND started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh';
$function$;

COMMENT ON FUNCTION public.mkt_cv_videos_today IS
  'Distinct videos claimed into cv_process today (Riyadh). The numerator of the cv.max_videos_per_day cap.';

/** The cap itself, as a number, so callers do not re-read the setting. */
CREATE OR REPLACE FUNCTION public.mkt_cv_video_cap()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT (value)::int FROM public.mkt_settings WHERE key = 'cv.max_videos_per_day'), 10);
$function$;

/** True while there is room for another video today. */
CREATE OR REPLACE FUNCTION public.mkt_cv_video_cap_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.mkt_cv_videos_today() < public.mkt_cv_video_cap();
$function$;

-- ---------------------------------------------------------------------------
-- The claim RPC, re-emitted with the cap.
--
-- Only ONE clause changes: when the caller asks for cv_process and the day is
-- full, cv_process is dropped from the candidate kinds. Everything else —
-- the enabled check, the FOR UPDATE SKIP LOCKED claim, the ordering, the
-- lease, the attempts increment — is byte-identical to the live definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mkt_cv_job_claim_next(
  p_worker_id text,
  p_kinds text[],
  p_lease_seconds integer DEFAULT 900
)
RETURNS TABLE(job_id uuid, kind text, video_id uuid, frame_id uuid, params jsonb, attempts integer, max_attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_kinds text[] := p_kinds;
BEGIN
  IF NOT public.mkt_cv_enabled() THEN RETURN; END IF;

  -- Daily video cap: drop cv_process from what this claim may take once the
  -- day is full, leaving the queued rows untouched for tomorrow. Follow-up
  -- kinds stay claimable so videos already admitted can finish.
  IF 'cv_process' = ANY(v_kinds) AND NOT public.mkt_cv_video_cap_ok() THEN
    v_kinds := array_remove(v_kinds, 'cv_process');
    IF v_kinds IS NULL OR array_length(v_kinds, 1) IS NULL THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  UPDATE public.mkt_cv_jobs j
     SET status = 'running',
         worker_id = p_worker_id,
         started_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1
   WHERE j.id = (
           SELECT c.id FROM public.mkt_cv_jobs c
            WHERE c.status = 'queued'
              AND c.next_run_at <= now()
              AND c.kind = ANY(v_kinds)
            ORDER BY c.priority, c.next_run_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
  RETURNING j.id, j.kind, j.video_id, j.frame_id, j.params, j.attempts, j.max_attempts;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Health: surface the cap next to the budget, so "why is nothing running"
-- has an answer without reading code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mkt_cv_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'enabled', public.mkt_cv_enabled(),
    -- `paused` now also covers the daily video cap: all three are reasons the
    -- lane is deliberately idle rather than broken.
    'paused', (NOT public.mkt_cv_enabled()) OR (NOT public.mkt_cv_budget_ok()) OR (NOT public.mkt_cv_video_cap_ok()),
    'videos', (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM public.mkt_cv_videos GROUP BY status) x),
    'shots', (SELECT COALESCE(jsonb_object_agg(analysis_status, n), '{}'::jsonb) FROM (SELECT analysis_status, count(*) n FROM public.mkt_cv_shots GROUP BY analysis_status) x),
    'frames', (SELECT count(*) FROM public.mkt_cv_frames),
    'keyframes_described', (SELECT count(*) FROM public.mkt_cv_frames WHERE analysis IS NOT NULL),
    'jobs', (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT kind || ':' || status AS k, count(*) n FROM public.mkt_cv_jobs GROUP BY kind, status) x),
    'oldest_running_s', (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(started_at)))::int, 0) FROM public.mkt_cv_jobs WHERE status = 'running'),
    'cost_today_usd', public.mkt_cv_cost_today(),
    'cost_month_usd', (SELECT COALESCE(sum(cost_usd),0) FROM public.mkt_cv_cost_ledger WHERE created_at >= date_trunc('month', now())),
    'budget_usd', COALESCE((SELECT (value)::numeric FROM public.mkt_settings WHERE key='cv.daily_budget_usd'), 30),
    'budget_ok', public.mkt_cv_budget_ok(),
    'videos_today', public.mkt_cv_videos_today(),
    'videos_cap', public.mkt_cv_video_cap(),
    'video_cap_ok', public.mkt_cv_video_cap_ok());
$function$;
