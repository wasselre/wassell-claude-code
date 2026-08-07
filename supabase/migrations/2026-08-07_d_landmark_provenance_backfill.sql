-- ============================================================================
-- Public project pages redesign — W3 (data): landmark provenance backfill.
--
-- The public read layer (get_public_project) renders nearby_landmarks ONLY when
-- all_projects.landmarks_source IN ('curated','verified') — FAIL-CLOSED, so a
-- future stored-but-unverified landmark never auto-publishes.
--
-- Every landmark currently stored on all_projects was entered by the
-- migrate-project skill from the developer's official project page, or manually
-- by an operator — NEVER by AI (AI landmark generation has been disabled since
-- project-details-ai-v2 issue #8; it always returns []). They are therefore
-- genuinely CURATED. This one-time backfill stamps landmarks_source='curated'
-- on public projects that have stored landmarks but no provenance flag yet, so
-- their factual landmark NAMES render (distances only when present — never
-- fabricated).
--
-- Country display needs NO backfill: get_public_project derives country live
-- from the district/city/region country_code (authoritative), never from the
-- stored location.country — a missing country_code yields NO country (never
-- defaults to Saudi).
--
-- Additive + reversible (snapshot table). Safe to re-run (idempotent WHERE).
-- ============================================================================

-- Snapshot the affected records before mutating.
CREATE TABLE IF NOT EXISTS public._backup_landmark_provenance_20260807 AS
  SELECT id, data
  FROM public.records
  WHERE model_id = public._pub_model_id('all_projects')
    AND jsonb_typeof(data->'nearby_landmarks') = 'array'
    AND jsonb_array_length(data->'nearby_landmarks') > 0
    AND COALESCE(data->>'landmarks_source','') = '';

UPDATE public.records
SET data = data || jsonb_build_object('landmarks_source','curated')
WHERE model_id = public._pub_model_id('all_projects')
  AND jsonb_typeof(data->'nearby_landmarks') = 'array'
  AND jsonb_array_length(data->'nearby_landmarks') > 0
  AND COALESCE(data->>'landmarks_source','') = '';
