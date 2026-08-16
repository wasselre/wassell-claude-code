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
  | 'shoots' | 'goals' | 'campaigns' | 'numbers' | 'settings' | 'roles';

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
  /**
   * Whether opening this step interrupts its owning role with a notification.
   * `false` = the task still opens (it shows in «my work»), but no alert fires.
   * Absent on legacy rows → treated as `true` (the engine's original behavior).
   */
  notify: boolean;
  /**
   * Which channels this step is PERMITTED to use. Each is AND-ed with the
   * recipient's own role settings (Settings → Notifications) — a step can
   * narrow what a role already allows, never widen it. Absent on legacy rows →
   * all three (so the role grid alone decides, exactly as before).
   * `NotificationChannel` = 'inapp' | 'push' | 'whatsapp'.
   */
  notify_channels: NotificationChannel[];
}

/** The channels a step may permit, in the order the editor renders them. */
export const STEP_NOTIFY_CHANNELS: readonly NotificationChannel[] = ['inapp', 'push', 'whatsapp'];

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
  /**
   * The caller's capability set — the UNION over every held role, resolved
   * server-side from the `role_capabilities` table (the same data
   * `wassell_mos_can` reads). The client no longer keeps its own capability
   * matrix; this is the single source of truth.
   */
  capabilities: string[];
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

/**
 * The seven writing-field kinds, transcribed from design screen 27's add-field
 * row: «إضافة حقل — نص قصير، نص طويل، جدول، اختيار، تاريخ، رقم، ملف».
 */
export type MosFieldKind = 'short' | 'long' | 'table' | 'select' | 'date' | 'number' | 'file';

export const FIELD_KIND_LABELS: Record<MosFieldKind, { ar: string; en: string }> = {
  short:  { ar: 'نص قصير', en: 'Short text' },
  long:   { ar: 'نص طويل', en: 'Long text' },
  table:  { ar: 'جدول',    en: 'Table' },
  select: { ar: 'اختيار',  en: 'Choice' },
  date:   { ar: 'تاريخ',   en: 'Date' },
  number: { ar: 'رقم',     en: 'Number' },
  file:   { ar: 'ملف',     en: 'File' },
};

/**
 * One writing field in a content type's schema. Legacy rows stored bare key
 * strings; screen 27's editor writes objects. Both shapes are valid — always
 * read the array through `fieldSchemaEntries` / `fieldSchemaKeys`, never raw.
 * `is_hidden` is delete-as-hide (screen 27: «حذف الحقل محمي»): the field stops
 * appearing on new records but existing records keep their data readable.
 */
export interface MosFieldDef {
  key: string;
  label_ar: string;
  label_en: string;
  kind: MosFieldKind;
  required: boolean;
  is_hidden?: boolean;
}

export type MosFieldSchemaEntry = string | MosFieldDef;

const KINDS = new Set<string>(['short', 'long', 'table', 'select', 'date', 'number', 'file']);

/** Normalize every entry to a MosFieldDef; legacy bare keys become long-text fields. */
export function fieldSchemaEntries(schema: MosFieldSchemaEntry[]): MosFieldDef[] {
  return schema.map((e) => {
    if (typeof e === 'string') {
      return { key: e, label_ar: e, label_en: e, kind: 'long', required: false };
    }
    return { ...e, kind: KINDS.has(e.kind) ? e.kind : 'long' };
  });
}

/** The VISIBLE field keys — what WritingFields renders. Hidden fields stay stored. */
export function fieldSchemaKeys(schema: MosFieldSchemaEntry[]): string[] {
  return fieldSchemaEntries(schema).filter((f) => !f.is_hidden).map((f) => f.key);
}

export interface MosContentType {
  id: string;
  key: string;
  label_ar: string;
  label_en: string;
  prefix: string;
  workflow_id: string | null;
  field_schema: MosFieldSchemaEntry[];
  sort_order: number;
  is_active: boolean;
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
  /** PRIMARY project (first of project_ids) — kept for filters/joins/display. */
  project_id: string | null;
  /** All linked Our-Projects (searchable multi-select). project_id === project_ids[0]. */
  project_ids: string[];
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
  created_at?: string;
  created_by_user_id?: string | null;
  data?: Record<string, unknown>;
  goal?: string | null;
  audience?: string | null;
  angle?: string | null;
  cta?: string | null;
  language?: string | null;
  workflow_id?: string | null;
  archived_at?: string | null;
  /** The ONE material submitted for approval; promoted to a 'final' link when the
   *  item is approved. Present on the view for every row. */
  approval_asset_id?: string | null;
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
  /** Who closed it — drives screen 08's «اعتمده ريان · …» approver meta line. */
  closed_by_user_id?: string | null;
  /** What a rejection targeted (field keys + `scene:<id>`) — screen 38's chips. */
  revision_targets?: string[];
  /** From the PINNED version's step — drives screen 35's approvals split. */
  is_approval?: boolean;
  approval_kind?: 'creative' | 'process' | 'budget' | null;
}

