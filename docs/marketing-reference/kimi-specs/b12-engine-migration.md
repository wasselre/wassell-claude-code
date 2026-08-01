TASK: Write ONE new SQL migration file: supabase/migrations/2026-08-01_01_workflow_engine_role_paths.sql
It extends the CANONICAL Wassel workflow/roles engine with marketing role-paths and retires the marketing-branded engine tables. Write the file only — do NOT apply it, do NOT touch any other file. It will be applied to a branch DB first, prod later.

Style: one BEGIN/COMMIT transaction; every CREATE guarded (IF NOT EXISTS / DO blocks); a header comment block explaining what+why; section banners. Read supabase/migrations/2026-07-30_01_mos_core.sql first to match house style and to see the tables being retired.

## GROUND TRUTH (live prod — trust this over schema.sql, which is stale)

canonical `workflows` columns: id uuid PK, label_ar, label_en, trigger_model_id uuid NULL->models CASCADE, trigger_event text CHECK IN ('create','update','delete','webhook','on_due','button_click'), group_id uuid->workflow_groups SET NULL, conditions jsonb '[]', actions jsonb '[]', branches jsonb (prod-only column), metadata jsonb, is_active bool, created_at, updated_at. NOTE: verify nullability of trigger_event with a guarded `ALTER TABLE workflows ALTER COLUMN trigger_event DROP NOT NULL` inside a DO block that checks attnotnull first — role_path rows carry trigger_event NULL (CHECK constraints pass on NULL).

canonical `roles`: id uuid PK, label_ar, label_en, schema jsonb (a ModelSchema — roles carry fields), is_system, created_at, updated_at. `users.role_assignments` is a jsonb ARRAY of objects {"role_id": "<uuid>", "field_values": {}} — multi-role per user already.

`mos_workflows`: id, key UNIQUE, label_ar, label_en, is_active, created_at, updated_at, archived_at.
`mos_workflow_steps`: id, workflow_id->mos_workflows CASCADE, position, key, label_ar, label_en, role text CHECK ('ceo','marketing_manager','ops_supervisor','writer','montage'), due_days int DEFAULT 2, is_approval bool, approval_kind text CHECK (creative|process|budget, NULL when not approval), require_note_on_reject bool DEFAULT true, creates_revision bool DEFAULT true, required_fields jsonb '[]', required_files jsonb '[]', created_at, updated_at. UNIQUE(workflow_id,key), UNIQUE(workflow_id,position).
`mos_tasks`: id, content_id->mos_content CASCADE, step_id->mos_workflow_steps SET NULL, role text, assignee_user_id->users SET NULL, status CHECK (open|done|skipped), result CHECK (NULL|submitted|approved|changes_requested), note, round int DEFAULT 1, opened_at, due_at, closed_at, closed_by_user_id->users SET NULL, created_at, updated_at. Partial unique uq_mos_tasks_one_open ON (content_id) WHERE status='open'. CHECK: result changes_requested requires note. Policies: read=wassell_mos_can('read'); ins/upd/del=wassell_mos_can('assign'); plus mos_tasks_upd_own UPDATE where assignee_user_id = wassell_app_user_id(auth.uid()).
`mos_role_grants`: user_id PK->users CASCADE, mos_role CHECK (ceo|marketing_manager|ops_supervisor|writer|montage|viewer), granted_by_user_id, created_at, updated_at.
`mos_content`: has workflow_id uuid FK -> mos_workflows(id) ON DELETE SET NULL (constraint name mos_content_workflow_id_fkey). `mos_content_types`: workflow_id FK -> mos_workflows SET NULL (mos_content_types_workflow_id_fkey).
`mos_content_v` view (security_invoker=true) — read its definition in supabase/migrations/2026-07-30_01_mos_core.sql:379-417; you will REBUILD it in this migration over the new task table + pinned versions.
Helper functions that exist and you may call: wassell_is_admin(uuid), wassell_app_user_id(uuid), wassell_mos_can(text[, uuid]) (being rewritten here), wassell_mos_role(uuid) (being rewritten here).
The transition semantics to port into SQL live in api/marketing-os.ts `case 'task_complete'` (~line 342) — READ IT CAREFULLY and mirror it exactly (submit/approve advances to next step by position; changes_requested requires note, routes back to the earliest prior step whose creates_revision=true (falling back to step 1), increments round; completing the last step leaves no open task = done).

## THE MIGRATION — sections in order

### 1. workflows.kind
ADD COLUMN kind text NOT NULL DEFAULT 'automation'; CHECK kind IN ('automation','role_path') (named workflows_kind_check, add via DO block if absent). Make trigger_event nullable (guarded, see above).

