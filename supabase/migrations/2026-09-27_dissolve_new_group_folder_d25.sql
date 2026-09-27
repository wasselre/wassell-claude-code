-- D25: dissolve the "New Group" model-folder.
--
-- The group (label_ar "المبيعات", label_en "New Group",
-- id ea355303-a1b2-4070-9e06-9be271a1bcc5, order 3) wrapped the sales lifecycle
-- models. Those are already hidden (WORKSPACE_HIDDEN_MODEL_NAMES) and surfaced
-- through the Sales Workspace, but the folder still showed because clients /
-- chats / ai_chats render inside it — leaving a redundant "المبيعات" folder next
-- to the new Sales Workspace sidebar row.
--
-- Ungroup ALL of the folder's models → they become top-level sidebar rows (the
-- hidden ones stay hidden via WORKSPACE_HIDDEN_MODEL_NAMES; only clients / chats /
-- ai_chats remain visible), then delete the now-empty group. The sidebar reads
-- model_groups + models.group_id from the DB, so this takes effect on next load —
-- no code deploy required.
--
-- Applied live to wassell-prod 2026-09-27 (group deleted, 13 models ungrouped).
-- Restore: re-INSERT model_groups (id ea355303-…, ar المبيعات, en 'New Group',
-- order 3) and set group_id back on those models.

BEGIN;

UPDATE public.models
SET group_id = NULL, updated_at = now()
WHERE group_id = 'ea355303-a1b2-4070-9e06-9be271a1bcc5';

DELETE FROM public.model_groups
WHERE id = 'ea355303-a1b2-4070-9e06-9be271a1bcc5';

COMMIT;