/**
 * Screen 02's «القادم إليك» band — NOT a task: an in-flight item whose pinned
 * path reaches MY role at a future step. Shown so the role can prepare; it
 * becomes a real task only when the path advances to that step.
 */
export interface MosUpcoming {
  content_id: string;
  ref: string | null;
  title: string;
  step_key: string;
  step_label_ar: string;
  step_label_en: string;
  /** How many steps stand between the current one and mine («بعد خطوتين»). */
  steps_away: number;
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
  /** See StepDef.notify — the per-step notification gate. */
  notify?: boolean;
  /** See StepDef.notify_channels — the per-step permitted channels. */
  notify_channels?: NotificationChannel[];
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
  footage_status: 'have' | 'to_make' | 'missing' | 'template';
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

/**
 * Client-side ceiling on one marketing-os call. Vercel kills an edge function
 * at 25s and returns a bare 504; aborting a touch earlier lets us surface a
 * friendly, retryable message instead of that raw gateway code (the transient
 * DB-busy failure mode). The LoadError card's «إعادة المحاولة» does the retry.
 */
const CALL_TIMEOUT_MS = 23_000;

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const isAr = (): boolean => useAppStore.getState().language === 'ar';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch('/api/marketing-os', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeader()),
        ...activeRoleHeader(),
      },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
  } catch (e) {
    // AbortError (our timeout) or a network drop — both read to the user as
    // "the server is busy, try again", not a stack trace.
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new MosApiError(
      isAr()
        ? 'الخادم مشغول مؤقتًا. أعد المحاولة بعد لحظات.'
        : 'The server is busy right now. Give it a moment and try again.',
      aborted ? 504 : 0,
      { error: 'unavailable' },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: string; error_ar?: string;
    };
    // A gateway/DB-busy status (502/503/504) carries no useful body — replace
    // the raw "failed (504)" with a plain retryable message.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new MosApiError(
        isAr()
          ? 'الخادم مشغول مؤقتًا. أعد المحاولة بعد لحظات.'
          : 'The server is busy right now. Give it a moment and try again.',
        res.status,
        b,
      );
    }
    throw new MosApiError(
      (isAr() ? b?.error_ar || b?.error : b?.error) ?? `marketing-os ${action} failed (${res.status})`,
      res.status,
      b,
    );
  }
  return (await res.json()) as T;
}

/**
 * A non-2xx from /api/marketing-os. Carries the HTTP status and the parsed
 * body so callers can branch on structured errors — e.g. asset_delete's
 * 409 `{ error: 'in_use', used_in }` (status 409, payload.used_in).
 */
export class MosApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MosApiError';
  }
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
  /** The approved material this publication uses. `asset_id` (mos_assets.id) is
   *  the durable link; `file_id` is a legacy key kept for older rows. */
  asset_id: string | null;
  file_id: string | null;
  published_by_user_id: string | null;
  account_label_ar: string | null;
  account_label_en: string | null;
  account_handle: string | null;
  account_connected: boolean | null;
  latest_captured_at: string | null;
  latest_source: 'manual' | 'api' | null;
  latest_views: number | null;
  latest_engagement: number | null;
  latest_enquiries: number | null;
  /** Engagement breakdown — latest reading per publication. */
  latest_likes: number | null;
  latest_comments: number | null;
  latest_saves: number | null;
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
  /** Access-token expiry, when a real connection set one (screen 26 «تنتهي…»). */
  token_expires_at?: string | null;
}

export interface MosSnapshot {
  id: string;
  publication_id: string;
  captured_at: string;
  source: 'manual' | 'api';
  views: number | null;
  engagement: number | null;
  enquiries: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  /** Platform-specific readings; a skip carries { skipped: reason }. */
  extra?: Record<string, unknown>;
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

/** One granted (role, capability) pair in the capabilities matrix. */
export interface CapabilityCell {
  role_key: string;
  capability: string;
}

/** The capabilities matrix — what each role can DO (twin of the surface matrix). */
export const fetchCapabilityMatrix = () =>
  call<{
    capabilities: string[];
    roles: Array<{ key: string; role_id: string }>;
    cells: CapabilityCell[];
  }>('capability_matrix');

/** Grant (grant=true) or revoke a capability on a role. Presence IS the grant. */
export const setCapability = (roleKey: string, capability: string, grant: boolean) =>
  call<{ ok: true }>('capability_set', { role_key: roleKey, capability, grant });

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
  values: {
    views?: number | null;
    engagement?: number | null;
    enquiries?: number | null;
    likes?: number | null;
    comments?: number | null;
    saves?: number | null;
    /** Platform-specific readings (e.g. TikTok watch-time). */
    extra?: Record<string, unknown>;
  },
) => call<{ snapshots: MosSnapshot[] }>('metrics_record', { publication_id: publicationId, ...values });

/** «لا توجد أرقام» — a deliberate skip, distinct from missing AND from zero. */
export const skipMetrics = (publicationId: string, reason: string) =>
  call<{ ok: true }>('metrics_skip', { publication_id: publicationId, reason });

export const fetchMetricsHistory = (publicationId: string) =>
  call<{ snapshots: MosSnapshot[] }>('metrics_history', { publication_id: publicationId });

