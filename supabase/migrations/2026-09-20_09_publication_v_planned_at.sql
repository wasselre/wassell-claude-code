-- ============================================================================
-- `mos_publication_v` exposes the PLANNED time, not only the scheduled one.
-- 2026-09-20.
--
-- `mos_publications` carries two timestamps and they mean different things:
--
--   planned_at    when the plan says this goes out — written at month commit
--   scheduled_at  when the publisher actually took it — NULL until then
--
-- The view published only `scheduled_at`, so every consumer that asked "what
-- publishes this week" saw NULL for work that was perfectly well planned. On
-- 2026-09-20 that put all nine of September's first organic posts under
-- «بحاجة لموعد نشر» — needs a publish date — while 138 releases sat correctly
-- queued, the first for Tue 22 Sep 18:00 Riyadh.
--
-- `due_at` is the same COALESCE the release engine already uses
-- (`mos_release_v.due_at`), so the screen and the publisher finally answer the
-- question the same way.
--
-- CREATE OR REPLACE appends the two columns; nothing existing moves or changes
-- type, so dependent views and policies are untouched.
-- ============================================================================

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
    p.asset_ids,
    p.campaign_id,
    p.planned_at,
    COALESCE(p.scheduled_at, p.planned_at) AS due_at
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

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
   WHERE table_name = 'mos_publication_v' AND column_name IN ('planned_at', 'due_at');
  IF v <> 2 THEN RAISE EXCEPTION 'MOS:PUB_V_MISSING_COLUMNS got %', v; END IF;
  -- And it must now SEE September's planned publications.
  SELECT count(*) INTO v FROM public.mos_publication_v WHERE due_at IS NOT NULL;
  IF v = 0 THEN RAISE EXCEPTION 'MOS:PUB_V_DUE_AT_ALL_NULL'; END IF;
END $$;
