-- 2026-07-19: Listing video conversion — generation_jobs gains kind='video-convert'.
--
-- WHY: Aqar market-listing videos are Cloudflare Stream HLS playlists (.m3u8),
-- which WhatsApp cannot carry as media, so listing sends silently dropped every
-- video (directVideoUrls filters non-file URLs by design). The Fly worker now
-- converts each HLS stream to an .mp4 ONCE per listing (ffmpeg copy-remux,
-- re-encode fallback under the ~16 MB WhatsApp video cap), re-hosts it to the
-- public marketing-assets bucket, and caches the mapping on the LISTING record
-- as data.video_mp4_map = { "<source_url>": "<mp4 public url>" }. The send flow
-- (ListingWhatsAppFlow) maps video_urls through that cache.
--
-- Queue posture: rides the existing generation_jobs queue + claim/complete/
-- fail RPCs (same as kind='clean-text'). job.record_id = the LISTING record,
-- message_id = NULL, params = { source_url, listing_id }.
--
-- Watchdog: generation_jobs_watchdog() (kind-agnostic UPDATE) already sweeps
-- stale running jobs of ANY kind to 'failed'. Its cleaning-shape record patch
-- only touches records that actually have data.cleaning entries matching the
-- stale message ids — video-convert jobs have message_id NULL, so the record
-- branch is a natural no-op. No watchdog change needed.

ALTER TABLE public.generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs
  ADD  CONSTRAINT generation_jobs_kind_check
  CHECK (kind IN ('image','video','audio','clean-text','video-convert'));
