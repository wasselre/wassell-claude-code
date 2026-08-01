/**
 * Typed SPA client for /api/marketing-os.
 *
 * Same two-file shape as every other bespoke module (see src/lib/financing/client.ts):
 * a thin `call<T>` transport plus one typed wrapper per action. Components never
 * touch `supabase` directly and never build a fetch by hand.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

/** The five working roles, plus the two the database can also return. */
export type MosRole =
  | 'administrator'
  | 'ceo'
  | 'marketing_manager'
  | 'ops_supervisor'
  | 'writer'
  | 'montage'
  | 'viewer'
  | 'none';

/** The five roles a role-path step can point at (mos_ prefix stripped). */
export type MosPathRole = 'ceo' | 'marketing_manager' | 'ops_supervisor' | 'writer' | 'montage';

/** Every surface the shell can route to. Absence from surface_access = hidden. */
export type SurfaceKey =
  | 'overview' | 'mywork' | 'team' | 'content' | 'calendar' | 'library'
  | 'shoots' | 'campaigns' | 'numbers' | 'settings' | 'roles';

export type SurfaceLevel = 'full' | 'read' | 'hidden';

/** A role-path step, as stored in workflows.metadata.steps. */
export interface StepDef {
  key: string;
  label_ar: string;
  label_en: string;
  role_key: MosPathRole;
  due_days: number;
  is_approval: boolean;
  approval_kind: 'creative' | 'process' | 'budget' | null;
  require_note_on_reject: boolean;
  creates_revision: boolean;
  required_fields: string[];
  required_files: string[];
}

/** A canonical workflow (kind='role_path') with its current version pinned on. */
export interface WorkflowDef {
  id: string;
  label_ar: string;
  label_en: string;
  is_active: boolean;
  steps: StepDef[];
  current_version_no: number;
  current_version_id: string | null;
}

export interface BootstrapMe {
  user_id: string | null;
  /** Every mos role the caller HOLDS (multi-role is the point of the new engine). */
  roles: MosRole[];
  active_role: MosRole;
  surfaces: Record<SurfaceKey, SurfaceLevel>;
  prefs: Record<string, unknown>;
}

export interface BootstrapResponse {
  me: BootstrapMe;
  content_types: MosContentType[];
  workflows: WorkflowDef[];
  platform_accounts: MosAccount[];
  settings: Record<string, unknown>;
  unread_notifications: number;
}

/** A person and the mos role keys they hold. */
export interface RolePerson {
  user_id: string;
  name_ar: string | null;
  name_en: string | null;
  email: string | null;
  roles: MosRole[];
}

/** A canonical mos role and how many people currently hold it. */
export interface MosRoleDef {
  key: string;
  role_id: string;
  label_ar: string;
  label_en: string;
  holders: number;
}

export interface SurfaceCell {
  role_key: string;
  surface_key: string;
  level: SurfaceLevel;
}

export interface MosContentVersion {
  id: string;
  content_id: string;
  round: number;
  data: Record<string, unknown>;
  scenes: MosScene[];
  submitted_by_user_id: string | null;
  rejected_note: string | null;
  created_at: string;
}

export interface MosContentType {
  id: string;
  key: string;
  label_ar: string;
  label_en: string;
  prefix: string;
  workflow_id: string | null;
  field_schema: string[];
  sort_order: number;
}

/**
 * A row of `mos_content_v`. `status_key` and `owner_role` are DERIVED from the
 * open task by the view — they are not columns anyone can set, which is why the
 * list can never disagree with the task queue.
 *
 * The role field is `owner_role`, NOT `current_role`: the latter is a reserved
 * SQL niladic function, so a view column of that name is silently shadowed and
 * returns the database role ('postgres') to every caller.
 */
