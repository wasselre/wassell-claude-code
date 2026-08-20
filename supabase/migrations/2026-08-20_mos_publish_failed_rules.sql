-- ============================================================================
-- publish_failed — the notification event for the bundle.social status sweep.
--
-- The sweep (api/_lib/marketing/bundleStatusSync.ts, run by the 10-min
-- /api/cron/bundle-status + the Publishing Board refresh) emits
-- notify_emit('marketing','publish_failed',…) when a post transitions into
-- ERROR on bundle's side. In-app rows are written unconditionally by
-- notify_emit; THESE rule rows are what let the push/whatsapp channels fire —
-- a failed scheduled post at 9pm must reach a phone, not wait for someone to
-- open the app.
--
-- Matrix posture mirrors publish_due (2026-08-01_04): the publishing roles
-- (ops_supervisor + marketing_manager) get inapp+whatsapp immediate; rows for
-- the other roles/channels exist DISABLED so the Settings screen-43 matrix can
-- show and toggle the event per role. Idempotent (ON CONFLICT DO NOTHING).
-- ============================================================================
BEGIN;

WITH roles5(role_key) AS (
  VALUES ('mos_ceo'), ('mos_marketing_manager'), ('mos_ops_supervisor'),
         ('mos_writer'), ('mos_montage')
),
channels3(channel) AS (
  VALUES ('inapp'), ('push'), ('whatsapp')
),
on_cells(role_key, channel) AS (
  VALUES
  ('mos_ops_supervisor',    'inapp'),
  ('mos_ops_supervisor',    'whatsapp'),
  ('mos_marketing_manager', 'inapp'),
  ('mos_marketing_manager', 'whatsapp')
)
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id,
       'publish_failed',
       c.channel,
       'immediate',
       (o.role_key IS NOT NULL)
  FROM roles5 ro
  JOIN public.roles r ON r.key = ro.role_key
 CROSS JOIN channels3 c
  LEFT JOIN on_cells o
    ON o.role_key = ro.role_key AND o.channel = c.channel
ON CONFLICT (role_id, event, channel) DO NOTHING;

-- Fail loudly if the seed found no mos_* roles (wrong environment / bad keys).
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.notification_rules
   WHERE event = 'publish_failed';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'NTF:PUBLISH_FAILED_SEED_EMPTY — no notification_rules rows landed for publish_failed';
  END IF;
END $$;

COMMIT;
