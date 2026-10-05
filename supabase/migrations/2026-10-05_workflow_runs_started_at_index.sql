-- The app's boot reads the 500 newest workflow runs
-- (`order by started_at desc limit 500`, appStore WORKFLOW_RUNS_BOOT_LIMIT).
-- With no index on started_at that is a full scan + sort of all 47,235 rows
-- (177 MB), and the RLS check (wassell_can_view_workflows) runs on every row
-- first: measured 2026-10-05 it hit the statement timeout on phone loads
-- (HTTP 500 "canceling statement due to statement timeout" on every boot of the
-- chats page). With the index the scan stops after the 500 newest rows.

CREATE INDEX IF NOT EXISTS workflow_runs_started_at_desc_idx
  ON public.workflow_runs (started_at DESC);
