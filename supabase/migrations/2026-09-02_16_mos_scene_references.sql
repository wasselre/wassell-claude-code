-- Visual references attached to scripted scenes (competitor shots = reference
-- only, Wassel assets = usable, or an explicit production gap). Written by the
-- API (service client) after a capability gate; RLS enabled with no policies.
CREATE TABLE IF NOT EXISTS public.mos_scene_references (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id           uuid REFERENCES public.mos_scenes(id) ON DELETE CASCADE,
  draft_id           uuid REFERENCES public.mos_script_drafts(id) ON DELETE CASCADE,
  draft_scene_index  int,
  content_id         uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('competitor_shot','wassel_asset','gap')),
  ref_id             uuid,                      -- mkt_cv_shots.id | mos_assets.id | NULL for gap
  frame_url          text,
  open_url           text,                      -- stored video url + #t=<sec>
  start_ms           int,
  end_ms             int,
  reason             text,
  learn_element      text,
  adaptation_notes   text,
  usage_class        text NOT NULL DEFAULT 'reference_only'
                       CHECK (usage_class IN ('reference_only','usable')),
  gap                jsonb,                     -- {kind: footage|image|design|animation, spec}
  rank               int,
  similarity         numeric,
  status             text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','rejected')),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- competitor material can never be classified as usable
  CONSTRAINT mos_scene_references_competitor_reference_only
    CHECK (kind <> 'competitor_shot' OR usage_class = 'reference_only'),
  CONSTRAINT mos_scene_references_target CHECK (scene_id IS NOT NULL OR (draft_id IS NOT NULL AND draft_scene_index IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mos_scene_references_scene ON public.mos_scene_references (scene_id, rank);
CREATE INDEX IF NOT EXISTS mos_scene_references_draft ON public.mos_scene_references (draft_id, draft_scene_index, rank);
ALTER TABLE public.mos_scene_references ENABLE ROW LEVEL SECURITY;
