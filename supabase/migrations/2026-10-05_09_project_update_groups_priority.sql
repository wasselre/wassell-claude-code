-- WhatsApp sources get a priority (operator rule 2026-10-05: the Al-Ramz
-- officer's PRIVATE chat outranks the broker group).
--
-- When a higher-priority chat of the same company changed a project in the
-- last 7 days, a lower-priority chat's sheet / price list for that project is
-- skipped (worker/src/projectUpdates/whatsapp.ts `outrankedBy`) — so an old
-- file re-posted in the group cannot roll back the newer private one.
-- Bookings still apply from any chat (they only move a unit forward).

ALTER TABLE public.project_update_groups ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

UPDATE public.project_update_groups SET priority = 1 WHERE chat_wid = '966554081507@c.us';
