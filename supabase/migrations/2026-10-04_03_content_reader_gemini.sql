-- Competitor posts are read by Gemini, not the Claude runner (2026-10-04).
--
-- content_process now reads each post's media with ONE gemini-3.8-flash call
-- (on-screen text + the project pick with a verbatim quote + the structured
-- fields), runs the same proof checker, and finishes the post itself. The
-- runner's two competitor lanes (mkt_visual_ocr, mkt_content_enrichment) are
-- no longer fed. Chosen by two blind 60-post tests (runner, Kimi K3).
--
--   content.reader                     'gemini' | 'runner' — the switch; setting
--                                      it back to 'runner' restores the old path
--                                      with no deploy.
--   content.reader_daily_budget_usd    the sweep stops starting reads for the
--                                      rest of the Riyadh day once the reader's
--                                      metered spend reaches it.
--   content.reader_paused_until        written by the worker when Gemini refuses
--                                      with a per-DAY quota; reads resume after it.

BEGIN;

INSERT INTO public.mkt_settings (key, value, updated_at) VALUES
  ('content.reader', '"gemini"'::jsonb, now()),
  ('content.reader_daily_budget_usd', '25'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Runner reading jobs still waiting would spend the subscription on posts the
-- Gemini reader re-reads anyway. A job already running is left to finish.
UPDATE public.claude_jobs
   SET status = 'cancelled'
 WHERE kind IN ('mkt_visual_ocr', 'mkt_content_enrichment')
   AND status = 'pending';

COMMIT;
