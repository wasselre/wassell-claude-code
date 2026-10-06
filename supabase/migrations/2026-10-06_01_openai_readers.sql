-- 2026-10-06: OpenAI as a second engine for competitor post reading and image
-- design reads (operator decision after two blind bake-offs the same day):
--   post reading  → gpt-6-luna   (content.reader = 'openai')
--   design reads  → gpt-6.1-sol  (content.design_reader = 'openai')
-- Code: worker/src/ai/providers/openaiHttp.ts, marketing/content/openaiRead.ts,
-- marketing/content/geminiDesign.ts (engine switch).
--
-- SHIPPED DARK: this migration does NOT switch either setting. content.reader
-- keeps its current value and content.design_reader is created as 'gemini'.
-- Switching on = UPDATE mkt_settings SET value = '"openai"' for the key(s).
BEGIN;

-- 1 ── prices (cited) ─────────────────────────────────────────────────────────
-- https://developers.openai.com/api/docs/pricing (standard tier, read 2026-10-06).
-- Batch is half; cached input was not listed for these models.
INSERT INTO public.ai_price_book (provider, model, input_per_m, output_per_m, effective_from, source, notes, updated_at)
VALUES
  ('openai', 'gpt-6-luna', 0.10, 0.50, '-infinity', 'https://developers.openai.com/api/docs/pricing (read 2026-10-06)',
   'Standard tier. Batch $0.05/$0.25. Reasoning tokens are billed as output.', now()),
  ('openai', 'gpt-6.1-sol', 2.00, 10.00, '-infinity', 'https://developers.openai.com/api/docs/pricing (read 2026-10-06)',
   'Standard tier. Batch $1.00/$5.00. Reasoning tokens are billed as output.', now())
ON CONFLICT (provider, model, effective_from) DO UPDATE SET
  input_per_m = EXCLUDED.input_per_m, output_per_m = EXCLUDED.output_per_m,
  source = EXCLUDED.source, notes = EXCLUDED.notes, updated_at = now();

-- 2 ── the design engine switch (created OFF = Gemini) ──────────────────────────
INSERT INTO public.mkt_settings (key, value, updated_at)
VALUES ('content.design_reader', '"gemini"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- 3 ── posts still owed a design read, for either engine ───────────────────────
-- A post is owed a read while it has no DONE post-level read from either
-- engine, and the CURRENT engine has not failed on it 3 times. Posts decided by
-- either model reader (gemini… / gpt-…) qualify.
CREATE OR REPLACE FUNCTION public.mkt_design_read_due(p_limit int DEFAULT 200)
RETURNS TABLE(content_post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH eng AS (
    SELECT CASE WHEN (SELECT value FROM mkt_settings WHERE key = 'content.design_reader') = '"openai"'::jsonb
                THEN 'openai:gpt-6.1-sol' ELSE 'gemini:gemini-3.8-flash' END AS model_used
  )
  SELECT p.id
    FROM mkt_content_posts p
    JOIN mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
                                 AND (e.model LIKE 'gemini%' OR e.model LIKE 'gpt-%')
   WHERE EXISTS (SELECT 1 FROM mkt_content_media m WHERE m.content_post_id = p.id AND m.media_kind = 'image' AND m.download_status = 'stored')
     AND NOT EXISTS (SELECT 1 FROM mkt_content_media v WHERE v.content_post_id = p.id AND v.media_kind = 'video' AND v.download_status = 'stored')
     AND NOT EXISTS (
       SELECT 1 FROM visual_design_reads r
        WHERE r.subject_kind = 'competitor_post' AND r.subject_id = p.id AND r.level = 'post'
          AND r.model_used IN ('gemini:gemini-3.8-flash', 'openai:gpt-6.1-sol') AND r.status = 'done')
     AND NOT EXISTS (
       SELECT 1 FROM visual_design_reads r, eng
        WHERE r.subject_kind = 'competitor_post' AND r.subject_id = p.id AND r.level = 'post'
          AND r.model_used = eng.model_used AND r.status = 'failed'
          AND COALESCE((r.raw->>'attempts')::int, 1) >= 3)
   ORDER BY p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(1, LEAST(p_limit, 2000));
$$;
REVOKE ALL ON FUNCTION public.mkt_design_read_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_design_read_due(int) TO service_role;

COMMIT;
