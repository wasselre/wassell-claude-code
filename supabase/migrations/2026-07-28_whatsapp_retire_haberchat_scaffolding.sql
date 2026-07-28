-- WA-28 -- remove the abandoned wa_* scaffolding. Operator confirmed 2026-07-28
-- that there is no fallback to Haberchat.
--
-- wa_conversations / wa_leads / wa_errors are the remains of an autonomous
-- WhatsApp replier that was never shipped, marked DEPRECATED for months.
--
-- Checked before dropping, as required:
--   * row counts: 0 / 0 / 0
--   * code references in api/, src/, worker/: NONE
--   * foreign keys pointing at them: none
--
-- Backed up as structure+data anyway. They are empty, so this is a formality --
-- but "it was empty when I looked" is not a reason to skip a backup.
--
-- DELIBERATELY KEPT:
--   haberchat_webhook_dlq -- misleading name, but api/webhook/waha.ts writes the
--   LIVE gateway's dead-letter rows to it. Dropping it would silently remove the
--   only place a failed WhatsApp webhook is recorded.
--   chat_messages rows with 24-hex device ids -- 1,916 of them. Real customer
--   history from the Haberchat era; only the PROVIDER is retired, not the
--   messages it carried.

CREATE TABLE IF NOT EXISTS public._backup_wa_conversations_20260728 AS TABLE public.wa_conversations;
CREATE TABLE IF NOT EXISTS public._backup_wa_leads_20260728         AS TABLE public.wa_leads;
CREATE TABLE IF NOT EXISTS public._backup_wa_errors_20260728        AS TABLE public.wa_errors;

DROP TABLE IF EXISTS public.wa_conversations CASCADE;
DROP TABLE IF EXISTS public.wa_leads         CASCADE;
DROP TABLE IF EXISTS public.wa_errors        CASCADE;

COMMENT ON TABLE public.haberchat_webhook_dlq IS
  'Dead-letter rows for the LIVE WAHA webhook (api/webhook/waha.ts). The haberchat_ name is historical -- this table is in active use, do not drop it with the Haberchat retirement.';