export interface MosContentRow {
  id: string;
  ref: string | null;
  title: string;
  content_type_key: string;
  content_type_label_ar: string;
  content_type_label_en: string;
  project_id: string | null;
  campaign_id: string | null;
  purpose: 'organic' | 'paid' | 'both';
  status_key: string;
  current_step_label_ar: string | null;
  current_step_label_en: string | null;
  owner_role: MosRole | null;
  current_assignee_user_id: string | null;
  current_task_due_at: string | null;
  current_round: number | null;
  due_at: string | null;
  target_publish_at: string | null;
  updated_at: string;
  /** Only present on `content_detail` (the list select names its columns). */
  data?: Record<string, unknown>;
  goal?: string | null;
  audience?: string | null;
  angle?: string | null;
  cta?: string | null;
  language?: string | null;
  workflow_id?: string | null;
  archived_at?: string | null;
}

export interface MosTask {
  id: string;
  content_id: string;
  step_id: string | null;
  role: MosRole;
  assignee_user_id: string | null;
  status: 'open' | 'done' | 'skipped';
  result: 'submitted' | 'approved' | 'changes_requested' | null;
  note: string | null;
  round: number;
  opened_at: string;
  due_at: string | null;
  closed_at: string | null;
}

export interface MosStep {
  id: string;
  workflow_id: string;
  position: number;
  key: string;
  label_ar: string;
  label_en: string;
  role: MosRole;
  due_days: number;
  is_approval: boolean;
  approval_kind: 'creative' | 'process' | 'budget' | null;
  /** Field slugs the step expects to be filled — drives the task checklist. */
  required_fields?: string[] | null;
  required_files?: string[] | null;
  require_note_on_reject?: boolean;
  creates_revision?: boolean;
}

