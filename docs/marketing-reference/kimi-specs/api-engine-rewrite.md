TASK: Rewire the Marketing OS API + client + workspace shell onto the NEW canonical engine. Files you may modify:
- api/marketing-os.ts
- src/lib/marketingOS/client.ts
- src/pages/Marketing/MarketingWorkspace.tsx
- src/pages/Marketing/SettingsPage.tsx (ONLY the parts that break from removed actions — keep its screens intact otherwise; if the s26/s27 sections were split into components by a parallel task, leave those files alone)
- NEW small migration: supabase/migrations/2026-08-01_05_mos_role_grant_rpc.sql
Nothing else. Do not run migrations.

CONTEXT — READ FIRST, in order:
1. supabase/migrations/2026-08-01_01_workflow_engine_role_paths.sql — the engine: workflows.kind='role_path' with steps at metadata.steps; workflow_versions; mos_content.workflow_version_id; workflow_role_tasks (replaces mos_tasks; columns subject_table/subject_id/step_key/role_key/revision_targets...); RPCs workflow_advance_role_path + workflow_role_task_transfer; functions wassell_mos_roles() (text[] of held role keys), wassell_mos_role() (compat single), wassell_mos_can(), wassell_mos_surface_level(); surface_access table; canonical roles rows with key 'mos_*'. mos_workflows/mos_workflow_steps/mos_tasks/mos_role_grants ARE DROPPED — any code referencing them must change.
2. supabase/migrations/2026-08-01_02_mos_domain_batch.sql — mos_content_versions, mos_settings, mos_campaign_events, new columns.
3. docs/marketing-reference/api-contract.md — THE CONTRACT. Implement its "Engine" section actions exactly (bootstrap CHANGED, task_complete CHANGED, task_transfer NEW, workflow_save NEW replacing step_save, roles_list CHANGED, role_grant CHANGED, surface_matrix NEW, surface_set NEW) plus content_versions NEW and settings_data CHANGED (engine parts only: role-path workflows list now reads canonical rows; keep the rest of settings_data working).
4. api/marketing-os.ts as it stands (the actions being changed: bootstrap 162, task_complete 342, roles_list 599, role_grant 610, settings_data 1338, step_save 1358, work_list 705).

KEY IMPLEMENTATION POINTS:

A. bootstrap: query in parallel — wassell_mos_roles via supabase.rpc('wassell_mos_roles') (no args → auth uid), surface levels: read surface_access joined to roles + compute the caller's per-surface level client-of-the-db style: simplest is one rpc call per surface is WRONG — instead SELECT the caller's levels in one query: for each surface_key in a fixed list ['overview','mywork','team','content','calendar','library','shoots','campaigns','numbers','settings','roles'] call wassell_mos_surface_level? That is 11 RPC round trips — NO. Do it in one PostgREST call: supabase.from('surface_access').select('surface_key, level, roles!inner(key)') and compute the max level per surface for the caller's held roles in TS (roles from the wassell_mos_roles rpc; administrator/marketing_manager → all 'full'; viewer floor: overview:'read'). Mirror the SQL function's exact semantics (absence = hidden).
   workflows: from('workflows').select('id,label_ar,label_en,is_active,metadata').eq('kind','role_path') + latest version_no per workflow from('workflow_versions').select('workflow_id,version_no,id').order... aggregate in TS. Steps come from metadata.steps.
   Also return settings (mos_settings rows as Record), unread_notifications: 0 placeholder if the notifications migration file (2026-08-01_04) is absent from the repo, else real count via from('notifications') filtered read_at is null (count head:true).
   me.active_role: parse request header 'x-mos-active-role'; include only if held; else roles[0] ?? 'viewer'.

B. task_complete → supabase.rpc('workflow_advance_role_path', { p_subject_table:'mos_content', p_subject_id, p_result, p_note, p_targets }). BEFORE the rpc, when result==='submitted': snapshot the round — read mos_content (data) + mos_scenes rows for the content, read current open task's round, INSERT mos_content_versions { content_id, round, data, scenes: jsonb array of the scene rows, submitted_by_user_id: caller app user id (resolve via rpc wassell_app_user_id? it takes auth uid — simpler: select users.id where auth_uid = caller; the endpoint already has a pattern for user resolution — reuse it) } with upsert onConflict 'content_id,round' (a resubmit of the same round overwrites its snapshot). When result==='changes_requested': after the rpc returns, UPDATE mos_content_versions SET rejected_note = note WHERE content_id + round = (the CLOSED task's round — the rpc response returns round AFTER increment for rejections, so the rejected version round = response.round - 1; guard >= 1).
   Keep the existing response envelope + add the rpc's jsonb payload fields per the contract.