/* ------------------------------------------------------------------ */
/* the rest of the workspace                                          */
/* ------------------------------------------------------------------ */

/**
 * A managed measure type — the reusable registry a success criterion is picked
 * from. The four presets ship seeded; more can be added in Settings or created
 * inline on a campaign. `direction` decides the "or more" / "or less" wording;
 * `unit:'currency'` prefixes the riyal unit, `unit:'percent'` the % sign.
 */
/** How a measure's target number reads: a bare count, riyals, or a percentage. */
export type MosMeasureUnit = 'count' | 'currency' | 'percent';

/**
 * Which LIVE metric a measure's target is tracked against — so «مشاهدات = 200,000»
 * computes pace against impressions, «مؤهلون = 150» against qualified, etc. `none`
 * = a descriptive measure with no live actual (target shown, no pace).
 */
export type MosMeasureSource =
  | 'impressions' | 'clicks' | 'leads' | 'qualified'
  | 'spend' | 'cpl' | 'cpl_qualified' | 'ctr' | 'none';

export interface MosMeasureType {
  id: string;
  key: string;
  label_ar: string;
  label_en: string;
  direction: 'higher' | 'lower';
  unit: MosMeasureUnit;
  source: MosMeasureSource;
  is_preset: boolean;
  sort_order: number;
  is_active: boolean;
  archived_at: string | null;
}

/**
 * One success measure ON a campaign. The label/direction/unit are SNAPSHOTTED
 * from the measure type at save time (so a later rename/archive never rewrites
 * history and every read surface renders without a join).
 */
export interface MosSuccessMeasure {
  type_key: string;
  label_ar: string;
  label_en: string;
  direction: 'higher' | 'lower';
  unit: MosMeasureUnit;
  source: MosMeasureSource;
  threshold: number | null;
}

/** The "or more" / "SAR or less" / "% or more" tail after a target number. */
export function successMeasureSuffix(
  direction: 'higher' | 'lower',
  unit: MosMeasureUnit,
  isAr: boolean,
): string {
  const more = direction === 'higher';
  if (unit === 'currency') {
    return more ? (isAr ? 'ريال أو أكثر' : 'SAR or more') : (isAr ? 'ريال أو أقل' : 'SAR or less');
  }
  if (unit === 'percent') {
    return more ? (isAr ? '٪ أو أكثر' : '% or more') : (isAr ? '٪ أو أقل' : '% or less');
  }
  return more ? (isAr ? 'أو أكثر' : 'or more') : (isAr ? 'أو أقل' : 'or less');
}

/**
 * A saved, reusable audience — the campaign brief's «الجمهور» picked from a
 * managed registry (`mos_audiences`) instead of retyped every time. A title
 * (`name`) plus a large free-text `details` field. Single-language, like the
 * other brief fields (goal/offer); read-time translation is the overlay's job.
 */
export interface MosAudience {
  id: string;
  name: string;
  details: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  archived_at: string | null;
}

export interface MosCampaign {
  id: string;
  ref: string | null;
  name: string;
  /** PRIMARY project (first of project_ids) — kept for filters/joins/display. */
  project_id: string | null;
  /** All linked Our-Projects (searchable multi-select). project_id === project_ids[0]. */
  project_ids: string[];
  objective: 'awareness' | 'leads' | 'traffic' | 'sales' | 'other';
  status: 'planning' | 'active' | 'paused' | 'done' | 'cancelled';
  /** Paid carries a budget and a target cost; organic is reach — screen 19's fork. */
  kind: 'paid' | 'organic';
  /** The goal written as a RESULT («١٥٠ عميلًا مؤهلًا…») — the campaign's identity. */
  goal: string | null;
  owner_role: MosRole | null;
  /** Back-compat scalar pair — mirrors success_measures[0]; kept for list/overview/judgment reads. */
  success_metric: string | null;
  success_threshold: number | null;
  /** Every success measure the campaign is judged by (screen 15/19). */
  success_measures: MosSuccessMeasure[];
  starts_on: string | null;
  ends_on: string | null;
  budget_total: number | null;
  note: string | null;
  created_at: string;
  /** The brief (screen 19). Server merges these from the base table. */
  audience?: string | null;
  /** The chosen saved audience (`mos_audiences`). `audience` above is its name
   *  snapshot; `audience_details` is resolved live for the read/edit surfaces. */
  audience_id?: string | null;
  audience_details?: string | null;
  offer?: string | null;
  destination_url?: string | null;
  measured_by?: string | null;
  /** Server-set on every save from mos_settings.signature_threshold. */
  requires_signature?: boolean;
  signed_by_user_id?: string | null;
  signed_at?: string | null;
  execution_count: number;
  total_spend: number | null;
  total_leads: number | null;
  total_qualified: number | null;
  total_impressions: number | null;
  total_clicks: number | null;
  content_count: number;
  /** The goals this campaign serves (mos_campaign_goals). Every campaign has ≥1. */
  goal_ids: string[];
  /**
   * The platform sub-line for the list (design screen 14): a paid campaign's
   * executions' ad platforms, or — for organic / not-yet-launched paid — the
   * feeds its attributed content publishes to. Computed server-side by
   * `campaign_list`; empty means "not launched yet". Absent on the other reads
   * that return an MosCampaign (detail/search/overview), which don't need it.
   */
  platforms?: string[];
}

