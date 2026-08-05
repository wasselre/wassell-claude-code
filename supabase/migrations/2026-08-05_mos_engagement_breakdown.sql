-- Organic-post engagement breakdown: likes / comments / saves become first-class
-- captured readings on mos_metric_snapshots, alongside views / engagement /
-- enquiries. The Numbers capture grid, the Performance tab, the publish view and
-- the campaign detail screen all read these per publication.
--
-- Not applied by CI (the db-migrations job only runs the 2026-09-0* translation
-- set against its fixture) — run this in production BEFORE the code that reads
-- the new latest_* columns / writes the new snapshot columns goes live.

BEGIN;

-- 1. New nullable readings on the snapshot table (parallel to views/engagement/enquiries).
ALTER TABLE public.mos_metric_snapshots
  ADD COLUMN IF NOT EXISTS likes    integer,
  ADD COLUMN IF NOT EXISTS comments integer,
  ADD COLUMN IF NOT EXISTS saves    integer;

-- 2. A snapshot must still carry at least one reading; the three new metrics now
--    also satisfy that (a likes-only snapshot is valid), matching how the API
--    and the capture UI treat every empty box as NULL rather than 0.
ALTER TABLE public.mos_metric_snapshots
  DROP CONSTRAINT IF EXISTS mos_snap_not_empty_check;
ALTER TABLE public.mos_metric_snapshots
  ADD CONSTRAINT mos_snap_not_empty_check CHECK (
    views IS NOT NULL OR engagement IS NOT NULL OR enquiries IS NOT NULL
    OR likes IS NOT NULL OR comments IS NOT NULL OR saves IS NOT NULL
    OR extra <> '{}'::jsonb
  );

-- 3. Surface the new latest_* readings on the per-publication view. CREATE OR
--    REPLACE keeps every existing column, its order and the view's grants +
--    security_invoker flag intact; the three new columns are appended at the end
--    (the only column shape CREATE OR REPLACE VIEW allows). Consumers read by
--    name, so end-ordering is immaterial. The lateral subselect also carries the
--    new columns so s.likes/s.comments/s.saves resolve.
CREATE OR REPLACE VIEW public."mos_publication_v" WITH (security_invoker=true) AS
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
          WHERE (x.publication_id = p.id)) AS snapshot_count,
    s.likes AS latest_likes,
    s.comments AS latest_comments,
    s.saves AS latest_saves
   FROM ((mos_publications p
     LEFT JOIN mos_platform_accounts a ON ((a.id = p.account_id)))
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
          WHERE (m.publication_id = p.id)
          ORDER BY m.captured_at DESC
         LIMIT 1) s ON (true));

COMMIT;
