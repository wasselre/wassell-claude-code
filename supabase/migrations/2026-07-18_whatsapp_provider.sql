-- ============================================================================
-- 2026-07-18: whatsapp_numbers.provider — per-number gateway routing
-- ----------------------------------------------------------------------------
-- Introduces a per-number PROVIDER discriminator so Wassell can run the
-- self-hosted WAHA gateway alongside Haberchat and flip a single number over
-- (or back) with one column. Defaults to 'haberchat' so this migration is inert
-- until a number is explicitly set to 'waha'.
--
-- Routing key: whatsapp_numbers.provider. For a WAHA number the existing
-- device_id column holds the WAHA SESSION NAME (e.g. 'wassel_main') — a WAHA
-- session is a name string, and every device_id column / encodeURIComponent()
-- path segment in the app already treats device_id as an opaque string (no
-- 24-hex assertion anywhere), so a session name flows through untouched. The
-- webhook, store resolution ladder, and chat_messages.device_id all keep
-- working with the session name as the id.
--
-- session_name is a redundant explicit copy of the WAHA session (equals
-- device_id for WAHA rows) — kept as a named column so the pairing UI and the
-- worker watchdog have an unambiguous field to read, independent of any future
-- device_id reinterpretation.
--
-- See docs/evaluations/2026-07-18-waha-vs-haberchat.md for the full rationale.
-- ============================================================================

BEGIN;

ALTER TABLE public.whatsapp_numbers
  ADD COLUMN IF NOT EXISTS provider     text NOT NULL DEFAULT 'haberchat',
  ADD COLUMN IF NOT EXISTS session_name text;

-- Constrain provider to the known set. Drop-then-add so re-runs are clean.
ALTER TABLE public.whatsapp_numbers
  DROP CONSTRAINT IF EXISTS whatsapp_numbers_provider_check;
ALTER TABLE public.whatsapp_numbers
  ADD CONSTRAINT whatsapp_numbers_provider_check
  CHECK (provider IN ('haberchat','waha'));

-- Existing rows are all Haberchat devices (the DEFAULT already stamps them, but
-- be explicit for any row inserted before the default applied).
UPDATE public.whatsapp_numbers
   SET provider = 'haberchat'
 WHERE provider IS NULL;

COMMIT;