/**
 * A marketing goal — a SIMPLE, reusable objective (`mos_goals`) that campaigns
 * are grouped under. A campaign links to one or more; a goal can hold many
 * campaigns. Single-language name/description, like the brief fields — read-time
 * translation is the overlay's job.
 */
export interface MosGoal {
  id: string;
  name: string;
  description: string | null;
  /** The goal's success measures — the SAME multi-measure shape as a campaign's
   *  (snapshotted from the registry; the first row is the MAIN measure). */
  success_measures: MosSuccessMeasure[];
  sort_order: number;
  is_active: boolean;
  created_at: string;
  archived_at: string | null;
  /** Linked-campaign count, attached by the goals_list / goal_save reads. */
  campaign_count: number;
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
  /** The platform's own campaign id, once the ad set exists on it. */
  platform_campaign_id?: string | null;
  /** What the ad set is FOR. */
  purpose?: 'conversion' | 'awareness' | 'retargeting' | 'traffic' | null;
  /** Screen 21's side panels — descriptive brief data on the execution. */
  targeting?: MosTargeting;
  lead_form_fields?: string[];
  /**
   * Structured per-platform campaign settings — REAL Marketing API field
   * names + enum values (Meta / Snapchat / TikTok). Schemas + renderer:
   * src/lib/marketingOS/adPlatforms/. Null/absent on platforms we don't
   * model structurally (google, x, youtube) — those keep `targeting`.
   */
  platform_settings?: Record<string, string | string[] | number | boolean | null> | null;
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
  /** Ad-level platform creative — format, copy, CTA, destination. */
  creative?: Record<string, string | string[] | number | boolean | null> | null;
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
  /** Chosen aspect ratio, e.g. '9:16', '16:9', '1:1' — see ASSET_ASPECT_RATIOS. */
  aspect_ratio?: string | null;
}

/**
 * The aspect-ratio choices offered on upload and on the asset record — the
 * pixel shape of a photo or video, chosen not measured. The `value` is the bare
 * ratio ('9:16') so it renders LTR and stays stable; the label carries the
 * context a marketer thinks in (ريلز/ستوري, منشور, مربّع…).
 */
export const ASSET_ASPECT_RATIOS: Array<{ value: string; ar: string; en: string }> = [
  { value: '9:16', ar: '9:16 — عمودي (ريلز/ستوري)', en: '9:16 — Vertical (Reels/Story)' },
  { value: '4:5',  ar: '4:5 — عمودي (منشور)',        en: '4:5 — Portrait (Feed)' },
  { value: '1:1',  ar: '1:1 — مربّع',                en: '1:1 — Square' },
  { value: '16:9', ar: '16:9 — أفقي',                en: '16:9 — Landscape' },
  { value: '4:3',  ar: '4:3 — أفقي كلاسيكي',          en: '4:3 — Classic' },
  { value: '3:4',  ar: '3:4 — عمودي',                en: '3:4 — Tall' },
  { value: '2:3',  ar: '2:3 — عمودي',                en: '2:3 — Tall' },
  { value: '21:9', ar: '21:9 — عريض',                en: '21:9 — Ultrawide' },
];

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
  /** The Our-Projects record id for this master (from `projects_list`), so the
   *  UI can open `/model/our_projects/:ourId`. Null when the caller can't see
   *  the Our-Projects record (button falls back to the all_projects page). */
  our_project_id?: string | null;
}

export interface MosOverview {
  role: MosRole;
  /** The segmented control's value — week_start/week_end are ITS bounds. */
  period: 'week' | 'month' | 'quarter';
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
    ref: string | null;
    title: string | null;
  }>;
  /** Aimed at the period (target_publish_at) but nothing scheduled yet. */
  unscheduled: Array<{ id: string; ref: string | null; title: string; target_publish_at: string | null }>;
  campaigns: Array<Pick<MosCampaign,
    'id' | 'ref' | 'name' | 'status' | 'budget_total' | 'total_spend' | 'total_leads' | 'total_qualified'>>;
  mix: Array<{ content_type_key: string; status_key: string }>;
  /** Oldest item sitting with my role — «أقدمها منتظر منذ …». */
  waiting_oldest_at: string | null;
  /** The late stat's stage breakdown («٢ في التصميم · ٢ بانتظار المراجعة»). */
  late_mix: Array<{ label_ar: string; label_en: string; n: number }>;
  week_start: string;
  week_end: string;
}

export interface MosTitleRef {
  id: string;
  ref: string | null;
  title: string;
  content_type_key: string;
}

export type OverviewPeriod = 'week' | 'month' | 'quarter';

export const fetchOverview = (period: OverviewPeriod = 'week') =>
  call<MosOverview>('overview', { period });

