-- Capture Haberchat's message `subtype` on chat_messages.
--
-- Every Haberchat message carries both a `type` (our `kind`: text / image /
-- interactive / notification_template / call_log / ...) AND a `subtype` that
-- discriminates system events — e.g. a `notification_template` with subtype
-- `biz_privacy_mode_init_fb` is WhatsApp's "this business works with another
-- company to manage this chat" privacy notice. Without the subtype these
-- body-less system/interactive messages rendered as a raw `[interactive]` /
-- `[notification_template]` placeholder in the thread. The column lets the UI
-- render a proper localized system notice instead.
--
-- Additive + nullable: existing rows stay NULL, existing writers unaffected.

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS subtype TEXT;
