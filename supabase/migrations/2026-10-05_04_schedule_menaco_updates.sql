-- Weekly automatic updates for Menaco (مينا 51 - التعاون, مينا 52 - النرجس).
--
-- The Menaco reader (worker/src/projectUpdates/menaco.ts) reads the public
-- listing pages on menaco.sa. Before scheduling it was checked on the live
-- worker 2026-10-05: a dry run matched 51/51 and 16/16 units with no change
-- (the CRM was already current), then a live run stamped both projects.

UPDATE public.project_update_settings
SET scheduled_sources = array_append(scheduled_sources, 'menaco'),
    updated_at = now()
WHERE id = 1 AND NOT ('menaco' = ANY (scheduled_sources));
