-- ---------------------------------------------------------------------------
-- Marketing OS — notification rules for `manual_task_assigned`
--
-- Hand-assigned tasks (2026-08-10) had no notification: a manager could put work
-- in someone's queue and the only way to find out was to go look. This seeds the
-- role × channel row set for a NEW event key so the settings matrix can tune it.
--
-- Why its own key rather than reusing the workflow's `task_assigned`: the two
-- differ in what muting them means. "A previous stage was approved and your turn
-- began" is a reasonable thing for a busy role to silence; "your manager just
-- handed you something" is a different decision, and the workflow event's own
-- subtitle («اعتُمدت خطوة سابقة ودورك بدأ») would be a lie if it carried both.
--
-- Defaults, following the posture already seeded for `task_assigned`:
--   in-app   — ON for every role. A task a PERSON put in your queue must always
--              be findable in the inbox, including for the CEO (an inbox row
--              does not interrupt; it waits).
--   whatsapp — ON for the writer and the editor only. They are the production
--              doers who work outside the app, exactly as their `task_assigned`
--              row is already configured. The approvers work inside the app, and
--              the CEO's «إشعاران فقط» rule stays intact — nothing new reaches
--              them externally.
--   push     — OFF everywhere, matching every other event in the original seed.
--
-- Off cells are stored as enabled=false rows (not omitted) so the matrix UI
-- edits them in place — the same convention as the 2026-08-01_04 seed.
-- ---------------------------------------------------------------------------

BEGIN;

WITH on_cells(role_key, channel) AS (
  VALUES
    ('mos_ceo',               'inapp'),
    ('mos_marketing_manager', 'inapp'),
    ('mos_ops_supervisor',    'inapp'),
    ('mos_writer',            'inapp'),
    ('mos_writer',            'whatsapp'),
    ('mos_montage',           'inapp'),
    ('mos_montage',           'whatsapp')
),
roles5(role_key) AS (
  VALUES ('mos_ceo'), ('mos_marketing_manager'), ('mos_ops_supervisor'),
         ('mos_writer'), ('mos_montage')
),
channels3(channel) AS (
  VALUES ('inapp'), ('push'), ('whatsapp')
)
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id,
       'manual_task_assigned',
       c.channel,
       'immediate',
       EXISTS (SELECT 1 FROM on_cells o
                WHERE o.role_key = rr.role_key AND o.channel = c.channel)
FROM roles5 rr
CROSS JOIN channels3 c
JOIN public.roles r ON r.key = rr.role_key
ON CONFLICT (role_id, event, channel) DO NOTHING;

-- The seed must cover the whole grid, or the settings matrix renders a cell with
-- no row behind it and an admin's first click silently creates one with defaults
-- nobody chose. 5 roles × 3 channels.
DO $$
DECLARE v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.notification_rules
   WHERE event = 'manual_task_assigned';
  IF v_rows <> 15 THEN
    RAISE EXCEPTION 'NTF:SEED_INCOMPLETE — manual_task_assigned has % rows, expected 15', v_rows;
  END IF;
END $$;

COMMIT;
