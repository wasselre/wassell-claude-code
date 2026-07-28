-- ============================================================================
-- Marketing Management: the marketing fields the plan was missing, plus a
-- single source of truth for "what can this item move to next" (2026-08-21).
--
-- ADDITIVE ONLY. No column is dropped, renamed or retyped; no row is rewritten;
-- no existing constraint, policy, trigger or RPC is altered. Every ALTER is
-- IF NOT EXISTS so a re-run is a no-op. Existing Marketing Intelligence data is
-- untouched — this file only reaches mkt_content_items.
--
-- Baseline counts recorded immediately before writing this (production):
--   campaigns 2 · content_items 1 · versions 0 · status_history 2 · scenes 3
--   slides 0 · raw_assets 1 · asset_links 0 · tasks 12 · approvals 2
--   publications 0 · performance_snapshots 0 · lead_attributions 0
--   intelligence_actions 0 · alerts 0
-- Re-run the same counts after applying: every number must be identical.
-- ============================================================================

-- ── 1. Marketing planning fields ────────────────────────────────────────────
-- All nullable. Nothing becomes required, so every existing row stays valid and
-- no default has to be back-written across the table.
ALTER TABLE public.mkt_content_items
  -- Is this an organic post or something we put money behind? Drives which
  -- performance fields are meaningful (paid has spend/CPL, organic does not).
  ADD COLUMN IF NOT EXISTS organic_or_paid text,
  -- Where in the funnel this piece is meant to work.
  ADD COLUMN IF NOT EXISTS funnel_stage text,
  -- The angle: HOW we are saying it, as distinct from main_idea (WHAT).
  ADD COLUMN IF NOT EXISTS content_angle text,
  -- The commercial hook — discount, payment plan, handover terms. Kept separate
  -- from caption because it is the part Sales must sanity-check.
  ADD COLUMN IF NOT EXISTS offer_message text,
  -- Where the CTA actually sends a person.
  ADD COLUMN IF NOT EXISTS cta_destination text,
  -- The trackable URL used in the post (UTM'd link, wa.me link, short link).
  ADD COLUMN IF NOT EXISTS tracking_link text,
  -- Operational: the one thing that has to happen next, and what is stopping it.
  -- Free text on purpose — a blocker is a sentence, not an enum, and forcing it
  -- into a picklist is how blockers stop being written down at all.
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS blocker text,
  -- The finished creative, chosen from the existing asset library rather than a
  -- new storage path. ON DELETE SET NULL: removing an asset must never delete
  -- the content item that referenced it.
  ADD COLUMN IF NOT EXISTS final_asset_id uuid
    REFERENCES public.mkt_raw_assets(id) ON DELETE SET NULL;

-- Vocabularies as NOT VALID checks, then validated separately: the table is
-- small today, but this is the pattern that stays safe when it is not — the
-- ACCESS EXCLUSIVE lock is taken only for the catalog update, and VALIDATE runs
-- without blocking writers. Existing rows are all NULL, so validation passes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_ci_organic_or_paid_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_organic_or_paid_check
      CHECK (organic_or_paid IS NULL OR organic_or_paid IN ('organic','paid','boosted')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_organic_or_paid_check;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_ci_funnel_stage_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_funnel_stage_check
      CHECK (funnel_stage IS NULL OR funnel_stage IN
        ('awareness','consideration','decision','retention')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_funnel_stage_check;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_ci_cta_destination_check') THEN
    ALTER TABLE public.mkt_content_items ADD CONSTRAINT mkt_ci_cta_destination_check
      CHECK (cta_destination IS NULL OR cta_destination IN
        ('whatsapp','landing_page','website','phone_call','instagram_dm','form','profile','none')) NOT VALID;
    ALTER TABLE public.mkt_content_items VALIDATE CONSTRAINT mkt_ci_cta_destination_check;
  END IF;
END $$;

COMMENT ON COLUMN public.mkt_content_items.content_angle  IS 'HOW we say it (main_idea is WHAT we say).';
COMMENT ON COLUMN public.mkt_content_items.offer_message  IS 'Commercial terms shown in the content — discount, payment plan, handover.';
COMMENT ON COLUMN public.mkt_content_items.blocker        IS 'Free text: what is stopping the next action. Deliberately not an enum.';
COMMENT ON COLUMN public.mkt_content_items.final_asset_id IS 'Finished creative, referencing the existing mkt_raw_assets library.';

-- Filtering the content board by project is a first-class use, so make sure the
-- partial index that serves it exists (it already does from the 08-18 file;
-- repeated here as IF NOT EXISTS so a fresh replay is not missing it).
CREATE INDEX IF NOT EXISTS idx_mkt_ci_project ON public.mkt_content_items(project_id);

-- ── 2. Legal next statuses, derived from the existing rule ──────────────────
-- The UI previously rendered ALL 17 other statuses as buttons and let the
-- database reject the wrong ones. Showing only the legal moves needs the same
-- knowledge in the client — and a hand-copied list in TypeScript would drift
-- from the trigger the moment either side changed.
--
-- So the answer is computed FROM mkt_content_status_allowed rather than
-- duplicated: one rule, two readers. Nothing about the status machine changes.
CREATE OR REPLACE FUNCTION public.mkt_content_next_statuses(p_from text)
RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(s ORDER BY ord), ARRAY[]::text[])
  FROM unnest(ARRAY[
    'idea','brief','writing','awaiting_script_approval','approved_for_production',
    'raw_assets_required','recording','designing','editing','internal_review',
    'revision_requested','awaiting_final_approval','approved','ready_to_publish',
    'scheduled','published','cancelled','archived'
  ]) WITH ORDINALITY AS t(s, ord)
  WHERE s <> p_from
    AND public.mkt_content_status_allowed(p_from, s);
$$;

REVOKE ALL ON FUNCTION public.mkt_content_next_statuses(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_next_statuses(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.mkt_content_next_statuses(text) IS
  'Legal next statuses for a content item, derived from mkt_content_status_allowed so the UI and the trigger cannot disagree.';
