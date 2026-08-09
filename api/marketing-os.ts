/**
 * POST /api/marketing-os
 *
 * Action-dispatch endpoint for the Marketing OS module — a ground-up rebuild.
 * It shares NOTHING with the `mkt_*` tables or `api/marketing-mgmt.ts`; it reads
 * and writes the `mos_*` domain tables plus the canonical engine tables
 * (`workflows` kind='role_path', `workflow_versions`, `workflow_role_tasks`,
 * `roles` key 'mos_*', `surface_access`) that replaced the retired mos engine
 * (formerly mos_workflows / mos_workflow_steps / mos_tasks / mos_role_grants).
 *
 * Deliberately NOT `api/marketing.ts` — that name is already the live Marketing
 * Intelligence endpoint (competitor intel, ~49k observed facts) and is unrelated.
 *
 * Posture, matching every other bespoke module here:
 *   - Edge runtime, one POST, `{ action, ...payload }`.
 *   - Runs on the CALLER's JWT, never the service role. RLS is the authorization
 *     boundary — `wassell_mos_can(<capability>)` decides, not this file.
 *   - Task transitions go through `workflow_advance_role_path` (SQL, atomic);
 *     this file only snapshots versions and translates the response.
 *   - Reads go through `mos_content_v`, which DERIVES status and current owner
 *     from the open task. There is no stored status column to disagree with.
 *   - Updates use an allow-list, never a deny-list.
 *   - Deliberate DB rejections are translated bilingually; raw Postgres is never
 *     returned to the browser but is always console.error-ed (repo rule: fail loudly).
 */
import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

function callerClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('supabase env missing');
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data, error } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  if (error) {
    console.error('[marketing-os] wassell_app_user_id failed', error.code, error.message, error.details);
    return null;
  }
  return (data as string | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Clamp any client-supplied limit. No list here is ever unbounded. */
const cap = (n: unknown, def: number, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Deliberate database rejections, translated. Anything unmapped stays generic. */
const DB_MESSAGES: Record<string, { en: string; ar: string }> = {
  'MOS:UNKNOWN_CONTENT_TYPE': {
    en: 'That content type does not exist.',
    ar: 'نوع المحتوى غير موجود.',
  },
  'MOS:NOTE_REQUIRED': {
    en: 'Requesting changes requires a note explaining what to change.',
    ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
  },
  'MOS:NO_OPEN_TASK': {
    en: 'This item has no open task.',
    ar: 'لا توجد مهمة مفتوحة لهذا العنصر.',
  },
  'MOS:NOT_YOUR_TASK': {
    en: 'This task sits with another role.',
    ar: 'هذه المهمة تتبع دورًا آخر.',
  },
  'MOS:UNKNOWN_ROLE': {
    en: 'That marketing role does not exist.',
    ar: 'دور التسويق غير موجود.',
  },
  workflow_role_tasks_reject_note_check: {
    en: 'Requesting changes requires a note explaining what to change.',
    ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
  },
  uq_workflow_role_tasks_one_open: {
    en: 'This item already has an open task.',
    ar: 'هذا العنصر لديه مهمة مفتوحة بالفعل.',
  },
  mos_content_purpose_check: {
    en: 'Purpose must be organic, paid or both.',
    ar: 'الغرض يجب أن يكون عضويًا أو مدفوعًا أو الاثنين.',
  },
  mos_campaign_executions_purpose_check: {
    en: 'Execution purpose must be conversion, awareness, retargeting or traffic.',
    ar: 'غرض التنفيذ يجب أن يكون تحويلًا أو وعيًا أو إعادة استهداف أو زيارات.',
  },
  mos_campaign_events_kind_check: {
    en: 'That campaign event kind does not exist.',
    ar: 'نوع حدث الحملة غير موجود.',
  },
  client_attributions_source_check: {
    en: 'Attribution source must be lead_form, manual or import.',
    ar: 'مصدر النسبة يجب أن يكون نموذج عميل أو يدويًا أو استيرادًا.',
  },
  client_attributions_touch_check: {
    en: 'Touch type must be first or last.',
    ar: 'نوع اللمسة يجب أن يكون الأولى أو الأخيرة.',
  },
  'MOS:ATTRIBUTION_IMMUTABLE': {
    en: 'Attribution rows are append-only; correct by stamping a superseding row.',
    ar: 'سجل النسبة غير قابل للتعديل؛ صحّح بإضافة صف جديد يحل محل القديم.',
  },
  mos_snap_not_empty_check: {
    en: 'Enter at least one number, or skip this publication.',
    ar: 'أدخل رقمًا واحدًا على الأقل، أو تخطَّ هذا المنشور.',
  },
};

function translateDbError(error: PostgrestError): { status: number; en: string; ar: string } {
  console.error('[marketing-os] db error', error.code, error.message, error.details, error.hint);

  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return {
      status: 403,
      en: 'Your marketing role does not allow this action.',
      ar: 'دورك في التسويق لا يسمح بهذا الإجراء.',
    };
  }
  for (const token of Object.keys(DB_MESSAGES)) {
    const mapped = DB_MESSAGES[token];
    if (mapped && error.message.includes(token)) {
      return { status: 400, en: mapped.en, ar: mapped.ar };
    }
  }
  return {
    status: 400,
    en: 'The database rejected this change.',
    ar: 'رفضت قاعدة البيانات هذا التغيير.',
  };
}

/** Returns a Response when `error` is set, otherwise null. */
function dbFail(error: PostgrestError | null): Response | null {
  if (!error) return null;
  const t = translateDbError(error);
  return new Response(JSON.stringify({ error: t.en, error_ar: t.ar }), {
    status: t.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal row shape. PostgREST cannot infer a select built from a runtime string. */
interface Row {
  id: string;
  [key: string]: unknown;
}

/**
 * The Content list shows a dozen fields. Naming them keeps the payload
 * proportional to the screen instead of shipping every column of the view.
 */
const CONTENT_LIST_COLUMNS = [
  'id', 'ref', 'title', 'content_type_key', 'content_type_label_ar', 'content_type_label_en',
  'project_id', 'project_ids', 'campaign_id', 'purpose',
  'status_key', 'current_step_label_ar', 'current_step_label_en',
  'owner_role', 'current_assignee_user_id', 'current_task_due_at', 'current_round',
  'due_at', 'target_publish_at', 'updated_at',
].join(', ');

/** Patchable content fields. Identity and provenance are excluded by omission. */
const CONTENT_EDITABLE = [
  'title', 'project_id', 'project_ids', 'campaign_id', 'purpose', 'language',
  'goal', 'audience', 'angle', 'cta',
  'target_publish_at', 'due_at', 'data',
] as const;

/** The live metric a success measure's target is tracked against (mirrors the
 *  MosMeasureSource type + the mos_measure_types.source CHECK constraint). */
const MEASURE_SOURCES: readonly string[] = [
  'impressions', 'clicks', 'leads', 'qualified',
  'spend', 'cpl', 'cpl_qualified', 'ctr', 'none',
];

/**
 * A campaign or content item can link to SEVERAL projects (`project_ids`, a
 * searchable multi-select restricted to Our Projects) while `project_id` is kept
 * as the PRIMARY (first) project — so every existing filter, join, attribution
 * read, and single-name display keeps working unchanged. Call this on any patch
 * that carries `project_ids`: it normalizes the array (drops blanks, dedupes) and
 * derives the primary. If the caller sent `project_ids` we always re-derive
 * `project_id` from it, so the two can never disagree.
 */
function applyProjectIds(patch: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(patch, 'project_ids')) return;
  const raw = patch.project_ids;
  const ids = Array.isArray(raw)
    ? Array.from(new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0)))
    : [];
  patch.project_ids = ids;
  patch.project_id = ids[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* the canonical engine (workflows kind='role_path' + workflow_role_   */
/* tasks + roles 'mos_*' + surface_access)                             */
/* ------------------------------------------------------------------ */

/** The five marketing roles a role-path step can point at (keys, mos_ stripped). */
const MOS_ROLE_KEYS = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'] as const;

/** Every surface the shell can route to, in the matrix's stable order. */
const SURFACES = [
  'overview', 'mywork', 'team', 'content', 'calendar', 'library',
  'shoots', 'goals', 'campaigns', 'numbers', 'settings', 'roles',
] as const;
type SurfaceKey = (typeof SURFACES)[number];
type SurfaceLevel = 'full' | 'read' | 'hidden';

/**
 * Every marketing capability, in a stable order for the Roles-screen matrix.
 * These are what a role can DO (RLS gates on them via wassell_mos_can); they
 * are stored as data in role_capabilities. Keep in sync with the seed in
 * migration 2026-08-06_01_role_capabilities.sql and the client `Capability`
 * type (MarketingWorkspace.tsx).
 */
const CAPABILITIES = [
  'read', 'comment', 'write_content', 'view_content_body', 'compare_versions',
  'view_activity', 'assign', 'schedule', 'publish', 'approve_creative',
  'approve_process', 'approve_budget', 'manage_assets', 'enter_metrics',
  'review_performance', 'manage_settings', 'manage_roles',
] as const;

/** The notification channels a step may permit; AND-ed with each role's grid. */
const NOTIFY_CHANNELS = ['inapp', 'push', 'whatsapp'] as const;
type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * Normalize a raw `notify_channels` value from jsonb into a clean, deduped
 * subset of the three known channels. Absent / non-array → all three (the
 * legacy default: the role grid alone decides).
 */
function channelsOf(raw: unknown): NotifyChannel[] {
  if (!Array.isArray(raw)) return [...NOTIFY_CHANNELS];
  const out = NOTIFY_CHANNELS.filter((c) => (raw as unknown[]).includes(c));
  // An explicitly empty array is a real state (step permits nothing); only an
  // absent/garbage value falls back to "all three".
  return out;
}

/** A role-path step as stored in workflows.metadata->'steps'. */
interface StepDef {
  key: string;
  label_ar: string;
  label_en: string;
  role_key: string;
  due_days: number;
  is_approval: boolean;
  approval_kind: string | null;
  require_note_on_reject: boolean;
  creates_revision: boolean;
  required_fields: string[];
  required_files: string[];
  /** Whether opening this step fires a notification at all. */
  notify: boolean;
  /** Channels this step permits (AND-ed with each recipient's role settings). */
  notify_channels: NotifyChannel[];
}

/** Defensive read of metadata.steps — metadata is jsonb, so nothing is guaranteed. */
function stepsOf(metadata: unknown): StepDef[] {
  const raw = (metadata as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return [];
  const out: StepDef[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : '';
    if (!key) continue;
    out.push({
      key,
      label_ar: typeof r.label_ar === 'string' ? r.label_ar : '',
      label_en: typeof r.label_en === 'string' ? r.label_en : '',
      role_key: typeof r.role_key === 'string' ? r.role_key : '',
      due_days: typeof r.due_days === 'number' && Number.isFinite(r.due_days) ? r.due_days : 2,
      is_approval: r.is_approval === true,
      approval_kind: typeof r.approval_kind === 'string' ? r.approval_kind : null,
      require_note_on_reject: r.require_note_on_reject === true,
      creates_revision: r.creates_revision === true,
      required_fields: Array.isArray(r.required_fields) ? (r.required_fields as unknown[]).map(String) : [],
      required_files: Array.isArray(r.required_files) ? (r.required_files as unknown[]).map(String) : [],
      // Absent on legacy rows → notify on, all channels (the original behavior).
      notify: r.notify !== false,
      notify_channels: 'notify_channels' in r ? channelsOf(r.notify_channels) : [...NOTIFY_CHANNELS],
    });
  }
  return out;
}

interface WorkflowDef {
  id: string;
  label_ar: string;
  label_en: string;
  is_active: boolean;
  steps: StepDef[];
  current_version_no: number;
  current_version_id: string | null;
}

/** Canonical role-path rows + the version table → the contract's WorkflowDef list. */
function assembleWorkflowDefs(wfRows: unknown[], verRows: unknown[]): WorkflowDef[] {
  const latest = new Map<string, { version_no: number; id: string }>();
  for (const v of verRows) {
    const r = v as { workflow_id: string; version_no: number; id: string };
    const cur = latest.get(r.workflow_id);
    if (!cur || r.version_no > cur.version_no) {
      latest.set(r.workflow_id, { version_no: r.version_no, id: r.id });
    }
  }
  return wfRows.map((w) => {
    const r = w as { id: string; label_ar: string; label_en: string; is_active: boolean; metadata: unknown };
    const v = latest.get(r.id);
    return {
      id: r.id,
      label_ar: r.label_ar,
      label_en: r.label_en,
      is_active: r.is_active,
      steps: stepsOf(r.metadata),
      current_version_no: v?.version_no ?? 0,
      current_version_id: v?.id ?? null,
    };
  });
}

/**
 * The caller's level per surface, mirroring wassell_mos_surface_level() exactly:
 * administrator / marketing_manager see everything; otherwise the MAX level
 * across held roles wins and absence of a row means hidden; a viewer (no
 * marketing role at all) gets a read floor on 'overview' alone. Computed here
 * from one surface_access read so bootstrap stays a single round trip.
 */
function computeSurfaces(held: string[], accessRows: unknown[]): Record<SurfaceKey, SurfaceLevel> {
  const rows = accessRows as Array<{
    surface_key: string;
    level: SurfaceLevel;
    roles: { key: string } | Array<{ key: string }> | null;
  }>;
  const rank: Record<SurfaceLevel, number> = { hidden: 0, read: 1, full: 2 };
  const seesAll = held.includes('administrator') || held.includes('marketing_manager');
  const out = {} as Record<SurfaceKey, SurfaceLevel>;
  for (const surface of SURFACES) {
    if (seesAll) {
      out[surface] = 'full';
      continue;
    }
    let best: SurfaceLevel | null = null;
    for (const r of rows) {
      if (r.surface_key !== surface) continue;
      const joined = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      const key = joined?.key ?? '';
      if (!key.startsWith('mos_') || !held.includes(key.slice(4))) continue;
      if (best === null || rank[r.level] > rank[best]) best = r.level;
    }
    if (best !== null) {
      out[surface] = best;
    } else {
      out[surface] = held.includes('viewer') && surface === 'overview' ? 'read' : 'hidden';
    }
  }
  return out;
}

/**
 * workflow_role_tasks row → the task shape the SPA already renders. The stage
 * rail matches tasks to steps by id, so step_id carries the step KEY (steps are
 * synthesized with id = key below) — one stable identifier across versions.
 */
function mapRoleTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    content_id: t.subject_id,
    step_id: t.step_key ?? null,
    role: t.role_key,
    assignee_user_id: t.assignee_user_id ?? null,
    status: t.status,
    result: t.result ?? null,
    note: t.note ?? null,
    round: t.round,
    opened_at: t.opened_at,
    due_at: t.due_at ?? null,
    closed_at: t.closed_at ?? null,
    // Who closed it + what a rejection targeted — screen 08's «اعتمده ريان · …»
    // meta line and screen 38's revision chips both read these.
    closed_by_user_id: t.closed_by_user_id ?? null,
    revision_targets: Array.isArray(t.revision_targets) ? t.revision_targets : [],
  };
}

/**
 * The pinned path each listed subject is following: its open task's step key +
 * the pinned workflow version's steps. Screens 02 («القادم إليك») and 35 (the
 * creative/process approval split) both read steps from the PINNED version,
 * never from the workflow's current definition — the item keeps following the
 * path it started on.
 */
async function loadPinnedStepMeta(
  sb: SupabaseClient,
  subjectIds: string[],
): Promise<
  | { bySubject: Map<string, { steps: StepDef[]; currentStepKey: string | null }> }
  | { fail: Response }
> {
  const bySubject = new Map<string, { steps: StepDef[]; currentStepKey: string | null }>();
  if (subjectIds.length === 0) return { bySubject };

  const taskRes = await sb.from('workflow_role_tasks')
    .select('subject_id, step_key, workflow_version_id')
    .eq('subject_table', 'mos_content')
    .in('subject_id', subjectIds)
    .eq('status', 'open');
  if (taskRes.error) {
    const fail = dbFail(taskRes.error);
    if (fail) return { fail };
    return { bySubject };
  }
  const tasks = (taskRes.data ?? []) as Array<{
    subject_id: string; step_key: string | null; workflow_version_id: string | null;
  }>;
  const versionIds = Array.from(new Set(
    tasks.map((t) => t.workflow_version_id).filter((v): v is string => typeof v === 'string' && v !== ''),
  ));
  const stepsByVersion = new Map<string, StepDef[]>();
  if (versionIds.length > 0) {
    const verRes = await sb.from('workflow_versions').select('id, definition').in('id', versionIds);
    if (verRes.error) {
      const fail = dbFail(verRes.error);
      if (fail) return { fail };
      return { bySubject };
    }
    for (const v of verRes.data ?? []) {
      const row = v as { id: string; definition: unknown };
      const metadata = (row.definition as { metadata?: unknown } | null)?.metadata;
      stepsByVersion.set(row.id, stepsOf(metadata));
    }
  }
  for (const t of tasks) {
    bySubject.set(t.subject_id, {
      steps: (t.workflow_version_id ? stepsByVersion.get(t.workflow_version_id) : undefined) ?? [],
      currentStepKey: t.step_key,
    });
  }
  return { bySubject };
}

/** StepDefs → the step shape the SPA renders (id = key, position = 1-based index). */
function mapStepDefs(workflowId: string, steps: StepDef[]): Array<Record<string, unknown>> {
  return steps.map((s, i) => ({
    id: s.key,
    workflow_id: workflowId,
    position: i + 1,
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
  }));
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow';

/** roles.key 'mos_*' → the stripped key the API contract speaks in. */
const stripMosPrefix = (key: string): string => key.replace(/^mos_/, '');

/** Finite number or null — for budget/spend inputs that may arrive as null. */
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/* ------------------------------------------------------------------ */
/* notifications — every emission enters through notify_emit, and a    */
/* notification failure must NEVER fail the business write that        */
/* triggered it, so the one call site below swallows exactly that      */
/* failure (console.error'd) and nothing else.                         */
/* ------------------------------------------------------------------ */

interface NotifyArgs {
  event: string;
  /** UNPREFIXED role keys ('writer'); the helper adds the mos_ prefix. */
  roles?: string[];
  users?: string[];
  titleAr: string;
  titleEn?: string | null;
  bodyAr?: string | null;
  bodyEn?: string | null;
  url?: string | null;
  /**
   * Per-step channel mask (subset of inapp/push/whatsapp). When present it is
   * AND-ed with each recipient's role grid inside notify_emit — a step narrows,
   * never widens. Omit for the role-grid-only behavior every other caller wants.
   */
  channels?: NotifyChannel[];
}

async function emitNotify(sb: SupabaseClient, args: NotifyArgs): Promise<void> {
  try {
    const params: Record<string, unknown> = {
      p_workspace: 'marketing',
      p_event: args.event,
      // roles.key is mos_*-prefixed; the API speaks in stripped keys.
      p_role_keys: (args.roles ?? []).map((r) => (r.startsWith('mos_') ? r : `mos_${r}`)),
      p_user_ids: args.users ?? [],
      p_title_ar: args.titleAr,
      p_title_en: args.titleEn ?? null,
      p_body_ar: args.bodyAr ?? null,
      p_body_en: args.bodyEn ?? null,
      p_url: args.url ?? null,
    };
    // Only the per-step path passes a mask. Omitting p_channels entirely (rather
    // than sending null) lets the four role-grid-only callers resolve against
    // either notify_emit signature, so they never depend on this feature's
    // migration having landed first; the mask itself needs the 10-arg version.
    if (args.channels) params.p_channels = args.channels;
    const { error } = await sb.rpc('notify_emit', params);
    // A failed emission is logged, never thrown: the content advance, the
    // shoot delivery or the campaign save that triggered it already committed,
    // and a lost notification must not read as a lost business write.
    if (error) {
      console.error('[marketing-os] notify_emit failed', args.event, error.code, error.message, error.details);
    }
  } catch (e) {
    // Same posture for a transport-level throw: loud in the logs, invisible
    // to the business write.
    console.error('[marketing-os] notify_emit threw', args.event, e);
  }
}

/**
 * Resolve a pinned step's notification gate + permitted channels from the
 * version the task was opened under. workflow_versions.definition snapshots
 * metadata.steps, so an in-flight record keeps the notification rules it
 * started with. Anything missing (legacy version, deleted step, read error) →
 * notify on, all channels: the engine's original behavior.
 */
async function resolveStepNotify(
  sb: SupabaseClient,
  versionId: string | null,
  stepKey: string | null,
): Promise<{ notify: boolean; channels: NotifyChannel[] }> {
  const fallback = { notify: true, channels: [...NOTIFY_CHANNELS] as NotifyChannel[] };
  if (!versionId || !stepKey) return fallback;
  const res = await sb.from('workflow_versions')
    .select('definition').eq('id', versionId).maybeSingle();
  if (res.error) {
    console.error('[marketing-os] step-notify version read failed', res.error.code, res.error.message);
    return fallback;
  }
  if (!res.data) return fallback;
  const def = (res.data as { definition?: unknown }).definition;
  const step = stepsOf((def as { metadata?: unknown } | null)?.metadata).find((s) => s.key === stepKey);
  return step ? { notify: step.notify, channels: step.notify_channels } : fallback;
}

/**
 * The caller's surface levels — the same read bootstrap makes, extracted so
 * search can filter result types by exactly the same rules (hidden surface →
 * the type is absent from results AND chips).
 */
async function callerSurfaces(
  sb: SupabaseClient,
): Promise<{ surfaces: Record<SurfaceKey, SurfaceLevel> } | { fail: Response }> {
  const [rolesRes, accessRes] = await Promise.all([
    sb.rpc('wassell_mos_roles'),
    sb.from('surface_access').select('surface_key, level, roles!inner(key)'),
  ]);
  const fail = dbFail(rolesRes.error) ?? dbFail(accessRes.error);
  if (fail) return { fail };
  const held = (rolesRes.data as string[] | null) ?? [];
  return { surfaces: computeSurfaces(held, accessRes.data ?? []) };
}

/** The role × event × channel matrix rows, in the contract's shape. */
async function fetchNotificationRuleRows(
  sb: SupabaseClient,
): Promise<{ rules: Array<Record<string, unknown>> } | { fail: Response }> {
  const res = await sb.from('notification_rules').select('event, channel, timing, enabled, roles!inner(key)');
  const fail = dbFail(res.error);
  if (fail) return { fail };
  const rows = ((res.data ?? []) as unknown as Array<{
    event: string;
    channel: string;
    timing: string;
    enabled: boolean;
    roles: { key: string } | Array<{ key: string }> | null;
  }>)
    .map((r) => {
      const joined = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      const key = joined?.key ?? '';
      return {
        role_key: key.startsWith('mos_') ? stripMosPrefix(key) : '',
        event: r.event,
        channel: r.channel,
        timing: r.timing,
        enabled: r.enabled,
      };
    })
    .filter((r) => r.role_key !== '');
  // Deterministic order: role, then event, then channel.
  rows.sort((a, b) =>
    a.role_key.localeCompare(b.role_key)
    || a.event.localeCompare(b.event)
    || a.channel.localeCompare(b.channel));
  return { rules: rows };
}

/**
 * The campaign the UI renders = the view's aggregates + the base table's
 * brief/signature columns (mos_campaign_v predates them and a view change is
 * out of scope for this endpoint, so the two reads are merged here).
 */
async function readCampaignMerged(
  sb: SupabaseClient,
  id: string,
): Promise<{ row: Record<string, unknown> | null; error: PostgrestError | null }> {
  const [viewRes, baseRes] = await Promise.all([
    sb.from('mos_campaign_v').select('*').eq('id', id).maybeSingle(),
    sb.from('mos_campaigns').select('*').eq('id', id).maybeSingle(),
  ]);
  const error = viewRes.error ?? baseRes.error;
  if (error) return { row: null, error };
  if (!viewRes.data && !baseRes.data) return { row: null, error: null };
  const row: Record<string, unknown> = {
    ...((viewRes.data ?? {}) as Record<string, unknown>),
    ...((baseRes.data ?? {}) as Record<string, unknown>),
  };
  // Attach the chosen audience's LIVE details (the name is snapshotted on the
  // campaign; the long details are resolved fresh so an edit to the record shows
  // through). Non-fatal: a failed lookup just omits details, it never sinks the read.
  const audienceId = str(row.audience_id);
  if (audienceId) {
    const aud = await sb.from('mos_audiences').select('details').eq('id', audienceId).maybeSingle();
    if (aud.error) {
      console.error('[marketing-os] audience details read failed', aud.error.code, aud.error.message);
    } else if (aud.data) {
      row.audience_details = (aud.data as { details: string | null }).details;
    }
  }
  return { row, error: null };
}

/**
 * Read the goal ids currently linked to a campaign. Returns an error Response
 * (via dbFail) on failure so callers can bail the same way they do elsewhere.
 */
async function readCampaignGoalIds(
  sb: SupabaseClient,
  campaignId: string,
): Promise<{ ids: string[]; error: Response | null }> {
  const res = await sb.from('mos_campaign_goals').select('goal_id').eq('campaign_id', campaignId);
  const f = dbFail(res.error);
  if (f) return { ids: [], error: f };
  const ids = ((res.data ?? []) as Array<{ goal_id: string }>).map((r) => r.goal_id);
  return { ids, error: null };
}

/**
 * Replace a campaign's goal links with exactly `goalIds` (delete-all then
 * insert), so a save is idempotent and order-independent. Returns an error
 * Response on failure, or null on success.
 */
async function syncCampaignGoals(
  sb: SupabaseClient,
  campaignId: string,
  goalIds: string[],
): Promise<Response | null> {
  const del = await sb.from('mos_campaign_goals').delete().eq('campaign_id', campaignId);
  const df = dbFail(del.error);
  if (df) return df;
  if (goalIds.length === 0) return null;
  const rows = goalIds.map((goal_id) => ({ campaign_id: campaignId, goal_id }));
  const ins = await sb.from('mos_campaign_goals').insert(rows);
  return dbFail(ins.error);
}

/**
 * Append to the campaign's «ما الذي تغيّر» ledger. The ledger row is part of
 * the audit trail, but the business write it describes has already committed
 * by the time this runs — so an insert failure is console.error-ed and the
 * action continues rather than falsely reporting the write itself failed.
 */
async function logCampaignEvent(
  sb: SupabaseClient,
  args: {
    campaignId: string;
    kind: string;
    summaryAr: string;
    summaryEn?: string | null;
    detail?: Record<string, unknown>;
    actorUserId: string | null;
  },
): Promise<void> {
  const ins = await sb.from('mos_campaign_events').insert({
    campaign_id: args.campaignId,
    kind: args.kind,
    summary_ar: args.summaryAr,
    summary_en: args.summaryEn ?? null,
    detail: (args.detail ?? {}) as Record<string, unknown>,
    actor_user_id: args.actorUserId,
  });
  if (ins.error) {
    console.error('[marketing-os] campaign event insert failed', args.kind,
      ins.error.code, ins.error.message, ins.error.details);
  }
}

/** mos_settings.signature_threshold → the amount above which a budget needs a signature. */
async function readSignatureThreshold(sb: SupabaseClient): Promise<number> {
  const res = await sb.from('mos_settings').select('value').eq('key', 'signature_threshold').maybeSingle();
  if (res.error) {
    console.error('[marketing-os] signature_threshold read failed', res.error.code, res.error.message);
    return 50_000;
  }
  const amount = ((res.data as { value?: { amount?: unknown } } | null)?.value?.amount);
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : 50_000;
}

/**
 * Open a freshly created content item on its workflow's first step: pin the
 * current version, then insert the open task. Shared by content_create and
 * assets_bulk's create_content so the two never drift.
 */
async function openFirstTask(
  sb: SupabaseClient,
  contentId: string,
  workflowId: string,
): Promise<Response | null> {
  const [wfRes, verRes] = await Promise.all([
    sb.from('workflows').select('id, metadata').eq('id', workflowId).maybeSingle(),
    sb.from('workflow_versions').select('id, version_no')
      .eq('workflow_id', workflowId)
      .order('version_no', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const wfFail = dbFail(wfRes.error) ?? dbFail(verRes.error);
  if (wfFail) return wfFail;

  const first = stepsOf((wfRes.data as { metadata?: unknown } | null)?.metadata ?? null)[0];
  const versionId = (verRes.data as { id: string } | null)?.id ?? null;
  if (!first) return null;
  if (versionId) {
    const pin = await sb.from('mos_content')
      .update({ workflow_version_id: versionId }).eq('id', contentId);
    const pinFail = dbFail(pin.error);
    if (pinFail) return pinFail;
  }
  // Definer-rights RPC: screen 33 grants creation to Writer/Ops, but the task
  // INSERT policy requires 'assign' — opening the first task on create is an
  // engine concern, not a caller privilege (migration 08).
  const taskRes = await sb.rpc('workflow_role_path_start', {
    p_subject_table: 'mos_content',
    p_subject_id: contentId,
  });
  return dbFail(taskRes.error);
}

/**
 * Search excerpt: the matching text with the first case-insensitive hit
 * wrapped in <mark>. indexOf (not RegExp) so any term — including regex
 * metacharacters — is matched literally.
 */
function buildExcerpt(text: string, term: string): string | null {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + term.length + 80);
  return (start > 0 ? '…' : '')
    + text.slice(start, idx)
    + '<mark>'
    + text.slice(idx, idx + term.length)
    + '</mark>'
    + text.slice(idx + term.length, end)
    + (end < text.length ? '…' : '');
}

/** First field (in priority order) containing the term → the hit's reason + excerpt. */
function matchIn(
  fields: Array<[reason: string, text: string | null | undefined]>,
  term: string,
): { match_reason: string; excerpt: string } {
  for (const [reason, text] of fields) {
    if (!text) continue;
    const excerpt = buildExcerpt(text, term);
    if (excerpt !== null) return { match_reason: reason, excerpt };
  }
  // Unreachable when the caller only feeds rows the DB matched, but a row
  // that slipped through reports the title rather than crashing the search.
  return { match_reason: 'title', excerpt: '' };
}

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');

  return withAuth(req, async (user) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'body must be JSON');
    }

    const sb = callerClient(req);
    const action = str(body.action);
    if (!action) return jsonError(400, 'action is required');

    switch (action) {
      /* -------------------------------------------------------- */
      /* bootstrap — me (roles, surfaces), workflows, settings in  */
      /* one call on page load                                     */
      /* -------------------------------------------------------- */
      case 'bootstrap': {
        const [rolesRes, capsRes, accessRes, typesRes, wfRes, verRes, settingsRes, accountsRes, appUserId] =
          await Promise.all([
            sb.rpc('wassell_mos_roles'),
            // Capability truth from the DB (role_capabilities), so the client
            // stops hand-mirroring the matrix. One source, no drift.
            sb.rpc('wassell_mos_capabilities'),
            sb.from('surface_access').select('surface_key, level, roles!inner(key)'),
            sb.from('mos_content_types')
              .select('id, key, label_ar, label_en, prefix, workflow_id, field_schema, sort_order')
              .is('archived_at', null)
              .eq('is_active', true)
              .order('sort_order', { ascending: true }),
            sb.from('workflows')
              .select('id, label_ar, label_en, is_active, metadata')
              .eq('kind', 'role_path')
              .order('label_en', { ascending: true }),
            sb.from('workflow_versions').select('id, workflow_id, version_no'),
            sb.from('mos_settings').select('key, value'),
            sb.from('mos_platform_accounts').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            resolveAppUserId(sb, user.userId),
          ]);
        const fail = dbFail(rolesRes.error) ?? dbFail(capsRes.error) ?? dbFail(accessRes.error)
          ?? dbFail(typesRes.error) ?? dbFail(wfRes.error) ?? dbFail(verRes.error)
          ?? dbFail(settingsRes.error) ?? dbFail(accountsRes.error);
        if (fail) return fail;

        const held = (rolesRes.data as string[] | null) ?? [];
        const capabilities = (capsRes.data as string[] | null) ?? [];
        // Display-affecting only (contract convention): the header chooses which
        // of the caller's HELD roles the UI leads with; it never authorizes.
        const requestedRole = (req.headers.get('x-mos-active-role') ?? '').trim();
        const activeRole = held.includes(requestedRole) ? requestedRole : (held[0] ?? 'viewer');

        const settings: Record<string, unknown> = {};
        for (const row of (settingsRes.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }

        return jsonOk({
          me: {
            user_id: appUserId,
            roles: held,
            capabilities,
            active_role: activeRole,
            surfaces: computeSurfaces(held, accessRes.data ?? []),
            // Notification prefs arrive with the notifications migration (…_04),
            // which is not in this build yet.
            prefs: {},
          },
          content_types: typesRes.data ?? [],
          workflows: assembleWorkflowDefs(wfRes.data ?? [], verRes.data ?? []),
          platform_accounts: accountsRes.data ?? [],
          settings,
          unread_notifications: 0,
        });
      }

      /* -------------------------------------------------------- */
      /* Content list                                              */
      /* -------------------------------------------------------- */
      case 'content_list': {
        let q = sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).is('archived_at', null);

        const typeKey = str(body.content_type_key);
        const statusKey = str(body.status_key);
        const projectId = str(body.project_id);
        const role = str(body.role);
        const search = str(body.q);
        if (typeKey) q = q.eq('content_type_key', typeKey);
        if (statusKey) q = q.eq('status_key', statusKey);
        // Match membership, not just the primary project — an item filtered by a
        // project it's tagged with (even as a secondary) should surface.
        if (projectId) q = q.contains('project_ids', [projectId]);
        if (role) q = q.eq('owner_role', role);
        if (search) q = q.ilike('title', `%${search}%`);

        // Items with a due date first, soonest first; undated fall to the end.
        const { data, error } = await q
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));

        const fail = dbFail(error);
        if (fail) return fail;

        // Screen 03's campaign column and platform filter need two facts the
        // content view does not carry: the campaign's NAME and which platforms
        // each item is headed to. Both are one batched lookup, never per-row.
        const rows = (data ?? []) as unknown as Row[];
        const ids = rows.map((r) => r.id as string);
        const campaignIds = Array.from(new Set(
          rows.map((r) => r.campaign_id as string | null).filter((c): c is string => Boolean(c)),
        ));
        const camps = campaignIds.length > 0
          ? await sb.from('mos_campaigns').select('id, name').in('id', campaignIds)
          : { data: [] as Array<{ id: string; name: string }>, error: null };
        const pubs = ids.length > 0
          ? await sb.from('mos_publications').select('content_id, platform').in('content_id', ids)
          : { data: [] as Array<{ content_id: string; platform: string }>, error: null };
        // A preview THUMBNAIL for each item — its FINAL cut's image, falling back
        // to a source/reference asset that actually has a thumb. Powers the
        // reference chooser (screen 08) and any thumbnailed content list. Two
        // batched reads, never per-row; RLS applies, so an unreadable asset is
        // simply omitted (the item shows a typed placeholder instead).
        const links = ids.length > 0
          ? await sb.from('mos_asset_links').select('content_id, asset_id, role').in('content_id', ids)
          : { data: [] as Array<{ content_id: string; asset_id: string; role: string }>, error: null };
        const fail2 = dbFail(camps.error) ?? dbFail(pubs.error) ?? dbFail(links.error);
        if (fail2) return fail2;

        const assetIds = Array.from(new Set((links.data ?? []).map((l) => l.asset_id)));
        const assetsRes = assetIds.length > 0
          ? await sb.from('mos_assets').select('id, thumb_url, kind').in('id', assetIds)
          : { data: [] as Array<{ id: string; thumb_url: string | null; kind: string | null }>, error: null };
        const fail3 = dbFail(assetsRes.error);
        if (fail3) return fail3;

        const campName = new Map((camps.data ?? []).map((c) => [c.id, c.name]));
        const plats = new Map<string, string[]>();
        for (const p of pubs.data ?? []) {
          const arr = plats.get(p.content_id) ?? [];
          if (p.platform && !arr.includes(p.platform)) arr.push(p.platform);
          plats.set(p.content_id, arr);
        }

        // Choose one preview asset per content: an asset WITH a thumb wins over
        // one without, and among those the final cut wins over source/reference.
        const assetById = new Map((assetsRes.data ?? []).map((a) => [a.id, a]));
        const ROLE_RANK: Record<string, number> = { final: 0, source: 1, reference: 2 };
        const bestByContent = new Map<string, { thumb: string | null; kind: string | null; score: number }>();
        for (const l of links.data ?? []) {
          const a = assetById.get(l.asset_id);
          if (!a) continue;
          const score = (a.thumb_url ? 0 : 100) + (ROLE_RANK[l.role] ?? 3);
          const cur = bestByContent.get(l.content_id);
          if (!cur || score < cur.score) {
            bestByContent.set(l.content_id, { thumb: a.thumb_url ?? null, kind: a.kind ?? null, score });
          }
        }

        return jsonOk({
          content: rows.map((r) => {
            const best = bestByContent.get(r.id as string);
            return {
              ...r,
              campaign_name: r.campaign_id ? campName.get(r.campaign_id as string) ?? null : null,
              platforms: plats.get(r.id as string) ?? [],
              thumb_url: best?.thumb ?? null,
              preview_kind: best?.kind ?? null,
            };
          }),
        });
      }

      /* -------------------------------------------------------- */
      /* Workspace — one round trip                                */
      /* -------------------------------------------------------- */
      case 'content_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const [item, tasks, scenes] = await Promise.all([
          sb.from('mos_content_v').select('*').eq('id', id).maybeSingle(),
          sb.from('workflow_role_tasks').select('*')
            .eq('subject_table', 'mos_content').eq('subject_id', id)
            .order('opened_at', { ascending: true }),
          sb.from('mos_scenes').select('*').eq('content_id', id)
            .order('position', { ascending: true }),
        ]);

        const fail = dbFail(item.error) ?? dbFail(tasks.error) ?? dbFail(scenes.error);
        if (fail) return fail;
        if (!item.data) return jsonError(404, 'content item not found');

        // Steps for the stage rail come from the item's PINNED version, so an
        // edit to the path never relabels a step under running work. An item
        // with no pin (never started on a path) falls back to the live row.
        const row = item.data as Row;
        const workflowId = (row.workflow_id as string | null) ?? null;
        const pinnedVersionId = (row.workflow_version_id as string | null) ?? null;
        let steps: Array<Record<string, unknown>> = [];
        if (pinnedVersionId) {
          const verRes = await sb.from('workflow_versions')
            .select('definition').eq('id', pinnedVersionId).maybeSingle();
          const verFail = dbFail(verRes.error);
          if (verFail) return verFail;
          const def = (verRes.data as { definition?: { metadata?: unknown } } | null)?.definition;
          steps = mapStepDefs(workflowId ?? '', stepsOf(def?.metadata ?? null));
        } else if (workflowId) {
          const wfRes = await sb.from('workflows')
            .select('metadata').eq('id', workflowId).maybeSingle();
          const wfFail = dbFail(wfRes.error);
          if (wfFail) return wfFail;
          steps = mapStepDefs(workflowId, stepsOf((wfRes.data as { metadata?: unknown } | null)?.metadata ?? null));
        }

        return jsonOk({
          item: item.data,
          tasks: (tasks.data ?? []).map((t) => mapRoleTask(t as Record<string, unknown>)),
          scenes: scenes.data ?? [],
          steps,
        });
      }

      /* -------------------------------------------------------- */
      /* Create — and open the first task in the same request      */
      /* -------------------------------------------------------- */
      case 'content_create': {
        const title = str(body.title);
        const typeKey = str(body.content_type_key);
        if (!title) return jsonError(400, 'title is required');
        if (!typeKey) return jsonError(400, 'content_type_key is required');

        const typeRes = await sb.from('mos_content_types')
          .select('id, workflow_id').eq('key', typeKey).maybeSingle();
        const typeFail = dbFail(typeRes.error);
        if (typeFail) return typeFail;
        if (!typeRes.data) return jsonError(400, 'unknown content type');
        const type = typeRes.data as { id: string; workflow_id: string | null };

        const appUserId = await resolveAppUserId(sb, user.userId);
        const insert: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(body, k)) insert[k] = body[k];
        }
        applyProjectIds(insert);
        insert.title = title;
        insert.content_type_id = type.id;
        insert.workflow_id = type.workflow_id;
        insert.created_by_user_id = appUserId;

        const created = await sb.from('mos_content').insert(insert).select('id, ref').maybeSingle();
        const createFail = dbFail(created.error);
        if (createFail) return createFail;
        if (!created.data) return jsonError(500, 'insert returned no row');
        const row = created.data as unknown as Row;

        // Open the workflow's first step immediately. Content with no task would
        // read as 'draft' and sit in nobody's queue — the exact failure mode this
        // module exists to remove. The item is PINNED to the current version, so
        // a later edit to the path never moves running work.
        if (type.workflow_id) {
          const openFail = await openFirstTask(sb, row.id, type.workflow_id);
          if (openFail) return openFail;
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', row.id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Allow-listed patch                                        */
      /* -------------------------------------------------------- */
      case 'content_update': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const raw = (body.patch ?? {}) as Record<string, unknown>;

        const patch: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        applyProjectIds(patch);
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');

        const upd = await sb.from('mos_content').update(patch).eq('id', id).select('id').maybeSingle();
        const updFail = dbFail(upd.error);
        if (updFail) return updFail;
        if (!upd.data) return jsonError(404, 'content item not found');

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Advance the role path — the transition itself is SQL      */
      /* -------------------------------------------------------- */
      case 'task_complete': {
        // The SPA hands the open task's id; the engine advances by subject.
        // Both are accepted and resolved to the same open row.
        const taskId = str(body.task_id);
        let contentId = str(body.content_id);
        const result = str(body.result);
        const note = str(body.note);
        const targets = Array.isArray(body.targets)
          ? (body.targets as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        if (!taskId && !contentId) return jsonError(400, 'task_id or content_id is required');
        if (!result || !['submitted', 'approved', 'changes_requested'].includes(result)) {
          return jsonError(400, 'result must be submitted, approved or changes_requested');
        }
        // Mirrors the CHECK constraint so the user gets a sentence, not a violation.
        if (result === 'changes_requested' && !note) {
          return new Response(
            JSON.stringify({
              error: 'Requesting changes requires a note explaining what to change.',
              error_ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        let tq = sb.from('workflow_role_tasks')
          .select('id, subject_id, round')
          .eq('subject_table', 'mos_content')
          .eq('status', 'open');
        tq = taskId ? tq.eq('id', taskId) : tq.eq('subject_id', contentId ?? '');
        const cur = await tq.maybeSingle();
        const curFail = dbFail(cur.error);
        if (curFail) return curFail;
        if (!cur.data) return jsonError(404, 'no open task found');
        const openTask = cur.data as unknown as { id: string; subject_id: string; round: number };
        contentId = openTask.subject_id;

        // Submitted work gets a frozen snapshot of the round BEFORE the engine
        // moves on — a resubmit of the same round overwrites its own snapshot.
        if (result === 'submitted') {
          const [contentRes, scenesRes, appUserId] = await Promise.all([
            sb.from('mos_content').select('data').eq('id', contentId).maybeSingle(),
            sb.from('mos_scenes').select('*').eq('content_id', contentId)
              .order('position', { ascending: true }),
            resolveAppUserId(sb, user.userId),
          ]);
          const snapReadFail = dbFail(contentRes.error) ?? dbFail(scenesRes.error);
          if (snapReadFail) return snapReadFail;
          const snap = await sb.from('mos_content_versions').upsert(
            {
              content_id: contentId,
              round: openTask.round,
              data: ((contentRes.data as { data?: unknown } | null)?.data ?? {}) as Record<string, unknown>,
              scenes: scenesRes.data ?? [],
              submitted_by_user_id: appUserId,
            },
            { onConflict: 'content_id,round' },
          );
          const snapFail = dbFail(snap.error);
          if (snapFail) return snapFail;
        }

        const adv = await sb.rpc('workflow_advance_role_path', {
          p_subject_table: 'mos_content',
          p_subject_id: contentId,
          p_result: result,
          p_note: note,
          p_targets: targets,
        });
        const advFail = dbFail(adv.error);
        if (advFail) return advFail;
        const payload = (adv.data ?? {}) as {
          closed_task_id: string;
          opened_task_id: string | null;
          next_step_key: string | null;
          round: number;
          done: boolean;
        };

        // A rejection's reason lives on the version it rejected. The engine has
        // already incremented the round, so the rejected version is round - 1.
        if (result === 'changes_requested' && payload.round - 1 >= 1) {
          const rn = await sb.from('mos_content_versions')
            .update({ rejected_note: note })
            .eq('content_id', contentId)
            .eq('round', payload.round - 1);
          const rnFail = dbFail(rn.error);
          if (rnFail) return rnFail;
        }

        // Approval is the bridge to a publishable file: the material the item's
        // owner submitted for approval (mos_content.approval_asset_id) becomes an
        // approved ('final') link, which is what the Publishing tab reads. The RPC
        // is SECURITY DEFINER (the approver may not hold asset-write RLS) and
        // promotes the EXPLICIT selection only — a no-op when nothing was marked.
        if (result === 'approved') {
          const promo = await sb.rpc('mos_promote_approval_asset', { p_content_id: contentId });
          const promoFail = dbFail(promo.error);
          if (promoFail) return promoFail;
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', contentId).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;

        // Notifications: the engine has opened the NEXT task — its role is who
        // gets interrupted. A rejection reopens the revision step (the writer),
        // a submit/approval opens the following step. done=true opens nothing.
        if (payload.opened_task_id) {
          const nt = await sb.from('workflow_role_tasks')
            .select('role_key, assignee_user_id, workflow_version_id, step_key')
            .eq('id', payload.opened_task_id).maybeSingle();
          if (nt.error) {
            console.error('[marketing-os] next-task read for notification failed',
              nt.error.code, nt.error.message);
          } else if (nt.data) {
            const next = nt.data as {
              role_key: string;
              assignee_user_id: string | null;
              workflow_version_id: string | null;
              step_key: string | null;
            };
            // The step that just became active decides whether — and on which
            // channels — its owner is interrupted. `notify: false` opens the
            // task silently (it still shows in «my work»); otherwise the step's
            // permitted channels are AND-ed with the recipient's role grid.
            const notifyCfg = await resolveStepNotify(sb, next.workflow_version_id, next.step_key);
            if (notifyCfg.notify) {
              const itemTitle = ((full.data as { title?: string } | null)?.title) ?? '';
              await emitNotify(sb, result === 'changes_requested'
                ? {
                    event: 'changes_requested',
                    roles: [next.role_key],
                    users: next.assignee_user_id ? [next.assignee_user_id] : [],
                    titleAr: 'أُعيد العمل بتعديلات',
                    titleEn: 'Changes requested',
                    bodyAr: `«${itemTitle}» — ${note ?? ''}`,
                    bodyEn: itemTitle,
                    url: `/m/content/${contentId}?tab=tasks`,
                    channels: notifyCfg.channels,
                  }
                : {
                    event: 'task_assigned',
                    roles: [next.role_key],
                    users: next.assignee_user_id ? [next.assignee_user_id] : [],
                    titleAr: 'فُتحت لك مهمة',
                    titleEn: 'A task was assigned to you',
                    bodyAr: `«${itemTitle}» بانتظار خطوتك.`,
                    bodyEn: itemTitle,
                    url: `/m/content/${contentId}?tab=tasks`,
                    channels: notifyCfg.channels,
                  });
            }
          }
        }

        return jsonOk({ item: full.data, ...payload });
      }

      /* -------------------------------------------------------- */
      /* Hand an open task to a specific person                    */
      /* -------------------------------------------------------- */
      case 'task_transfer': {
        const taskId = str(body.task_id);
        const toUserId = str(body.to_user_id);
        if (!taskId || !toUserId) return jsonError(400, 'task_id and to_user_id are required');
        const res = await sb.rpc('workflow_role_task_transfer', {
          p_task_id: taskId,
          p_to_user_id: toUserId,
        });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* «تأجيل / تقديم» (s35) — move an open task's due date.     */
      /* RLS gates the write to roles holding 'assign' (manager /  */
      /* ops supervisor / admin), the same gate as transfer.       */
      /* -------------------------------------------------------- */
      case 'task_update': {
        const taskId = str(body.task_id);
        const dueAt = str(body.due_at);
        if (!taskId) return jsonError(400, 'task_id is required');
        if (!dueAt) return jsonError(400, 'due_at is required');
        if (Number.isNaN(new Date(dueAt).getTime())) return jsonError(400, 'due_at must be a date');
        const upd = await sb.from('workflow_role_tasks')
          .update({ due_at: new Date(dueAt).toISOString() })
          .eq('id', taskId).eq('subject_table', 'mos_content').eq('status', 'open')
          .select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'open task not found');
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Round snapshots — the review-comparison trail             */
      /* -------------------------------------------------------- */
      case 'content_versions': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const res = await sb.from('mos_content_versions').select('*')
          .eq('content_id', contentId)
          .order('round', { ascending: true });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ versions: res.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Notifications — the in-app inbox. RLS scopes every read   */
      /* to the caller's own rows; writes happen via notify_emit.  */
      /* -------------------------------------------------------- */
      case 'notifications_list': {
        const unreadOnly = body.unread_only === true;
        // Filters before transforms: .order()/.limit() return the transform
        // builder, which no longer accepts .is().
        const base = sb.from('notifications')
          .select('id, kind, title_ar, title_en, body_ar, body_en, url, read_at, created_at');
        const filtered = unreadOnly ? base.is('read_at', null) : base;
        const [rows, unread] = await Promise.all([
          filtered.order('created_at', { ascending: false }).limit(cap(body.limit, 50, 200)),
          sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
        ]);
        const f = dbFail(rows.error) ?? dbFail(unread.error);
        if (f) return f;
        return jsonOk({ rows: rows.data ?? [], unread: unread.count ?? 0 });
      }

      case 'notifications_read': {
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : [];
        if (ids.length === 0) return jsonError(400, 'ids must be a non-empty array');
        if (ids.length > 500) return jsonError(400, 'at most 500 ids per call');
        // The RPC re-checks ownership definer-side; ids belonging to someone
        // else are no-ops, not leaks.
        const res = await sb.rpc('mark_notifications_read', { p_ids: ids });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The role × event × channel matrix (screen 43)             */
      /* -------------------------------------------------------- */
      case 'notification_rules': {
        const res = await fetchNotificationRuleRows(sb);
        if ('fail' in res) return res.fail;
        return jsonOk({ rules: res.rules });
      }

      case 'notification_rule_set': {
        const roleKey = str(body.role_key);
        const event = str(body.event);
        const channel = str(body.channel);
        const timing = str(body.timing);
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!event) return jsonError(400, 'event is required');
        if (!channel || !['inapp', 'push', 'whatsapp'].includes(channel)) {
          return jsonError(400, 'channel must be inapp, push or whatsapp');
        }
        if (typeof body.enabled !== 'boolean') return jsonError(400, 'enabled must be a boolean');
        if (timing && !['immediate', 'digest'].includes(timing)) {
          return jsonError(400, 'timing must be immediate or digest');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');

        const row: Record<string, unknown> = {
          role_id: (roleRes.data as { id: string }).id,
          event,
          channel,
          enabled: body.enabled,
        };
        if (timing) row.timing = timing;
        const up = await sb.from('notification_rules').upsert(row, { onConflict: 'role_id,event,channel' });
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Per-user delivery prefs — whatsapp on/off, digest hour,   */
      /* quiet hours. Absent row = defaults, so this is an upsert. */
      /* -------------------------------------------------------- */
      case 'notification_prefs_save': {
        const appUserId = await resolveAppUserId(sb, user.userId);
        if (!appUserId) return jsonError(400, 'no app user for this account');

        const hour = (v: unknown, name: string): number | null | Response => {
          if (v === undefined || v === null) return null;
          if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23) return v;
          return jsonError(400, `${name} must be an integer between 0 and 23`);
        };
        const digestHour = hour(body.digest_hour, 'digest_hour');
        if (digestHour instanceof Response) return digestHour;
        const quietFrom = hour(body.quiet_from, 'quiet_from');
        if (quietFrom instanceof Response) return quietFrom;
        const quietTo = hour(body.quiet_to, 'quiet_to');
        if (quietTo instanceof Response) return quietTo;

        const patch: Record<string, unknown> = { user_id: appUserId };
        if (typeof body.whatsapp_enabled === 'boolean') patch.whatsapp_enabled = body.whatsapp_enabled;
        if (digestHour !== null) patch.digest_hour = digestHour;
        if (Object.prototype.hasOwnProperty.call(body, 'quiet_from')) patch.quiet_from = quietFrom;
        if (Object.prototype.hasOwnProperty.call(body, 'quiet_to')) patch.quiet_to = quietTo;

        const up = await sb.from('notification_prefs')
          .upsert(patch, { onConflict: 'user_id' }).select('*').maybeSingle();
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ prefs: up.data });
      }

      /* -------------------------------------------------------- */
      /* «تذكير» (s01/s35) — a manual nudge to whoever holds the   */
      /* item's open task.                                         */
      /* -------------------------------------------------------- */
      case 'remind': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');

        const [taskRes, itemRes] = await Promise.all([
          sb.from('workflow_role_tasks')
            .select('id, role_key, assignee_user_id')
            .eq('subject_table', 'mos_content')
            .eq('subject_id', contentId)
            .eq('status', 'open')
            .maybeSingle(),
          sb.from('mos_content_v').select('id, title').eq('id', contentId).maybeSingle(),
        ]);
        const f = dbFail(taskRes.error) ?? dbFail(itemRes.error);
        if (f) return f;
        const task = taskRes.data as { role_key: string; assignee_user_id: string | null } | null;
        if (!task) {
          return new Response(
            JSON.stringify({
              error: 'This item has no open task.',
              error_ar: 'لا توجد مهمة مفتوحة لهذا العنصر.',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const title = ((itemRes.data as { title?: string } | null)?.title) ?? '';

        await emitNotify(sb, {
          event: 'manual_reminder',
          roles: [task.role_key],
          users: task.assignee_user_id ? [task.assignee_user_id] : [],
          titleAr: 'تذكير بمهمة',
          titleEn: 'Task reminder',
          bodyAr: `تذكير: «${title}» بانتظار خطوتك.`,
          bodyEn: `Reminder: "${title}" is waiting on your step.`,
          url: `/m/content/${contentId}?tab=tasks`,
        });
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Scenes — the shoot list is derived from these             */
      /* -------------------------------------------------------- */
      case 'scene_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.scene ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['position', 'start_sec', 'end_sec', 'visual', 'voiceover',
                         'on_screen_text', 'footage_status', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }

        if (id) {
          const upd = await sb.from('mos_scenes').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'scene not found');
        } else {
          patch.content_id = contentId;
          if (patch.position === undefined) {
            const last = await sb.from('mos_scenes').select('position')
              .eq('content_id', contentId).order('position', { ascending: false }).limit(1).maybeSingle();
            const f = dbFail(last.error);
            if (f) return f;
            patch.position = ((last.data as { position: number } | null)?.position ?? 0) + 1;
          }
          const ins = await sb.from('mos_scenes').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ scenes: list.data ?? [] });
      }

      case 'scene_delete': {
        const id = str(body.id);
        const contentId = str(body.content_id);
        if (!id || !contentId) return jsonError(400, 'id and content_id are required');
        const del = await sb.from('mos_scenes').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ scenes: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Publications — one row per platform                       */
      /* -------------------------------------------------------- */
      case 'publication_list': {
        const contentId = str(body.content_id);
        const [pubs, accounts] = await Promise.all([
          contentId
            ? sb.from('mos_publication_v').select('*').eq('content_id', contentId)
                .order('scheduled_at', { ascending: true, nullsFirst: false })
            : sb.from('mos_publication_v').select('*')
                .order('scheduled_at', { ascending: true, nullsFirst: false })
                .limit(cap(body.limit, 200, 500)),
          sb.from('mos_platform_accounts').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(accounts.error);
        if (f) return f;
        return jsonOk({ publications: pubs.data ?? [], accounts: accounts.data ?? [] });
      }

      case 'publication_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.publication ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'account_id', 'status', 'scheduled_at', 'published_at',
                         'caption', 'external_url', 'external_id', 'note',
                         // The approved material this publication uses. asset_id is
                         // the durable link (mos_assets.id, always present); file_id
                         // is kept for legacy rows that stored an asset's file id.
                         'asset_id', 'file_id'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }

        // Marking published stamps who and when, so "who posted this" is never a
        // guess. The DB also refuses published without a timestamp.
        if (patch.status === 'published') {
          if (!patch.published_at) patch.published_at = new Date().toISOString();
          patch.published_by_user_id = await resolveAppUserId(sb, user.userId);
        }
        // Scheduling emits NOTHING here: «حان وقت النشر» (publish_due) fires at
        // tick time from the worker's mos_notification_sweep, not at save time —
        // a notification on save would arrive hours before anyone can act on it.

        if (id) {
          const upd = await sb.from('mos_publications').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'publication not found');
        } else {
          if (!patch.platform) return jsonError(400, 'platform is required');
          patch.content_id = contentId;
          const ins = await sb.from('mos_publications').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', contentId)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Metric snapshots — append-only, never overwritten         */
      /* -------------------------------------------------------- */
      case 'metrics_record': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');

        const num = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
        const views = num(body.views);
        const engagement = num(body.engagement);
        const enquiries = num(body.enquiries);
        // The engagement breakdown — captured per publication, same posture as
        // the three above (empty box → NULL, never 0).
        const likes = num(body.likes);
        const comments = num(body.comments);
        const saves = num(body.saves);

        // Platform-specific readings (e.g. TikTok watch-time) ride in extra.
        const extra = (body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra))
          ? (body.extra as Record<string, unknown>)
          : {};

        // Mirrors mos_snap_not_empty_check so the user gets a sentence rather
        // than a constraint violation.
        if (views === null && engagement === null && enquiries === null
            && likes === null && comments === null && saves === null
            && Object.keys(extra).length === 0) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number, or skip this publication.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل، أو تخطَّ هذا المنشور.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const ins = await sb.from('mos_metric_snapshots').insert({
          publication_id: publicationId,
          source: 'manual',
          views, engagement, enquiries,
          likes, comments, saves,
          extra,
          entered_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const hf = dbFail(hist.error);
        if (hf) return hf;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* «لا توجد أرقام» — a deliberate skip is a THIRD state,     */
      /* distinct from both missing (nothing entered) and zero.    */
      /* extra {skipped: reason} satisfies the not-empty CHECK.    */
      /* -------------------------------------------------------- */
      case 'metrics_skip': {
        const publicationId = str(body.publication_id);
        const reason = str(body.reason);
        if (!publicationId || !reason) {
          return jsonError(400, 'publication_id and reason are required');
        }
        const ins = await sb.from('mos_metric_snapshots').insert({
          publication_id: publicationId,
          source: 'manual',
          views: null,
          engagement: null,
          enquiries: null,
          extra: { skipped: reason },
          entered_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The Friday entry screen (s50): everything published in    */
      /* the week, grouped by platform, each publication carrying  */
      /* its latest reading and its three-state status.            */
      /* -------------------------------------------------------- */
      case 'numbers_week': {
        const { weekStart, weekEnd } = weekBounds(str(body.week_start));

        const pubs = await sb.from('mos_publication_v').select('*')
          .eq('status', 'published')
          .gte('published_at', weekStart)
          .lt('published_at', weekEnd)
          .order('published_at', { ascending: false })
          .limit(cap(body.limit, 300, 500));
        const f = dbFail(pubs.error);
        if (f) return f;
        const pubRows = (pubs.data ?? []) as unknown as Array<Row & {
          content_id: string; platform: string; published_at: string | null;
        }>;

        const pubIds = pubRows.map((p) => p.id);
        const contentIds = Array.from(new Set(pubRows.map((p) => p.content_id)));
        const [snaps, titles] = await Promise.all([
          pubIds.length > 0
            ? sb.from('mos_metric_snapshots').select('*')
                .in('publication_id', pubIds)
                .order('captured_at', { ascending: false })
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f2 = dbFail(snaps.error) ?? dbFail(titles.error);
        if (f2) return f2;

        // Latest snapshot per publication (the list is captured_at DESC).
        const latestByPub = new Map<string, Record<string, unknown>>();
        for (const s of (snaps.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const pid = s.publication_id as string;
          if (!latestByPub.has(pid)) latestByPub.set(pid, s);
        }
        const titleById = new Map(
          ((titles.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );

        const byPlatform = new Map<string, Array<Record<string, unknown>>>();
        let entered = 0;
        let missingCount = 0;
        for (const p of pubRows) {
          const latest = latestByPub.get(p.id) ?? null;
          const extra = (latest?.extra ?? {}) as Record<string, unknown>;
          const skippedReason = typeof extra.skipped === 'string' ? extra.skipped : null;
          // Missing = nothing was ever entered. A skip is NOT missing — it is
          // a deliberate statement, so it counts toward neither entered nor
          // the remaining-work estimate.
          const missing = latest === null;
          if (missing) missingCount += 1;
          else if (!skippedReason) entered += 1;

          const entry: Record<string, unknown> = {
            publication_id: p.id,
            content_ref: titleById.get(p.content_id)?.ref ?? null,
            title: titleById.get(p.content_id)?.title ?? '',
            latest: latest
              ? {
                  captured_at: latest.captured_at ?? null,
                  source: latest.source ?? null,
                  views: latest.views ?? null,
                  engagement: latest.engagement ?? null,
                  enquiries: latest.enquiries ?? null,
                  likes: latest.likes ?? null,
                  comments: latest.comments ?? null,
                  saves: latest.saves ?? null,
                  extra,
                }
              : null,
            missing,
            skipped_reason: skippedReason,
          };
          const list = byPlatform.get(p.platform) ?? [];
          list.push(entry);
          byPlatform.set(p.platform, list);
        }

        const platforms = Array.from(byPlatform.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([platform, publications]) => ({ platform, publications }));

        return jsonOk({
          platforms,
          progress: {
            entered,
            total: pubRows.length,
            // Two minutes per publication is the team's own estimate for the
            // Friday round — it sizes the «باقي ~٢٠ دقيقة» line.
            estimate_minutes: missingCount * 2,
          },
          week_start: weekStart,
          week_end: weekEnd,
        });
      }

      case 'metrics_history': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');
        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const f = dbFail(hist.error);
        if (f) return f;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Roles — canonical roles 'mos_*' × users.role_assignments  */
      /* -------------------------------------------------------- */
      case 'roles_list': {
        const [rolesRes, usersRes] = await Promise.all([
          sb.from('roles').select('id, key, label_ar, label_en')
            .like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('users').select('id, name_ar, name_en, email, role_assignments, is_active')
            .eq('is_active', true).order('name_en', { ascending: true }).limit(500),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(usersRes.error);
        if (f) return f;

        const roleRows = (rolesRes.data ?? []) as unknown as Array<{
          id: string; key: string; label_ar: string; label_en: string;
        }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const people = ((usersRes.data ?? []) as unknown as Array<{
          id: string;
          name_ar: string | null;
          name_en: string | null;
          email: string | null;
          role_assignments: unknown;
        }>).map((u) => {
          const assignments = Array.isArray(u.role_assignments) ? u.role_assignments : [];
          const held = assignments
            .map((a) => keyById.get(String((a as { role_id?: unknown } | null)?.role_id ?? '')))
            .filter((k): k is string => Boolean(k));
          return { user_id: u.id, name_ar: u.name_ar, name_en: u.name_en, email: u.email, roles: held };
        });
        const roles = roleRows.map((r) => {
          const key = stripMosPrefix(r.key);
          return {
            key,
            role_id: r.id,
            label_ar: r.label_ar,
            label_en: r.label_en,
            holders: people.filter((p) => p.roles.includes(key)).length,
          };
        });
        return jsonOk({ people, roles });
      }

      case 'role_grant': {
        const targetUserId = str(body.user_id);
        const roleKey = str(body.role_key);
        if (!targetUserId || !roleKey) return jsonError(400, 'user_id and role_key are required');
        if (typeof body.grant !== 'boolean') return jsonError(400, 'grant must be a boolean');
        // Atomic + self-authorizing (manage_roles) inside the RPC — a browser
        // read-modify-write of users.role_assignments would be a lost-update race.
        const res = await sb.rpc('mos_role_grant', {
          p_user_id: targetUserId,
          p_role_key: roleKey,
          p_grant: body.grant,
        });
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The surface matrix (screen 33) — full / read / hidden     */
      /* -------------------------------------------------------- */
      case 'surface_matrix': {
        const [rolesRes, cellsRes] = await Promise.all([
          sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('surface_access').select('role_id, surface_key, level'),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(cellsRes.error);
        if (f) return f;
        const roleRows = (rolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((cellsRes.data ?? []) as unknown as Array<{
          role_id: string; surface_key: string; level: string;
        }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', surface_key: c.surface_key, level: c.level }))
          .filter((c) => c.role_key !== '');
        return jsonOk({
          surfaces: [...SURFACES],
          roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
          cells,
        });
      }

      case 'surface_set': {
        const roleKey = str(body.role_key);
        const surfaceKey = str(body.surface_key);
        const level = str(body.level);
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!surfaceKey || !(SURFACES as readonly string[]).includes(surfaceKey)) {
          return jsonError(400, 'unknown surface');
        }
        if (!level || !['full', 'read', 'hidden'].includes(level)) {
          return jsonError(400, 'level must be full, read or hidden');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');
        const up = await sb.from('surface_access').upsert(
          { role_id: (roleRes.data as { id: string }).id, surface_key: surfaceKey, level },
          { onConflict: 'role_id,surface_key' },
        );
        const f = dbFail(up.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Capabilities matrix — what each role can DO (role x cap). */
      /* Twin of surface_matrix; the Roles screen edits both.      */
      /* -------------------------------------------------------- */
      case 'capability_matrix': {
        const [rolesRes, cellsRes] = await Promise.all([
          sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
          sb.from('role_capabilities').select('role_id, capability'),
        ]);
        const f = dbFail(rolesRes.error) ?? dbFail(cellsRes.error);
        if (f) return f;
        const roleRows = (rolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((cellsRes.data ?? []) as unknown as Array<{ role_id: string; capability: string }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', capability: c.capability }))
          .filter((c) => c.role_key !== '');
        return jsonOk({
          capabilities: [...CAPABILITIES],
          roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
          cells,
        });
      }

      case 'capability_set': {
        const roleKey = str(body.role_key);
        const capability = str(body.capability);
        const grant = body.grant === true;
        if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          return jsonError(400, 'unknown role');
        }
        if (!capability || !(CAPABILITIES as readonly string[]).includes(capability)) {
          return jsonError(400, 'unknown capability');
        }
        const roleRes = await sb.from('roles').select('id').eq('key', `mos_${roleKey}`).maybeSingle();
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        if (!roleRes.data) return jsonError(400, 'unknown role');
        const roleId = (roleRes.data as { id: string }).id;
        // Presence IS the grant — insert to grant, delete to revoke. RLS
        // (role_capabilities_ins / _del) enforces 'manage_roles' on the caller.
        const res = grant
          ? await sb.from('role_capabilities')
              .upsert({ role_id: roleId, capability }, { onConflict: 'role_id,capability' })
          : await sb.from('role_capabilities')
              .delete().eq('role_id', roleId).eq('capability', capability);
        const f = dbFail(res.error);
        if (f) return f;
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* Overview — four numbers and the two lists that need a     */
      /* decision today. Counts are COUNTS, not a fetched page     */
      /* trimmed client-side, so they stay true past 1,000 rows.   */
      /* -------------------------------------------------------- */
      case 'overview': {
        const nowIso = new Date().toISOString();
        // Screen 01's segmented control: هذا الأسبوع / الشهر / الربع. The
        // response shape is unchanged — week_start/week_end carry the bounds
        // of whichever period was asked for.
        const periodRaw = str(body.period);
        const period = periodRaw === 'month' || periodRaw === 'quarter' ? periodRaw : 'week';
        const { weekStart, weekEnd } = periodBounds(period, str(body.week_of));
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        const live = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")');
        const mine = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).eq('owner_role', myRole);
        const late = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")')
          .lt('current_task_due_at', nowIso);

        const [liveRes, mineRes, lateRes, stalled, week, spend, byType, mineOldest, lateRows] = await Promise.all([
          live,
          mine,
          late,
          // Oldest-touched open work first — the bottleneck, by definition.
          // «متوقف — لم يتحرك منذ ٤٨ ساعة»: only items untouched for 48h count
          // as stalled. Without this every in-production item showed, including
          // ones that moved today. nowIso is the frozen epoch on the capture
          // server and real now in prod — correct in both.
          sb.from('mos_content_v')
            .select('id, ref, title, status_key, current_step_label_ar, current_step_label_en, owner_role, current_task_due_at, updated_at, content_type_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .lt('updated_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
            .order('updated_at', { ascending: true }).limit(8),
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at')
            .gte('scheduled_at', weekStart).lt('scheduled_at', weekEnd)
            .order('scheduled_at', { ascending: true }).limit(60),
          sb.from('mos_campaign_v')
            .select('id, ref, name, status, budget_total, total_spend, total_leads, total_qualified')
            .in('status', ['active', 'planning']).limit(20),
          sb.from('mos_content_v').select('content_type_key, status_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")').limit(1000),
          // «أقدمها منتظر منذ …» — the oldest item sitting with my role.
          sb.from('mos_content_v').select('updated_at')
            .is('archived_at', null).eq('owner_role', myRole)
            .order('updated_at', { ascending: true }).limit(1),
          // The late stat's breakdown («٢ في التصميم · ٢ بانتظار المراجعة»).
          sb.from('mos_content_v').select('current_step_label_ar, current_step_label_en')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .lt('current_task_due_at', nowIso).limit(200),
        ]);

        const f = dbFail(liveRes.error) ?? dbFail(mineRes.error) ?? dbFail(lateRes.error)
          ?? dbFail(stalled.error) ?? dbFail(week.error) ?? dbFail(spend.error) ?? dbFail(byType.error)
          ?? dbFail(mineOldest.error) ?? dbFail(lateRows.error);
        if (f) return f;

        // Titles for the week card rows — one extra query beats N.
        const weekContentIds = Array.from(new Set(
          (week.data ?? []).map((p) => (p as unknown as Row).content_id as string),
        ));
        let weekTitles = new Map<string, { ref: string | null; title: string }>();
        if (weekContentIds.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title').in('id', weekContentIds);
          const tf = dbFail(t.error);
          if (tf) return tf;
          weekTitles = new Map((t.data ?? []).map((r): [string, { ref: string | null; title: string }] => {
            const row = r as unknown as { id: string; ref: string | null; title: string };
            return [row.id, { ref: row.ref, title: row.title }];
          }));
        }
        const weekRows = (week.data ?? []).map((p) => {
          const row = p as unknown as Row;
          const t = weekTitles.get(row.content_id as string);
          return { ...row, ref: t?.ref ?? null, title: t?.title ?? null };
        });

        // «بحاجة لموعد نشر» — aimed at this period but nothing scheduled yet.
        const unscheduledRes = await sb.from('mos_content_v')
          .select('id, ref, title, target_publish_at')
          .is('archived_at', null).not('status_key', 'in', '("draft","done")')
          .gte('target_publish_at', weekStart).lt('target_publish_at', weekEnd)
          .order('target_publish_at', { ascending: true }).limit(20);
        const uf = dbFail(unscheduledRes.error);
        if (uf) return uf;
        const unscheduled = (unscheduledRes.data ?? []).filter((r) =>
          !weekContentIds.includes((r as unknown as Row).id as string));

        // Aggregate the late rows by stage label for the stat's detail line.
        const mixMap = new Map<string, { label_ar: string; label_en: string; n: number }>();
        for (const r of lateRows.data ?? []) {
          const row = r as unknown as { current_step_label_ar: string | null; current_step_label_en: string | null };
          const key = row.current_step_label_ar ?? row.current_step_label_en ?? '';
          if (!key) continue;
          const cur = mixMap.get(key);
          if (cur) cur.n += 1;
          else mixMap.set(key, {
            label_ar: row.current_step_label_ar ?? key,
            label_en: row.current_step_label_en ?? key,
            n: 1,
          });
        }
        const lateMix = Array.from(mixMap.values()).sort((a, b) => b.n - a.n).slice(0, 3);

        return jsonOk({
          role: myRole,
          period,
          counts: {
            in_production: liveRes.count ?? 0,
            waiting_on_me: mineRes.count ?? 0,
            publishing_this_week: weekRows.length + unscheduled.length,
            late: lateRes.count ?? 0,
          },
          stalled: stalled.data ?? [],
          week: weekRows,
          unscheduled,
          campaigns: spend.data ?? [],
          mix: byType.data ?? [],
          waiting_oldest_at: (mineOldest.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null,
          late_mix: lateMix,
          week_start: weekStart,
          week_end: weekEnd,
        });
      }

      /* -------------------------------------------------------- */
      /* My work / Team work — the task queue, by role             */
      /* -------------------------------------------------------- */
      case 'work_list': {
        const scope = str(body.scope) === 'team' ? 'team' : 'mine';
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        let q = sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS)
          .is('archived_at', null)
          .not('status_key', 'in', '("draft","done")');
        // 'mine' filters to the role the open task sits with. An administrator
        // has no queue of their own, so they see the team board instead of an
        // empty screen that would read as "nothing to do".
        if (scope === 'mine' && myRole !== 'administrator') q = q.eq('owner_role', myRole);

        const rows = await q.order('current_task_due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 300, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // The item's own open task carries the step key we need to name the action.
        const ids = (rows.data ?? []).map((r) => (r as unknown as Row).id);
        let tasks: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('workflow_role_tasks').select('*')
            .eq('subject_table', 'mos_content')
            .in('subject_id', ids)
            .eq('status', 'open');
          const tf = dbFail(t.error);
          if (tf) return tf;
          tasks = (t.data ?? []).map((row) => mapRoleTask(row as Record<string, unknown>));
        }

        // Pinned-version steps for the listed tasks — one read drives both the
        // approval split on screen 35 (is_approval / approval_kind per task)
        // and screen 02's «القادم إليك» band below.
        const stepMeta = await loadPinnedStepMeta(sb, ids);
        if ('fail' in stepMeta) return stepMeta.fail;
        tasks = (tasks as Array<Record<string, unknown>>).map((t) => {
          const meta = stepMeta.bySubject.get(t.content_id as string);
          const step = meta?.steps.find((s) => s.key === t.step_id);
          return {
            ...t,
            is_approval: step?.is_approval ?? false,
            approval_kind: step?.approval_kind ?? null,
          };
        });

        // «القادم إليك» (s02) — NOT tasks: in-flight items whose pinned path
        // reaches my role at a FUTURE step, so I can prepare without my queue
        // filling with work I cannot start yet.
        let upcoming: unknown[] = [];
        if (scope === 'mine' && (MOS_ROLE_KEYS as readonly string[]).includes(myRole)) {
          const cand = await sb.from('mos_content_v')
            .select('id, ref, title')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .neq('owner_role', myRole).limit(200);
          const cf = dbFail(cand.error);
          if (cf) return cf;
          const candIds = (cand.data ?? []).map((r) => (r as unknown as Row).id as string);
          if (candIds.length > 0) {
            const meta = await loadPinnedStepMeta(sb, candIds);
            if ('fail' in meta) return meta.fail;
            const titleBy = new Map((cand.data ?? []).map(
              (r): [string, { id: string; ref: string | null; title: string }] => {
                const row = r as unknown as { id: string; ref: string | null; title: string };
                return [row.id, row];
              },
            ));
            for (const [subjectId, m] of meta.bySubject) {
              if (!m.currentStepKey) continue;
              const idx = m.steps.findIndex((s) => s.key === m.currentStepKey);
              if (idx < 0) continue;
              for (let j = idx + 1; j < m.steps.length; j += 1) {
                const s = m.steps[j];
                if (!s || s.role_key !== myRole) continue;
                const c = titleBy.get(subjectId);
                if (!c) break;
                upcoming.push({
                  content_id: subjectId,
                  ref: c.ref,
                  title: c.title,
                  step_key: s.key,
                  step_label_ar: s.label_ar,
                  step_label_en: s.label_en,
                  steps_away: j - idx,
                });
                break;
              }
            }
            upcoming = (upcoming as Array<{ steps_away: number }>)
              .sort((a, b) => a.steps_away - b.steps_away).slice(0, 12);
          }
        }
        return jsonOk({ role: myRole, content: rows.data ?? [], tasks, upcoming });
      }

      /* -------------------------------------------------------- */
      /* Calendar — what is scheduled, and what is merely due       */
      /* -------------------------------------------------------- */
      case 'calendar': {
        const from = str(body.from);
        const to = str(body.to);
        if (!from || !to) return jsonError(400, 'from and to are required');

        const [pubs, due] = await Promise.all([
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at, caption')
            .or(`and(scheduled_at.gte.${from},scheduled_at.lte.${to}),and(published_at.gte.${from},published_at.lte.${to})`)
            .limit(500),
          // Content rows for the dotted chips: a task due date OR a target
          // publish date landing in the window. Fetched together so one query
          // feeds both the «استحقاق» and «مستهدف» chips the client derives.
          sb.from('mos_content_v')
            .select('id, ref, title, content_type_key, status_key, due_at, target_publish_at, owner_role')
            .is('archived_at', null)
            .or(`and(due_at.gte.${from},due_at.lte.${to}),and(target_publish_at.gte.${from},target_publish_at.lte.${to})`)
            .limit(500),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(due.error);
        if (f) return f;

        // Titles for the publication chips — one extra query beats N.
        const ids = Array.from(new Set((pubs.data ?? []).map((p) => (p as unknown as Row).content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: pubs.data ?? [], due: due.data ?? [], titles });
      }

      /* -------------------------------------------------------- */
      /* Campaigns — the spend side                                */
      /* -------------------------------------------------------- */
      case 'campaign_list': {
        const rows = await sb.from('mos_campaign_v').select('*')
          .is('archived_at', null)
          .order('starts_on', { ascending: false, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;
        // Attach each campaign's linked goal ids in one extra read (the junction
        // carries only two ids, so a full scan grouped in JS is cheaper than an
        // N+1 or a view rebuild). A campaign with no links gets an empty array.
        const links = await sb.from('mos_campaign_goals').select('campaign_id, goal_id');
        const lf = dbFail(links.error);
        if (lf) return lf;
        const byCampaign = new Map<string, string[]>();
        for (const l of (links.data ?? []) as Array<{ campaign_id: string; goal_id: string }>) {
          const arr = byCampaign.get(l.campaign_id) ?? [];
          arr.push(l.goal_id);
          byCampaign.set(l.campaign_id, arr);
        }
        // Platform sub-lines (design screen 14). Paid campaigns name their
        // executions' ad platforms; organic ones (or paid not launched yet) name
        // the feeds their attributed content publishes to. Computed HERE in three
        // bounded, campaign-scoped reads — the list used to resolve these on the
        // client with one full `campaign_detail` per row plus a `publication_list`,
        // an N+1 that saturated the browser's connection limit and the DB and
        // froze the whole workspace on mobile (the "entering Campaigns hangs" bug).
        const listRows = (rows.data ?? []) as Array<{ id: string; kind?: string }>;
        const ids = listRows.map((c) => c.id);
        const platformsByCampaign = new Map<string, Set<string>>();
        if (ids.length > 0) {
          const [execRows, contentRows] = await Promise.all([
            sb.from('mos_campaign_executions').select('campaign_id, platform').in('campaign_id', ids),
            sb.from('mos_content_v').select('id, campaign_id').in('campaign_id', ids).is('archived_at', null),
          ]);
          const ef = dbFail(execRows.error) ?? dbFail(contentRows.error);
          if (ef) return ef;
          const execByCampaign = new Map<string, Set<string>>();
          for (const r of (execRows.data ?? []) as Array<{ campaign_id: string; platform: string | null }>) {
            if (!r.platform) continue;
            const s = execByCampaign.get(r.campaign_id) ?? new Set<string>();
            s.add(r.platform);
            execByCampaign.set(r.campaign_id, s);
          }
          const campaignByContent = new Map<string, string>();
          const contentIds: string[] = [];
          for (const r of (contentRows.data ?? []) as Array<{ id: string; campaign_id: string | null }>) {
            if (!r.campaign_id) continue;
            campaignByContent.set(r.id, r.campaign_id);
            contentIds.push(r.id);
          }
          const pubByCampaign = new Map<string, Set<string>>();
          if (contentIds.length > 0) {
            const pubRows = await sb.from('mos_publications')
              .select('content_id, platform, status').in('content_id', contentIds);
            const pf = dbFail(pubRows.error);
            if (pf) return pf;
            for (const p of (pubRows.data ?? []) as Array<{ content_id: string; platform: string | null; status: string | null }>) {
              if (!p.platform || p.status === 'cancelled') continue;
              const cid = campaignByContent.get(p.content_id);
              if (!cid) continue;
              const s = pubByCampaign.get(cid) ?? new Set<string>();
              s.add(p.platform);
              pubByCampaign.set(cid, s);
            }
          }
          for (const c of listRows) {
            // Paid: executions' ad platforms. Empty (organic, or a paid campaign
            // with no executions yet) falls back to the attributed content's feeds.
            const execSet = c.kind === 'paid' ? execByCampaign.get(c.id) : undefined;
            const set = execSet && execSet.size > 0 ? execSet : (pubByCampaign.get(c.id) ?? new Set<string>());
            platformsByCampaign.set(c.id, set);
          }
        }
        const campaigns = listRows.map((c) => ({
          ...c,
          goal_ids: byCampaign.get(c.id) ?? [],
          platforms: Array.from(platformsByCampaign.get(c.id) ?? []),
        }));
        return jsonOk({ campaigns });
      }

      case 'campaign_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const [item, execs, content, comments, events, goalLinks] = await Promise.all([
          // Merged read: the view's aggregates + the base row's brief and
          // signature columns (see readCampaignMerged).
          readCampaignMerged(sb, id),
          sb.from('mos_campaign_executions').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).eq('campaign_id', id)
            .is('archived_at', null).limit(300),
          sb.from('mos_comments').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }).limit(200),
          sb.from('mos_campaign_events').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: false }).limit(200),
          // The goals this campaign serves, joined to their record for names.
          sb.from('mos_campaign_goals').select('goal_id, mos_goals(*)')
            .eq('campaign_id', id),
        ]);
        const f = dbFail(item.error) ?? dbFail(execs.error)
          ?? dbFail(content.error) ?? dbFail(comments.error) ?? dbFail(events.error)
          ?? dbFail(goalLinks.error);
        if (f) return f;
        if (!item.row) return jsonError(404, 'campaign not found');
        const goals = ((goalLinks.data ?? []) as Array<{ goal_id: string; mos_goals: unknown }>)
          .map((l) => l.mos_goals)
          .filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object');
        const goalIds = ((goalLinks.data ?? []) as Array<{ goal_id: string }>).map((l) => l.goal_id);
        return jsonOk({
          item: { ...(item.row as Record<string, unknown>), goal_ids: goalIds },
          executions: execs.data ?? [],
          content: content.data ?? [],
          comments: comments.data ?? [],
          events: events.data ?? [],
          goals,
        });
      }

      case 'campaign_save': {
        const raw = (body.campaign ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        // Goals are a MANY-TO-MANY link, not a column — pulled out of the patch
        // and synced into mos_campaign_goals after the row is written. `undefined`
        // (key absent) means "leave the links untouched"; an array (even empty on
        // an existing campaign) replaces them.
        const goalIdsProvided = Object.prototype.hasOwnProperty.call(raw, 'goal_ids');
        const goalIds = goalIdsProvided && Array.isArray(raw.goal_ids)
          ? Array.from(new Set((raw.goal_ids as unknown[])
              .filter((v): v is string => typeof v === 'string' && v.length > 0)))
          : [];
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'project_id', 'project_ids', 'objective', 'status', 'starts_on',
                         'ends_on', 'budget_total', 'note',
                         'kind', 'goal', 'owner_role', 'success_metric',
                         'success_threshold',
                         // The brief (screen 19): who it's for, what it offers,
                         // where it lands, how it's measured.
                         'audience', 'audience_id', 'offer', 'destination_url', 'measured_by'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // Multi-project: normalize the array and re-derive the primary project_id.
        applyProjectIds(patch);

        // Audience: when a saved record is chosen, SNAPSHOT its name into the
        // `audience` text column so every join-free reader (the brief read grid,
        // search's `audience` match, list/overview) keeps rendering a concise
        // label — the same posture as success_measures. Clearing the link
        // (audience_id = null) leaves whatever free text the client sent.
        if (Object.prototype.hasOwnProperty.call(patch, 'audience_id')) {
          const audienceId = str(patch.audience_id);
          patch.audience_id = audienceId; // normalize '' → null
          if (audienceId) {
            const aud = await sb.from('mos_audiences').select('name').eq('id', audienceId).maybeSingle();
            const af = dbFail(aud.error);
            if (af) return af;
            if (!aud.data) return jsonError(400, 'audience not found');
            patch.audience = (aud.data as { name: string }).name;
          }
        }

        // Multi-measure success criteria: sanitize the array to the known shape
        // and derive the back-compat primary (success_metric / success_threshold
        // = the first measure) so the list / overview / judgment reads that still
        // consult the scalar pair keep working unchanged.
        if (Object.prototype.hasOwnProperty.call(raw, 'success_measures') && Array.isArray(raw.success_measures)) {
          const clean = (raw.success_measures as unknown[])
            .map((e) => {
              const o = (e ?? {}) as Record<string, unknown>;
              return {
                type_key: str(o.type_key) ?? '',
                label_ar: str(o.label_ar) ?? '',
                label_en: str(o.label_en) ?? '',
                direction: o.direction === 'lower' ? 'lower' : 'higher',
                unit: o.unit === 'currency' ? 'currency' : o.unit === 'percent' ? 'percent' : 'count',
                source: MEASURE_SOURCES.includes(str(o.source) ?? '') ? (str(o.source) as string) : 'none',
                threshold: numOrNull(o.threshold),
              };
            })
            .filter((m) => m.type_key !== '');
          patch.success_measures = clean;
          patch.success_metric = clean[0]?.type_key ?? null;
          patch.success_threshold = clean[0]?.threshold ?? null;
        }

        // The signature requirement is DATA (mos_settings.signature_threshold),
        // recomputed on every save so a budget edit can raise — or clear — it.
        const threshold = await readSignatureThreshold(sb);
        const budgetOf = (v: unknown): number | null => numOrNull(v);
        const appUserId = await resolveAppUserId(sb, user.userId);

        if (id) {
          // Read the row first: the requires_signature flip detection (and the
          // budget fallback when this save doesn't carry one) both need it.
          const prev = await sb.from('mos_campaigns')
            .select('id, budget_total, requires_signature').eq('id', id).maybeSingle();
          const prevFail = dbFail(prev.error);
          if (prevFail) return prevFail;
          if (!prev.data) return jsonError(404, 'campaign not found');
          const prevRow = prev.data as { budget_total: unknown; requires_signature: boolean };

          const effectiveBudget = Object.prototype.hasOwnProperty.call(patch, 'budget_total')
            ? budgetOf(patch.budget_total)
            : budgetOf(prevRow.budget_total);
          const requires = effectiveBudget !== null && effectiveBudget >= threshold;
          patch.requires_signature = requires;

          const upd = await sb.from('mos_campaigns').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'campaign not found');

          // The CEO's «ميزانية تنتظر توقيعك» card fires on the false→true flip.
          if (!prevRow.requires_signature && requires) {
            await emitNotify(sb, {
              event: 'budget_signature',
              roles: ['ceo'],
              titleAr: 'ميزانية تنتظر توقيعك',
              titleEn: 'A budget awaits your signature',
              bodyAr: `حملة تجاوزت ميزانيتها حد التوقيع (${threshold} ر.س).`,
              bodyEn: `A campaign budget crossed the signature threshold (${threshold} SAR).`,
              url: `/m/campaigns/${id}`,
            });
          }

          // Sync the campaign↔goal links when the client sent them (an edit that
          // doesn't touch goals omits the key and leaves the links alone). An
          // explicit EMPTY array is refused — a campaign must keep ≥1 goal.
          if (goalIdsProvided) {
            if (goalIds.length === 0) return jsonError(400, 'at least one goal is required');
            const sf = await syncCampaignGoals(sb, id, goalIds);
            if (sf) return sf;
          }
          const finalGoals = await readCampaignGoalIds(sb, id);
          if (finalGoals.error) return finalGoals.error;

          const merged = await readCampaignMerged(sb, id);
          const mergedFail = dbFail(merged.error);
          if (mergedFail) return mergedFail;
          return jsonOk({ item: { ...(merged.row as Record<string, unknown>), goal_ids: finalGoals.ids } });
        }

        // Every campaign must serve at least one goal (the design rule: a
        // campaign is created in service of a goal). The UI enforces this too;
        // this is the server-side guarantee.
        if (goalIds.length === 0) {
          return jsonError(400, 'at least one goal is required');
        }

        // The design has no name field — the goal sentence IS the identity.
        // The list still wants a short handle, so the name falls back to it.
        if (!str(patch.name) && str(patch.goal)) patch.name = patch.goal;
        if (!str(patch.name)) return jsonError(400, 'goal or name is required');
        const newBudget = budgetOf(patch.budget_total);
        const requires = newBudget !== null && newBudget >= threshold;
        patch.requires_signature = requires;
        patch.created_by_user_id = appUserId;
        const ins = await sb.from('mos_campaigns').insert(patch).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        const created = ins.data as unknown as Row | null;

        // Link the new campaign to its goals (required, validated above).
        if (created?.id) {
          const sf = await syncCampaignGoals(sb, created.id, goalIds);
          if (sf) return sf;
        }

        // "التنفيذات التي ستُنشأ" — the modal's promise, kept server-side in
        // the same request: one DRAFT execution per chosen platform with its
        // budget share. Drafts spend nothing until someone launches them on
        // the platform itself.
        const execs = Array.isArray(body.executions) ? (body.executions as unknown[]) : [];
        if (created?.id && execs.length > 0) {
          const rows = execs
            .map((e) => e as Record<string, unknown>)
            .filter((e) => typeof e.platform === 'string' && e.platform !== '')
            .map((e) => ({
              campaign_id: created.id,
              platform: e.platform,
              label: typeof e.label === 'string' ? e.label : null,
              budget: typeof e.budget === 'number' && Number.isFinite(e.budget) ? e.budget : null,
              status: 'draft',
            }));
          if (rows.length > 0) {
            const execIns = await sb.from('mos_campaign_executions').insert(rows);
            const ef = dbFail(execIns.error);
            if (ef) return ef;
          }
        }

        // A brand-new campaign already over threshold is the false→true flip
        // from the CEO's perspective — they had nothing to sign before.
        if (created?.id && requires) {
          await emitNotify(sb, {
            event: 'budget_signature',
            roles: ['ceo'],
            titleAr: 'ميزانية تنتظر توقيعك',
            titleEn: 'A budget awaits your signature',
            bodyAr: `حملة جديدة تجاوزت ميزانيتها حد التوقيع (${threshold} ر.س).`,
            bodyEn: `A new campaign budget crossed the signature threshold (${threshold} SAR).`,
            url: `/m/campaigns/${created.id}`,
          });
        }

        const merged = await readCampaignMerged(sb, created?.id ?? '');
        const mergedFail = dbFail(merged.error);
        if (mergedFail) return mergedFail;
        return jsonOk({ item: { ...(merged.row as Record<string, unknown>), goal_ids: goalIds } });
      }

      case 'goals_list': {
        const [list, links] = await Promise.all([
          sb.from('mos_goals').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_campaign_goals').select('goal_id'),
        ]);
        const f = dbFail(list.error) ?? dbFail(links.error);
        if (f) return f;
        // Attach a linked-campaign count per goal so the Goals list can show
        // «٣ حملات» without a second round trip.
        const counts = new Map<string, number>();
        for (const l of (links.data ?? []) as Array<{ goal_id: string }>) {
          counts.set(l.goal_id, (counts.get(l.goal_id) ?? 0) + 1);
        }
        const goals = ((list.data ?? []) as Array<{ id: string }>).map((g) => ({
          ...g,
          campaign_count: counts.get(g.id) ?? 0,
        }));
        return jsonOk({ goals });
      }

      case 'goal_save': {
        const raw = (body.goal ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'description', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `name` is the identity shown everywhere — never let it be blanked.
        if (Object.prototype.hasOwnProperty.call(patch, 'name') && !str(patch.name)) {
          return jsonError(400, 'name is required');
        }
        // Multi-measure success criteria — the SAME sanitize as campaign_save
        // (goals have no back-compat scalar pair to derive, so it ends here).
        if (Object.prototype.hasOwnProperty.call(raw, 'success_measures') && Array.isArray(raw.success_measures)) {
          patch.success_measures = (raw.success_measures as unknown[])
            .map((e) => {
              const o = (e ?? {}) as Record<string, unknown>;
              return {
                type_key: str(o.type_key) ?? '',
                label_ar: str(o.label_ar) ?? '',
                label_en: str(o.label_en) ?? '',
                direction: o.direction === 'lower' ? 'lower' : 'higher',
                unit: o.unit === 'currency' ? 'currency' : o.unit === 'percent' ? 'percent' : 'count',
                source: MEASURE_SOURCES.includes(str(o.source) ?? '') ? (str(o.source) as string) : 'none',
                threshold: numOrNull(o.threshold),
              };
            })
            .filter((m) => m.type_key !== '');
        }
        if (id) {
          patch.updated_at = new Date().toISOString();
          const upd = await sb.from('mos_goals').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'goal not found');
        } else {
          if (!str(patch.name)) return jsonError(400, 'name is required');
          patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_goals').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const [list, links] = await Promise.all([
          sb.from('mos_goals').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
          sb.from('mos_campaign_goals').select('goal_id'),
        ]);
        const lf = dbFail(list.error) ?? dbFail(links.error);
        if (lf) return lf;
        const counts = new Map<string, number>();
        for (const l of (links.data ?? []) as Array<{ goal_id: string }>) {
          counts.set(l.goal_id, (counts.get(l.goal_id) ?? 0) + 1);
        }
        const goals = ((list.data ?? []) as Array<{ id: string }>).map((g) => ({
          ...g,
          campaign_count: counts.get(g.id) ?? 0,
        }));
        return jsonOk({ goals });
      }

      case 'execution_save': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');
        const raw = (body.execution ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'platform', 'account_id', 'label', 'status',
                         'starts_on', 'ends_on', 'budget', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note',
                         'targeting', 'lead_form_fields',
                         // The platform's own campaign id + what the ad set is
                         // FOR (conversion / awareness / retargeting / traffic).
                         'platform_campaign_id', 'purpose'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'purpose') && patch.purpose !== null
            && !['conversion', 'awareness', 'retargeting', 'traffic'].includes(String(patch.purpose))) {
          return new Response(
            JSON.stringify({
              error: 'Execution purpose must be conversion, awareness, retargeting or traffic.',
              error_ar: 'غرض التنفيذ يجب أن يكون تحويلًا أو وعيًا أو إعادة استهداف أو زيارات.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const appUserId = await resolveAppUserId(sb, user.userId);

        if (id) {
          // The previous status decides which ledger line this save writes.
          const prev = await sb.from('mos_campaign_executions')
            .select('id, status, label, platform').eq('id', id).maybeSingle();
          const prevFail = dbFail(prev.error);
          if (prevFail) return prevFail;
          if (!prev.data) return jsonError(404, 'execution not found');
          const prevRow = prev.data as { status: string; label: string | null; platform: string };

          const upd = await sb.from('mos_campaign_executions').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'execution not found');

          // «ما الذي تغيّر» — pause/resume is a decision someone made, not a
          // number that drifted, so it belongs in the campaign's event ledger.
          const nextStatus = typeof patch.status === 'string' ? patch.status : null;
          if (nextStatus && nextStatus !== prevRow.status) {
            const label = prevRow.label ?? prevRow.platform;
            if (nextStatus === 'paused') {
              await logCampaignEvent(sb, {
                campaignId,
                kind: 'execution_paused',
                summaryAr: `أُوقف التنفيذ «${label}».`,
                summaryEn: `Execution "${label}" paused.`,
                detail: { execution_id: id },
                actorUserId: appUserId,
              });
            } else if (nextStatus === 'running' && prevRow.status === 'paused') {
              await logCampaignEvent(sb, {
                campaignId,
                kind: 'execution_resumed',
                summaryAr: `استُؤنف التنفيذ «${label}».`,
                summaryEn: `Execution "${label}" resumed.`,
                detail: { execution_id: id },
                actorUserId: appUserId,
              });
            }
          }
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          patch.campaign_id = campaignId;
          const ins = await sb.from('mos_campaign_executions').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          const createdId = (ins.data as unknown as Row | null)?.id ?? null;
          if (createdId) {
            const label = str(patch.label) ?? String(patch.platform);
            await logCampaignEvent(sb, {
              campaignId,
              kind: 'execution_added',
              summaryAr: `أُضيف تنفيذ جديد: «${label}».`,
              summaryEn: `Execution added: "${label}".`,
              detail: { execution_id: createdId },
              actorUserId: appUserId,
            });
          }
        }
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Execution detail — the bottom layer, where each AD is a   */
      /* content reference + targeting + a result (screen 21)      */
      /* -------------------------------------------------------- */
      case 'execution_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const exec = await sb.from('mos_campaign_executions').select('*').eq('id', id).maybeSingle();
        const execFail = dbFail(exec.error);
        if (execFail) return execFail;
        if (!exec.data) return jsonError(404, 'execution not found');
        const row = exec.data as unknown as Row;

        const [campaign, ads, daily] = await Promise.all([
          sb.from('mos_campaign_v').select('*').eq('id', row.campaign_id as string).maybeSingle(),
          sb.from('mos_execution_ads').select('*').eq('execution_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_execution_daily').select('*').eq('execution_id', id)
            .order('day', { ascending: false }).limit(90),
        ]);
        const f = dbFail(campaign.error) ?? dbFail(ads.error) ?? dbFail(daily.error);
        if (f) return f;

        // Each ad points at a content record — fetch the referenced rows so the
        // UI can show titles, types, project (for the wrong-project warning) and
        // the workflow state (for the "waiting on approval" note).
        const contentIds = Array.from(new Set(
          (ads.data ?? [])
            .map((a) => (a as unknown as Row).content_id as string | null)
            .filter((c): c is string => Boolean(c)),
        ));
        let adContent: unknown[] = [];
        if (contentIds.length > 0) {
          const c = await sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).in('id', contentIds);
          const cf = dbFail(c.error);
          if (cf) return cf;
          adContent = c.data ?? [];
        }

        return jsonOk({
          execution: exec.data,
          campaign: campaign.data,
          ads: ads.data ?? [],
          ad_content: adContent,
          daily: daily.data ?? [],
        });
      }

      case 'ad_save': {
        const executionId = str(body.execution_id);
        if (!executionId) return jsonError(400, 'execution_id is required');
        const raw = (body.ad ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'label', 'status', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_execution_ads').update(patch).eq('id', id).select('id').maybeSingle();
          const uf = dbFail(upd.error);
          if (uf) return uf;
          if (!upd.data) return jsonError(404, 'ad not found');
        } else {
          patch.execution_id = executionId;
          const ins = await sb.from('mos_execution_ads').insert(patch).select('id').maybeSingle();
          const inf = dbFail(ins.error);
          if (inf) return inf;
        }
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      case 'ad_delete': {
        const id = str(body.id);
        const executionId = str(body.execution_id);
        if (!id || !executionId) return jsonError(400, 'id and execution_id are required');
        const del = await sb.from('mos_execution_ads').delete().eq('id', id);
        const df = dbFail(del.error);
        if (df) return df;
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      case 'daily_save': {
        const executionId = str(body.execution_id);
        const day = str(body.day);
        if (!executionId || !day) return jsonError(400, 'execution_id and day are required');
        const numOrNull = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        const spend = numOrNull(body.spend);
        const leads = numOrNull(body.leads);
        const qualified = numOrNull(body.qualified);
        // Mirrors mos_exec_daily_not_empty so the user gets a sentence.
        if (spend === null && leads === null && qualified === null) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number for the day.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل لليوم.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const up = await sb.from('mos_execution_daily').upsert(
          {
            execution_id: executionId,
            day,
            spend,
            leads,
            qualified,
            entered_by_user_id: await resolveAppUserId(sb, user.userId),
          },
          { onConflict: 'execution_id,day' },
        );
        const uf = dbFail(up.error);
        if (uf) return uf;
        const list = await sb.from('mos_execution_daily').select('*')
          .eq('execution_id', executionId).order('day', { ascending: false }).limit(90);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ daily: list.data ?? [] });
      }

      case 'execution_delete': {
        const id = str(body.id);
        const campaignId = str(body.campaign_id);
        if (!id || !campaignId) return jsonError(400, 'id and campaign_id are required');
        const del = await sb.from('mos_campaign_executions').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* The «ما الذي تغيّر» ledger — append-only                 */
      /* -------------------------------------------------------- */
      case 'campaign_events': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');
        const rows = await sb.from('mos_campaign_events').select('*')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ events: rows.data ?? [] });
      }

      case 'campaign_event_add': {
        const campaignId = str(body.campaign_id);
        const kind = str(body.kind);
        const summaryAr = str(body.summary_ar);
        if (!campaignId || !kind || !summaryAr) {
          return jsonError(400, 'campaign_id, kind and summary_ar are required');
        }
        // Mirrors mos_campaign_events_kind_check so the user gets a sentence.
        if (!['budget_shift', 'execution_added', 'execution_paused', 'execution_resumed',
              'content_linked', 'content_unlinked', 'signed', 'note'].includes(kind)) {
          return new Response(
            JSON.stringify({
              error: 'That campaign event kind does not exist.',
              error_ar: 'نوع حدث الحملة غير موجود.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const detail = (body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail))
          ? (body.detail as Record<string, unknown>)
          : {};
        const ins = await sb.from('mos_campaign_events').insert({
          campaign_id: campaignId,
          kind,
          summary_ar: summaryAr,
          summary_en: str(body.summary_en),
          detail,
          actor_user_id: await resolveAppUserId(sb, user.userId),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ event: ins.data });
      }

      /* -------------------------------------------------------- */
      /* What did this campaign actually produce? The derivation   */
      /* lives in SQL (mos_campaign_outcomes) over the attribution */
      /* ledger; this action also returns the settings it used.    */
      /* -------------------------------------------------------- */
      case 'campaign_outcomes': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');

        const exists = await sb.from('mos_campaigns').select('id').eq('id', campaignId).maybeSingle();
        const existsFail = dbFail(exists.error);
        if (existsFail) return existsFail;
        if (!exists.data) return jsonError(404, 'campaign not found');

        const [outcomes, attrSettings] = await Promise.all([
          sb.rpc('mos_campaign_outcomes', { p_campaign_id: campaignId }),
          sb.from('mos_settings').select('value').eq('key', 'attribution').maybeSingle(),
        ]);
        const f = dbFail(outcomes.error) ?? dbFail(attrSettings.error);
        if (f) return f;
        return jsonOk({
          outcomes: outcomes.data ?? {},
          settings: (attrSettings.data as { value?: unknown } | null)?.value ?? null,
        });
      }

      /* -------------------------------------------------------- */
      /* Budget signature — the CEO's named sign-off               */
      /* -------------------------------------------------------- */
      case 'campaign_sign': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');

        // approve_budget is the capability; the role check narrows it to the
        // people the design hands the pen to (CEO card on s43, manager/admin).
        const [canRes, rolesRes] = await Promise.all([
          sb.rpc('wassell_mos_can', { p_capability: 'approve_budget' }),
          sb.rpc('wassell_mos_roles'),
        ]);
        const gateFail = dbFail(canRes.error) ?? dbFail(rolesRes.error);
        if (gateFail) return gateFail;
        const held = (rolesRes.data as string[] | null) ?? [];
        const maySign = canRes.data === true
          && held.some((r) => ['ceo', 'marketing_manager', 'administrator'].includes(r));
        if (!maySign) {
          return new Response(
            JSON.stringify({
              error: 'Only the CEO can sign a campaign budget.',
              error_ar: 'التوقيع على ميزانية الحملة للرئيس التنفيذي فقط.',
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const appUserId = await resolveAppUserId(sb, user.userId);
        const upd = await sb.from('mos_campaigns')
          .update({ signed_by_user_id: appUserId, signed_at: new Date().toISOString() })
          .eq('id', campaignId).select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'campaign not found');

        await logCampaignEvent(sb, {
          campaignId,
          kind: 'signed',
          summaryAr: 'وُقّعت ميزانية الحملة.',
          summaryEn: 'Campaign budget signed.',
          actorUserId: appUserId,
        });

        const merged = await readCampaignMerged(sb, campaignId);
        const mergedFail = dbFail(merged.error);
        if (mergedFail) return mergedFail;
        return jsonOk({ campaign: merged.row });
      }

      /* -------------------------------------------------------- */
      /* CEO overview (s34) — three questions only: are we         */
      /* producing enough, at what cost, and what came back. NO    */
      /* task lists: the CEO is not a production manager.          */
      /* -------------------------------------------------------- */
      case 'ceo_overview': {
        const periodRaw = str(body.period);
        const period: 'month' | 'quarter' | 'year' =
          periodRaw === 'quarter' || periodRaw === 'year' ? periodRaw : 'month';
        const { weekStart: start, weekEnd: end } = periodBounds(period, null);
        const { weekStart: prevStart, weekEnd: prevEnd } = previousPeriodBounds(period, null);

        // The six calendar months ending this month — the production chart.
        const now = new Date();
        const monthKeys: string[] = [];
        for (let i = 5; i >= 0; i -= 1) {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
          monthKeys.push(d.toISOString().slice(0, 7));
        }
        const sixMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1))
          .toISOString();

        const [publishedNow, publishedPrev, published6m, campaigns, pendingSig, threshold] =
          await Promise.all([
            sb.from('mos_publication_v').select('id', { count: 'exact', head: true })
              .eq('status', 'published')
              .gte('published_at', start).lt('published_at', end),
            sb.from('mos_publication_v').select('id', { count: 'exact', head: true })
              .eq('status', 'published')
              .gte('published_at', prevStart).lt('published_at', prevEnd),
            sb.from('mos_publication_v').select('published_at')
              .eq('status', 'published')
              .gte('published_at', sixMonthsAgo).limit(2000),
            // Campaigns the CEO judges: anything running or recently ended.
            sb.from('mos_campaign_v')
              .select('id, ref, name, status, kind, objective, budget_total, total_spend, total_leads, total_qualified, success_metric, success_threshold, goal, starts_on, ends_on')
              .in('status', ['active', 'paused', 'done'])
              .order('total_spend', { ascending: false, nullsFirst: false })
              .limit(8),
            sb.from('mos_campaigns')
              .select('id, ref, name, budget_total, success_metric, success_threshold, goal')
              .eq('requires_signature', true)
              .is('signed_at', null)
              .is('archived_at', null)
              .order('budget_total', { ascending: false })
              .limit(10),
            readSignatureThreshold(sb),
          ]);
        const f = dbFail(publishedNow.error) ?? dbFail(publishedPrev.error)
          ?? dbFail(published6m.error) ?? dbFail(campaigns.error) ?? dbFail(pendingSig.error);
        if (f) return f;

        // The funnel's bottom half lives in the attribution ledger — aggregate
        // mos_campaign_outcomes over the campaigns on the list.
        const campaignRows = (campaigns.data ?? []) as Array<Record<string, unknown>>;
        const outcomeByCampaign = new Map<string, {
          appointments: number; reservations: number; reservation_value: number;
        }>();
        const outcomeResults = await Promise.all(
          campaignRows.map((c) => sb.rpc('mos_campaign_outcomes', { p_campaign_id: c.id as string })),
        );
        for (let i = 0; i < campaignRows.length; i += 1) {
          const res = outcomeResults[i];
          const camp = campaignRows[i];
          if (!res || !camp) continue;
          const of = dbFail(res.error);
          if (of) return of;
          const o = (res.data ?? {}) as Record<string, unknown>;
          outcomeByCampaign.set(camp.id as string, {
            appointments: typeof o.appointments === 'number' ? o.appointments : 0,
            reservations: typeof o.reservations === 'number' ? o.reservations : 0,
            reservation_value: typeof o.reservation_value === 'number' ? o.reservation_value : 0,
          });
        }

        const totals = campaignRows.reduce<{
          spend: number; committed: number; leads: number; qualified: number;
          appointments: number; reservations: number; reservation_value: number;
        }>(
          (acc, c) => {
            const o = outcomeByCampaign.get(c.id as string);
            acc.spend += typeof c.total_spend === 'number' ? c.total_spend : 0;
            acc.committed += typeof c.budget_total === 'number' ? c.budget_total : 0;
            acc.leads += typeof c.total_leads === 'number' ? c.total_leads : 0;
            acc.qualified += typeof c.total_qualified === 'number' ? c.total_qualified : 0;
            acc.appointments += o?.appointments ?? 0;
            acc.reservations += o?.reservations ?? 0;
            acc.reservation_value += o?.reservation_value ?? 0;
            return acc;
          },
          { spend: 0, committed: 0, leads: 0, qualified: 0, appointments: 0, reservations: 0, reservation_value: 0 },
        );

        const monthCount = new Map<string, number>(monthKeys.map((k): [string, number] => [k, 0]));
        for (const p of published6m.data ?? []) {
          const at = (p as { published_at?: string | null }).published_at;
          if (!at) continue;
          const key = at.slice(0, 7);
          if (monthCount.has(key)) monthCount.set(key, (monthCount.get(key) ?? 0) + 1);
        }

        return jsonOk({
          period,
          period_start: start,
          period_end: end,
          produced: publishedNow.count ?? 0,
          produced_prev: publishedPrev.count ?? 0,
          ...totals,
          campaigns: campaignRows.map((c) => {
            const o = outcomeByCampaign.get(c.id as string);
            const spend = typeof c.total_spend === 'number' ? c.total_spend : 0;
            const reservations = o?.reservations ?? 0;
            return {
              id: c.id,
              ref: c.ref ?? null,
              name: c.name ?? '',
              status: c.status,
              objective: c.objective ?? null,
              starts_on: c.starts_on ?? null,
              spend,
              qualified: typeof c.total_qualified === 'number' ? c.total_qualified : 0,
              reservations,
              cost_per_reservation: reservations > 0 ? Math.round(spend / reservations) : null,
            };
          }),
          production_by_month: monthKeys.map((k) => ({ month: k, count: monthCount.get(k) ?? 0 })),
          pending_signature: pendingSig.data ?? [],
          signature_threshold: threshold,
        });
      }

      /* -------------------------------------------------------- */
      /* Budget shift — move money between executions              */
      /* -------------------------------------------------------- */
      case 'budget_shift': {
        const campaignId = str(body.campaign_id);
        const fromId = str(body.from_execution_id);
        const toId = str(body.to_execution_id);
        const amount = numOrNull(body.amount);
        if (!campaignId || !fromId || !toId) {
          return jsonError(400, 'campaign_id, from_execution_id and to_execution_id are required');
        }
        if (fromId === toId) return jsonError(400, 'from and to executions must differ');
        if (amount === null || amount <= 0) {
          return jsonError(400, 'amount must be a positive number');
        }

        const execs = await sb.from('mos_campaign_executions')
          .select('id, campaign_id, budget, label, platform')
          .in('id', [fromId, toId]);
        const execsFail = dbFail(execs.error);
        if (execsFail) return execsFail;
        const rows = (execs.data ?? []) as unknown as Array<{
          id: string; campaign_id: string; budget: number | null; label: string | null; platform: string;
        }>;
        const from = rows.find((r) => r.id === fromId);
        const to = rows.find((r) => r.id === toId);
        if (!from || !to || from.campaign_id !== campaignId || to.campaign_id !== campaignId) {
          return jsonError(404, 'execution not found in this campaign');
        }
        const fromBudget = numOrNull(from.budget);
        if (fromBudget === null || fromBudget < amount) {
          return new Response(
            JSON.stringify({
              error: 'The source execution does not have enough budget for this shift.',
              error_ar: 'ميزانية التنفيذ المصدر لا تكفي لهذا التحويل.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Two conditional updates, each re-checking the budget it relies on so
        // a concurrent shift cannot push the source negative. (PostgREST has no
        // multi-statement transaction; the guards are the atomicity we can get
        // without a dedicated RPC.)
        const dec = await sb.from('mos_campaign_executions')
          .update({ budget: fromBudget - amount })
          .eq('id', fromId).eq('budget', fromBudget).select('id').maybeSingle();
        const decFail = dbFail(dec.error);
        if (decFail) return decFail;
        if (!dec.data) {
          return new Response(
            JSON.stringify({
              error: 'The source budget changed while shifting; try again.',
              error_ar: 'تغيّرت ميزانية المصدر أثناء التحويل؛ حاول مجددًا.',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const inc = await sb.from('mos_campaign_executions')
          .update({ budget: (numOrNull(to.budget) ?? 0) + amount })
          .eq('id', toId);
        const incFail = dbFail(inc.error);
        if (incFail) return incFail;

        await logCampaignEvent(sb, {
          campaignId,
          kind: 'budget_shift',
          summaryAr: `حُوّل مبلغ ${amount} ر.س من «${from.label ?? from.platform}» إلى «${to.label ?? to.platform}».`,
          summaryEn: `Shifted ${amount} SAR from "${from.label ?? from.platform}" to "${to.label ?? to.platform}".`,
          detail: { from_execution_id: fromId, to_execution_id: toId, amount },
          actorUserId: await resolveAppUserId(sb, user.userId),
        });

        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Attribution — the append-only client ↔ spend ledger. The  */
      /* list reads the BASE table and flags superseded rows: the  */
      /* effective view (client_attributions_effective) is exactly */
      /* the rows where superseded = false, so one payload serves  */
      /* both the effective list and the audit trail.              */
      /* -------------------------------------------------------- */
      case 'attribution_list': {
        const campaignId = str(body.campaign_id);
        const clientRecordId = str(body.client_record_id);
        if (!campaignId && !clientRecordId) {
          return jsonError(400, 'campaign_id or client_record_id is required');
        }

        // Filters before transforms — .order()/.limit() would drop .eq()/.or().
        let q = sb.from('client_attributions').select('*');
        if (clientRecordId) q = q.eq('client_record_id', clientRecordId);
        if (campaignId) {
          // A row attributes to the campaign directly, through one of its
          // executions, or through an ad of one of its executions — the same
          // three paths mos_campaign_outcomes walks.
          const execs = await sb.from('mos_campaign_executions')
            .select('id').eq('campaign_id', campaignId).limit(500);
          const execsFail = dbFail(execs.error);
          if (execsFail) return execsFail;
          const execIds = (execs.data ?? []).map((e) => (e as unknown as Row).id);
          let adIds: string[] = [];
          if (execIds.length > 0) {
            const ads = await sb.from('mos_execution_ads').select('id').in('execution_id', execIds).limit(1000);
            const adsFail = dbFail(ads.error);
            if (adsFail) return adsFail;
            adIds = (ads.data ?? []).map((a) => (a as unknown as Row).id);
          }
          const ors = [`campaign_id.eq.${campaignId}`];
          if (execIds.length > 0) ors.push(`execution_id.in.(${execIds.join(',')})`);
          if (adIds.length > 0) ors.push(`ad_id.in.(${adIds.join(',')})`);
          q = q.or(ors.join(','));
        }
        const rows = await q
          .order('occurred_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // The supersession flag: a row is superseded when any other row points
        // at it. Asked of the base table so the flag is true even when the
        // correcting row falls outside this filter.
        const data = (rows.data ?? []) as unknown as Array<Row & { supersedes_id: string | null }>;
        const ids = data.map((r) => r.id);
        const supersededIds = new Set<string>();
        if (ids.length > 0) {
          const sup = await sb.from('client_attributions')
            .select('supersedes_id').in('supersedes_id', ids).limit(1000);
          const supFail = dbFail(sup.error);
          if (supFail) return supFail;
          for (const s of (sup.data ?? []) as unknown as Array<{ supersedes_id: string | null }>) {
            if (s.supersedes_id) supersededIds.add(s.supersedes_id);
          }
        }
        return jsonOk({
          rows: data.map((r) => ({ ...r, superseded: supersededIds.has(r.id) })),
        });
      }

      case 'attribution_stamp': {
        const clientRecordId = str(body.client_record_id);
        const occurredAt = str(body.occurred_at);
        const source = str(body.source);
        if (!clientRecordId || !occurredAt || !source) {
          return jsonError(400, 'client_record_id, occurred_at and source are required');
        }
        if (!['lead_form', 'manual', 'import'].includes(source)) {
          return new Response(
            JSON.stringify({
              error: 'Attribution source must be lead_form, manual or import.',
              error_ar: 'مصدر النسبة يجب أن يكون نموذج عميل أو يدويًا أو استيرادًا.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const campaignId = str(body.campaign_id);
        const executionId = str(body.execution_id);
        const adId = str(body.ad_id);
        // Mirrors the table CHECK: a row naming no spend object attributes nothing.
        if (!campaignId && !executionId && !adId) {
          return new Response(
            JSON.stringify({
              error: 'Name at least one of campaign, execution or ad.',
              error_ar: 'حدّد حملة أو تنفيذًا أو إعلانًا واحدًا على الأقل.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const touchType = str(body.touch_type);
        if (touchType && !['first', 'last'].includes(touchType)) {
          return jsonError(400, 'touch_type must be first or last');
        }
        const ins = await sb.from('client_attributions').insert({
          client_record_id: clientRecordId,
          campaign_id: campaignId,
          execution_id: executionId,
          ad_id: adId,
          touch_type: touchType ?? 'first',
          occurred_at: occurredAt,
          source,
          note: str(body.note),
          supersedes_id: str(body.supersedes_id),
          created_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ row: ins.data });
      }

      /* -------------------------------------------------------- */
      /* Assets — the material library                             */
      /* -------------------------------------------------------- */
      case 'asset_list': {
        let q = sb.from('mos_assets').select('*').is('archived_at', null);
        const kind = str(body.kind);
        const projectId = str(body.project_id);
        const search = str(body.q);
        if (kind) q = q.eq('kind', kind);
        if (projectId) q = q.eq('project_id', projectId);
        if (search) q = q.ilike('title', `%${search}%`);
        const rows = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // Usage comes from the link table, so "unused" is a fact rather than a
        // counter somebody has to remember to decrement.
        const links = await sb.from('mos_asset_links').select('asset_id, content_id, role').limit(2000);
        const lf = dbFail(links.error);
        if (lf) return lf;
        return jsonOk({ assets: rows.data ?? [], links: links.data ?? [] });
      }

      case 'asset_save': {
        const raw = (body.asset ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'kind', 'source', 'project_id', 'file_id', 'url',
                         'thumb_url', 'shot_on', 'tags', 'note',
                         'file_path', 'mime_type', 'size_bytes', 'original_name',
                         'usage_rights', 'shoot_request_id', 'aspect_ratio',
                         'shot_by', 'rights_expiry'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_assets').update(patch).eq('id', id).select('*').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'asset not found');
          return jsonOk({ asset: upd.data });
        }
        if (!str(patch.title)) return jsonError(400, 'title is required');
        patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
        const ins = await sb.from('mos_assets').insert(patch).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ asset: ins.data });
      }

      /* -------------------------------------------------------- */
      /* One asset: what uses it, its derivative versions, and     */
      /* whether any publication depends on it (screen 22)         */
      /* -------------------------------------------------------- */
      case 'asset_detail': {
        const assetId = str(body.asset_id);
        if (!assetId) return jsonError(400, 'asset_id is required');

        const asset = await sb.from('mos_assets').select('*').eq('id', assetId).maybeSingle();
        const assetFail = dbFail(asset.error);
        if (assetFail) return assetFail;
        if (!asset.data) return jsonError(404, 'asset not found');
        const row = asset.data as unknown as Row & { parent_asset_id: string | null };

        const links = await sb.from('mos_asset_links')
          .select('asset_id, content_id, role').eq('asset_id', assetId);
        const linksFail = dbFail(links.error);
        if (linksFail) return linksFail;
        const linkRows = (links.data ?? []) as unknown as Array<{
          asset_id: string; content_id: string; role: string;
        }>;
        const contentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));

        const [contents, liveAds, pubsCount, versions] = await Promise.all([
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_execution_ads').select('content_id').in('content_id', contentIds).eq('status', 'running')
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_publications').select('id', { count: 'exact', head: true })
                .in('content_id', contentIds)
            : Promise.resolve({ count: 0, error: null }),
          // Derivatives of the same root: the parent plus every child cut.
          sb.from('mos_assets').select('id, title, created_at')
            .or(`id.eq.${row.parent_asset_id ?? row.id},parent_asset_id.eq.${row.parent_asset_id ?? row.id}`)
            .order('created_at', { ascending: true }),
        ]);
        const f = dbFail(contents.error) ?? dbFail(liveAds.error)
          ?? dbFail(pubsCount.error) ?? dbFail(versions.error);
        if (f) return f;

        const titleById = new Map(
          ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );
        const liveContentIds = new Set(
          ((liveAds.data ?? []) as unknown as Array<{ content_id: string | null }>)
            .map((a) => a.content_id).filter((c): c is string => Boolean(c)),
        );
        const usedIn = linkRows
          .map((l) => ({
            content_id: l.content_id,
            ref: titleById.get(l.content_id)?.ref ?? null,
            title: titleById.get(l.content_id)?.title ?? '',
            role: l.role,
            live_ad: liveContentIds.has(l.content_id),
          }))
          // Deterministic: by content title, then role.
          .sort((a, b) => a.title.localeCompare(b.title) || a.role.localeCompare(b.role));

        return jsonOk({
          asset: asset.data,
          used_in: usedIn,
          versions: versions.data ?? [],
          publications_using: pubsCount.count ?? 0,
        });
      }

      /* -------------------------------------------------------- */
      /* Archive / unarchive. Allowed even while in use — the      */
      /* asset stops appearing in pickers without breaking the     */
      /* record of what shipped.                                   */
      /* -------------------------------------------------------- */
      case 'asset_archive': {
        const assetId = str(body.asset_id);
        if (!assetId) return jsonError(400, 'asset_id is required');
        if (typeof body.archived !== 'boolean') return jsonError(400, 'archived must be a boolean');
        const upd = await sb.from('mos_assets')
          .update({ archived_at: body.archived ? new Date().toISOString() : null })
          .eq('id', assetId).select('*').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'asset not found');
        return jsonOk({ asset: upd.data });
      }

      /* -------------------------------------------------------- */
      /* Delete — blocked while anything references the asset.     */
      /* In use → 409 {error:'in_use', used_in}; unused → real     */
      /* delete (archiving is asset_archive's job).                */
      /* -------------------------------------------------------- */
      case 'asset_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const links = await sb.from('mos_asset_links')
          .select('asset_id, content_id, role').eq('asset_id', id);
        const linksFail = dbFail(links.error);
        if (linksFail) return linksFail;
        const linkRows = (links.data ?? []) as unknown as Array<{
          asset_id: string; content_id: string; role: string;
        }>;
        const contentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));

        let pubsUsing = 0;
        let titleById = new Map<string, { id: string; ref: string | null; title: string }>();
        if (contentIds.length > 0) {
          const [contents, pubsCount] = await Promise.all([
            sb.from('mos_content_v').select('id, ref, title').in('id', contentIds),
            sb.from('mos_publications').select('id', { count: 'exact', head: true })
              .in('content_id', contentIds),
          ]);
          const f = dbFail(contents.error) ?? dbFail(pubsCount.error);
          if (f) return f;
          titleById = new Map(
            ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
              .map((c) => [c.id, c] as const),
          );
          pubsUsing = pubsCount.count ?? 0;
        }

        if (linkRows.length > 0 || pubsUsing > 0) {
          const usedIn = linkRows
            .map((l) => ({
              content_id: l.content_id,
              ref: titleById.get(l.content_id)?.ref ?? null,
              title: titleById.get(l.content_id)?.title ?? '',
              role: l.role,
            }))
            .sort((a, b) => a.title.localeCompare(b.title) || a.role.localeCompare(b.role));
          return new Response(
            JSON.stringify({
              error: 'in_use',
              error_ar: 'المادة مستخدمة في محتوى أو منشورات؛ أرشفها بدل حذفها.',
              used_in: usedIn,
              publications_using: pubsUsing,
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const del = await sb.from('mos_assets').delete().eq('id', id).select('id').maybeSingle();
        const f = dbFail(del.error);
        if (f) return f;
        if (!del.data) return jsonError(404, 'asset not found');
        return jsonOk({ ok: true });
      }

      /* -------------------------------------------------------- */
      /* The «غير مستخدمة» shelf (s41): not archived, no links,    */
      /* and no publication touches a content it's linked to.      */
      /* -------------------------------------------------------- */
      case 'assets_unused': {
        const [assets, links] = await Promise.all([
          sb.from('mos_assets').select('*').is('archived_at', null)
            .order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500)),
          sb.from('mos_asset_links').select('asset_id, content_id').limit(4000),
        ]);
        const f = dbFail(assets.error) ?? dbFail(links.error);
        if (f) return f;
        const linkRows = (links.data ?? []) as unknown as Array<{ asset_id: string; content_id: string }>;
        const linkedAssetIds = new Set(linkRows.map((l) => l.asset_id));

        // Publications reach assets only through content links — an asset with
        // zero links is already unused, so this only ever refines linked ones.
        const linkedContentIds = Array.from(new Set(linkRows.map((l) => l.content_id)));
        const pubContentIds = new Set<string>();
        if (linkedContentIds.length > 0) {
          const pubs = await sb.from('mos_publications').select('content_id')
            .in('content_id', linkedContentIds).limit(2000);
          const pubsFail = dbFail(pubs.error);
          if (pubsFail) return pubsFail;
          for (const p of (pubs.data ?? []) as unknown as Array<{ content_id: string }>) {
            pubContentIds.add(p.content_id);
          }
        }
        const pubbedAssetIds = new Set(
          linkRows.filter((l) => pubContentIds.has(l.content_id)).map((l) => l.asset_id),
        );

        const rows = ((assets.data ?? []) as unknown as Row[])
          .filter((a) => !linkedAssetIds.has(a.id) && !pubbedAssetIds.has(a.id));
        return jsonOk({ rows });
      }

      /* -------------------------------------------------------- */
      /* Bulk ops on the grid selection (s16): archive, tag, or    */
      /* turn the selection into ONE content item pre-linked to    */
      /* every asset in it.                                        */
      /* -------------------------------------------------------- */
      case 'assets_bulk': {
        const ids = Array.isArray(body.ids)
          ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : [];
        const op = str(body.op);
        if (ids.length === 0) return jsonError(400, 'ids must be a non-empty array');
        if (ids.length > 100) return jsonError(400, 'at most 100 assets per bulk operation');
        if (!op || !['archive', 'tag', 'create_content'].includes(op)) {
          return jsonError(400, 'op must be archive, tag or create_content');
        }

        if (op === 'archive') {
          const upd = await sb.from('mos_assets')
            .update({ archived_at: new Date().toISOString() }).in('id', ids).select('id');
          const f = dbFail(upd.error);
          if (f) return f;
          const done = new Set(((upd.data ?? []) as unknown as Row[]).map((r) => r.id));
          return jsonOk({ results: ids.map((assetId) => ({ id: assetId, ok: done.has(assetId) })) });
        }

        if (op === 'tag') {
          const tag = str(body.tag);
          if (!tag) return jsonError(400, 'tag is required for the tag op');
          const assets = await sb.from('mos_assets').select('id, tags').in('id', ids);
          const f = dbFail(assets.error);
          if (f) return f;
          const results: Array<{ id: string; ok: boolean }> = [];
          for (const a of (assets.data ?? []) as unknown as Array<{ id: string; tags: unknown }>) {
            const current = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : [];
            const next = current.includes(tag) ? current : [...current, tag];
            const upd = await sb.from('mos_assets').update({ tags: next }).eq('id', a.id);
            // A failed row is reported in results, not swallowed — the UI
            // marks exactly which assets didn't take the tag.
            if (upd.error) {
              console.error('[marketing-os] bulk tag failed for asset', a.id, upd.error.code, upd.error.message);
              results.push({ id: a.id, ok: false });
            } else {
              results.push({ id: a.id, ok: true });
            }
          }
          return jsonOk({ results });
        }

        // create_content — one item carrying every selected asset as source
        // material. Title falls back to the first asset's title.
        const typeKey = str(body.content_type_key);
        if (!typeKey) return jsonError(400, 'content_type_key is required for create_content');
        const typeRes = await sb.from('mos_content_types')
          .select('id, workflow_id').eq('key', typeKey).maybeSingle();
        const typeFail = dbFail(typeRes.error);
        if (typeFail) return typeFail;
        if (!typeRes.data) return jsonError(400, 'unknown content type');
        const type = typeRes.data as { id: string; workflow_id: string | null };

        const assets = await sb.from('mos_assets').select('id, title').in('id', ids);
        const assetsFail = dbFail(assets.error);
        if (assetsFail) return assetsFail;
        const firstTitle = ((assets.data ?? [])[0] as { title?: string } | undefined)?.title;

        const title = str(body.title) ?? str(firstTitle);
        if (!title) return jsonError(400, 'title is required when the selection has none');

        const appUserId = await resolveAppUserId(sb, user.userId);
        const created = await sb.from('mos_content').insert({
          title,
          content_type_id: type.id,
          workflow_id: type.workflow_id,
          created_by_user_id: appUserId,
        }).select('id, ref').maybeSingle();
        const createFail = dbFail(created.error);
        if (createFail) return createFail;
        if (!created.data) return jsonError(500, 'insert returned no row');
        const contentId = (created.data as unknown as Row).id;

        if (type.workflow_id) {
          const openFail = await openFirstTask(sb, contentId, type.workflow_id);
          if (openFail) return openFail;
        }

        const linkRows = ids.map((assetId) => ({ asset_id: assetId, content_id: contentId, role: 'source' }));
        const linkIns = await sb.from('mos_asset_links')
          .upsert(linkRows, { onConflict: 'asset_id,content_id' });
        const linkFail = dbFail(linkIns.error);
        if (linkFail) return linkFail;

        return jsonOk({
          results: ids.map((assetId) => ({ id: assetId, ok: true, content_id: contentId })),
          content_id: contentId,
        });
      }

      case 'asset_link': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const role = str(body.role) ?? 'source';
        const up = await sb.from('mos_asset_links')
          .upsert({ asset_id: assetId, content_id: contentId, role }, { onConflict: 'asset_id,content_id' });
        const f = dbFail(up.error);
        if (f) return f;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      case 'asset_unlink': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const del = await sb.from('mos_asset_links').delete()
          .eq('asset_id', assetId).eq('content_id', contentId);
        const f = dbFail(del.error);
        if (f) return f;
        // Unlinking the material that was submitted for approval clears the
        // pointer, so a later approval can't promote an asset that is no longer
        // attached. The FK is ON DELETE SET NULL only when the ASSET is deleted;
        // an unlink is a link delete, so we clear it here.
        const clear = await sb.from('mos_content')
          .update({ approval_asset_id: null })
          .eq('id', contentId).eq('approval_asset_id', assetId);
        const clearFail = dbFail(clear.error);
        if (clearFail) return clearFail;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      // Mark (or clear) the ONE material submitted for approval on a content
      // item. On the next 'approved' task result the API promotes it to a 'final'
      // link (mos_promote_approval_asset). Governed by mos_content UPDATE RLS,
      // the same gate as content_update.
      case 'content_set_approval_asset': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const assetId = str(body.asset_id); // null clears the selection
        if (assetId) {
          const linked = await sb.from('mos_asset_links')
            .select('asset_id').eq('content_id', contentId).eq('asset_id', assetId).maybeSingle();
          const linkFail = dbFail(linked.error);
          if (linkFail) return linkFail;
          if (!linked.data) return jsonError(400, 'asset is not linked to this content');
        }
        const upd = await sb.from('mos_content')
          .update({ approval_asset_id: assetId ?? null })
          .eq('id', contentId).select('id').maybeSingle();
        const updFail = dbFail(upd.error);
        if (updFail) return updFail;
        if (!upd.data) return jsonError(404, 'content item not found');
        return jsonOk({ content_id: contentId, approval_asset_id: assetId ?? null });
      }

      /* -------------------------------------------------------- */
      /* Shoot requests — what missing scenes turn into            */
      /* -------------------------------------------------------- */
      case 'shoot_list': {
        const [reqs, items, shootAssets, links] = await Promise.all([
          sb.from('mos_shoot_requests').select('*')
            .order('created_at', { ascending: false }).limit(cap(body.limit, 100, 300)),
          sb.from('mos_shoot_items').select('*').limit(1000),
          // Delivered files per request — the completed table's «ملفات» count
          // and the usage percentage both come from these.
          sb.from('mos_assets').select('id, shoot_request_id, kind')
            .not('shoot_request_id', 'is', null).is('archived_at', null).limit(2000),
          sb.from('mos_asset_links').select('asset_id, content_id').limit(4000),
        ]);
        const f = dbFail(reqs.error) ?? dbFail(items.error)
          ?? dbFail(shootAssets.error) ?? dbFail(links.error);
        if (f) return f;

        // Every scene still marked missing, whether or not it has been requested
        // yet — the backlog IS the pending shoot list. created_at feeds the
        // "oldest waiting" column that drives the auto-suggest threshold.
        const missing = await sb.from('mos_scenes')
          .select('id, content_id, position, visual, footage_status, created_at')
          .eq('footage_status', 'missing').limit(500);
        const mf = dbFail(missing.error);
        if (mf) return mf;

        const contentIds = Array.from(new Set((missing.data ?? [])
          .map((s) => (s as unknown as Row).content_id as string)));
        let owners: unknown[] = [];
        if (contentIds.length > 0) {
          const o = await sb.from('mos_content_v')
            .select('id, ref, title, project_id, content_type_key').in('id', contentIds);
          const of_ = dbFail(o.error);
          if (of_) return of_;
          owners = o.data ?? [];
        }
        return jsonOk({
          requests: reqs.data ?? [],
          items: items.data ?? [],
          missing_scenes: missing.data ?? [],
          scene_owners: owners,
          shoot_assets: shootAssets.data ?? [],
          asset_links: links.data ?? [],
        });
      }

      /* -------------------------------------------------------- */
      /* Delivery — the wire that makes this NOT Drive. Files      */
      /* arriving is what marks the waiting scenes covered; nobody */
      /* has to notice and connect them by hand.                   */
      /* -------------------------------------------------------- */
      case 'shoot_deliver': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const upd = await sb.from('mos_shoot_requests')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', id).select('id').maybeSingle();
        const uf = dbFail(upd.error);
        if (uf) return uf;
        if (!upd.data) return jsonError(404, 'shoot request not found');

        const itemRows = await sb.from('mos_shoot_items').select('id, scene_id, content_id').eq('request_id', id);
        const irf = dbFail(itemRows.error);
        if (irf) return irf;
        const rows = (itemRows.data ?? []) as unknown as Array<{ id: string; scene_id: string | null }>;

        if (rows.length > 0) {
          const itemsDone = await sb.from('mos_shoot_items')
            .update({ done: true }).eq('request_id', id);
          const idf = dbFail(itemsDone.error);
          if (idf) return idf;

          const sceneIds = rows.map((r) => r.scene_id).filter((s): s is string => Boolean(s));
          if (sceneIds.length > 0) {
            // The scenes that were waiting on this shoot are now covered. If a
            // shot was actually missed, downgrading it back is one click —
            // correction is the exception, connecting is the default.
            const scenes = await sb.from('mos_scenes')
              .update({ footage_status: 'have' }).in('id', sceneIds);
            const sf = dbFail(scenes.error);
            if (sf) return sf;
          }
        }

        const [reqsAfter, itemsAfter] = await Promise.all([
          sb.from('mos_shoot_requests').select('*').order('created_at', { ascending: false }).limit(300),
          sb.from('mos_shoot_items').select('*').limit(1000),
        ]);
        const rf = dbFail(reqsAfter.error) ?? dbFail(itemsAfter.error);
        if (rf) return rf;

        // «وصل التصوير» — the contents whose scenes this shoot covered are
        // unblocked; interrupt whoever holds their open task.
        const shootContentIds = Array.from(new Set(
          ((itemRows.data ?? []) as unknown as Array<{ content_id: string | null }>)
            .map((r) => r.content_id).filter((c): c is string => Boolean(c)),
        ));
        if (shootContentIds.length > 0) {
          const openTasks = await sb.from('workflow_role_tasks')
            .select('subject_id, role_key, assignee_user_id')
            .eq('subject_table', 'mos_content')
            .in('subject_id', shootContentIds)
            .eq('status', 'open');
          if (openTasks.error) {
            console.error('[marketing-os] open-task read for shoot_delivered failed',
              openTasks.error.code, openTasks.error.message);
          } else {
            const taskRows = (openTasks.data ?? []) as unknown as Array<{
              subject_id: string; role_key: string; assignee_user_id: string | null;
            }>;
            const roles = Array.from(new Set(taskRows.map((t) => t.role_key)));
            const users = Array.from(new Set(
              taskRows.map((t) => t.assignee_user_id).filter((u): u is string => Boolean(u)),
            ));
            if (roles.length > 0 || users.length > 0) {
              await emitNotify(sb, {
                event: 'shoot_delivered',
                roles,
                users,
                titleAr: 'وصل التصوير',
                titleEn: 'Shoot delivered',
                bodyAr: 'سُلّمت مواد التصوير وأصبحت اللقطات الناقصة متوفرة.',
                bodyEn: 'Shoot materials were delivered; the missing scenes are now covered.',
                url: `/m/shoots/${id}`,
              });
            }
          }
        }

        return jsonOk({
          requests: reqsAfter.data ?? [],
          items: itemsAfter.data ?? [],
          scenes_marked: rows.filter((r) => r.scene_id).length,
        });
      }

      case 'shoot_save': {
        const raw = (body.request ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'project_id', 'status', 'scheduled_at',
                         'location', 'note', 'assigned_role'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        let requestId = id;
        if (id) {
          const upd = await sb.from('mos_shoot_requests').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'shoot request not found');
        } else {
          if (!str(patch.title)) return jsonError(400, 'title is required');
          patch.requested_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_shoot_requests').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          requestId = (ins.data as unknown as Row | null)?.id ?? null;

          // Requests raised from the shoot backlog carry their scenes with them,
          // so the person filming sees the actual shot list.
          const scenes = Array.isArray(body.scene_ids) ? (body.scene_ids as unknown[]) : [];
          if (requestId && scenes.length > 0) {
            const sceneRows = await sb.from('mos_scenes')
              .select('id, content_id, visual, position')
              .in('id', scenes.filter((s): s is string => typeof s === 'string'));
            const sf = dbFail(sceneRows.error);
            if (sf) return sf;
            const payload = (sceneRows.data ?? []).map((s) => {
              const sc = s as unknown as Row;
              return {
                request_id: requestId,
                scene_id: sc.id,
                content_id: sc.content_id,
                description: (sc.visual as string | null) ?? `#${String(sc.position)}`,
              };
            });
            if (payload.length > 0) {
              const itemsIns = await sb.from('mos_shoot_items').insert(payload);
              const itf = dbFail(itemsIns.error);
              if (itf) return itf;
            }
          }
        }
        const list = await sb.from('mos_shoot_requests').select('*')
          .order('created_at', { ascending: false }).limit(300);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ requests: list.data ?? [], request_id: requestId });
      }

      case 'shoot_item_toggle': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const done = body.done === true;
        const upd = await sb.from('mos_shoot_items').update({ done }).eq('id', id).select('*').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'shoot item not found');
        return jsonOk({ item: upd.data });
      }

      /* -------------------------------------------------------- */
      /* One shoot request: the shot list with each item's scene   */
      /* and owning content resolved (screen 24)                   */
      /* -------------------------------------------------------- */
      case 'shoot_detail': {
        const requestId = str(body.request_id);
        if (!requestId) return jsonError(400, 'request_id is required');

        const [request, items, assetsCount] = await Promise.all([
          sb.from('mos_shoot_requests').select('*').eq('id', requestId).maybeSingle(),
          sb.from('mos_shoot_items').select('*').eq('request_id', requestId)
            .order('created_at', { ascending: true }),
          sb.from('mos_assets').select('id', { count: 'exact', head: true })
            .eq('shoot_request_id', requestId).is('archived_at', null),
        ]);
        const f = dbFail(request.error) ?? dbFail(items.error) ?? dbFail(assetsCount.error);
        if (f) return f;
        if (!request.data) return jsonError(404, 'shoot request not found');

        const itemRows = (items.data ?? []) as unknown as Array<Row & {
          scene_id: string | null; content_id: string | null;
        }>;
        const sceneIds = Array.from(new Set(
          itemRows.map((i) => i.scene_id).filter((s): s is string => Boolean(s)),
        ));
        const contentIds = Array.from(new Set(
          itemRows.map((i) => i.content_id).filter((c): c is string => Boolean(c)),
        ));

        const [scenes, contents] = await Promise.all([
          sceneIds.length > 0
            ? sb.from('mos_scenes').select('*').in('id', sceneIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          contentIds.length > 0
            ? sb.from('mos_content_v').select('id, ref, title').in('id', contentIds)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f2 = dbFail(scenes.error) ?? dbFail(contents.error);
        if (f2) return f2;

        const sceneById = new Map(
          ((scenes.data ?? []) as unknown as Row[]).map((s) => [s.id, s] as const),
        );
        const contentById = new Map(
          ((contents.data ?? []) as unknown as Array<{ id: string; ref: string | null; title: string }>)
            .map((c) => [c.id, c] as const),
        );

        return jsonOk({
          request: request.data,
          items: itemRows.map((i) => ({
            ...i,
            scene: i.scene_id ? (sceneById.get(i.scene_id) ?? null) : null,
            content_ref: i.content_id ? (contentById.get(i.content_id)?.ref ?? null) : null,
            content_title: i.content_id ? (contentById.get(i.content_id)?.title ?? null) : null,
          })),
          assets_count: assetsCount.count ?? 0,
        });
      }

      case 'shoot_item_add': {
        const requestId = str(body.request_id);
        const description = str(body.description);
        if (!requestId || !description) {
          return jsonError(400, 'request_id and description are required');
        }
        const ins = await sb.from('mos_shoot_items').insert({
          request_id: requestId,
          description,
          scene_id: str(body.scene_id),
          content_id: str(body.content_id),
        }).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ item: ins.data });
      }

      /* -------------------------------------------------------- */
      /* Comments — the thread                                     */
      /* -------------------------------------------------------- */
      case 'comment_add': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        const bodyText = str(body.body);
        if (!bodyText) return jsonError(400, 'body is required');
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        const ins = await sb.from('mos_comments').insert({
          content_id: contentId,
          campaign_id: campaignId,
          body: bodyText,
          author_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ comments: list.data ?? [] });
      }

      case 'comment_list': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ comments: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Settings — workflows, types, platforms, surface matrix    */
      /* -------------------------------------------------------- */
      case 'settings_data': {
        const [wfRes, verRes, typesRes, accountsRes, settingsRes, surfRolesRes, surfCellsRes, rulesRes] =
          await Promise.all([
            sb.from('workflows')
              .select('id, label_ar, label_en, is_active, metadata')
              .eq('kind', 'role_path')
              .order('label_en', { ascending: true }),
            sb.from('workflow_versions').select('id, workflow_id, version_no'),
            sb.from('mos_content_types').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            sb.from('mos_platform_accounts').select('*').is('archived_at', null)
              .order('sort_order', { ascending: true }),
            sb.from('mos_settings').select('key, value'),
            sb.from('roles').select('id, key').like('key', 'mos\\_%').order('key', { ascending: true }),
            sb.from('surface_access').select('role_id, surface_key, level'),
            fetchNotificationRuleRows(sb),
          ]);
        const f = dbFail(wfRes.error) ?? dbFail(verRes.error) ?? dbFail(typesRes.error)
          ?? dbFail(accountsRes.error) ?? dbFail(settingsRes.error)
          ?? dbFail(surfRolesRes.error) ?? dbFail(surfCellsRes.error);
        if (f) return f;
        if ('fail' in rulesRes) return rulesRes.fail;

        const settings: Record<string, unknown> = {};
        for (const row of (settingsRes.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }
        const roleRows = (surfRolesRes.data ?? []) as unknown as Array<{ id: string; key: string }>;
        const keyById = new Map(roleRows.map((r) => [r.id, stripMosPrefix(r.key)]));
        const cells = ((surfCellsRes.data ?? []) as unknown as Array<{
          role_id: string; surface_key: string; level: string;
        }>)
          .map((c) => ({ role_key: keyById.get(c.role_id) ?? '', surface_key: c.surface_key, level: c.level }))
          .filter((c) => c.role_key !== '');

        return jsonOk({
          workflows: assembleWorkflowDefs(wfRes.data ?? [], verRes.data ?? []),
          content_types: typesRes.data ?? [],
          accounts: accountsRes.data ?? [],
          settings,
          surface: {
            roles: roleRows.map((r) => ({ key: stripMosPrefix(r.key), role_id: r.id })),
            cells,
          },
          notification_rules: rulesRes.rules,
        });
      }

      /* -------------------------------------------------------- */
      /* Module settings — thresholds as data (screen 25 cards)    */
      /* -------------------------------------------------------- */
      case 'settings_save': {
        const key = str(body.key);
        if (!key) return jsonError(400, 'key is required');
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          return jsonError(400, 'value is required');
        }
        const value = body.value;
        // mos_settings.value is jsonb — a scalar or array would break every
        // reader that does value->>'field'. Objects only.
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return jsonError(400, 'value must be a JSON object');
        }
        const up = await sb.from('mos_settings').upsert(
          {
            key,
            value: value as Record<string, unknown>,
            updated_by_user_id: await resolveAppUserId(sb, user.userId),
          },
          { onConflict: 'key' },
        );
        const f = dbFail(up.error);
        if (f) return f;

        const all = await sb.from('mos_settings').select('key, value');
        const allFail = dbFail(all.error);
        if (allFail) return allFail;
        const settings: Record<string, unknown> = {};
        for (const row of (all.data ?? []) as Array<{ key: string; value: unknown }>) {
          settings[row.key] = row.value;
        }
        return jsonOk({ ok: true, settings });
      }

      /* -------------------------------------------------------- */
      /* Save a whole role path — steps live in metadata, and the  */
      /* DB trigger snapshots the new version on write             */
      /* -------------------------------------------------------- */
      case 'workflow_save': {
        const labelAr = str(body.label_ar);
        const labelEn = str(body.label_en);
        if (!labelAr || !labelEn) return jsonError(400, 'label_ar and label_en are required');
        const rawSteps = Array.isArray(body.steps) ? (body.steps as unknown[]) : null;
        if (!rawSteps || rawSteps.length === 0) return jsonError(400, 'steps must be a non-empty array');

        const seen = new Set<string>();
        const steps: StepDef[] = [];
        for (const raw of rawSteps) {
          const s = (raw ?? {}) as Record<string, unknown>;
          const key = str(s.key);
          const sLabelAr = str(s.label_ar);
          const sLabelEn = str(s.label_en);
          const roleKey = str(s.role_key);
          if (!key || !sLabelAr || !sLabelEn) {
            return jsonError(400, 'every step needs key, label_ar and label_en');
          }
          if (seen.has(key)) return jsonError(400, `duplicate step key: ${key}`);
          seen.add(key);
          if (!roleKey || !(MOS_ROLE_KEYS as readonly string[]).includes(roleKey)) {
            return jsonError(400, `step ${key} needs a valid role_key`);
          }
          const dueDays = typeof s.due_days === 'number' && Number.isInteger(s.due_days) && s.due_days >= 0
            ? s.due_days
            : null;
          if (dueDays === null) return jsonError(400, `step ${key}: due_days must be an integer >= 0`);
          steps.push({
            key,
            label_ar: sLabelAr,
            label_en: sLabelEn,
            role_key: roleKey,
            due_days: dueDays,
            is_approval: s.is_approval === true,
            approval_kind: str(s.approval_kind),
            require_note_on_reject: s.require_note_on_reject === true,
            creates_revision: s.creates_revision === true,
            required_fields: Array.isArray(s.required_fields) ? (s.required_fields as unknown[]).map(String) : [],
            required_files: Array.isArray(s.required_files) ? (s.required_files as unknown[]).map(String) : [],
            // Notification gate + permitted channels. Absent → notify on, all
            // channels (legacy default). An explicit empty channel array is a
            // real state kept verbatim (the step permits nothing).
            notify: s.notify !== false,
            notify_channels: 'notify_channels' in s ? channelsOf(s.notify_channels) : [...NOTIFY_CHANNELS],
          });
        }

        const id = str(body.id);
        let workflowId: string;
        if (id) {
          const existing = await sb.from('workflows')
            .select('id, kind, metadata').eq('id', id).maybeSingle();
          const existFail = dbFail(existing.error);
          if (existFail) return existFail;
          if (!existing.data || (existing.data as { kind?: string }).kind !== 'role_path') {
            return jsonError(404, 'workflow not found');
          }
          const prevMeta = ((existing.data as { metadata?: Record<string, unknown> }).metadata ?? {});
          const metadata = {
            ...prevMeta,
            managed_by: 'marketing_os',
            key: typeof prevMeta.key === 'string' && prevMeta.key !== '' ? prevMeta.key : slugify(labelEn),
            steps,
          };
          const patch: Record<string, unknown> = { label_ar: labelAr, label_en: labelEn, metadata };
          if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
          const upd = await sb.from('workflows').update(patch).eq('id', id);
          const updFail = dbFail(upd.error);
          if (updFail) return updFail;
          workflowId = id;
        } else {
          const ins = await sb.from('workflows').insert({
            label_ar: labelAr,
            label_en: labelEn,
            kind: 'role_path',
            trigger_model_id: null,
            trigger_event: null,
            conditions: [],
            actions: [],
            is_active: typeof body.is_active === 'boolean' ? body.is_active : true,
            metadata: { managed_by: 'marketing_os', key: slugify(labelEn), steps },
          }).select('id').maybeSingle();
          const insFail = dbFail(ins.error);
          if (insFail) return insFail;
          if (!ins.data) return jsonError(500, 'insert returned no row');
          workflowId = (ins.data as unknown as Row).id;
        }

        // The write above already triggered the version snapshot; read it back.
        const [wfRow, verRow] = await Promise.all([
          sb.from('workflows').select('id, label_ar, label_en, is_active, metadata')
            .eq('id', workflowId).maybeSingle(),
          sb.from('workflow_versions').select('id, version_no')
            .eq('workflow_id', workflowId)
            .order('version_no', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const readFail = dbFail(wfRow.error) ?? dbFail(verRow.error);
        if (readFail) return readFail;
        const w = wfRow.data as {
          id: string; label_ar: string; label_en: string; is_active: boolean; metadata: unknown;
        } | null;
        const v = verRow.data as { id: string; version_no: number } | null;
        return jsonOk({
          workflow: w
            ? {
                id: w.id,
                label_ar: w.label_ar,
                label_en: w.label_en,
                is_active: w.is_active,
                steps: stepsOf(w.metadata),
                current_version_no: v?.version_no ?? 0,
                current_version_id: v?.id ?? null,
              }
            : null,
          version_no: v?.version_no ?? 0,
        });
      }

      case 'content_type_save': {
        const raw = (body.content_type ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['key', 'label_ar', 'label_en', 'prefix', 'workflow_id',
                         'field_schema', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_content_types').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'content type not found');
        } else {
          if (!str(patch.key) || !str(patch.prefix)) return jsonError(400, 'key and prefix are required');
          const ins = await sb.from('mos_content_types').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_content_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ content_types: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Success-measure types — the managed registry a campaign's */
      /* success criteria are picked from (four presets seeded).   */
      /* -------------------------------------------------------- */
      case 'measure_types_list': {
        const list = await sb.from('mos_measure_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ measure_types: list.data ?? [] });
      }

      case 'measure_type_save': {
        const raw = (body.measure_type ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['key', 'label_ar', 'label_en', 'direction', 'unit', 'source',
                         'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // Direction / unit / source are constrained by the table CHECKs; normalize
        // here so a bad client value fails as a 400 rather than a raw DB error.
        if (patch.direction !== undefined && patch.direction !== 'higher' && patch.direction !== 'lower') {
          return jsonError(400, 'direction must be higher or lower');
        }
        if (patch.unit !== undefined && patch.unit !== 'count' && patch.unit !== 'currency' && patch.unit !== 'percent') {
          return jsonError(400, 'unit must be count, currency, or percent');
        }
        if (patch.source !== undefined && !MEASURE_SOURCES.includes(patch.source as string) && patch.source !== 'none') {
          return jsonError(400, 'source is not a valid measure source');
        }
        if (id) {
          // The key is the stable identity snapshotted onto campaigns — never
          // reslug an existing type.
          delete patch.key;
          const upd = await sb.from('mos_measure_types').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'measure type not found');
        } else {
          if (!str(patch.key) || !str(patch.label_ar) || !str(patch.label_en)) {
            return jsonError(400, 'key and both labels are required');
          }
          const ins = await sb.from('mos_measure_types').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_measure_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ measure_types: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Audiences — the managed registry the campaign brief's     */
      /* «الجمهور» is picked from (name + large details).          */
      /* -------------------------------------------------------- */
      case 'audiences_list': {
        const list = await sb.from('mos_audiences').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ audiences: list.data ?? [] });
      }

      case 'audience_save': {
        const raw = (body.audience ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'details', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `name` is the identity shown everywhere — never let it be blanked.
        if (Object.prototype.hasOwnProperty.call(patch, 'name') && !str(patch.name)) {
          return jsonError(400, 'name is required');
        }
        if (id) {
          const upd = await sb.from('mos_audiences').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'audience not found');
        } else {
          if (!str(patch.name)) return jsonError(400, 'name is required');
          patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_audiences').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_audiences').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ audiences: list.data ?? [] });
      }

      case 'account_save': {
        const raw = (body.account ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'handle', 'label_ar', 'label_en', 'sort_order'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `is_connected` / `can_publish` / `can_read_metrics` are deliberately NOT
        // editable here. Publishing stays manual until a real OAuth flow sets them;
        // a checkbox that claims a connection would be a lie in the UI.
        if (id) {
          const upd = await sb.from('mos_platform_accounts').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'account not found');
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          const ins = await sb.from('mos_platform_accounts').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_platform_accounts').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ accounts: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Projects — names for the brief, from the live CRM          */
      /* -------------------------------------------------------- */
      case 'projects_list': {
        // Our Projects only — a project is "ours" iff all_projects.is_public = true
        // (the same membership flag the website reads). The picker never offers the
        // ~1,000 market/all projects, only the 49 we actually run.
        const rows = await sb.from('v_all_projects').select('id, project_name')
          .eq('is_public', true)
          .order('project_name', { ascending: true }).limit(1000);
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ projects: rows.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Weekly numbers — everything published that has no reading  */
      /* since the given date. This is the Friday data-entry queue. */
      /* -------------------------------------------------------- */
      case 'metrics_queue': {
        const since = str(body.since)
          ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
        const pubs = await sb.from('mos_publication_v').select('*')
          .eq('status', 'published')
          .order('published_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(pubs.error);
        if (f) return f;

        const rows = (pubs.data ?? []) as unknown as Array<Row & { latest_captured_at: string | null }>;
        const ids = Array.from(new Set(rows.map((p) => p.content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: rows, titles, since });
      }

      /* -------------------------------------------------------- */
      /* Search — one box over every object type the caller may    */
      /* SEE. A hidden surface means its type is absent from both  */
      /* the results and the count chips: search never hints at    */
      /* something the sidebar doesn't show. Each hit carries the  */
      /* field that matched and a <mark>-wrapped excerpt.          */
      /* -------------------------------------------------------- */
      case 'search': {
        const raw = str(body.q);
        // PostgREST's `or=` is a comma/parenthesis-delimited grammar, so a term
        // containing those characters would produce a malformed filter rather
        // than a search. Strip them instead of shipping a broken query.
        const term = raw ? raw.replace(/[(),*]/g, ' ').trim() : null;

        const surf = await callerSurfaces(sb);
        if ('fail' in surf) return surf.fail;
        // Type → the surface that governs its visibility.
        const TYPE_SURFACE = {
          content: 'content',
          campaign: 'campaigns',
          asset: 'library',
          shoot: 'shoots',
        } as const;
        type SearchType = keyof typeof TYPE_SURFACE;
        const TYPE_ORDER: SearchType[] = ['content', 'campaign', 'asset', 'shoot'];
        const visible = TYPE_ORDER.filter((t) => surf.surfaces[TYPE_SURFACE[t]] !== 'hidden');

        if (!term) {
          return jsonOk({
            results: [],
            chips: visible.map((t) => ({ type: t, count: 0 })),
            content: [],
            campaigns: [],
            assets: [],
            shoots: [],
          });
        }
        const like = `%${term}%`;

        const [contentRes, campaignRes, assetRes, shootRes] = await Promise.all([
          visible.includes('content')
            ? sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS)
                .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like}`)
                .order('updated_at', { ascending: false }).limit(20)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('campaign')
            ? sb.from('mos_campaign_v').select('*')
                .is('archived_at', null).or(`name.ilike.${like},ref.ilike.${like},goal.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('asset')
            ? sb.from('mos_assets').select('*')
                .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like},note.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
          visible.includes('shoot')
            ? sb.from('mos_shoot_requests').select('*')
                .or(`title.ilike.${like},ref.ilike.${like},location.ilike.${like}`)
                .order('created_at', { ascending: false }).limit(10)
            : Promise.resolve({ data: [] as unknown[], error: null }),
        ]);
        const f = dbFail(contentRes.error) ?? dbFail(campaignRes.error)
          ?? dbFail(assetRes.error) ?? dbFail(shootRes.error);
        if (f) return f;

        interface SearchHit {
          type: SearchType;
          id: string;
          ref: string | null;
          title: string;
          thumb_url: string | null;
          match_reason: string;
          excerpt: string;
        }
        const hits: Record<SearchType, SearchHit[]> = { content: [], campaign: [], asset: [], shoot: [] };

        for (const r of (contentRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null]],
            term,
          );
          hits.content.push({
            type: 'content',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }
        for (const r of (campaignRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['name', r.name as string | null], ['ref', r.ref as string | null], ['goal', r.goal as string | null]],
            term,
          );
          hits.campaign.push({
            type: 'campaign',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.name as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }
        for (const r of (assetRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null], ['note', r.note as string | null]],
            term,
          );
          hits.asset.push({
            type: 'asset',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: (r.thumb_url as string | null) ?? (r.url as string | null) ?? null,
            ...m,
          });
        }
        for (const r of (shootRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
          const m = matchIn(
            [['title', r.title as string | null], ['ref', r.ref as string | null], ['location', r.location as string | null]],
            term,
          );
          hits.shoot.push({
            type: 'shoot',
            id: r.id as string,
            ref: (r.ref as string | null) ?? null,
            title: (r.title as string) ?? '',
            thumb_url: null,
            ...m,
          });
        }

        return jsonOk({
          results: TYPE_ORDER.flatMap((t) => hits[t]),
          chips: TYPE_ORDER.filter((t) => visible.includes(t))
            .map((t) => ({ type: t, count: hits[t].length })),
          // Legacy keys for the pre-s44 search page, populated ONLY for types
          // whose surface the caller may see ([] when hidden — the same rule
          // as results/chips). New UI consumes results/chips above.
          content: contentRes.data ?? [],
          campaigns: campaignRes.data ?? [],
          assets: assetRes.data ?? [],
          shoots: shootRes.data ?? [],
        });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}

/**
 * Saturday→Friday week containing `iso` (or today). The Saudi working week
 * starts on Sunday, but the publishing week the team plans around runs to
 * Friday, which is the day the numbers get entered.
 */
function weekBounds(iso: string | null): { weekStart: string; weekEnd: string } {
  const base = iso ? new Date(iso) : new Date();
  const day = base.getUTCDay(); // 0 = Sunday
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { weekStart: start.toISOString(), weekEnd: end.toISOString() };
}

/**
 * Screen 01/34's segmented periods. `week` is the publishing week above;
 * `month` / `quarter` / `year` are calendar UTC bounds, `[start, end)`.
 */
function periodBounds(
  period: 'week' | 'month' | 'quarter' | 'year',
  iso: string | null,
): { weekStart: string; weekEnd: string } {
  if (period === 'week') return weekBounds(iso);
  const base = iso ? new Date(iso) : new Date();
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  if (period === 'month') {
    return {
      weekStart: new Date(Date.UTC(y, m, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
    };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return {
      weekStart: new Date(Date.UTC(y, q, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, q + 3, 1)).toISOString(),
    };
  }
  return {
    weekStart: new Date(Date.UTC(y, 0, 1)).toISOString(),
    weekEnd: new Date(Date.UTC(y + 1, 0, 1)).toISOString(),
  };
}

/** The bounds of the period of the same length immediately before [start, end). */
function previousPeriodBounds(
  period: 'week' | 'month' | 'quarter' | 'year',
  iso: string | null,
): { weekStart: string; weekEnd: string } {
  const base = iso ? new Date(iso) : new Date();
  if (period === 'week') {
    const prev = new Date(base);
    prev.setUTCDate(base.getUTCDate() - 7);
    return weekBounds(prev.toISOString());
  }
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  if (period === 'month') {
    return {
      weekStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, m, 1)).toISOString(),
    };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return {
      weekStart: new Date(Date.UTC(y, q - 3, 1)).toISOString(),
      weekEnd: new Date(Date.UTC(y, q, 1)).toISOString(),
    };
  }
  return {
    weekStart: new Date(Date.UTC(y - 1, 0, 1)).toISOString(),
    weekEnd: new Date(Date.UTC(y, 0, 1)).toISOString(),
  };
}