export const fetchWork = (scope: 'mine' | 'team') =>
  call<{
    role: MosRole;
    content: MosContentRow[];
    tasks: MosTask[];
    upcoming: MosUpcoming[];
    manual_tasks: MosManualTask[];
  }>('work_list', { scope });

/* ------------------------------------------------------------------ */
/* Manual tasks — hand-assigned work no workflow generates             */
/* ------------------------------------------------------------------ */

/**
 * A task a person was GIVEN rather than one a workflow produced. It is a
 * separate row from `MosTask` on purpose: it has no step, no role, no round
 * and no approval loop, several can be open for the same person at once, and
 * closing one advances nothing.
 */
export interface MosManualTask {
  id: string;
  /** Set when this is one occurrence of a repeating task. */
  series_id: string | null;
  /** The occurrence's own date (Riyadh-local `YYYY-MM-DD`), when in a series. */
  occurrence_on: string | null;
  title: string;
  details: string | null;
  assignee_user_id: string;
  created_by_user_id: string;
  campaign_id: string | null;
  content_id: string | null;
  goal_id: string | null;
  project_id: string | null;
  status: 'open' | 'done' | 'cancelled';
  due_at: string | null;
  done_note: string | null;
  closed_at: string | null;
  closed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** How a repeating task repeats. Weekday numbers are 0 = Sunday … 6 = Saturday. */
export interface MosRepeatRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval_n: number;
  byweekday: number[];
  bymonthday: number | null;
  /** `HH:MM`, Asia/Riyadh. */
  due_time: string;
  starts_on: string;
  ends_on: string | null;
}

export interface MosTaskSeries extends MosRepeatRule {
  id: string;
  title: string;
  details: string | null;
  assignee_user_id: string;
  created_by_user_id: string;
  campaign_id: string | null;
  content_id: string | null;
  goal_id: string | null;
  project_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** What the New/Edit task form sends. `repeat` present ⇒ it is a repeating task. */
export interface MosManualTaskInput {
  id?: string;
  series_id?: string;
  title: string;
  details?: string | null;
  assignee_user_id?: string;
  due_at?: string | null;
  campaign_id?: string | null;
  content_id?: string | null;
  goal_id?: string | null;
  project_id?: string | null;
  repeat?: MosRepeatRule | null;
}

export const fetchManualTasks = (opts: {
  scope?: 'mine' | 'team' | 'created';
  include_done?: boolean;
  campaign_id?: string;
  content_id?: string;
  goal_id?: string;
  project_id?: string;
} = {}) => call<{ manual_tasks: MosManualTask[] }>('manual_task_list', { scope: 'mine', ...opts });

export const saveManualTask = (task: MosManualTaskInput) =>
  call<{ id?: string | null; series_id?: string | null; generated?: number }>(
    'manual_task_save',
    { task },
  );

export const completeManualTask = (id: string, note?: string) =>
  call<{ ok: true }>('manual_task_complete', { id, note: note ?? null });

export const reopenManualTask = (id: string) =>
  call<{ ok: true }>('manual_task_reopen', { id });

export const cancelManualTask = (id: string) =>
  call<{ ok: true }>('manual_task_cancel', { id });

export const deleteManualTask = (id: string) =>
  call<{ ok: true }>('manual_task_delete', { id });

export const fetchTaskSeries = () =>
  call<{ series: MosTaskSeries[] }>('task_series_list');

export const stopTaskSeries = (id: string, purgeFuture: boolean) =>
  call<{ ok: true }>('task_series_stop', { id, purge_future: purgeFuture });

/** Screen 35's «تأجيل / تقديم» — move an open task's due date. */
export const updateTask = (taskId: string, patch: { due_at: string }) =>
  call<{ ok: true }>('task_update', { task_id: taskId, ...patch });

/* ------------------------------------------------------------------ */
/* CEO overview (s34) — results, not activity; no task lists           */
/* ------------------------------------------------------------------ */

export type CeoPeriod = 'month' | 'quarter' | 'year';

export interface MosCeoOverview {
  period: CeoPeriod;
  period_start: string;
  period_end: string;
  /** Publications published in the period, and in the one before it. */
  produced: number;
  produced_prev: number;
  spend: number;
  committed: number;
  leads: number;
  qualified: number;
  appointments: number;
  reservations: number;
  reservation_value: number;
  campaigns: Array<{
    id: string;
    ref: string | null;
    name: string;
    status: MosCampaign['status'];
    objective: MosCampaign['objective'] | null;
    starts_on: string | null;
    spend: number;
    qualified: number;
    reservations: number;
    cost_per_reservation: number | null;
  }>;
  /** The six calendar months ending this one — the production chart. */
  production_by_month: Array<{ month: string; count: number }>;
  pending_signature: Array<{
    id: string;
    ref: string | null;
    name: string;
    budget_total: number | null;
    success_metric: string | null;
    success_threshold: number | null;
    goal: string | null;
  }>;
  signature_threshold: number;
}

export const fetchCeoOverview = (period: CeoPeriod = 'month') =>
  call<MosCeoOverview>('ceo_overview', { period });

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
    events: MosCampaignEvent[];
    goals: MosGoal[];
  }>('campaign_detail', { id });

