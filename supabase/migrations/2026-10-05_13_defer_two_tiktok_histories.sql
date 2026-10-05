-- 2026-10-05 ~09:15 UTC: Apify's self-service monthly limit is $200 (higher
-- needs Apify support). $176.15 was used, ~$56 of it re-bought Rakez/Thiraa
-- TikTok histories (bug fixed in 93d0b3a7). With $23.85 left to 2026-10-22 the
-- room goes to DAILY collection; these two accounts' 12-month TikTok history is
-- deferred (tagged provider_metadata.history_deferred_at). Applied live.
-- TO RESUME: same statement as in 2026-10-05_05_defer_tiktok_history.sql.
BEGIN;
UPDATE public.mkt_social_accounts
   SET history_done_at = now(),
       provider_metadata = COALESCE(provider_metadata,'{}'::jsonb) || jsonb_build_object('history_deferred_at', now(), 'history_deferred_reason', 'apify $200 self-service cap — resume after cycle reset 2026-10-23 or a support-raised limit'),
       updated_at = now()
 WHERE platform = 'tiktok' AND collection_enabled AND history_done_at IS NULL;
COMMIT;
