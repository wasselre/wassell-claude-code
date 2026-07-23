-- ──────────────────────────────────────────────────────────────────────
-- Maqsam call ingest (2026-07-22)
--
-- Maqsam becomes the SECOND telephony provider: it carries the AI-agent
-- calls on its own number, while Hatif keeps the human sales-agent calls.
-- Both feed the same call_logs + phone_calls pipeline; this migration adds
-- the two pieces of infrastructure the Maqsam ingest needs.
--
-- Related code: api/_lib/maqsam.ts, api/_lib/maqsamIngest.ts,
--               api/webhook/maqsam-call.ts, api/maqsam/sync-calls.ts
-- Idempotent — safe to re-run.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Provider discriminator on call_logs. Every pre-existing row is Hatif's.
--    Maqsam ingest writes provider='maqsam'. The Maqsam rows also carry a
--    synthetic channel_id ('5f0aa1de-6a2b-4c8f-9d3e-1b7c4a90e2f5' — a fixed
--    constant, since Maqsam has no channel concept and channel_id is NOT NULL).
ALTER TABLE public.call_logs
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'hatif';

CREATE INDEX IF NOT EXISTS idx_call_logs_provider ON public.call_logs (provider);

-- 2. Public bucket for re-hosted call recordings. Maqsam serves recordings
--    only behind API Basic auth, so the ingest downloads the MP3 server-side
--    and re-hosts it here — that's what lets the record form's <audio> player
--    play the recording without Maqsam credentials (same posture as Hatif,
--    whose recording URLs are already public). Recordings are keyed
--    maqsam/<callId>.mp3 and immutable.
-- No mime allowlist: providers serve recordings with generic types (Retell's
-- CloudFront sends binary/octet-stream — verified live 2026-07-24, it broke
-- the original allowlist). The ingest normalizes contentType to audio/* on
-- upload; writes are service-role-only, so the allowlist bought nothing.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'call-recordings',
  'call-recordings',
  true,
  100 * 1024 * 1024  -- 100 MB max per recording
)
ON CONFLICT (id) DO UPDATE SET allowed_mime_types = NULL;

-- Public read; writes only via service role (the ingest). No user-facing
-- INSERT/UPDATE/DELETE policies on purpose.
DROP POLICY IF EXISTS "call_recordings_public_read" ON storage.objects;
CREATE POLICY "call_recordings_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'call-recordings');

COMMIT;
