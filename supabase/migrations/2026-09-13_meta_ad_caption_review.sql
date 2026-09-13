-- ============================================================================
-- Meta ad automation — caption review phase + push house rules (2026-09-13)
-- ----------------------------------------------------------------------------
-- Operator corrections after the first C-042 push (2026-09-13):
--   1. targeting  = the account's Meta Saved Audience, never broad KSA;
--   2. placements = Instagram + WhatsApp only (never Facebook etc.);
--   3. multi-advertiser ads OFF on every creative;
--   4. square 1:1 → feed, vertical 9:16 → stories/reels/status — never the
--      same file everywhere; both slots required;
--   5. the ad caption is written by AI and APPROVED BY THE MANAGER before the
--      ad is created in Meta (new `caption_review` state on the ad row);
--   6. the Click-to-WhatsApp welcome template is duplicated from an existing
--      project's template with the project name swapped;
--   7. every Advantage+ creative enhancement OFF (no music, overlays, …).
--
-- Rules 1–4, 6, 7 are code (metaPush.ts / runMetaAdJob.ts). This migration
-- carries the DATA side of rule 5 and rule 1:
--   a. a notification event `ad_caption_ready` (manager inapp + whatsapp on,
--      every other role/channel cell present but disabled — same posture as
--      ad_created / ad_failed in 2026-09-10_meta_auto_ad.sql);
--   b. the default saved audience for pushed ad sets in mos_settings.meta_push
--      (the account's only saved audience on 2026-09-13; the Settings →
--      Platforms → Meta card lets manage_paid_ads change it).
-- Idempotent.
-- ============================================================================

-- ── a. notification rules — ad_caption_ready ─────────────────────────────────
WITH roles5(role_key) AS (
  VALUES ('mos_ceo'), ('mos_marketing_manager'), ('mos_ops_supervisor'),
         ('mos_writer'), ('mos_montage')
),
channels3(channel) AS (
  VALUES ('inapp'), ('push'), ('whatsapp')
),
events1(event) AS (
  VALUES ('ad_caption_ready')
),
on_cells(role_key, channel) AS (
  VALUES
  ('mos_marketing_manager', 'inapp'),
  ('mos_marketing_manager', 'whatsapp'),
  ('mos_marketing_manager', 'push')
)
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id, ev.event, c.channel, 'immediate', (o.role_key IS NOT NULL)
  FROM roles5 ro
  JOIN public.roles r ON r.key = ro.role_key
 CROSS JOIN channels3 c
 CROSS JOIN events1 ev
  LEFT JOIN on_cells o
    ON o.role_key = ro.role_key AND o.channel = c.channel
ON CONFLICT (role_id, event, channel) DO NOTHING;

DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.notification_rules WHERE event = 'ad_caption_ready';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'NTF:AD_CAPTION_EVENT_SEED_EMPTY — no notification_rules rows landed for ad_caption_ready';
  END IF;
END $$;

-- ── b. default saved audience for every pushed ad set ────────────────────────
-- Saved Audience «عام - ألرياض - 18+» (id 120253259850460020) — the account's
-- only one on 2026-09-13. The push reads the spec FRESH from Graph by this id;
-- the name here is display only.
INSERT INTO public.mos_settings (key, value)
VALUES ('meta_push', jsonb_build_object(
  'saved_audience_id', '120253259850460020',
  'saved_audience_name', 'عام - ألرياض - 18+'
))
ON CONFLICT (key) DO NOTHING;
