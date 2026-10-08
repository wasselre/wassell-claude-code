-- 2026-10-08: RAW CAPTURE of every image, goal-free (operator decision).
--
-- Until now each reading was shaped by one goal (which project a post promotes;
-- a design read in fixed categories), so anything outside those boxes was lost.
-- The raw capture records EVERYTHING in an image once — every text copied
-- exactly with its position, size, typeface, weight and colour; the scene,
-- objects, people, lighting, camera; composition; colours with hex and share;
-- typography; graphics; branding; materials; mood; a designer's description and
-- a recreate brief — so agents (real-estate copy, real-estate design, luxury
-- design, luxury-tone copy, …) can each be built from the same raw library
-- later, with classification done afterwards from the stored text.
--
-- Model: gpt-6-luna (chosen 2026-10-08 after a 20-image blind test against
-- gpt-6.1-sol: real errors on 7 vs 4 images, ~$0.0023 vs ~$0.052 per image).
-- Every row records its model and schema version, so a later re-capture with
-- another model sits beside it (unique per media × model × version).
-- Worker: worker/src/marketing/content/rawCapture.ts; content_process mode
-- 'raw_capture'; the sweep enqueues posts from mkt_raw_capture_due.
BEGIN;

CREATE TABLE IF NOT EXISTS public.mkt_media_raw_capture (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_media_id uuid NOT NULL REFERENCES public.mkt_content_media(id) ON DELETE CASCADE,
  content_post_id  uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  model            text NOT NULL,
  schema_version   text NOT NULL,
  status           text NOT NULL CHECK (status IN ('done', 'failed')),
  capture          jsonb,
  failure_reason   text,
  attempts         integer NOT NULL DEFAULT 1,
  cost_usd         numeric,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_media_id, model, schema_version)
);
CREATE INDEX IF NOT EXISTS mkt_media_raw_capture_post_idx ON public.mkt_media_raw_capture (content_post_id);
CREATE INDEX IF NOT EXISTS mkt_media_raw_capture_org_idx  ON public.mkt_media_raw_capture (organization_id);

ALTER TABLE public.mkt_media_raw_capture ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_media_raw_capture_read ON public.mkt_media_raw_capture;
CREATE POLICY mkt_media_raw_capture_read ON public.mkt_media_raw_capture FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.mkt_media_raw_capture FROM anon;
-- Writes: service role only (the worker); no insert/update policy for users.

-- Switch, model, daily cap. Pause key written by the worker on an empty OpenAI balance.
INSERT INTO public.mkt_settings (key, value, updated_at)
VALUES ('content.raw_capture', '{"enabled": true, "model": "gpt-6-luna", "daily_budget_usd": 40}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Posts that still have a stored image with no capture for this model + schema
-- version (and fewer than 3 failed attempts). Newest posts first.
CREATE OR REPLACE FUNCTION public.mkt_raw_capture_due(p_model text, p_schema_version text, p_limit int DEFAULT 200)
RETURNS TABLE(content_post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id
    FROM mkt_content_posts p
   WHERE EXISTS (
     SELECT 1 FROM mkt_content_media m
      WHERE m.content_post_id = p.id AND m.media_kind = 'image' AND m.download_status = 'stored'
        AND NOT EXISTS (
          SELECT 1 FROM mkt_media_raw_capture c
           WHERE c.content_media_id = m.id AND c.model = p_model AND c.schema_version = p_schema_version
             AND (c.status = 'done' OR c.attempts >= 3)))
   ORDER BY p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.mkt_raw_capture_due(text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_raw_capture_due(text, text, int) TO service_role;

COMMIT;
