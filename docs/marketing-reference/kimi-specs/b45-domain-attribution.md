TASK: Write TWO new SQL migration files (nothing else):
1. supabase/migrations/2026-08-01_02_mos_domain_batch.sql
2. supabase/migrations/2026-08-01_03_client_attributions.sql
Do NOT apply them. They run AFTER supabase/migrations/2026-08-01_01_workflow_engine_role_paths.sql (which creates workflow_versions, workflow_role_tasks, surface_access and retires mos_workflows/mos_workflow_steps/mos_tasks/mos_role_grants). If that file exists in the repo, read it first for style + to avoid duplicating anything; if it does not exist yet, proceed against this spec's ground truth.

House style: read supabase/migrations/2026-07-30_01_mos_core.sql. One BEGIN/COMMIT per file, guarded DDL (IF NOT EXISTS / DO blocks), header comment.

GROUND TRUTH (live prod columns — do not re-add existing ones): mos_campaigns has kind, goal, owner_role, success_metric, success_threshold, objective, status, starts_on, ends_on, budget_total, note, ref, project_id, archived_at. mos_campaign_executions has targeting jsonb, lead_form_fields jsonb, platform, account_id, label, status, starts_on, ends_on, budget, spend, impressions, clicks, leads, qualified, source, note. mos_assets has file_path, mime_type, size_bytes, original_name, usage_rights, shoot_request_id, tags text[], shot_on, archived_at. mos_scenes has footage_status CHECK ('have','to_make','missing') named mos_scenes_footage_check. mos_shoot_requests has delivered_at, assigned_role, location, scheduled_at. mos_content has data jsonb, workflow_id, campaign_id, purpose, language, goal, audience, angle, cta, target_publish_at, due_at. RLS helper: wassell_mos_can(text). User mapping: wassell_app_user_id(auth.uid()). Touch trigger fn: mos_tg_touch_updated_at().

=== FILE 1: 2026-08-01_02_mos_domain_batch.sql ===

A. mos_content_versions — round snapshots written on submit:
   id uuid PK default gen_random_uuid(), content_id uuid NOT NULL -> mos_content CASCADE, round int NOT NULL, data jsonb NOT NULL, scenes jsonb NOT NULL DEFAULT '[]' (frozen scene list), submitted_by_user_id uuid -> users SET NULL, rejected_note text NULL (filled when that round got rejected), created_at timestamptz default now(). UNIQUE(content_id, round). Index content_id. RLS: SELECT wassell_mos_can('read'); INSERT wassell_mos_can('write_content'); UPDATE wassell_mos_can('assign') (to attach the rejection note); no DELETE policy.

B. Campaign brief + signature columns on mos_campaigns (ADD COLUMN IF NOT EXISTS):
   audience text, offer text, destination_url text, measured_by text, requires_signature boolean NOT NULL DEFAULT false, signed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, signed_at timestamptz.

C. mos_campaign_events — the «ما الذي تغيّر» ledger:
   id uuid PK, campaign_id uuid NOT NULL -> mos_campaigns CASCADE, kind text NOT NULL CHECK (kind IN ('budget_shift','execution_added','execution_paused','execution_resumed','content_linked','content_unlinked','signed','note')), summary_ar text NOT NULL, summary_en text, detail jsonb NOT NULL DEFAULT '{}', actor_user_id uuid -> users SET NULL, created_at timestamptz default now(). Index (campaign_id, created_at DESC). RLS: SELECT read; INSERT wassell_mos_can('enter_metrics') OR wassell_mos_can('approve_budget'); no UPDATE/DELETE policies (append-only ledger).

D. Executions: ADD COLUMN IF NOT EXISTS platform_campaign_id text, purpose text CHECK (purpose IS NULL OR purpose IN ('conversion','awareness','retargeting','traffic')) (named check, DO-guarded).

E. Assets: ADD COLUMN IF NOT EXISTS shot_by text, rights_expiry date, parent_asset_id uuid REFERENCES mos_assets(id) ON DELETE SET NULL, duration_seconds numeric. Index parent_asset_id.

F. Shoots: ADD COLUMN IF NOT EXISTS crew text, duration_estimate text.

G. Scenes: widen footage CHECK to ('have','to_make','missing','template') — drop constraint mos_scenes_footage_check if exists, re-add with the new set, same name.

H. workflow_role_tasks: ADD COLUMN IF NOT EXISTS revision_targets jsonb NOT NULL DEFAULT '[]' — GUARDED so it is a no-op if migration 01 already created it (wrap in DO block checking the table exists first; if the table does not exist, RAISE EXCEPTION telling the operator migration 01 must run first).