### 2. workflow_versions (engine-level, benefits ALL workflows)
CREATE TABLE workflow_versions: id uuid PK DEFAULT gen_random_uuid(), workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, version_no int NOT NULL, definition jsonb NOT NULL, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow_id, version_no). Index on workflow_id. RLS ON; policy: SELECT to authenticated USING (true) (definitions are internal app data every role must render); NO insert/update/delete policies (writes come from the SECURITY DEFINER trigger below / service role).

Trigger function workflows_tg_write_version() SECURITY DEFINER SET search_path=public: AFTER INSERT OR UPDATE ON workflows FOR EACH ROW. On UPDATE, skip when the definition did not change (compare jsonb_build_object over label_ar,label_en,kind,trigger_model_id,trigger_event,conditions,actions,branches,metadata OLD vs NEW — is_active flips alone do NOT version). Insert a row with version_no = COALESCE(max+1,1) for that workflow and definition = jsonb_build_object('label_ar',...,'label_en',...,'kind',...,'trigger_model_id',...,'trigger_event',...,'conditions',...,'actions',...,'branches',...,'metadata',...). created_by_user_id = wassell_app_user_id(auth.uid()) (NULL-safe).
Backfill: INSERT version 1 for every existing workflows row that has no version yet (same definition shape, created_by NULL).

### 3. Marketing roles become canonical roles
ALTER TABLE roles ADD COLUMN IF NOT EXISTS key text; partial unique index on key WHERE key IS NOT NULL.
Seed 5 rows with FIXED uuids (use literal uuids 'a0000000-0000-4000-8000-00000000000１' style is INVALID — use real hex: 'ad000001-...' etc. Pick literal constants like 'c0febe01-0000-4000-8000-000000000001' through -005), keys: mos_ceo, mos_marketing_manager, mos_ops_supervisor, mos_writer, mos_montage; label_ar/label_en (الرئيس التنفيذي/CEO, مدير التسويق/Marketing Manager, مشرف العمليات/Ops Supervisor, الكاتب/Writer, المونتاج/Montage); schema '{"sections":[]}'::jsonb; is_system true. ON CONFLICT (id) DO NOTHING.
Migrate mos_role_grants → users.role_assignments: for each grant with mos_role <> 'viewer', append {"role_id": <matching mos_* role uuid>, "field_values": {}} to that user's role_assignments UNLESS an entry with that role_id already exists (jsonb containment check). viewer grants migrate to nothing (viewer = default).

### 4. surface_access (generic three-state surface matrix)
CREATE TABLE surface_access: role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, surface_key text NOT NULL, level text NOT NULL CHECK (level IN ('full','read','hidden')), updated_at timestamptz DEFAULT now(), PRIMARY KEY (role_id, surface_key). RLS ON; SELECT to authenticated USING (true); write policies (INSERT/UPDATE/DELETE) gated on wassell_mos_can('manage_roles').
SEED it from the approved design's screen 33 matrix: READ docs/marketing-reference/source/screens/s33.html and transcribe the exact ●(full)/○(read)/—(hidden) cell values for the five roles across its surface rows. Map the Arabic surface rows to these surface_key values: overview, mywork, team, content, calendar, library, shoots, campaigns, numbers, settings, search, notifications, roles. If s33 lacks a row for a key, omit that key (do not invent). Add a SQL comment above the seed mapping each Arabic row label to its key so the transcription is auditable.

### 5. Rewrite the mos capability stack over canonical assignment
- wassell_mos_roles(p_auth_uid uuid DEFAULT auth.uid()) RETURNS text[] STABLE SECURITY DEFINER: NULL uid -> '{}'; admin (wassell_is_admin) -> ARRAY['administrator']; else SELECT keys of held marketing roles: from users u join roles r on r.id::text IN (SELECT (elem->>'role_id') FROM jsonb_array_elements(u.role_assignments) elem) where u.auth_uid=p_auth_uid AND r.key LIKE 'mos\_%' — return array of substring(r.key from 5) (strips 'mos_'); empty -> ARRAY['viewer'].
- wassell_mos_role(p_auth_uid uuid DEFAULT auth.uid()) RETURNS text (compat, used by UI): highest-privilege single role from wassell_mos_roles ordered administrator > marketing_manager > ops_supervisor > ceo > writer > montage > viewer.
- wassell_mos_can(p_capability text, p_auth_uid uuid DEFAULT auth.uid()) RETURNS bool: TRUE if ANY role in wassell_mos_roles grants the capability — keep the existing per-role capability CASE exactly as it is today (read it in 2026-07-30_01_mos_core.sql:80-106): administrator/marketing_manager -> all; ceo -> read,comment,approve_budget,review_performance; ops_supervisor -> read,comment,assign,schedule,publish,approve_process,manage_assets,enter_metrics,review_performance; writer -> read,comment,write_content,schedule,publish; montage -> read,comment,write_content,manage_assets; viewer -> read. (CREATE OR REPLACE keeps every existing RLS policy working unchanged.)
- wassell_mos_surface_level(p_surface_key text, p_auth_uid uuid DEFAULT auth.uid()) RETURNS text: admin or marketing_manager -> 'full'; else the MAX level across held mos roles from surface_access (full > read > hidden); no row for a held role -> treat that role as 'hidden'; no held roles (viewer) -> 'hidden' except surface_key IN ('overview') -> 'read' (viewer read-only floor; note this in a comment).

