-- ============================================================================
-- Drop the 2026-09-29 Companies-restructure backup tables (2026-09-30)
-- ----------------------------------------------------------------------------
-- The operator confirmed the restructure and asked for the backups to go.
-- Nothing reads them (no function, no view). A full JSON copy of every row was
-- exported first to the operator's machine (.backups.local/, git-ignored) —
-- that export, not these tables, is the remaining undo for the merge.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';
DROP TABLE IF EXISTS public._backup_20260929_company_records;
DROP TABLE IF EXISTS public._backup_20260929_company_models;
DROP TABLE IF EXISTS public._backup_20260929_mkt_organizations;
DROP TABLE IF EXISTS public._backup_20260929_mkt_project_organizations;
COMMIT;