C. workflow_save: validate steps array (non-empty, unique keys, role_key in the 5, due_days int>=0); upsert the workflows row: for update — read existing row, merge metadata { ...existing.metadata, managed_by:'marketing_os', key: existing.metadata?.key ?? slug from label_en, steps }; for insert — kind 'role_path', conditions/actions '[]', is_active true. The DB trigger writes the version; afterwards read latest version_no and return it. REMOVE the step_save case entirely.

D. roles_list / role_grant: per contract. role_grant calls the NEW rpc mos_role_grant (see migration below). roles_list: from('roles').select('id,key,label_ar,label_en').like('key','mos\_%') + from('users').select('id,name_ar,name_en,email,role_assignments,is_active') — compose people with their held mos role keys.

E. surface_matrix / surface_set per contract (surface_set upserts via from('surface_access').upsert with onConflict 'role_id,surface_key').

F. task_transfer: rpc('workflow_role_task_transfer', { p_task_id, p_to_user_id }).

G. content_versions: from('mos_content_versions').select('*').eq('content_id',...).order('round').

H. work_list + any other action that referenced mos_tasks: switch to workflow_role_tasks (subject_table eq 'mos_content'; content join via subject_id). Search api/marketing-os.ts for EVERY occurrence of mos_tasks / mos_workflows / mos_workflow_steps / mos_role_grants and repoint or remove — grep before you finish; zero references may remain.

I. settings_data: role-path workflows from canonical rows (same shape the SettingsPage consumes — adapt SettingsPage minimally where fields moved into metadata.steps); drop the mos_workflow_steps read; include mos_settings values + surface matrix summary + notification-rules placeholder (empty array if migration 04 absent).

J. MarketingWorkspace.tsx: the WorkspaceCtx today has a hardcoded Capability MATRIX keyed by single role. Change to: bootstrap supplies me.roles (string[]) + me.surfaces (Record<surface,'full'|'read'|'hidden'>) + me.active_role. Keep the Capability union + MATRIX as the CLIENT-SIDE mirror but compute capability truth as the UNION over me.roles (administrator/marketing_manager → all). NAV filtering: each NAV item maps to a surface_key (add the mapping: overview→overview, my-work→mywork, team→team, content→content, calendar→calendar, library→library, shoots→shoots, campaigns→campaigns, numbers→numbers, settings→settings, search→content? NO — search is not in surface_access: show search whenever the user has ANY non-hidden surface). Hidden surface ⇒ nav item ABSENT (not disabled). 'read' ⇒ item visible; pages themselves handle read-only affordances later. Expose surfaces + roles + activeRole + setActiveRole (state persisted to localStorage 'mos_active_role'; sent as the x-mos-active-role header by the api client). Update src/lib/marketingOS/client.ts callMos to attach that header from localStorage.
   KEEP RequireMarketingWorkspace + the page_access gate untouched.

K. client.ts: add/adjust types for the contract shapes (BootstrapMe, WorkflowDef {id,label_ar,label_en,is_active,steps:StepDef[],current_version_no}, StepDef, SurfaceLevel, RolePerson etc.). No `any`.

MIGRATION 2026-08-01_05_mos_role_grant_rpc.sql: BEGIN/COMMIT; CREATE OR REPLACE FUNCTION public.mos_role_grant(p_user_id uuid, p_role_key text, p_grant boolean) RETURNS void SECURITY DEFINER SET search_path=public: require wassell_mos_can('manage_roles') else RAISE insufficient_privilege; validate p_role_key in the 5 mos keys ('ceo','marketing_manager','ops_supervisor','writer','montage' — accept WITHOUT the mos_ prefix and map to 'mos_'||p_role_key); resolve role id from roles.key; p_grant true → append {role_id, field_values:{}} to users.role_assignments if absent; false → remove any element with that role_id (jsonb path filter, rebuild array). GRANT EXECUTE to authenticated.

VERIFY before finishing: npx tsc --noEmit passes AND npx tsc -p tsconfig.api.json --noEmit passes (api has its own tsconfig — check the name; if tsconfig.api.json does not exist, find how api/ is typechecked and run that). grep -n "mos_tasks\|mos_workflows\|mos_workflow_steps\|mos_role_grants" api/ src/ returns ZERO code references (comments that say "formerly mos_tasks" are fine).
Print exactly: API-ENGINE REWIRED + the tsc results + the grep result.
