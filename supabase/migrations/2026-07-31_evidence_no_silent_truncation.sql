-- ============================================================================
-- 2026-07-31 — Evidence truncation must never be silent.
--
-- mkt_intelligence_evidence cut caption/transcript/OCR at 2000/4000/3000 chars
-- with no signal in the payload. No production post has ever exceeded those
-- limits (max observed at the time of this change: 804 caption / 1081
-- transcript / 1360 OCR), so no attribution has been decided on partial text.
-- But the first long-form post would have been judged from a cut caption with
-- nothing anywhere saying so — the silent-failure pattern this codebase has
-- been bitten by repeatedly (see CLAUDE.md "Silent Failures").
--
-- This was found while reviewing an attribution I had earlier mis-called a
-- false positive: I had judged it from a 45-character preview in an ad-hoc
-- query, while the full caption named the project explicitly. The lesson is the
-- same at every layer — a reviewer (human or model) must be able to SEE that
-- the text in front of them is partial.
--
-- Fix: raise the ceilings far above anything observed, and always report the
-- true length plus an explicit per-field truncation flag.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mkt_intelligence_evidence(p_post_ids uuid[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT coalesce(jsonb_agg(ev), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'post_id', cp.id,
      'platform', cp.platform,
      'post_type', cp.post_type,
      'account', (SELECT '@'||handle||' ('||platform||')' FROM mkt_social_accounts sa WHERE sa.id=cp.social_account_id),
      'organization_id', cp.organization_id,
      'caption',    left(coalesce(cp.caption,''), 8000),
      'transcript', left(coalesce(tr.txt,''),    16000),
      'ocr_text',   left(coalesce(oc.txt,''),    12000),
      'evidence_lengths', jsonb_build_object(
        'caption',    length(coalesce(cp.caption,'')),
        'transcript', length(coalesce(tr.txt,'')),
        'ocr_text',   length(coalesce(oc.txt,''))
      ),
      'evidence_truncated', jsonb_build_object(
        'caption',    length(coalesce(cp.caption,'')) > 8000,
        'transcript', length(coalesce(tr.txt,''))    > 16000,
        'ocr_text',   length(coalesce(oc.txt,''))    > 12000
      ),
      'candidates', coalesce(e.candidate_projects, '[]'::jsonb),
      'deterministic_partial', coalesce((e.result->>'deterministic_partial')::boolean, false),
      'snippet', coalesce(e.result->>'snippet','')
    ) AS ev
    FROM mkt_content_posts cp
    LEFT JOIN mkt_content_enrichment e ON e.content_post_id = cp.id
    -- LATERALs (not correlated scalar subqueries) so the aggregated text can be
    -- referenced twice — once truncated, once measured — without re-aggregating.
    LEFT JOIN LATERAL (
      SELECT string_agg(nullif(t.text,''), ' ') AS txt
      FROM mkt_transcripts t WHERE t.content_post_id = cp.id AND t.status = 'done'
    ) tr ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(nullif(v.text,''), ' | ') AS txt
      FROM mkt_visual_text v WHERE v.content_post_id = cp.id
    ) oc ON true
    WHERE cp.id = ANY(p_post_ids)
  ) s;
$$;