/** The marketing goals registry (with a linked-campaign count per goal). */
export const fetchGoals = () => call<{ goals: MosGoal[] }>('goals_list');

export const saveGoal = (goal: Record<string, unknown>) =>
  call<{ goals: MosGoal[] }>('goal_save', { goal });

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

/* ------------------------------------------------------------------ */
/* Nested campaign tree (execution → ad sets → ads) — fast bulk entry  */
/* ------------------------------------------------------------------ */

/**
 * An ad set as returned by `campaign_tree_get` — the middle level between an
 * execution ("platform campaign") and its ads. Meta calls it an "Ad Set";
 * other platforms an "Ad Group" — the execution's platform decides the label.
 */
export interface CampaignTreeAdSet {
  id: string;
  name: string;
  /** The ad set's own id on the platform (Meta ad set / TikTok ad group id). */
  platform_adset_id: string | null;
  status: string;
  sort_order: number;
}

/**
 * An ad as returned by `campaign_tree_get`. `ad_set_id === null` means the ad
 * sits directly under the execution (a "loose"/unassigned ad). `platform_ad_id`
 * is the external Meta Ad ID that inbound WhatsApp attribution resolves against.
 */
export interface CampaignTreeAd {
  id: string;
  label: string;
  platform_ad_id: string | null;
  ad_set_id: string | null;
  content_id: string | null;
  status: string;
}

/** The whole nested tree for one execution — the shape both tree RPCs return. */
export interface CampaignTree {
  execution: {
    id: string;
    campaign_id: string;
    platform: string;
    label: string | null;
    platform_campaign_id: string | null;
  };
  ad_sets: CampaignTreeAdSet[];
  ads: CampaignTreeAd[];
}

/**
 * One ad inside a save payload. `id` present ⇒ update that row; absent ⇒ the
 * server assigns a real id. External ids are optional.
 */
export interface AdDraft {
  id?: string;
  label: string;
  platform_ad_id?: string | null;
  content_id?: string | null;
  status?: string;
}

/** One ad set inside a save payload, carrying its ads. */
export interface AdSetDraft {
  id?: string;
  name: string;
  platform_adset_id?: string | null;
  sort_order?: number;
  ads: AdDraft[];
}

/**
 * The full-replace save payload. The WHOLE tree is sent on every save — rows
 * present in the DB but absent here are soft-archived server-side.
 *
 * Written as a `type` (not an `interface`) so it satisfies the `call<T>`
 * transport's `Record<string, unknown>` param — a named interface lacks the
 * implicit index signature that assignability needs (same reason `saveWorkflow`
 * uses an inline object type for its payload).
 */
export type CampaignTreeSavePayload = {
  execution_id: string;
  platform_campaign_id?: string | null;
  ad_sets: AdSetDraft[];
};

export const fetchCampaignTree = (executionId: string) =>
  call<CampaignTree>('campaign_tree_get', { execution_id: executionId });

export const saveCampaignTree = (payload: CampaignTreeSavePayload) =>
  call<CampaignTree>('campaign_tree_save', payload);

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

/** Archive (or un-archive). Allowed even while the asset is in use. */
export const archiveAsset = (id: string, archived = true) =>
  call<{ asset: MosAsset }>('asset_archive', { asset_id: id, archived });

/**
 * Hard delete. BLOCKED while anything references the asset: the server answers
 * 409 `{ error: 'in_use', used_in }` — catch MosApiError and read
 * `err.payload.used_in` to show where it's used (offer archive instead).
 */
export const deleteAsset = (id: string) => call<{ ok: true }>('asset_delete', { id });

export interface MosAssetUsage {
  content_id: string;
  ref: string | null;
  title: string;
  role: string;
  live_ad: boolean;
}

export const fetchAssetDetail = (assetId: string) =>
  call<{
    asset: MosAsset;
    used_in: MosAssetUsage[];
    versions: Array<{ id: string; title: string; created_at: string }>;
    publications_using: number;
  }>('asset_detail', { asset_id: assetId });

export const fetchUnusedAssets = () => call<{ rows: MosAsset[] }>('assets_unused');

export interface BulkAssetResult {
  id: string;
  ok: boolean;
  content_id?: string;
}

export const bulkAssets = (
  ids: string[],
  op: 'archive' | 'tag' | 'create_content',
  opts: { tag?: string; content_type_key?: string; title?: string } = {},
) => call<{ results: BulkAssetResult[]; content_id?: string }>('assets_bulk', { ids, op, ...opts });

export const linkAsset = (assetId: string, contentId: string, role = 'source') =>
  call<{ links: MosAssetLink[] }>('asset_link', { asset_id: assetId, content_id: contentId, role });

export const unlinkAsset = (assetId: string, contentId: string) =>
  call<{ links: MosAssetLink[] }>('asset_unlink', { asset_id: assetId, content_id: contentId });

/** Mark (assetId) or clear (null) the ONE material submitted for approval. The
 *  marketing manager's approval promotes it to the approved ('final') band. */
