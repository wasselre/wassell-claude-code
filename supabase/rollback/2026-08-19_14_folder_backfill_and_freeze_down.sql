-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_14_folder_backfill_and_freeze.sql
--
-- Removes the folder-creation freeze and the classifier function. It does NOT
-- reverse the tag/type backfill, and that asymmetry is deliberate:
--
--   - The FREEZE is a behaviour change and is fully reverted here: drop the
--     trigger and the guard function, and folders can be created again.
--
--   - The TAGS and TYPES are DATA the backfill added to files, and there is no
--     clean way to remove exactly them: a tag added by B9 is indistinguishable
--     from the same tag added by a user in the Library, and a document_type
--     upgraded from 'other' is now just a correct type. Trying to "un-backfill"
--     would risk deleting a user's own tag or reverting a type someone has
--     since confirmed. The backfill was additive and each value is defensible
--     on its own, so it is left in place. If a specific value is wrong, it is
--     edited in the Library like any other metadata.
--
-- So this rollback restores the ability to create folders and nothing else,
-- which is the only part that is a policy rather than a fact.
--
-- Idempotent.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS folders_freeze_creation ON public.folders;
DROP FUNCTION IF EXISTS public.folders_block_creation();
DROP FUNCTION IF EXISTS public.b9_folder_name_to_type(text);

COMMIT;
