-- A WhatsApp source can declare that its availability sheets are ALWAYS
-- complete (operator 2026-10-05: «yes» — the Al-Ramz officer's sheets).
--
-- With lists_are_complete = true every availability sheet from that chat is
-- read as «everything still for sale in the buildings it names» — the AI no
-- longer decides (it read the same ستون الندى sheet as complete on the dry run
-- and partial on the live run that day). Guards in the reader: a project's
-- sheets in one batch are merged first (available + «hold» lists), and a sheet
-- with no available unit (a hold list on its own) stays partial. Coverage
-- from the sheet's own rows, crossed-out rows and the safety brake still apply.

ALTER TABLE public.project_update_groups ADD COLUMN IF NOT EXISTS lists_are_complete boolean NOT NULL DEFAULT false;

UPDATE public.project_update_groups SET lists_are_complete = true WHERE chat_wid = '966554081507@c.us';
