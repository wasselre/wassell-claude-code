-- ============================================================================
-- Public project pages redesign — W6 (table only): AI/generated editorial layer.
--
-- One row per (project_id, lang). Each language row carries the FULL editorial
-- set (hero_description / overview / highlights / seo_description) — the EN row
-- is NOT SEO-only. Kept physically SEPARATE from human overrides (which live in
-- the project_details sidecar) so automatic regeneration can never touch a
-- human-edited field.
--
-- Precedence at read time (in get_public_project, W1):
--   manual override (project_details) → generation-valid AI draft (THIS table)
--   → deterministic factual fallback.
--
-- Never anon-readable directly — surfaced ONLY through the W1 definer RPCs.
-- The queue + capture trigger + worker lane that POPULATE this table land later
-- (G3, feature-flagged). This migration only creates the durable store so the
-- read layer can reference it now.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.project_public_content (
  project_id        uuid    NOT NULL,          -- references a records.id (all_projects)
  lang              text    NOT NULL CHECK (lang IN ('ar','en')),
  hero_description  text,
  overview          text,
  highlights        jsonb   NOT NULL DEFAULT '[]'::jsonb,   -- array of short strings
  seo_description   text,
  -- provenance / auditability
  source_fact_hash  text,                       -- hash of the allowlisted public facts the copy was generated from
  provider          text,                       -- e.g. 'qwen' | 'deepseek' | 'anthropic'
  model             text,
  generated_at      timestamptz,
  validation_status text    NOT NULL DEFAULT 'pending'
                            CHECK (validation_status IN ('pending','valid','invalid')),
  human_edited      boolean NOT NULL DEFAULT false,
  locked            boolean NOT NULL DEFAULT false,   -- when true, the auto pipeline must never overwrite
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_project_public_content_project
  ON public.project_public_content (project_id);

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION public.tg_project_public_content_touch()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS project_public_content_touch ON public.project_public_content;
CREATE TRIGGER project_public_content_touch
BEFORE UPDATE ON public.project_public_content
FOR EACH ROW EXECUTE FUNCTION public.tg_project_public_content_touch();

-- RLS: NEVER anon. Authenticated may READ (admin editor UI shows the drafts);
-- writes are admin-only. The public read layer (W1) is SECURITY DEFINER and
-- bypasses this. The worker writes with the service role (bypasses RLS).
ALTER TABLE public.project_public_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_public_content FROM anon;
GRANT SELECT ON public.project_public_content TO authenticated;

DROP POLICY IF EXISTS ppc_authenticated_read ON public.project_public_content;
CREATE POLICY ppc_authenticated_read
  ON public.project_public_content FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS ppc_admin_write ON public.project_public_content;
CREATE POLICY ppc_admin_write
  ON public.project_public_content FOR ALL TO authenticated
  USING (public.wassell_is_admin(auth.uid()))
  WITH CHECK (public.wassell_is_admin(auth.uid()));
