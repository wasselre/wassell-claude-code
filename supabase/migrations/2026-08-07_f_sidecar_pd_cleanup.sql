-- ============================================================================
-- Public project pages redesign — W5 (data): normalize project_details sidecars.
--
-- When a sidecar was created, the CRM copied EVERY site_settings pd_* page-text
-- value into it (see ProjectDetailsBridgePage.templateOverridesFromSiteSettings,
-- removed in the same change). That produced stale per-project duplicates —
-- including the Riyadh map headline "في قلب الرياض الجديدة" on all 28 sidecars —
-- that never tracked the live site defaults or the project's real geography.
--
-- This removes ONLY the pd_* values that are BYTE-EQUAL to the current
-- site_settings default (proven untouched template copies — 921 values across
-- 28 sidecars, incl. every Riyadh headline). Genuinely customized pd_* values
-- (3 of them) are DISTINCT from the site default and are PRESERVED. All non-pd_*
-- content (hero_short_description, description, features, agent_*, images,
-- show_* toggles, landmarks) is untouched.
--
-- After cleanup an empty pd_* field falls back to the site default / dynamic
-- geography at render time — the sidecar becomes an override-only surface.
--
-- Additive-safe + reversible (full snapshot). Idempotent (re-running strips
-- nothing new once the copies are gone).
-- ============================================================================

-- Snapshot every project_details record before mutating.
CREATE TABLE IF NOT EXISTS public._backup_project_details_20260807 AS
  SELECT id, data FROM public.records
  WHERE model_id = public._pub_model_id('project_details');

-- Strip byte-equal pd_* copies, per sidecar, preserving customized values.
WITH ss AS (
  SELECT data AS s FROM public.records
  WHERE model_id = public._pub_model_id('site_settings') LIMIT 1
),
strip AS (
  SELECT sc.id,
         array_agg(k) AS keys_to_remove
  FROM public.records sc
  CROSS JOIN ss
  CROSS JOIN LATERAL jsonb_object_keys(sc.data) AS k
  WHERE sc.model_id = public._pub_model_id('project_details')
    AND k LIKE 'pd_%'
    AND sc.data->>k IS NOT DISTINCT FROM ss.s->>k
  GROUP BY sc.id
)
UPDATE public.records r
SET data = r.data - strip.keys_to_remove
FROM strip
WHERE r.id = strip.id
  AND array_length(strip.keys_to_remove, 1) > 0;