### 6. workflow_role_tasks (engine-generic task table; mos_tasks promoted)
CREATE TABLE workflow_role_tasks: id uuid PK DEFAULT gen_random_uuid(), subject_table text NOT NULL DEFAULT 'mos_content', subject_id uuid NOT NULL, workflow_version_id uuid REFERENCES workflow_versions(id), step_key text, role_key text NOT NULL CHECK (role_key IN ('ceo','marketing_manager','ops_supervisor','writer','montage')), assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL, status text NOT NULL DEFAULT 'open' CHECK (open|done|skipped), result text CHECK (result IS NULL OR result IN ('submitted','approved','changes_requested')), note text, revision_targets jsonb NOT NULL DEFAULT '[]', round int NOT NULL DEFAULT 1, opened_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz, closed_at timestamptz, closed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at/updated_at defaults, CHECK (result IS DISTINCT FROM 'changes_requested' OR note IS NOT NULL).
Indexes: UNIQUE (subject_table, subject_id) WHERE status='open' (one-open-task invariant); (role_key) WHERE open; (assignee_user_id) WHERE open; (due_at) WHERE open; (subject_table, subject_id).
BEFORE UPDATE touch trigger reusing mos_tg_touch_updated_at().
RLS ON, policies mirroring mos_tasks but scoped: read = wassell_mos_can('read') AND subject_table='mos_content'; ins/upd/del = wassell_mos_can('assign') AND subject_table='mos_content'; own-update = assignee_user_id = wassell_app_user_id(auth.uid()). (Future non-marketing consumers add their own policies.)
DATA MIGRATION from mos_tasks: id, subject_id=content_id, step_key = (SELECT s.key FROM mos_workflow_steps s WHERE s.id = t.step_id), role_key=t.role, workflow_version_id = NULL for now (filled in section 8 after content pinning), everything else 1:1 (revision_targets '[]').

### 7. Migrate the two mos workflows into canonical workflows
INSERT INTO workflows (id, label_ar, label_en, kind, trigger_model_id, trigger_event, conditions, actions, is_active, metadata)
SELECT w.id, w.label_ar, w.label_en, 'role_path', NULL, NULL, '[]', '[]', w.is_active,
 jsonb_build_object('managed_by','marketing_os','key',w.key,'steps',
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('key',s.key,'label_ar',s.label_ar,'label_en',s.label_en,'role_key',s.role,'due_days',s.due_days,'is_approval',s.is_approval,'approval_kind',s.approval_kind,'require_note_on_reject',s.require_note_on_reject,'creates_revision',s.creates_revision,'required_fields',s.required_fields,'required_files',s.required_files) ORDER BY s.position),'[]') FROM mos_workflow_steps s WHERE s.workflow_id=w.id))
FROM mos_workflows w ON CONFLICT (id) DO NOTHING;  -- SAME uuids so existing mos_content.workflow_id keeps pointing at the right row
(branches column: omit from the INSERT column list — its default/NULL is fine.)
The version trigger fires on these inserts -> version 1 exists for each.

### 8. Re-point FKs + pin in-flight content
- mos_content: DROP CONSTRAINT mos_content_workflow_id_fkey; ADD FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL.
- mos_content_types: same swap to workflows(id).
- ALTER TABLE mos_content ADD COLUMN IF NOT EXISTS workflow_version_id uuid REFERENCES workflow_versions(id) ON DELETE RESTRICT.
- Backfill: UPDATE mos_content SET workflow_version_id = (SELECT v.id FROM workflow_versions v WHERE v.workflow_id = mos_content.workflow_id AND v.version_no = 1) WHERE workflow_id IS NOT NULL — freezes every in-flight record on the exact definition it has been running under.
- UPDATE workflow_role_tasks t SET workflow_version_id = c.workflow_version_id FROM mos_content c WHERE t.subject_table='mos_content' AND t.subject_id=c.id.

