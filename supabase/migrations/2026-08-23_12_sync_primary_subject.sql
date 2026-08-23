-- File Metadata Intelligence — keep file_subjects in sync with the primary.
--
-- document_type is the PRIMARY subject; file_subjects holds the full multi-value
-- set. The one-time backfill seeded existing files, but a NEW upload only sets
-- document_type (via the fill-in trigger) and would have NO file_subjects row —
-- so the detail-panel multiselect would open empty and the subject facet/search
-- would miss it. This trigger mirrors the primary into file_subjects on every
-- insert / document_type change, so the junction always contains at least the
-- primary. Extra subjects added by a human are preserved (INSERT … ON CONFLICT).

CREATE OR REPLACE FUNCTION public.tg_files_sync_primary_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER            -- the primary-subject mirror is a system invariant,
SET search_path TO 'public' -- not a per-user grant, so it must not depend on RLS
AS $$
BEGIN
  IF NEW.document_type IS NOT NULL THEN
    INSERT INTO public.file_subjects (file_id, subject)
    VALUES (NEW.id, NEW.document_type)
    ON CONFLICT (file_id, subject) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_sync_primary_subject ON public.files;
CREATE TRIGGER files_sync_primary_subject
  AFTER INSERT OR UPDATE OF document_type ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_sync_primary_subject();

-- Catch-up for any files created between the backfill and this trigger.
INSERT INTO public.file_subjects (file_id, subject)
SELECT id, document_type FROM public.files WHERE document_type IS NOT NULL
ON CONFLICT (file_id, subject) DO NOTHING;
