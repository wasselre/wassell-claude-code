-- WA-29 — make one-message-one-row a DATABASE guarantee, not a convention.
--
-- The duplicate-message defect fixed on 2026-07-27 was caught and repaired in
-- application code (chatIngest.messageIdHash). Nothing stopped a future writer
-- -- a backfill script, a second gateway, a new ingest path -- reintroducing
-- it. chat_messages had only a PK on `id`, and the whole problem was that the
-- id is NOT the identity: it embeds the addressing mode, so the same message
-- under `@c.us` and `@lid` occupies two ids.
--
-- message_hash is WhatsApp's own message id, derived by the SAME rule the
-- application uses, unique per (hash, flow) to match the application's key --
-- direction included so a freak collision cannot merge an inbound with an
-- outbound.
--
-- NULL for anything outside WAHA's id shape: Haberchat-era bare-hex rows,
-- synthesized reaction rows, `failed:` and `pending:` rows. NULLs do not
-- conflict in a unique index, so those paths stay unconstrained -- which is what
-- keeps LID healing and any future provider migration working.
--
-- Verified before creating: 1,051 hashable rows, 0 would violate. Then verified
-- it BITES: inserting the same message under `@lid` raises 23505.

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS message_hash text
  GENERATED ALWAYS AS (
    CASE WHEN id ~ '^(true|false)_[^_]+@[a-z.]+_'
         THEN split_part(id, '_', 3)
         ELSE NULL END
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_hash_flow_uniq
  ON public.chat_messages (message_hash, flow)
  WHERE message_hash IS NOT NULL;

COMMENT ON COLUMN public.chat_messages.message_hash IS
  'WA-29: WhatsApp''s own message id, extracted from the addressing-dependent row id. Unique per (hash, flow) so one message cannot occupy two rows.';