export const setApprovalAsset = (contentId: string, assetId: string | null) =>
  call<{ content_id: string; approval_asset_id: string | null }>(
    'content_set_approval_asset',
    { content_id: contentId, asset_id: assetId },
  );

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
    notify: s.notify,
    notify_channels: s.notify_channels,
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
    notify: s.notify ?? true,
    notify_channels: s.notify_channels ?? [...STEP_NOTIFY_CHANNELS],
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
  notification_rules: MosNotificationRule[];
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

/** The managed measure-type registry (active + inactive; the picker filters). */
export const fetchMeasureTypes = () =>
  call<{ measure_types: MosMeasureType[] }>('measure_types_list');

/** Create or update a measure type; returns the full refreshed list. */
export const saveMeasureType = (measureType: Record<string, unknown>) =>
  call<{ measure_types: MosMeasureType[] }>('measure_type_save', { measure_type: measureType });

/** The saved-audiences registry (active + inactive; the picker filters). */
export const fetchAudiences = () =>
  call<{ audiences: MosAudience[] }>('audiences_list');

/** Create or update a saved audience; returns the full refreshed list. */
export const saveAudience = (audience: Record<string, unknown>) =>
  call<{ audiences: MosAudience[] }>('audience_save', { audience });

export const fetchMetricsQueue = (since?: string) =>
  call<{ publications: MosPublication[]; titles: MosTitleRef[]; since: string }>(
    'metrics_queue',
    since ? { since } : {},
  );

export type SearchHitType = 'content' | 'campaign' | 'asset' | 'shoot';

export interface SearchHit {
  type: SearchHitType;
  id: string;
  ref: string | null;
  title: string;
  thumb_url: string | null;
  /** Asset hits only: set when the asset's bytes are a private `files` row
   *  (canonical intake). The page signs it — there is no stored public url. */
  file_id?: string | null;
  /** The field that matched ('title' | 'ref' | 'goal' | 'note' | 'location'). */
  match_reason: string;
  /** Server-built excerpt with the hit wrapped in <mark> — render as HTML. */
  excerpt: string;
}

export interface SearchResponse {
  results: SearchHit[];
  /** Only surfaces the caller may see appear here (hidden = absent). */
  chips: Array<{ type: SearchHitType; count: number }>;
  /**
   * Legacy keys for the pre-s44 search page — populated ONLY for types whose
   * surface the caller may see ([] when hidden, same rule as results/chips).
   * New UI should consume results/chips.
   */
  content: MosContentRow[];
  campaigns: MosCampaign[];
  assets: MosAsset[];
  shoots: MosShootRequest[];
}

export const searchAll = (q: string) => call<SearchResponse>('search', { q });

/* ------------------------------------------------------------------ */
/* notifications                                                       */
/* ------------------------------------------------------------------ */

export interface MosNotification {
  id: string;
  kind: string;
  title_ar: string;
  title_en: string | null;
  body_ar: string | null;
  body_en: string | null;
  url: string | null;
  read_at: string | null;
  created_at: string;
}

export const fetchNotifications = (opts: { unread_only?: boolean; limit?: number } = {}) =>
  call<{ rows: MosNotification[]; unread: number }>('notifications_list', opts);

export const markNotificationsRead = (ids: string[]) =>
  call<{ ok: true }>('notifications_read', { ids });

export type NotificationChannel = 'inapp' | 'push' | 'whatsapp';
export type NotificationTiming = 'immediate' | 'digest';

export interface MosNotificationRule {
  role_key: string;
  event: string;
  channel: NotificationChannel;
  timing: NotificationTiming;
  enabled: boolean;
}

export const fetchNotificationRules = () =>
  call<{ rules: MosNotificationRule[] }>('notification_rules');

export const setNotificationRule = (rule: {
  role_key: string;
  event: string;
  channel: NotificationChannel;
  enabled: boolean;
  timing?: NotificationTiming;
}) => call<{ ok: true }>('notification_rule_set', rule);

export interface MosNotificationPrefs {
  user_id: string;
  whatsapp_enabled: boolean;
  digest_hour: number;
  quiet_from: number | null;
  quiet_to: number | null;
}

export const saveNotificationPrefs = (prefs: {
  whatsapp_enabled?: boolean;
  digest_hour?: number;
  quiet_from?: number | null;
  quiet_to?: number | null;
}) => call<{ prefs: MosNotificationPrefs }>('notification_prefs_save', prefs);

/** «تذكير» — nudge whoever holds the item's open task. */
export const remindContent = (contentId: string) =>
  call<{ ok: true }>('remind', { content_id: contentId });

/* ------------------------------------------------------------------ */
/* campaign events / outcomes / signature / budget shift               */
/* ------------------------------------------------------------------ */

export type CampaignEventKind =
  | 'budget_shift' | 'execution_added' | 'execution_paused' | 'execution_resumed'
  | 'content_linked' | 'content_unlinked' | 'signed' | 'note';

export interface MosCampaignEvent {
  id: string;
  campaign_id: string;
  kind: CampaignEventKind;
  summary_ar: string;
  summary_en: string | null;
  detail: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
}