### 9. Rebuild mos_content_v
DROP VIEW mos_content_v; CREATE VIEW mos_content_v WITH (security_invoker=true) — same output columns as before (the API depends on them) but: open task from workflow_role_tasks (subject_table='mos_content'); current step data extracted from the PINNED version: join workflow_versions v ON v.id=c.workflow_version_id, then step obj = the element of v.definition->'metadata'... CAREFUL: definition stores metadata at top level as built in section 2, i.e. definition->'metadata'->'steps'. Extract with a LEFT JOIN LATERAL (SELECT elem, ord::int AS position FROM jsonb_array_elements(v.definition->'metadata'->'steps') WITH ORDINALITY AS e(elem, ord) WHERE elem->>'key' = t.step_key) s ON true. current_step_label_ar = s.elem->>'label_ar', etc., current_step_position = s.position, owner_role = t.role_key, status_key same CASE logic as the old view (s.key present -> step key; open task w/o step -> 'unassigned'; any closed tasks -> 'done'; else 'draft').

### 10. workflow_advance_role_path — the engine transition (SECURITY DEFINER, transactional)
CREATE FUNCTION workflow_advance_role_path(p_subject_table text, p_subject_id uuid, p_result text, p_note text DEFAULT NULL, p_targets jsonb DEFAULT '[]') RETURNS jsonb, plpgsql SECURITY DEFINER SET search_path=public.
Semantics (port from api/marketing-os.ts task_complete):
- Only p_subject_table='mos_content' supported for now (RAISE otherwise, errcode feature_not_supported).
- Lock the open task: SELECT ... FROM workflow_role_tasks WHERE subject_table/subject_id AND status='open' FOR UPDATE; none -> RAISE 'MOS:NO_OPEN_TASK'.
- AUTHZ inside the function (definer bypasses RLS, so check explicitly): caller roles := wassell_mos_roles(auth.uid()); allowed when 'administrator' or 'marketing_manager' member, OR task.role_key = ANY(roles), OR task.assignee_user_id = wassell_app_user_id(auth.uid()). Else RAISE insufficient_privilege 'MOS:NOT_YOUR_TASK'.
- p_result must be one of submitted/approved/changes_requested; changes_requested requires non-empty p_note (RAISE 'MOS:NOTE_REQUIRED').
- Load pinned steps: from mos_content.workflow_version_id -> workflow_versions.definition->'metadata'->'steps' (jsonb array). If content has no version (workflow_id NULL) -> close task, return done.
- Close the task: status='done', result, note=p_note, revision_targets=COALESCE(p_targets,'[]'), closed_at=now(), closed_by_user_id=wassell_app_user_id(auth.uid()).
- Find current index by step_key in the pinned array.
- If submitted/approved: next step = index+1; if exists, INSERT new open task (subject, workflow_version_id, step_key=next->>'key', role_key=next->>'role_key', round = same round, due_at = now() + (next->>'due_days')::int * interval '1 day'); if no next -> nothing (record done).
- If changes_requested: target = the LAST step BEFORE current index with creates_revision=true, else steps[0]; INSERT new open task at that step with round = old.round + 1, due_at from its due_days.
- RETURN jsonb: {closed_task_id, opened_task_id (nullable), next_step_key (nullable), round, done bool}.
GRANT EXECUTE to authenticated.

### 11. workflow_role_task_transfer(p_task_id uuid, p_to_user_id uuid) RETURNS void
SECURITY DEFINER: only wassell_mos_can('manage_roles') OR wassell_mos_can('assign') callers (RAISE otherwise); task must be open; sets assignee_user_id=p_to_user_id, appends to note a line 'transferred by <app user id> at <now()>' (keep simple), touches updated_at. GRANT EXECUTE to authenticated.

### 12. Retirement
DROP TABLE mos_tasks; DROP TABLE mos_workflow_steps; DROP TABLE mos_role_grants; DROP TABLE mos_workflows; (order matters for FKs: mos_tasks first (FK->steps), then steps (FK->mos_workflows), then role_grants, then mos_workflows — all FKs INTO them from mos_content/mos_content_types were re-pointed in section 8; double-check no other FK references remain — mos_content_v was rebuilt in 9.)
Add a final comment listing what was retired and where each concern now lives.

VALIDATION at the end of the file (before COMMIT): DO block that RAISEs if (a) any mos_content.workflow_id NOT NULL lacks workflow_version_id, (b) workflow_role_tasks count <> the pre-migration mos_tasks count (capture count into a temp table at the top of the migration before section 6), (c) any workflows row with kind='role_path' has metadata->'steps' NULL or empty.

When done print exactly: ENGINE-MIGRATION WRITTEN plus a 5-line summary of section line numbers.