I. mos_settings — module settings key-value:
   key text PK, value jsonb NOT NULL, updated_by_user_id uuid, updated_at timestamptz default now(). RLS: SELECT read; INSERT/UPDATE wassell_mos_can('manage_settings'); no DELETE.
   Seed (ON CONFLICT (key) DO NOTHING):
     ('signature_threshold', '{"amount": 50000, "currency": "SAR"}'),
     ('shoot_grouping_thresholds', '{"min_shots": 4, "max_wait_days": 14}'),
     ('attribution', '{"window_days": 90, "touch": "first", "exclude_cancelled": true}'),
     ('external_effects', '{"enabled": true}')  -- branch/fixture envs flip to false; notify dispatch checks it

=== FILE 2: 2026-08-01_03_client_attributions.sql ===

client_attributions — IMMUTABLE append-only attribution ledger linking CRM clients to marketing spend objects:
  id uuid PK default gen_random_uuid(),
  client_record_id uuid NOT NULL           -- records.id of the client (unified records; NO FK because frozen models may move rows out of `records` — add a comment explaining this),
  campaign_id uuid REFERENCES mos_campaigns(id) ON DELETE RESTRICT,   -- RESTRICT: never lose the ledger to a campaign delete
  execution_id uuid REFERENCES mos_campaign_executions(id) ON DELETE RESTRICT,
  ad_id uuid REFERENCES mos_execution_ads(id) ON DELETE RESTRICT,
  touch_type text NOT NULL DEFAULT 'first' CHECK (touch_type IN ('first','last')),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('lead_form','manual','import')),
  note text,
  supersedes_id uuid REFERENCES client_attributions(id),  -- audited corrections APPEND a new row pointing at the corrected one
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (campaign_id IS NOT NULL OR execution_id IS NOT NULL OR ad_id IS NOT NULL)
Indexes: (client_record_id, occurred_at), (campaign_id), (execution_id), (ad_id), (supersedes_id).
RLS: SELECT wassell_mos_can('read') OR wassell_can_view_workflows-style? NO — keep it simple: SELECT to authenticated USING (wassell_mos_can('read')); INSERT WITH CHECK (wassell_mos_can('enter_metrics') OR wassell_mos_can('approve_budget')); NO UPDATE and NO DELETE policies — immutability enforced by absence of policies AND by a BEFORE UPDATE OR DELETE trigger that RAISES 'MOS:ATTRIBUTION_IMMUTABLE' (belt and braces vs service-role code).

Helper view client_attributions_effective — resolves the correction chain: the latest row per (client_record_id, touch_type) chain where no other row supersedes it:
  CREATE VIEW client_attributions_effective WITH (security_invoker=true) AS
  SELECT a.* FROM client_attributions a
  WHERE NOT EXISTS (SELECT 1 FROM client_attributions b WHERE b.supersedes_id = a.id);

Derivation function mos_campaign_outcomes(p_campaign_id uuid) RETURNS jsonb, LANGUAGE sql, STABLE, SECURITY INVOKER (caller RLS applies to unified_records!):
  Reads settings from mos_settings key 'attribution' (window_days, exclude_cancelled).
  attributed := effective FIRST-touch rows for this campaign (campaign_id matches OR execution belongs to campaign OR ad belongs to campaign's executions).
  Model ids as constants with a comment: appointments b032a675-6237-4436-9783-a1a253855f74 (data->>'appointment_status', data->>'appointment_date', data->>'client_id'); visits 372ed642-3753-40b4-9dd7-e8390f91b1f8 (data->>'scheduled_datetime', data->>'client_id'); reservations 5a1e0ffe-0000-4000-8000-000000000002 (data->>'reservation_amount', data->>'reservation_date', data->>'payment_status', data->>'client_id').
  Window: CRM record's date within [attribution.occurred_at, occurred_at + window_days].
  Returns jsonb_build_object(
    'attributed_clients', <count of distinct client_record_id attributed>,           -- unique clients
    'appointments', <COUNT of appointment records of attributed clients in-window whose appointment_status NOT IN ('cancelled','no_show')>,  -- event count
    'visits', <COUNT of visit records of attributed clients in-window>,               -- event count (model has no status — comment this)
    'reservations', <COUNT of reservation records of attributed clients in-window>,   -- unique events; NOTE in a comment: the live reservations model has NO cancelled state — exclude_cancelled currently excludes nothing here; appointments DO honor it
    'reservation_value', <SUM of reservation_amount::numeric of those records (use a safe cast: NULLIF regex guard or the existing try_numeric(text) function if present — CHECK the catalog comment: try_numeric exists in this DB, use it)>,
    'window_days', <the setting>, 'touch', 'first', 'computed_at', now())
  Client matching: CRM records store the client link at data->>'client_id' = the client's records.id::text — compare against attributed client_record_id::text.
  GRANT EXECUTE to authenticated.

Both files end with a validation DO block (file 1: assert mos_settings seeded >= 4 rows; file 2: assert the immutability trigger exists).

When done print exactly: DOMAIN+ATTRIBUTION WRITTEN.
