-- ============================================================
-- Phase C.1 + C.2 — Extend realtime publication, set replica identity
-- ============================================================
-- Root cause of the user's "not live" symptom: the supabase_realtime
-- publication only contains chat_messages, call_logs, and
-- webhook_payloads. Records / models / workflows / dashboards /
-- profiles / roles / users / model_views are not published, so
-- multi-user changes are invisible to other browser sessions until
-- a manual refresh.
--
-- C.1: ALTER PUBLICATION ... ADD TABLE for the 11 missing tables.
--      Purely additive; existing publication members unchanged.
--      WAL volume increases proportional to write rate. At current
--      scale (4 users, low write rate), the impact is negligible.
--
-- C.2: REPLICA IDENTITY policy:
--   FULL  — small tables where UPDATE/DELETE payloads need full row:
--           models, model_groups, workflows, workflow_groups,
--           dashboards, model_views, profiles, roles, users.
--   DEFAULT (PK only) — high-volume tables where whole-row WAL
--           would compound:
--           records, workflow_runs.
--   For the DEFAULT-identity tables, the frontend RealtimeOrchestrator
--   merge handlers (Phase C.3) will refetch the full row by id when
--   they need fields beyond the PK on UPDATE/DELETE events.
--
-- Verification:
--   SELECT tablename FROM pg_publication_tables
--     WHERE pubname='supabase_realtime' ORDER BY tablename;
--   → expect: chat_messages, call_logs, dashboards, model_groups,
--             model_views, models, profiles, records, roles, users,
--             webhook_payloads, workflow_groups, workflow_runs, workflows.
--   SELECT relname, relreplident FROM pg_class WHERE relname IN (...);
--   → 'f' for the FULL set, 'd' for records and workflow_runs.
--
-- Rollback:
--   ALTER PUBLICATION supabase_realtime DROP TABLE <name>;  per table.
--   ALTER TABLE <name> REPLICA IDENTITY DEFAULT;            per FULL.
-- ============================================================

-- C.1: extend the supabase_realtime publication.
ALTER PUBLICATION supabase_realtime ADD TABLE
  public.records,
  public.models,
  public.model_groups,
  public.workflows,
  public.workflow_groups,
  public.workflow_runs,
  public.dashboards,
  public.model_views,
  public.profiles,
  public.roles,
  public.users;

-- C.2: REPLICA IDENTITY FULL on low-volume metadata tables — UPDATE/DELETE
-- realtime payloads carry the full row image so subscribers can compute diffs
-- without refetching.
ALTER TABLE public.models          REPLICA IDENTITY FULL;
ALTER TABLE public.model_groups    REPLICA IDENTITY FULL;
ALTER TABLE public.workflows       REPLICA IDENTITY FULL;
ALTER TABLE public.workflow_groups REPLICA IDENTITY FULL;
ALTER TABLE public.dashboards      REPLICA IDENTITY FULL;
ALTER TABLE public.model_views     REPLICA IDENTITY FULL;
ALTER TABLE public.profiles        REPLICA IDENTITY FULL;
ALTER TABLE public.roles           REPLICA IDENTITY FULL;
ALTER TABLE public.users           REPLICA IDENTITY FULL;

-- records and workflow_runs intentionally left at REPLICA IDENTITY DEFAULT.
-- Whole-row WAL on these high-volume tables would punish write throughput at
-- scale; the merge handler will refetch by id when needed.
