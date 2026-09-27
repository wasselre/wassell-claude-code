-- D43: delete the Whiteboard feature.
--
-- The tldraw pages (src/pages/Whiteboard/*), the hardcoded Sidebar NavLink, the
-- store slice (whiteboards / whiteboardFolders state + ~10 actions + boot-load +
-- localStorage keys), the types, and the /whiteboard routes are all removed in
-- code. Drop the two tables (8 boards + 3 folders). `whiteboards.folder_id →
-- whiteboard_folders` has ON DELETE SET NULL, so drop the child table first.
--
-- Applied live to wassell-prod 2026-09-27. Snapshot (recoverable — board
-- snapshots are image-heavy JSONB):
--   _backup_whiteboards_20260927        (8 boards)
--   _backup_whiteboard_folders_20260927 (3 folders)
-- Restore = recreate the tables from the backups + restore the code from git.

BEGIN;

CREATE TABLE public._backup_whiteboards_20260927 AS SELECT * FROM public.whiteboards;
CREATE TABLE public._backup_whiteboard_folders_20260927 AS SELECT * FROM public.whiteboard_folders;

DROP TABLE public.whiteboards;
DROP TABLE public.whiteboard_folders;

COMMIT;