export interface MosScene {
  id: string;
  content_id: string;
  position: number;
  start_sec: number | null;
  end_sec: number | null;
  visual: string | null;
  voiceover: string | null;
  on_screen_text: string | null;
  footage_status: 'have' | 'to_make' | 'missing';
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The role the caller is currently working as. Display-affecting only — the
 * server validates it against the held roles and never authorizes off it.
 */
const ACTIVE_ROLE_KEY = 'mos_active_role';

export function getActiveRole(): string | null {
  return window.localStorage.getItem(ACTIVE_ROLE_KEY);
}

export function persistActiveRole(role: string): void {
  window.localStorage.setItem(ACTIVE_ROLE_KEY, role);
}

function activeRoleHeader(): Record<string, string> {
  const role = getActiveRole();
  return role ? { 'x-mos-active-role': role } : {};
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing-os', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
      ...activeRoleHeader(),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; error_ar?: string };
    const isAr = useAppStore.getState().language === 'ar';
    throw new Error(
      (isAr ? b?.error_ar || b?.error : b?.error) ?? `marketing-os ${action} failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* actions                                                            */
/* ------------------------------------------------------------------ */

export const fetchBootstrap = () => call<BootstrapResponse>('bootstrap');

export const fetchContentList = (filters: Record<string, unknown> = {}) =>
  call<{ content: MosContentRow[] }>('content_list', filters);

export const fetchContentDetail = (id: string) =>
  call<{ item: MosContentRow; tasks: MosTask[]; scenes: MosScene[]; steps: MosStep[] }>(
    'content_detail',
    { id },
  );

export const createContent = (payload: Record<string, unknown>) =>
  call<{ item: MosContentRow }>('content_create', payload);

export const updateContent = (id: string, patch: Record<string, unknown>) =>
  call<{ item: MosContentRow }>('content_update', { id, patch });

export interface TaskAdvanceResult {
  item: MosContentRow;
  closed_task_id: string;
  opened_task_id: string | null;
  next_step_key: string | null;
  round: number;
  done: boolean;
}

export const completeTask = (
  taskId: string,
  result: 'submitted' | 'approved' | 'changes_requested',
  note?: string,
  targets?: string[],
) => call<TaskAdvanceResult>('task_complete', { task_id: taskId, result, note, targets });

export const transferTask = (taskId: string, toUserId: string) =>
  call<{ ok: true }>('task_transfer', { task_id: taskId, to_user_id: toUserId });

export const fetchContentVersions = (contentId: string) =>
  call<{ versions: MosContentVersion[] }>('content_versions', { content_id: contentId });

export interface MosPublication {
  id: string;
  content_id: string;
  platform: string;
  account_id: string | null;
  status: 'draft' | 'scheduled' | 'published' | 'cancelled';
  scheduled_at: string | null;
  published_at: string | null;
  caption: string | null;
  external_url: string | null;
  note: string | null;
  account_label_ar: string | null;
  account_label_en: string | null;
  account_handle: string | null;
  account_connected: boolean | null;
  latest_captured_at: string | null;
  latest_source: 'manual' | 'api' | null;
  latest_views: number | null;
  latest_engagement: number | null;
  latest_enquiries: number | null;
  snapshot_count: number;
}

export interface MosAccount {
  id: string;
  platform: string;
  handle: string | null;
  label_ar: string;
  label_en: string;
  is_connected: boolean;
  can_publish: boolean;
  can_read_metrics: boolean;
}

export interface MosSnapshot {
  id: string;
  publication_id: string;
  captured_at: string;
  source: 'manual' | 'api';
  views: number | null;
  engagement: number | null;
  enquiries: number | null;
}

export const fetchRoles = () =>
  call<{ people: RolePerson[]; roles: MosRoleDef[] }>('roles_list');

export const grantRole = (userId: string, roleKey: MosPathRole, grant: boolean) =>
  call<{ ok: true }>('role_grant', { user_id: userId, role_key: roleKey, grant });

export const fetchSurfaceMatrix = () =>
  call<{
    surfaces: SurfaceKey[];
    roles: Array<{ key: string; role_id: string }>;
    cells: SurfaceCell[];
  }>('surface_matrix');

export const setSurface = (roleKey: string, surfaceKey: SurfaceKey, level: SurfaceLevel) =>
  call<{ ok: true }>('surface_set', { role_key: roleKey, surface_key: surfaceKey, level });

export const saveScene = (contentId: string, scene: Record<string, unknown>) =>
  call<{ scenes: MosScene[] }>('scene_save', { content_id: contentId, scene });

export const deleteScene = (contentId: string, id: string) =>
  call<{ scenes: MosScene[] }>('scene_delete', { content_id: contentId, id });

export const fetchPublications = (contentId?: string) =>
  call<{ publications: MosPublication[]; accounts: MosAccount[] }>('publication_list',
    contentId ? { content_id: contentId } : {});

export const savePublication = (contentId: string, publication: Record<string, unknown>) =>
  call<{ publications: MosPublication[] }>('publication_save', {
    content_id: contentId,
    publication,
  });

export const recordMetrics = (
  publicationId: string,
  values: { views?: number | null; engagement?: number | null; enquiries?: number | null },
) => call<{ snapshots: MosSnapshot[] }>('metrics_record', { publication_id: publicationId, ...values });

export const fetchMetricsHistory = (publicationId: string) =>
  call<{ snapshots: MosSnapshot[] }>('metrics_history', { publication_id: publicationId });

/* ------------------------------------------------------------------ */
/* the rest of the workspace                                          */
/* ------------------------------------------------------------------ */

export interface MosCampaign {
  id: string;
  ref: string | null;
  name: string;
  project_id: string | null;
  objective: 'awareness' | 'leads' | 'traffic' | 'sales' | 'other';
  status: 'planning' | 'active' | 'paused' | 'done' | 'cancelled';
  /** Paid carries a budget and a target cost; organic is reach — screen 19's fork. */
  kind: 'paid' | 'organic';
  /** The goal written as a RESULT («١٥٠ عميلًا مؤهلًا…») — the campaign's identity. */
  goal: string | null;
  owner_role: MosRole | null;
  success_metric: string | null;
  success_threshold: number | null;
  starts_on: string | null;
  ends_on: string | null;
  budget_total: number | null;
  note: string | null;
  created_at: string;
  execution_count: number;
  total_spend: number | null;
  total_leads: number | null;
  total_qualified: number | null;
  total_impressions: number | null;
  total_clicks: number | null;
  content_count: number;
}

export interface MosExecution {
  id: string;
  campaign_id: string;
  content_id: string | null;
  platform: string;
  account_id: string | null;
  label: string | null;
  status: 'draft' | 'running' | 'paused' | 'ended';
  starts_on: string | null;
  ends_on: string | null;
  budget: number | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  qualified: number | null;
  source: 'manual' | 'api';
  note: string | null;
  /** Screen 21's side panels — descriptive brief data on the execution. */
  targeting?: MosTargeting;
  lead_form_fields?: string[];
}

/** The targeting brief. All free text — it describes the platform setup. */
export interface MosTargeting {
  location?: string;
  age?: string;
  interests?: string;
  placements?: string;
  bidding?: string;
  daily_budget?: string;
}

export interface MosAd {
  id: string;
  execution_id: string;
  content_id: string | null;
  label: string | null;
  status: 'running' | 'watch' | 'paused' | 'waiting';
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  qualified: number | null;
  note: string | null;
  created_at: string;
}

export interface MosDailyEntry {
  id: string;
  execution_id: string;
  day: string;
  spend: number | null;
  leads: number | null;
  qualified: number | null;
  note: string | null;
}

export interface MosAsset {
  id: string;
  ref: string | null;
  title: string;
  kind: 'photo' | 'video' | 'design' | 'audio' | 'document';
  source: 'shoot' | 'design' | 'developer' | 'stock' | 'ugc';
  project_id: string | null;
  file_id: string | null;
  url: string | null;
  thumb_url: string | null;
  shot_on: string | null;
  tags: string[];
  note: string | null;
  created_at: string;
  /** Set for uploaded files (screen 23); null for link-only assets. */
  file_path?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  original_name?: string | null;
  usage_rights?: string | null;
  /** The shoot request whose delivery brought this file in. */
  shoot_request_id?: string | null;
  /** Video runtime, seconds — drives the mm:ss thumb badge (screen 16). */
  duration_seconds?: number | null;
  /** Set on children of a grouped set («مجموعة ن» badge on the parent). */
  parent_asset_id?: string | null;
  rights_expiry?: string | null;
  shot_by?: string | null;
}

export interface MosAssetLink {
  asset_id: string;
  content_id: string;
  role: 'source' | 'final' | 'reference';
}

export interface MosShootRequest {
  id: string;
  ref: string | null;
  title: string;
  project_id: string | null;
  status: 'requested' | 'scheduled' | 'shot' | 'delivered' | 'cancelled';
  scheduled_at: string | null;
  delivered_at?: string | null;
  location: string | null;
  note: string | null;
  assigned_role: string | null;
  created_at: string;
}

export interface MosShootItem {
  id: string;
  request_id: string;
  scene_id: string | null;
  content_id: string | null;
  description: string;
  done: boolean;
}

export interface MosComment {
  id: string;
  content_id: string | null;
  campaign_id: string | null;
  body: string;
  author_user_id: string | null;
  created_at: string;
}

export interface MosProject {
  id: string;
  project_name: string | null;
}

export interface MosOverview {
  role: MosRole;
  counts: {
    in_production: number;
    waiting_on_me: number;
    publishing_this_week: number;
    late: number;
  };
  stalled: Array<{
    id: string;
    ref: string | null;
    title: string;
    status_key: string;
    current_step_label_ar: string | null;
    current_step_label_en: string | null;
    owner_role: MosRole | null;
    current_task_due_at: string | null;
    updated_at: string;
    content_type_key: string;
  }>;
  week: Array<{
    id: string;
    content_id: string;
    platform: string;
    status: string;
    scheduled_at: string | null;
    published_at: string | null;
  }>;
  campaigns: Array<Pick<MosCampaign,
    'id' | 'ref' | 'name' | 'status' | 'budget_total' | 'total_spend' | 'total_leads' | 'total_qualified'>>;
  mix: Array<{ content_type_key: string; status_key: string }>;
  week_start: string;
  week_end: string;
}

export interface MosTitleRef {
  id: string;
  ref: string | null;
  title: string;
  content_type_key: string;
}

export const fetchOverview = (weekOf?: string) =>
  call<MosOverview>('overview', weekOf ? { week_of: weekOf } : {});

export const fetchWork = (scope: 'mine' | 'team') =>
  call<{ role: MosRole; content: MosContentRow[]; tasks: MosTask[] }>('work_list', { scope });

export const fetchCalendar = (from: string, to: string) =>
  call<{
    publications: Array<MosPublication & { caption: string | null }>;
    due: Array<Pick<MosContentRow,
      'id' | 'ref' | 'title' | 'content_type_key' | 'status_key' | 'due_at' | 'target_publish_at' | 'owner_role'>>;
    titles: MosTitleRef[];
  }>('calendar', { from, to });

export const fetchCampaigns = () => call<{ campaigns: MosCampaign[] }>('campaign_list');

export const fetchCampaignDetail = (id: string) =>
  call<{
    item: MosCampaign;
    executions: MosExecution[];
    content: MosContentRow[];
    comments: MosComment[];
  }>('campaign_detail', { id });

export const saveCampaign = (
  campaign: Record<string, unknown>,
  executions?: Array<{ platform: string; label?: string | null; budget?: number | null }>,
) => call<{ item: MosCampaign }>('campaign_save', {
  campaign,
  ...(executions && executions.length > 0 ? { executions } : {}),
});

export const saveExecution = (campaignId: string, execution: Record<string, unknown>) =>
  call<{ executions: MosExecution[] }>('execution_save', { campaign_id: campaignId, execution });

export const deleteExecution = (campaignId: string, id: string) =>
  call<{ executions: MosExecution[] }>('execution_delete', { campaign_id: campaignId, id });

export const fetchExecutionDetail = (id: string) =>
  call<{
    execution: MosExecution;
    campaign: MosCampaign | null;
    ads: MosAd[];
    ad_content: MosContentRow[];
    daily: MosDailyEntry[];
  }>('execution_detail', { id });

export const saveAd = (executionId: string, ad: Record<string, unknown>) =>
  call<{ ads: MosAd[] }>('ad_save', { execution_id: executionId, ad });

export const deleteAd = (executionId: string, id: string) =>
  call<{ ads: MosAd[] }>('ad_delete', { execution_id: executionId, id });

export const saveDaily = (
  executionId: string,
  entry: { day: string; spend?: number | null; leads?: number | null; qualified?: number | null },
) => call<{ daily: MosDailyEntry[] }>('daily_save', { execution_id: executionId, ...entry });

export const AD_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  running: { ar: 'يعمل',        en: 'Running' },
  watch:   { ar: 'مراقبة',      en: 'Watching' },
  paused:  { ar: 'موقف',        en: 'Paused' },
  waiting: { ar: 'في الانتظار', en: 'Waiting' },
};

export const fetchAssets = (filters: Record<string, unknown> = {}) =>
  call<{ assets: MosAsset[]; links: MosAssetLink[] }>('asset_list', filters);

export const saveAsset = (asset: Record<string, unknown>) =>
  call<{ asset: MosAsset }>('asset_save', { asset });

export const archiveAsset = (id: string) => call<{ ok: true }>('asset_delete', { id });

export const linkAsset = (assetId: string, contentId: string, role = 'source') =>
  call<{ links: MosAssetLink[] }>('asset_link', { asset_id: assetId, content_id: contentId, role });

export const unlinkAsset = (assetId: string, contentId: string) =>
  call<{ links: MosAssetLink[] }>('asset_unlink', { asset_id: assetId, content_id: contentId });

export const fetchShoots = () =>
  call<{
    requests: MosShootRequest[];
    items: MosShootItem[];
    missing_scenes: Array<Pick<MosScene, 'id' | 'content_id' | 'position' | 'visual' | 'footage_status'>
      & { created_at?: string }>;
    scene_owners: Array<MosTitleRef & { project_id: string | null }>;
    shoot_assets: Array<{ id: string; shoot_request_id: string; kind: string }>;
    asset_links: Array<{ asset_id: string; content_id: string }>;
  }>('shoot_list');

export const deliverShoot = (id: string) =>
  call<{ requests: MosShootRequest[]; items: MosShootItem[]; scenes_marked: number }>(
    'shoot_deliver',
    { id },
  );

export const saveShoot = (request: Record<string, unknown>, sceneIds?: string[]) =>
  call<{ requests: MosShootRequest[]; request_id: string | null }>('shoot_save', {
    request,
    scene_ids: sceneIds ?? [],
  });

export const toggleShootItem = (id: string, done: boolean) =>
  call<{ item: MosShootItem }>('shoot_item_toggle', { id, done });

export const fetchComments = (target: { contentId?: string; campaignId?: string }) =>
  call<{ comments: MosComment[] }>('comment_list', {
    content_id: target.contentId,
    campaign_id: target.campaignId,
  });

export const addComment = (target: { contentId?: string; campaignId?: string }, body: string) =>
  call<{ comments: MosComment[] }>('comment_add', {
    content_id: target.contentId,
    campaign_id: target.campaignId,
    body,
  });

/**
 * StepDef → the step shape the stage rail and the modals render. The rail
 * matches tasks to steps by id, and tasks carry the step KEY, so id = key —
 * one stable identifier across workflow versions.
 */
export function stepDefToMosStep(workflowId: string, s: StepDef, index: number): MosStep {
  return {
    id: s.key,
    workflow_id: workflowId,
    position: index + 1,
    key: s.key,
    label_ar: s.label_ar,
    label_en: s.label_en,
    role: s.role_key,
    due_days: s.due_days,
    is_approval: s.is_approval,
    approval_kind: s.approval_kind,
    required_fields: s.required_fields,
    required_files: s.required_files,
    require_note_on_reject: s.require_note_on_reject,
    creates_revision: s.creates_revision,
  };
}

export function mosStepToStepDef(s: MosStep): StepDef {
  return {
    key: s.key,
    label_ar: s.label_ar,
    label_en: s.label_en,
    role_key: s.role as StepDef['role_key'],
    due_days: s.due_days,
    is_approval: s.is_approval,
    approval_kind: s.approval_kind,
    require_note_on_reject: s.require_note_on_reject ?? false,
    creates_revision: s.creates_revision ?? false,
    required_fields: s.required_fields ?? [],
    required_files: s.required_files ?? [],
  };
}

export interface SettingsData {
  workflows: WorkflowDef[];
  /** Flattened from each workflow's metadata.steps — kept for screens that
   *  reason about steps across workflows (the new-content preview). */
  steps: MosStep[];
  content_types: MosContentType[];
  accounts: MosAccount[];
  settings: Record<string, unknown>;
  surface: {
    roles: Array<{ key: string; role_id: string }>;
    cells: SurfaceCell[];
  };
  notification_rules: unknown[];
}

export const fetchSettings = async (): Promise<SettingsData> => {
  const res = await call<Omit<SettingsData, 'steps'>>('settings_data');
  return {
    ...res,
    steps: res.workflows.flatMap((w) => w.steps.map((s, i) => stepDefToMosStep(w.id, s, i))),
  };
};

/** Save a whole role path. The DB trigger snapshots the new version on write. */
export const saveWorkflow = (payload: {
  id?: string;
  label_ar: string;
  label_en: string;
  is_active?: boolean;
  steps: StepDef[];
}) => call<{ workflow: WorkflowDef; version_no: number }>('workflow_save', payload);

export const saveContentType = (contentType: Record<string, unknown>) =>
  call<{ content_types: MosContentType[] }>('content_type_save', { content_type: contentType });

export const saveAccount = (account: Record<string, unknown>) =>
  call<{ accounts: MosAccount[] }>('account_save', { account });

export const fetchProjects = () => call<{ projects: MosProject[] }>('projects_list');

export const fetchMetricsQueue = (since?: string) =>
  call<{ publications: MosPublication[]; titles: MosTitleRef[]; since: string }>(
    'metrics_queue',
    since ? { since } : {},
  );

export const searchAll = (q: string) =>
  call<{ content: MosContentRow[]; campaigns: MosCampaign[]; assets: MosAsset[] }>('search', { q });

/* ------------------------------------------------------------------ */
/* bilingual labels — one map, never inline strings in JSX            */
/* ------------------------------------------------------------------ */

export const PUB_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  draft:     { ar: 'مسودة',  en: 'Draft' },
  scheduled: { ar: 'مجدول',  en: 'Scheduled' },
  published: { ar: 'منشور',  en: 'Published' },
  cancelled: { ar: 'ملغى',   en: 'Cancelled' },
};

export const FOOTAGE_LABELS: Record<string, { ar: string; en: string }> = {
  have:    { ar: 'متوفرة', en: 'Have it' },
  to_make: { ar: 'تُصنع',  en: 'To be made' },
  missing: { ar: 'ناقصة',  en: 'Missing' },
};

export const ROLE_LABELS: Record<MosRole, { ar: string; en: string }> = {
  administrator:     { ar: 'مدير النظام',    en: 'Administrator' },
  ceo:               { ar: 'الرئيس التنفيذي', en: 'CEO' },
  marketing_manager: { ar: 'مدير التسويق',   en: 'Marketing Manager' },
  ops_supervisor:    { ar: 'مشرف العمليات',  en: 'Operations Supervisor' },
  writer:            { ar: 'الكاتب',          en: 'Writer' },
  montage:           { ar: 'المونتير',        en: 'Video Editor' },
  viewer:            { ar: 'مطّلع',           en: 'Viewer' },
  none:              { ar: 'بلا دور',         en: 'No role' },
};

export const PURPOSE_LABELS: Record<string, { ar: string; en: string }> = {
  organic: { ar: 'عضوي',   en: 'Organic' },
  paid:    { ar: 'مدفوع',  en: 'Paid' },
  both:    { ar: 'الاثنان', en: 'Both' },
};

/** Statuses the VIEW can synthesise when no workflow step is open. */
export const SYNTHETIC_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  draft:      { ar: 'مسودة',       en: 'Draft' },
  done:       { ar: 'منجز',        en: 'Done' },
  unassigned: { ar: 'بلا مرحلة',   en: 'Unassigned' },
};

/**
 * The stage label to show for a row. Prefers the workflow step's own label and
 * falls back to the synthetic status, so a brand-new item reads "مسودة" rather
 * than an empty cell.
 */
export function statusLabel(row: MosContentRow, isAr: boolean): string {
  const stepLabel = isAr ? row.current_step_label_ar : row.current_step_label_en;
  if (stepLabel) return stepLabel;
  const synthetic = SYNTHETIC_STATUS_LABELS[row.status_key];
  if (synthetic) return isAr ? synthetic.ar : synthetic.en;
  return row.status_key;
}

export const CAMPAIGN_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  planning:  { ar: 'تخطيط',  en: 'Planning' },
  active:    { ar: 'نشطة',   en: 'Active' },
  paused:    { ar: 'موقوفة', en: 'Paused' },
  done:      { ar: 'منتهية', en: 'Ended' },
  cancelled: { ar: 'ملغاة',  en: 'Cancelled' },
};

export const OBJECTIVE_LABELS: Record<string, { ar: string; en: string }> = {
  awareness: { ar: 'وعي',      en: 'Awareness' },
  leads:     { ar: 'عملاء',    en: 'Leads' },
  traffic:   { ar: 'زيارات',   en: 'Traffic' },
  sales:     { ar: 'مبيعات',   en: 'Sales' },
  other:     { ar: 'أخرى',     en: 'Other' },
};

export const EXEC_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  draft:   { ar: 'مسودة',  en: 'Draft' },
  running: { ar: 'تعمل',   en: 'Running' },
  paused:  { ar: 'موقوفة', en: 'Paused' },
  ended:   { ar: 'منتهية', en: 'Ended' },
};

export const ASSET_KIND_LABELS: Record<string, { ar: string; en: string }> = {
  photo:    { ar: 'صورة',   en: 'Photo' },
  video:    { ar: 'فيديو',  en: 'Video' },
  design:   { ar: 'تصميم',  en: 'Design' },
  audio:    { ar: 'صوت',    en: 'Audio' },
  document: { ar: 'مستند',  en: 'Document' },
};

export const ASSET_SOURCE_LABELS: Record<string, { ar: string; en: string }> = {
  shoot:     { ar: 'تصوير',        en: 'Shoot' },
  design:    { ar: 'تصميم داخلي',  en: 'In-house design' },
  developer: { ar: 'من المطوّر',   en: 'From developer' },
  stock:     { ar: 'مكتبة',        en: 'Stock' },
  ugc:       { ar: 'من العملاء',   en: 'UGC' },
};

export const SHOOT_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  requested: { ar: 'مطلوب',   en: 'Requested' },
  scheduled: { ar: 'مجدول',   en: 'Scheduled' },
  shot:      { ar: 'صُوِّر',   en: 'Shot' },
  delivered: { ar: 'سُلِّم',   en: 'Delivered' },
  cancelled: { ar: 'ملغى',    en: 'Cancelled' },
};

export const PLATFORM_LABELS: Record<string, { ar: string; en: string }> = {
  instagram: { ar: 'انستقرام',     en: 'Instagram' },
  tiktok:    { ar: 'تيك توك',      en: 'TikTok' },
  snapchat:  { ar: 'سناب شات',     en: 'Snapchat' },
  x:         { ar: 'إكس',          en: 'X' },
  youtube:   { ar: 'يوتيوب',       en: 'YouTube' },
  whatsapp:  { ar: 'واتساب',       en: 'WhatsApp' },
  website:   { ar: 'الموقع',       en: 'Website' },
  // Paid AD channels — a Meta ad set is not an Instagram post, so the spend
  // side names the ad platform, not the feed it lands in (design screen 19).
  meta:      { ar: 'إعلانات ميتا', en: 'Meta ads' },
  google:    { ar: 'بحث جوجل',     en: 'Google search' },
};

/** Screen 19's mandatory success criterion — what the campaign is judged by. */
export const SUCCESS_METRIC_LABELS: Record<string, { ar: string; en: string }> = {
  cpl_qualified: { ar: 'تكلفة العميل المؤهل', en: 'Cost per qualified lead' },
  cpl:           { ar: 'تكلفة العميل',         en: 'Cost per lead' },
  leads:         { ar: 'عدد العملاء المؤهلين', en: 'Qualified leads' },
  reach:         { ar: 'الوصول',               en: 'Reach' },
};

/** The purposes an ad set can serve, stored on the execution's label. */
export const EXEC_PURPOSE_LABELS: Record<string, { ar: string; en: string }> = {
  lead_form: { ar: 'نموذج عملاء', en: 'Lead form' },
  traffic:   { ar: 'زيارات',      en: 'Traffic' },
  awareness: { ar: 'وعي',         en: 'Awareness' },
};

/** The platform's own colour, used for the calendar spine and account chips. */
export const PLATFORM_CLASS: Record<string, string> = {
  instagram: 'ig',
  tiktok: 'tt',
  snapchat: 'sc',
  x: 'x',
};

/** Overdue = has a due date, it has passed, and the item is still open. */
export function isOverdue(row: MosContentRow): boolean {
  const due = row.current_task_due_at ?? row.due_at;
  if (!due) return false;
  if (row.status_key === 'done') return false;
  return new Date(due).getTime() < Date.now();
}
