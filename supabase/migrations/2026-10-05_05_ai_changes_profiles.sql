-- The AI's profile saves know about preference PROFILES (operator, 2026-10-05:
-- a customer can hold several profiles; separate profiles get their own
-- process). api/_lib/clientPrefs/wishRouter.ts decides whether what a customer
-- said refines a profile, replaces an earlier wish in it (a change of mind), or
-- is a separate second wish — which gets its own new profile.
--
--  1. client_ai_changes.kind gains 'profile' — the AI created a profile for a
--     second wish (Undo removes it, unless it became active or a rep made it).
--  2. client_ai_changes.profile_id / profile_name — the profile a change was
--     written to. NULL = the active profile of a client without profiles (and
--     every row written before today), which is what Undo already assumed.
--
-- Backward-compatible: new nullable columns and a wider CHECK. No 40001/40P01.

BEGIN;

ALTER TABLE public.client_ai_changes
  ADD COLUMN IF NOT EXISTS profile_id text,
  ADD COLUMN IF NOT EXISTS profile_name text;

ALTER TABLE public.client_ai_changes DROP CONSTRAINT IF EXISTS client_ai_changes_kind_check;
ALTER TABLE public.client_ai_changes
  ADD CONSTRAINT client_ai_changes_kind_check CHECK (kind IN ('pref', 'place', 'outcome', 'profile'));

COMMIT;
