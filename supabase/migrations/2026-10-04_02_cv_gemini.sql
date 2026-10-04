-- Visual Intelligence moves from Modal to Gemini (2026-10-04).
--
-- Why: a blind bake-off on 20 competitor videos (10 independent reviewers)
-- ranked the old Modal OCR worst on all 20 — text accuracy 2.8/10, coverage
-- 2.4/10, 174 invented lines — while Gemini 3.8 Flash watching the whole video
-- scored 8.8 / 9.7 with 4 invented lines in total. So every stored reading is
-- rebuilt, and the vectors with it: Gemini's embedding model is not comparable
-- with Modal's SigLIP-2 / bge-m3, so old and new vectors must never be mixed in
-- one search.
--
-- APPLY ORDER: after the worker that understands provider 'gemini' is deployed
-- and GEMINI_API_KEY is set on Fly. An older worker ignores the role change
-- (it rejects the unknown provider and keeps Modal) but WOULD claim the jobs
-- this enqueues once cv.enabled is on.
--
--   1. ai_price_book: Gemini rates (cited) — a fallback; the code passes the
--      exact cost of every call it makes.
--   2. mos_settings.ai_roles: embed_text / embed_image → gemini-embedding-2.
--   3. mkt_cv_reset_video(): the re-run deletes a video's old shots/frames.
--      mkt_cv_job_defer(): a per-DAY Gemini quota refusal puts the job back
--      for Google's retry time WITHOUT spending an attempt.
--   4. Clear every Modal-era vector (shots, frames, post embeddings).
--   5. Queue every competitor video and every processable Wassel asset.
--   6. Settings: cv.enabled on, at most 500 new videos a day.

BEGIN;

-- 1 ── prices ─────────────────────────────────────────────────────────────────
-- https://ai.google.dev/gemini-api/docs/pricing (paid tier, read 2026-10-04).
INSERT INTO public.ai_price_book (provider, model, input_per_m, output_per_m, effective_from, source, notes, updated_at)
VALUES
  ('gemini', 'gemini-3.8-flash', 0.75, 3.75, '-infinity', 'https://ai.google.dev/gemini-api/docs/pricing (read 2026-10-04)',
   'Output includes thinking tokens. Rate doubles on 2027-01-01 (next row).', now()),
  ('gemini', 'gemini-3.8-flash', 1.50, 7.50, '2027-01-01T00:00:00Z', 'https://ai.google.dev/gemini-api/docs/pricing (read 2026-10-04)',
   'Announced price from 2027-01-01.', now()),
  ('gemini', 'gemini-embedding-2', 0.20, NULL, '-infinity', 'https://ai.google.dev/gemini-api/docs/pricing (read 2026-10-04)',
   'Text input $0.20/M; IMAGE input $0.45/M ($0.00012 per image). The code prices each call by modality and passes cost_usd; this row is the text-rate fallback.', now())
ON CONFLICT (provider, model, effective_from) DO UPDATE SET
  input_per_m = EXCLUDED.input_per_m, output_per_m = EXCLUDED.output_per_m,
  source = EXCLUDED.source, notes = EXCLUDED.notes, updated_at = now();

-- 2 ── embedding roles ────────────────────────────────────────────────────────
UPDATE public.mos_settings
   SET value = jsonb_set(jsonb_set(value,
         '{embed_text}',  '{"provider":"gemini","model":"gemini-embedding-2","version":"g2","dim":1024}'::jsonb, true),
         '{embed_image}', '{"provider":"gemini","model":"gemini-embedding-2","version":"g2","dim":768}'::jsonb, true),
       updated_at = now()
 WHERE key = 'ai_roles';

