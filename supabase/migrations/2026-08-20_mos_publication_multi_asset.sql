-- ============================================================================
-- Carousel support: a publication can carry MULTIPLE approved files.
--
--   mos_publications.asset_ids — ORDERED uuid[] of mos_assets ids. Order is
--   the carousel order (Instagram Posts 1-10 mixed images/videos; TikTok
--   Photo Mode 1-10 images). NULL/empty ⇒ single-file behavior via the
--   existing asset_id.
--
-- Back-compat convention (enforced by publication_save in api/marketing-os.ts):
-- asset_id is ALWAYS kept equal to asset_ids[1] when the array is set, so every
-- existing consumer (board, metrics, the file cell) keeps working unchanged.
-- No junction table: order matters, the list is ≤10, and array columns keep
-- the read path one row wide.
-- ============================================================================

ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS asset_ids uuid[];

-- Expose through the read view (append-only, CREATE OR REPLACE keeps order).
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
    a.can_publish AS account_can_publish,
    p.asset_ids
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
