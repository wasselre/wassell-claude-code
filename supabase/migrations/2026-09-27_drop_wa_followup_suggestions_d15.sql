-- D15: retire the Follow-up Queue.
--
-- The AI-suggestion feed (`wa_followup_suggestions`) is dormant — no new rows in
-- 14 days as of 2026-09-27 (last written 2026-09-13; 108/111 already acted on) —
-- and its function is served by the Sales Workspace → Work Queue. Snapshot the
-- full table first (recoverable), then drop. No view / function / policy / trigger
-- references it (checked before dropping), so the drop is clean.
--
-- The writer was an operator-run Claude batch (the `wassel-whatsapp-voice` skill),
-- not in-repo application code — it simply stops being used.
--
-- Applied live to wassell-prod 2026-09-27 (backup: 111 rows).

BEGIN;

CREATE TABLE public._backup_wa_followup_suggestions_20260927 AS
  SELECT * FROM public.wa_followup_suggestions;

DROP TABLE public.wa_followup_suggestions;

COMMIT;
