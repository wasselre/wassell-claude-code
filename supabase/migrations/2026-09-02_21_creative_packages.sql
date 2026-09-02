-- ============================================================================
-- Post Creative Director — creative packages, derivatives, refs (2026-09-02_21)
--
-- A "package" is one versioned creative deliverable for a content item:
-- stage='concepts' holds the 2–3 concept cards; stage='package' holds the full
-- BasePackage (strategy, design text, slides, visual direction, palette,
-- assets, references, AI recommendations). Derivatives are the per-placement
-- adaptations; refs are the competitor/Wassel/file references the package
-- leans on (with a rights snapshot taken at pick time).
--
-- Versions are immutable history: every regenerate/human save is a NEW row
-- with (content_id, version) unique; apply writes applied_snapshot so revert
-- is possible; supersede is a status flip, never a delete.
--
-- RLS enabled with NO policies: all access goes through the API (service
-- client after requireCap) and the worker (service_role).
-- Additive + idempotent.
-- ============================================================================

BEGIN;

-- ── packages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mos_creative_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id          uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  round               int  NOT NULL DEFAULT 1,
  version             int  NOT NULL,
  stage               text NOT NULL CHECK (stage IN ('concepts','package')),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','applied','superseded','rejected')),
  intended_use        text NOT NULL DEFAULT 'organic'
                      CHECK (intended_use IN ('organic','paid','both')),
  language            text NOT NULL,
  recipe              text,
  concept_id          text,
  concepts            jsonb,              -- ConceptsOutput (stage='concepts')
  base                jsonb,              -- BasePackage   (stage='package')
  facts               jsonb,              -- the FactsPackage snapshot it was grounded on
  facts_used          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- Fact ids cited anywhere in the package
  brand_kit_version   int,
  brand_kit_mode      text CHECK (brand_kit_mode IN ('advisory','constraint')),
  roles               jsonb,              -- role ledger (provider/model/version per call)
  cost_usd            numeric,
  generated_by        text NOT NULL DEFAULT 'ai' CHECK (generated_by IN ('ai','human')),
  job_id              uuid REFERENCES public.mos_creative_jobs(id) ON DELETE SET NULL,
  created_by_user_id  uuid,
  applied_at          timestamptz,
  applied_by_user_id  uuid,
  applied_snapshot    jsonb,              -- prior values of every content field apply touched
  revision_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, version)
);

CREATE INDEX IF NOT EXISTS mos_creative_packages_content
  ON public.mos_creative_packages (content_id, created_at DESC);

-- updated_at bump (shared platform trigger from 2026-08-01_04).
DROP TRIGGER IF EXISTS mos_creative_packages_touch_tg ON public.mos_creative_packages;
CREATE TRIGGER mos_creative_packages_touch_tg
  BEFORE UPDATE ON public.mos_creative_packages
  FOR EACH ROW EXECUTE FUNCTION public.wassell_tg_touch_updated_at();

-- ── derivatives (per-placement adaptations of one package) ──────────────────
CREATE TABLE IF NOT EXISTS public.mos_creative_derivatives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      uuid NOT NULL REFERENCES public.mos_creative_packages(id) ON DELETE CASCADE,
  target_kind     text NOT NULL CHECK (target_kind IN ('organic','paid')),
  platform        text NOT NULL,
  placement_type  text NOT NULL,
  target_ref      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {publication_id?|execution_id?,ad_set_id?,ad_id?}
  dimensions      jsonb NOT NULL,                       -- {aspect, px:[w,h]} from PLACEMENT_SPECS
  adaptation      jsonb NOT NULL,                       -- full VisualAdaptation
  copy            jsonb NOT NULL,                       -- OrganicCopy | PaidCopy
  limits          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the PLACEMENT_SPECS ceilings that applied
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','superseded')),
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (package_id, target_kind, platform, placement_type)
);

CREATE INDEX IF NOT EXISTS mos_creative_derivatives_package
  ON public.mos_creative_derivatives (package_id);

-- ── refs (what the package leaned on / picked) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.mos_creative_refs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      uuid NOT NULL REFERENCES public.mos_creative_packages(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('reference','selected_asset')),
  ref_kind        text NOT NULL
                  CHECK (ref_kind IN ('competitor_post','competitor_media','wassel_content','wassel_file','file')),
  ref_id          uuid NOT NULL,          -- mkt_content_posts.id | mkt_content_media.id | files.id | mos_content.id
  slide_index     int,
  level           text CHECK (level IN ('slide','post')),
  aspect          text,                   -- composition|hierarchy|colors|carousel_structure|typography|image_treatment|cta|copy_structure|density|branding|other
  usage           text,                   -- direct|crop|retouch|color_correct|ai_edit|ai_extend|combine|reference_only
  rights_snapshot jsonb,                  -- usage_rights/provenance/verified AS PICKED (re-checked at approval)
  rationale       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mos_creative_refs_package
  ON public.mos_creative_refs (package_id);

ALTER TABLE public.mos_creative_packages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_creative_derivatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mos_creative_refs        ENABLE ROW LEVEL SECURITY;
-- No policies by design.

-- ── next version ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_creative_package_next_version(p_content_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(max(version), 0) + 1
    FROM public.mos_creative_packages
   WHERE content_id = p_content_id;
$$;

-- ── surgical patch of `base` ────────────────────────────────────────────────
-- Single-row jsonb_set, used by the image lane to write
-- ai_recommendations[i].execution — never a JS read-modify-write of the whole
-- base blob (which would race the human editor).
CREATE OR REPLACE FUNCTION public.mos_creative_package_patch(
  p_package_id uuid, p_path text[], p_value jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.mos_creative_packages
     SET base = jsonb_set(base, p_path, p_value, true),
         updated_at = now()
   WHERE id = p_package_id;
$$;

REVOKE ALL ON FUNCTION public.mos_creative_package_next_version(uuid)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_creative_package_patch(uuid, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_creative_package_next_version(uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_creative_package_patch(uuid, text[], jsonb) TO service_role;

COMMIT;