-- 3 ── reset helper ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_cv_reset_video(p_video_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n_frames int; n_shots int;
BEGIN
  DELETE FROM public.mkt_cv_dup_groups WHERE video_id = p_video_id;
  DELETE FROM public.mkt_cv_frames WHERE video_id = p_video_id;
  GET DIAGNOSTICS n_frames = ROW_COUNT;
  DELETE FROM public.mkt_cv_shots WHERE video_id = p_video_id;
  GET DIAGNOSTICS n_shots = ROW_COUNT;
  RETURN jsonb_build_object('frames', n_frames, 'shots', n_shots);
END; $$;
REVOKE ALL ON FUNCTION public.mkt_cv_reset_video(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_cv_reset_video(uuid) TO service_role;
COMMENT ON FUNCTION public.mkt_cv_reset_video(uuid) IS
  'Delete a video''s shots, frames and dup groups before the Gemini pipeline writes its new reading. Service role only.';

-- A daily quota is not the job's fault: give the attempt back, wait, retry.
-- Only a RUNNING job is touched (same race posture as complete/fail).
CREATE OR REPLACE FUNCTION public.mkt_cv_job_defer(p_job_id uuid, p_seconds int, p_error text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE j record;
BEGIN
  SELECT * INTO j FROM public.mkt_cv_jobs WHERE id = p_job_id AND status = 'running';
  IF NOT FOUND THEN RETURN 'noop'; END IF;
  UPDATE public.mkt_cv_jobs
     SET status = 'queued', attempts = GREATEST(j.attempts - 1, 0), error = LEFT(p_error, 2000),
         worker_id = NULL, lease_expires_at = NULL,
         next_run_at = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_seconds, 3600), 60), 172800))
   WHERE id = p_job_id;
  IF j.video_id IS NOT NULL THEN
    UPDATE public.mkt_cv_videos SET status = 'queued', updated_at = now() WHERE id = j.video_id AND status = 'processing';
  END IF;
  RETURN 'deferred';
END; $$;
REVOKE ALL ON FUNCTION public.mkt_cv_job_defer(uuid, int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_cv_job_defer(uuid, int, text) TO service_role;

-- 4 ── clear Modal-era vectors ────────────────────────────────────────────────
-- Search degrades to its lexical channel for a video until it is re-run.
UPDATE public.mkt_cv_shots  SET embedding_visual = NULL, embedding_text = NULL
 WHERE embedding_visual IS NOT NULL OR embedding_text IS NOT NULL;
UPDATE public.mkt_cv_frames SET embedding = NULL WHERE embedding IS NOT NULL;
-- Post embeddings for the script writer's exemplar search: rebuilt right after
-- this migration by `node scripts/backfill-post-embeddings.mjs` (Gemini, 1024-d).
DELETE FROM public.mkt_content_embeddings WHERE model IS DISTINCT FROM 'gemini-embedding-2';

-- 5 ── queue everything ───────────────────────────────────────────────────────
-- Every existing video (stuck 'processing' / 'analyzing' ones included) is redone.
UPDATE public.mkt_cv_videos SET status = 'queued', error = NULL, updated_at = now()
 WHERE status <> 'queued';

DO $q$
DECLARE r record; n_comp int := 0; n_wassel int := 0;
BEGIN
  FOR r IN SELECT cm.id FROM public.mkt_content_media cm
            WHERE cm.media_kind = 'video' AND cm.download_status = 'stored' AND cm.stored_url IS NOT NULL
  LOOP
    PERFORM public.mkt_cv_enqueue_video(r.id, 100);
    n_comp := n_comp + 1;
  END LOOP;
  SELECT count(*) INTO n_wassel FROM public.mkt_cv_enqueue_wassel_backlog(100000, NULL, ARRAY['video','photo']);
  RAISE NOTICE 'cv gemini re-run queued: % competitor videos, % wassel assets', n_comp, n_wassel;
END $q$;
-- Every queued job (Modal-era leftovers and the ones just created) starts
-- fresh with 5 attempts: Gemini overload bursts can eat a few.
UPDATE public.mkt_cv_jobs SET attempts = 0, max_attempts = 5, error = NULL, next_run_at = now()
 WHERE status = 'queued';

-- 6 ── switches ───────────────────────────────────────────────────────────────
-- 500 new videos a day ≈ $15/day at the measured ~$0.03 per video; the daily
-- budget (cv.daily_budget_usd = 30) stays as the hard stop.
INSERT INTO public.mkt_settings (key, value, updated_at) VALUES ('cv.max_videos_per_day', '500'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
INSERT INTO public.mkt_settings (key, value, updated_at) VALUES ('cv.enabled', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
