-- ============================================================================
-- 2026-06-09: media_assets — the first-class media library (Image Chats v3)
-- ----------------------------------------------------------------------------
-- v3 reframes Image Chats from a chat into a Creative Workspace. The chat's
-- per-message images become FIRST-CLASS ASSETS: every generation output is one
-- row in `media_assets`, carrying provenance (prompt/model/settings) + a stable
-- identity, referenced by Creative Sessions, the Files System, records, and
-- brand presets — reusable across the whole platform ("the image doesn't
-- belong to the chat; the session references assets").
--
-- Storage: the output BYTES stay in the existing PUBLIC `marketing-assets`
-- bucket (the worker already re-hosts there), so the workspace canvas renders
-- with cheap `<img src=public_url>` — no signed-URL round-trips. `media_assets`
-- adds the identity + provenance + the cross-session library query surface on
-- top. "Add to Files" copies the bytes into the private `wassel-files` bucket
-- once (reusing the v2 promote-on-add endpoint) and caches `promoted_file_id`.
--
-- This migration is ADDITIVE + invisible: it creates the table and adds a
-- `generation_id` column to `generation_jobs`. The v2 chat keeps working until
-- the v3 engine + UI land in later phases.
--
-- kind ∈ ('image','video','audio','document') — image now; the rest reserved so
-- the workspace becomes a generic AI Creative Studio without a schema change.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- Table
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.media_assets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL DEFAULT 'image'
                              CHECK (kind IN ('image','video','audio','document')),
  -- Storage of the bytes. Default = the public marketing-assets bucket the
  -- worker already re-hosts generation outputs into.
  storage_bucket  text        NOT NULL DEFAULT 'marketing-assets',
  storage_path    text,
  public_url      text        NOT NULL,
  mime_type       text,
  width           int,
  height          int,
  duration_ms     int,                                   -- video/audio (future)
  -- Provenance — shown in the Selected Asset panel.
  prompt          text,
  model_id        text,
  settings        jsonb,                                 -- { aspect_ratio, num_variations, seed, … }
  -- Lineage — which session/generation produced this asset.
  source_session_id     uuid REFERENCES public.records(id) ON DELETE SET NULL,
  source_generation_id  text,
  -- Promote-on-add dedup cache: the files.id once this asset is copied into the
  -- Files System (so Add-to-Record reuses one files row — v2 posture).
  promoted_file_id uuid,
  -- Owner = auth.uid() of the creator (mirrors generation_jobs.user_id, so the
  -- worker can stamp it straight from the job without an app-user lookup).
  created_by_user_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────────────────
-- Media-library browse (per user, newest first), optionally filtered by kind.
CREATE INDEX IF NOT EXISTS media_assets_owner_kind_idx
  ON public.media_assets (created_by_user_id, kind, created_at DESC);
-- All assets produced by a session (workspace timeline / session thumbnails).
CREATE INDEX IF NOT EXISTS media_assets_session_idx
  ON public.media_assets (source_session_id, created_at DESC);
-- Assets produced by a specific generation.
CREATE INDEX IF NOT EXISTS media_assets_generation_idx
  ON public.media_assets (source_generation_id);

-- ────────────────────────────────────────────────────────────────────────
-- RLS — owners can read their own assets; writes are server-side only
-- (the worker + the promote endpoint use the service-role key, which bypasses
-- RLS, exactly like generation_jobs). No authenticated INSERT/UPDATE policy.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "media_assets_owner_select" ON public.media_assets;
CREATE POLICY "media_assets_owner_select"
  ON public.media_assets FOR SELECT
  TO authenticated
  USING (created_by_user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- generation_jobs: a job now fills a Generation (not a chat message).
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.generation_jobs ADD COLUMN IF NOT EXISTS generation_id text;
-- A v3 job fills a Generation (generation_id), not a chat message — so
-- message_id is now optional (it was NOT NULL in the v2 schema).
ALTER TABLE public.generation_jobs ALTER COLUMN message_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_generation_idx
  ON public.generation_jobs (generation_id);

-- Re-create the claim RPC to ALSO return generation_id. (Return-type change
-- requires DROP + CREATE; CREATE OR REPLACE can't alter RETURNS TABLE.) The
-- extra column is ignored by the v2 worker and consumed by the v3 worker, so
-- both coexist during the cutover.
DROP FUNCTION IF EXISTS public.generation_job_claim_next(text, text);
CREATE FUNCTION public.generation_job_claim_next(
  p_worker_id text,
  p_kind      text DEFAULT 'image'
)
RETURNS TABLE (
  job_id        uuid,
  record_id     uuid,
  message_id    text,
  generation_id text,
  user_id       uuid,
  kind          text,
  prompt        text,
  params        jsonb,
  attempts      int
) LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.generation_jobs
     SET status     = 'running',
         worker_id  = p_worker_id,
         started_at = now(),
         attempts   = generation_jobs.attempts + 1
   WHERE id = (
     SELECT id
       FROM public.generation_jobs
      WHERE status = 'queued'
        AND kind = p_kind
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING id, record_id, message_id, generation_id, user_id, kind, prompt, params, attempts;
$$;

REVOKE ALL ON FUNCTION public.generation_job_claim_next(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_job_claim_next(text, text) TO service_role;

COMMIT;
