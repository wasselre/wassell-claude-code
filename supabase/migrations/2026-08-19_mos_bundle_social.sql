-- Organic posting via bundle.social — additive, backward-compatible.
--
-- MOS already models one publication row per platform (caption + approved file +
-- schedule + result), published MANUALLY. This adds the columns a real API push
-- needs so a publication can be handed to bundle.social to post/schedule, while
-- the manual path stays intact for platforms we don't push (x/website).
--
--   mos_publications.bundle_post_id   the post's id on bundle.social (the join key
--                                     for polling + webhook status updates)
--   mos_publications.bundle_status    bundle's own lifecycle string, verbatim:
--                                     DRAFT/SCHEDULED/PROCESSING/POSTED/RETRYING/
--                                     ERROR/REVIEW/DELETED. Distinct from our
--                                     coarse status (draft/scheduled/published/…)
--                                     so "under review" ≠ "failed" ≠ "published".
--   mos_publications.bundle_error     the platform's error text on ERROR (surfaced,
--                                     never swallowed).
--   mos_publications.bundle_synced_at when we last reconciled with bundle.
--
--   mos_platform_accounts.bundle_account_id / bundle_account_type — the connected
--   social account on bundle (set by platform_sync from the live team), so the UI
--   can show honest connection status instead of a hand-set checkbox.

ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS bundle_post_id   text,
  ADD COLUMN IF NOT EXISTS bundle_status    text,
  ADD COLUMN IF NOT EXISTS bundle_error     text,
  ADD COLUMN IF NOT EXISTS bundle_synced_at timestamptz;

-- The join key the webhook + poll look a publication up by.
CREATE INDEX IF NOT EXISTS mos_publications_bundle_post_id_idx
  ON public.mos_publications (bundle_post_id)
  WHERE bundle_post_id IS NOT NULL;

ALTER TABLE public.mos_platform_accounts
  ADD COLUMN IF NOT EXISTS bundle_account_id   text,
  ADD COLUMN IF NOT EXISTS bundle_account_type text,
  ADD COLUMN IF NOT EXISTS bundle_synced_at    timestamptz;

-- Expose the new publication columns through the read view (append-only, so
-- CREATE OR REPLACE keeps the existing leading column order).
CREATE OR REPLACE VIEW public.mos_publication_v AS
 SELECT p.id,
    p.content_id,
    p.platform,
    p.account_id,
    p.status,
    p.scheduled_at,
    p.published_at,
    p.caption,
    p.file_id,
    p.external_url,
    p.external_id,
    p.published_by_user_id,
    p.note,
    p.created_at,
    p.updated_at,
    a.label_ar AS account_label_ar,
    a.label_en AS account_label_en,
    a.handle AS account_handle,
    a.is_connected AS account_connected,
    s.captured_at AS latest_captured_at,
    s.source AS latest_source,
    s.views AS latest_views,
    s.engagement AS latest_engagement,
    s.enquiries AS latest_enquiries,
    ( SELECT count(*) AS count
           FROM mos_metric_snapshots x
          WHERE x.publication_id = p.id) AS snapshot_count,
    s.likes AS latest_likes,
    s.comments AS latest_comments,
    s.saves AS latest_saves,
    p.asset_id,
    p.bundle_post_id,
    p.bundle_status,
    p.bundle_error,
    p.bundle_synced_at,
    a.can_publish AS account_can_publish
   FROM mos_publications p
     LEFT JOIN mos_platform_accounts a ON a.id = p.account_id
     LEFT JOIN LATERAL ( SELECT m.id,
            m.publication_id,
            m.captured_at,
            m.source,
            m.views,
            m.engagement,
            m.enquiries,
            m.likes,
            m.comments,
            m.saves,
            m.extra,
            m.entered_by_user_id,
            m.created_at
           FROM mos_metric_snapshots m
          WHERE m.publication_id = p.id
          ORDER BY m.captured_at DESC
         LIMIT 1) s ON true;