export const fetchCampaignEvents = (campaignId: string) =>
  call<{ events: MosCampaignEvent[] }>('campaign_events', { campaign_id: campaignId });

export const addCampaignEvent = (
  campaignId: string,
  event: { kind: CampaignEventKind; summary_ar: string; summary_en?: string; detail?: Record<string, unknown> },
) => call<{ event: MosCampaignEvent }>('campaign_event_add', { campaign_id: campaignId, ...event });

export interface MosCampaignOutcomes {
  attributed_clients: number;
  appointments: number;
  visits: number;
  reservations: number;
  reservation_value: number;
  window_days: number;
  touch: string;
  computed_at: string;
}

export const fetchCampaignOutcomes = (campaignId: string) =>
  call<{ outcomes: MosCampaignOutcomes; settings: Record<string, unknown> | null }>(
    'campaign_outcomes',
    { campaign_id: campaignId },
  );

/** The CEO's named budget sign-off. 403 unless the caller may sign. */
export const signCampaign = (campaignId: string) =>
  call<{ campaign: MosCampaign }>('campaign_sign', { campaign_id: campaignId });

export const budgetShift = (
  campaignId: string,
  fromExecutionId: string,
  toExecutionId: string,
  amount: number,
) => call<{ executions: MosExecution[] }>('budget_shift', {
  campaign_id: campaignId,
  from_execution_id: fromExecutionId,
  to_execution_id: toExecutionId,
  amount,
});

/* ------------------------------------------------------------------ */
/* attribution — the append-only client ↔ spend ledger                 */
/* ------------------------------------------------------------------ */

export interface MosAttribution {
  id: string;
  client_record_id: string;
  campaign_id: string | null;
  execution_id: string | null;
  ad_id: string | null;
  touch_type: 'first' | 'last';
  occurred_at: string;
  source: 'lead_form' | 'manual' | 'import';
  note: string | null;
  supersedes_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  /** True when a later row corrects this one (the effective view hides those). */
  superseded: boolean;
}

export const fetchAttributions = (filter: { campaign_id?: string; client_record_id?: string }) =>
  call<{ rows: MosAttribution[] }>('attribution_list', filter);

/** INSERT-only. Corrections stamp a new row with supersedes_id. */
export const stampAttribution = (row: {
  client_record_id: string;
  campaign_id?: string;
  execution_id?: string;
  ad_id?: string;
  occurred_at: string;
  source: 'lead_form' | 'manual' | 'import';
  note?: string;
  supersedes_id?: string;
  touch_type?: 'first' | 'last';
}) => call<{ row: MosAttribution }>('attribution_stamp', row);

/* ------------------------------------------------------------------ */
/* shoots                                                              */
/* ------------------------------------------------------------------ */

export interface MosShootItemDetail extends MosShootItem {
  scene: MosScene | null;
  content_ref: string | null;
  content_title: string | null;
}

export const fetchShootDetail = (requestId: string) =>
  call<{ request: MosShootRequest; items: MosShootItemDetail[]; assets_count: number }>(
    'shoot_detail',
    { request_id: requestId },
  );

export const addShootItem = (
  requestId: string,
  item: { description: string; scene_id?: string; content_id?: string },
) => call<{ item: MosShootItem }>('shoot_item_add', { request_id: requestId, ...item });

/* ------------------------------------------------------------------ */
/* numbers — the Friday entry screen                                   */
/* ------------------------------------------------------------------ */

export interface MosNumbersPublication {
  publication_id: string;
  content_ref: string | null;
  title: string;
  latest: {
    captured_at: string | null;
    source: 'manual' | 'api' | null;
    views: number | null;
    engagement: number | null;
    enquiries: number | null;
    extra: Record<string, unknown>;
  } | null;
  /** No snapshot was ever entered. Distinct from skipped AND from zero. */
  missing: boolean;
  skipped_reason: string | null;
}

export interface MosNumbersWeek {
  platforms: Array<{ platform: string; publications: MosNumbersPublication[] }>;
  progress: { entered: number; total: number; estimate_minutes: number };
  week_start: string;
  week_end: string;
}

export const fetchNumbersWeek = (weekStart?: string) =>
  call<MosNumbersWeek>('numbers_week', weekStart ? { week_start: weekStart } : {});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

/** mos_settings upsert (threshold cards on screen 25). */
export const saveSetting = (key: string, value: Record<string, unknown>) =>
  call<{ ok: true; settings: Record<string, unknown> }>('settings_save', { key, value });

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
  have:     { ar: 'متوفرة', en: 'Have it' },
  to_make:  { ar: 'تُصنع',  en: 'To be made' },
  missing:  { ar: 'ناقصة',  en: 'Missing' },
  // Screen 07's fourth state: the shot comes from a template (الشعار + واتساب),
  // so nobody has to film it and it isn't "made" per-video either.
  template: { ar: 'قالب',   en: 'Template' },
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
  awareness:     { ar: 'وعي',    en: 'Awareness' },
  consideration: { ar: 'مهتمين', en: 'Consideration' },
  sales:         { ar: 'مبيعات', en: 'Sales' },
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
