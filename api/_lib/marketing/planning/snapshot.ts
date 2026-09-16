/**
 * Load the WorkloadSnapshot and the RuleSet the scheduling engine plans against.
 *
 * This is the ONLY place SQL rows become engine types. Both the preview and the
 * commit call it, and the commit's SQL validator re-reads the very same view
 * (`mos_work_ledger_v`) — so "preview and commit use the same numbers" is not a
 * promise, it is the same query.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_CALENDAR, DEFAULTS, DEFAULT_WORKFLOWS, DEFAULT_ROW_PUBLISHING,
  LOAD_BUCKETS,
  type LedgerRow, type LoadBucket, type PathRole, type PersonCapacity,
  type PlatformRules, type RowPublishing, type StepSpec, type WorkCalendar, type WorkflowSpec,
  type WorkloadSnapshot,
} from '../../../../src/lib/marketingOS/scheduling/index.js';
import type { RuleSet } from '../../../../src/lib/marketingOS/scheduling/plan.js';

const MOS_ROLES: PathRole[] = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'];
const BUCKETS = LOAD_BUCKETS;

/** Civil "today" in Riyadh — the same helper `api/marketing-os.ts` already uses. */
export function riyadhToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export interface PlanningSettings {
  publishBufferDays: number;
  manualTaskWeight: number;
  approvalsCapPerDay: number;
  weekendDays: number[];
  searchBudget: number;
  previewEnabled: boolean;
  reservationsEnforced: boolean;
  refreshLoopEnabled: boolean;
  autoApplyDefaultDecision: boolean;
  minActiveCreatives: number;
  adsCreatedPaused: boolean;
  /** Release settings — see `src/lib/marketingOS/scheduling/releases.ts`. */
  releaseAutoPublish: boolean;
  releaseEffortDays: number;
  releaseOwnerRole: string;
  releaseManualPlatforms: string[];
}

export const PLANNING_DEFAULTS: PlanningSettings = {
  publishBufferDays: DEFAULTS.publishBufferDays,
  manualTaskWeight: DEFAULTS.manualTaskWeight,
  approvalsCapPerDay: DEFAULTS.approvalsCapPerDay,
  weekendDays: [5],
  searchBudget: DEFAULTS.searchBudget,
  previewEnabled: true,
  reservationsEnforced: true,
  refreshLoopEnabled: true,
  autoApplyDefaultDecision: false,
  minActiveCreatives: 5,
  adsCreatedPaused: true,
  releaseAutoPublish: true,
  releaseEffortDays: 0.25,
  releaseOwnerRole: 'mos_writer',
  releaseManualPlatforms: [],
};

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export async function loadPlanningSettings(sb: SupabaseClient): Promise<PlanningSettings> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'planning').maybeSingle();
  if (error) {
    console.error('[planning] mos_settings.planning read failed', error.code, error.message);
    return PLANNING_DEFAULTS;
  }
  const v = (data as { value?: Record<string, unknown> } | null)?.value ?? {};
  const wd = Array.isArray(v.weekend_days)
    ? (v.weekend_days as unknown[]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6)
    : PLANNING_DEFAULTS.weekendDays;
  return {
    publishBufferDays: num(v.publish_buffer_days, PLANNING_DEFAULTS.publishBufferDays),
    manualTaskWeight: num(v.manual_task_weight, PLANNING_DEFAULTS.manualTaskWeight),
    approvalsCapPerDay: num(v.approvals_cap_per_day, PLANNING_DEFAULTS.approvalsCapPerDay),
    weekendDays: wd.length ? wd : PLANNING_DEFAULTS.weekendDays,
    searchBudget: num(v.search_budget, PLANNING_DEFAULTS.searchBudget),
    previewEnabled: bool(v.preview_enabled, true),
    reservationsEnforced: bool(v.reservations_enforced, true),
    refreshLoopEnabled: bool(v.refresh_loop_enabled, true),
    autoApplyDefaultDecision: bool(v.auto_apply_default_decision, false),
    minActiveCreatives: num(v.min_active_creatives, 5),
    adsCreatedPaused: bool(v.ads_created_paused, true),
    releaseAutoPublish: bool(v.release_auto_publish, true),
    releaseEffortDays: num(v.release_effort_days, 0.25),
    releaseOwnerRole: typeof v.release_owner_role === 'string' ? v.release_owner_role : 'mos_writer',
    releaseManualPlatforms: Array.isArray(v.release_manual_platforms)
      ? v.release_manual_platforms.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* snapshot                                                            */
/* ------------------------------------------------------------------ */

interface RoleRow { id: string; key: string }
interface UserRow { id: string; is_active: boolean | null; role_assignments: unknown }
interface CapRow { user_id: string; bucket: string; daily_slots: number }
interface RoleLoadRow { role_id: string; bucket: string; daily_new_tasks: number }
interface LeaveRow { user_id: string; start_at: string; end_at: string }
interface LedgerViewRow {
  user_id: string; day: string; bucket: string; weight: number;
  source: string; ref_id: string | null;
}

export async function loadWorkCalendar(
  sb: SupabaseClient, settings: PlanningSettings,
): Promise<WorkCalendar> {
  const { data, error } = await sb.from('mos_holidays').select('day').order('day');
  if (error) {
    // A missing holiday table must not silently produce a WRONG calendar —
    // surface it and fall back to "no holidays", which is the pre-existing
    // behaviour, so the plan is conservative rather than optimistic.
    console.error('[planning] mos_holidays read failed', error.code, error.message);
  }
  return {
    ...DEFAULT_CALENDAR,
    weekendDays: settings.weekendDays as WorkCalendar['weekendDays'],
    holidays: ((data as Array<{ day: string }> | null) ?? []).map((r) => r.day),
  };
}

export async function loadWorkloadSnapshot(
  sb: SupabaseClient, settings: PlanningSettings,
): Promise<WorkloadSnapshot> {
  const today = riyadhToday();
  const calendar = await loadWorkCalendar(sb, settings);

  const [rolesRes, usersRes, capsRes, roleLoadRes, leavesRes, ledgerRes, hashRes] = await Promise.all([
    sb.from('roles').select('id, key').eq('domain', 'marketing'),
    sb.from('users').select('id, is_active, role_assignments').eq('is_active', true),
    sb.from('mos_user_capacity').select('user_id, bucket, daily_slots'),
    sb.from('mos_role_load').select('role_id, bucket, daily_new_tasks'),
    sb.from('mos_leaves').select('user_id, start_at, end_at').eq('status', 'approved'),
    sb.from('mos_work_ledger_v').select('user_id, day, bucket, weight, source, ref_id'),
    sb.rpc('mos_workload_snapshot_hash'),
  ]);

  for (const [label, res] of [
    ['roles', rolesRes], ['users', usersRes], ['mos_user_capacity', capsRes],
    ['mos_role_load', roleLoadRes], ['mos_leaves', leavesRes],
    ['mos_work_ledger_v', ledgerRes], ['mos_workload_snapshot_hash', hashRes],
  ] as const) {
    if (res.error) {
      console.error(`[planning] snapshot ${label} failed`, res.error.code, res.error.message);
      throw new Error(`snapshot ${label} failed: ${res.error.message}`);
    }
  }

  const roles = (rolesRes.data as RoleRow[]) ?? [];
  const roleKeyById = new Map(roles.map((r) => [r.id, r.key.replace(/^mos_/, '') as PathRole]));
  const roleIdByKey = new Map(roles.map((r) => [r.key.replace(/^mos_/, '') as PathRole, r.id]));

  const roleLoad = new Map<string, number>();
  for (const r of (roleLoadRes.data as RoleLoadRow[]) ?? []) {
    roleLoad.set(`${r.role_id}|${r.bucket}`, r.daily_new_tasks);
  }
  const overrides = new Map<string, number>();
  for (const c of (capsRes.data as CapRow[]) ?? []) overrides.set(`${c.user_id}|${c.bucket}`, c.daily_slots);

  const leavesByUser = new Map<string, Array<{ from: string; to: string }>>();
  for (const l of (leavesRes.data as LeaveRow[]) ?? []) {
    const arr = leavesByUser.get(l.user_id) ?? [];
    arr.push({ from: l.start_at.slice(0, 10), to: l.end_at.slice(0, 10) });
    leavesByUser.set(l.user_id, arr);
  }

  const people: PersonCapacity[] = [];
  for (const u of (usersRes.data as UserRow[]) ?? []) {
    const assigned = Array.isArray(u.role_assignments) ? u.role_assignments : [];
    const held: PathRole[] = [];
    for (const a of assigned as Array<{ role_id?: string }>) {
      const key = a?.role_id ? roleKeyById.get(a.role_id) : undefined;
      if (key && MOS_ROLES.includes(key) && !held.includes(key)) held.push(key);
    }
    if (!held.length) continue;
    const caps: Partial<Record<LoadBucket, number>> = {};
    for (const bucket of BUCKETS) {
      const override = overrides.get(`${u.id}|${bucket}`);
      if (override != null) { caps[bucket] = override; continue; }
      if (bucket === 'approvals') {
        // Every role that performs approvals gets the shared approvals budget.
        caps.approvals = settings.approvalsCapPerDay;
        continue;
      }
      let best = 0;
      for (const role of held) {
        const rid = roleIdByKey.get(role);
        if (!rid) continue;
        best = Math.max(best, roleLoad.get(`${rid}|${bucket}`) ?? 0);
      }
      caps[bucket] = best;
    }
    people.push({ userId: u.id, roles: held, caps, leaves: leavesByUser.get(u.id) ?? [] });
  }
  people.sort((a, b) => (a.userId < b.userId ? -1 : 1));

  const ledger: LedgerRow[] = ((ledgerRes.data as LedgerViewRow[]) ?? [])
    .filter((r) => r.day >= today)
    .map((r) => ({
      userId: r.user_id,
      day: r.day,
      bucket: (BUCKETS.includes(r.bucket as LoadBucket) ? r.bucket : 'post') as LoadBucket,
      weight: Number(r.weight) || 0,
      source: (r.source === 'reservation' || r.source === 'manual' ? r.source : 'task') as LedgerRow['source'],
      refId: r.ref_id,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1
      : a.userId < b.userId ? -1 : a.userId > b.userId ? 1
        : a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const hash = typeof hashRes.data === 'string' ? hashRes.data : String(hashRes.data ?? '');
  return { today, calendar, people, ledger, hash };
}

/* ------------------------------------------------------------------ */
/* rules                                                              */
/* ------------------------------------------------------------------ */

/**
 * The month template's publishing moment, as the engine's `RowPublishing`.
 *
 * Exported and pure so the round-trip is testable without a Supabase client.
 * `publish_time` is a Postgres `time`, so it arrives as `18:00:00` or
 * `18:00:00+03` and must be trimmed to `HH:MM`; the engine validates the result
 * and raises a `publish_time` conflict rather than substituting a default
 * silently (see `checkRowPublishing`).
 *
 * WHY THIS EXISTS AT ALL: `loadRuleSet` built `publishing` with six keys and
 * `rowPublishing` was not one of them, so `planCampaign` fell back to
 * `DEFAULT_ROW_PUBLISHING` — 18:00 / 5 minutes. `compileMonth` set it from the
 * template, so the PREVIEW showed the operator's time; `campaignPlanCommit`
 * re-planned through `loadRuleSet`, so the COMMIT wrote 18:00. Measured with
 * `publish_time = 19:30`, `intra_row_gap_minutes = 10`: preview 19:30/19:40/19:50,
 * commit 18:00/18:05/18:10, and the plan signature declared them identical
 * because it keyed on `(day, slotIndex)` and never on the moment. No 409, no
 * diff, no toast — the operator approves one time and the database stores
 * another.
 */
export function rowPublishingFromTemplateRow(
  row: Record<string, unknown> | null | undefined,
): RowPublishing {
  if (!row) return DEFAULT_ROW_PUBLISHING;
  const raw = String(row.publish_time ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(raw);
  const gap = Number(row.intra_row_gap_minutes);
  return {
    publishTime: m
      ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`
      // NOT silently defaulted: a non-empty value that does not parse is passed
      // through verbatim so `checkRowPublishing` reports it as bad operator
      // data. Only a genuinely absent column falls back.
      : (raw || DEFAULT_ROW_PUBLISHING.publishTime),
    intraRowGapMinutes: Number.isFinite(gap) && gap >= 0
      ? Math.floor(gap) : DEFAULT_ROW_PUBLISHING.intraRowGapMinutes,
  };
}

interface EffortRow { workflow_key: string; step_key: string; bucket: string; working_days: number }
interface ContentTypeRow { key: string; workflow_id: string | null }
interface WorkflowRow { id: string; metadata: unknown }
interface BucketRow { content_type_id: string; bucket: string }

/**
 * Build the RuleSet from the live workflows + `mos_step_effort`.
 *
 * Effort NEVER comes from a step's `due_days` — that is a deadline allowance,
 * not an estimate of the work. A step with no effort row falls back to the
 * engine's seeded default, and 1 working day beyond that.
 */
export async function loadRuleSet(
  sb: SupabaseClient, settings: PlanningSettings,
): Promise<RuleSet> {
  const [wfRes, typeRes, effortRes, bucketRes, execRes, autoRes, acctRes, tmplRes] = await Promise.all([
    sb.from('workflows').select('id, metadata').eq('kind', 'role_path'),
    sb.from('mos_content_types').select('id, key, workflow_id').is('archived_at', null),
    sb.from('mos_step_effort').select('workflow_key, step_key, bucket, working_days'),
    sb.from('mos_load_buckets').select('content_type_id, bucket'),
    sb.from('mos_campaign_executions').select('platform, publishing_rules').not('publishing_rules', 'is', null),
    // Which destinations can publish by themselves RIGHT NOW. Read from the
    // database, never guessed from the platform name: "instagram" says nothing
    // about whether this tenant's Instagram is connected. If this call fails the
    // map stays empty, and an empty map means every release needs a person —
    // the safe direction, because the opposite would promise a publish that
    // nothing can perform.
    sb.rpc('mos_platform_automatable_map'),
    sb.from('mos_platform_accounts')
      .select('platform, id, can_publish, is_connected')
      .is('archived_at', null),
    // The month template's publishing moment. The COMMIT re-plans through this
    // function, so a row's publish time must be readable here or the commit
    // silently reverts the whole month to the engine default — see
    // `rowPublishingFromTemplateRow`.
    sb.from('mos_month_template').select('publish_time, intra_row_gap_minutes').maybeSingle(),
  ]);
  for (const [label, res] of [
    ['workflows', wfRes], ['mos_content_types', typeRes],
    ['mos_step_effort', effortRes], ['mos_load_buckets', bucketRes],
  ] as const) {
    if (res.error) {
      console.error(`[planning] rules ${label} failed`, res.error.code, res.error.message);
      throw new Error(`rules ${label} failed: ${res.error.message}`);
    }
  }

  const effort = new Map<string, number>();
  for (const e of (effortRes.data as EffortRow[]) ?? []) {
    effort.set(`${e.workflow_key}|${e.step_key}|${e.bucket}`, Number(e.working_days));
  }

  const workflows: Record<string, WorkflowSpec> = {};
  const wfKeyById = new Map<string, string>();
  for (const w of (wfRes.data as WorkflowRow[]) ?? []) {
    const meta = (w.metadata ?? {}) as { key?: string; steps?: unknown };
    const wfKey = typeof meta.key === 'string' ? meta.key : w.id;
    wfKeyById.set(w.id, wfKey);
    const rawSteps = Array.isArray(meta.steps) ? meta.steps : [];
    const seed = DEFAULT_WORKFLOWS[wfKey];
    const bucket: 'post' | 'video' = seed?.bucket ?? (/video/i.test(wfKey) ? 'video' : 'post');
    const steps: StepSpec[] = rawSteps.map((raw) => {
      const s = raw as Record<string, unknown>;
      const key = String(s.key ?? '');
      const seededStep = seed?.steps.find((x) => x.key === key);
      const isApproval = Boolean(s.is_approval);
      const afterReady = /schedul|publish|جدول|نشر/i.test(key);
      const eff = effort.get(`${wfKey}|${key}|${bucket}`)
        ?? effort.get(`${wfKey}|${key}|*`)
        ?? seededStep?.workingDays
        ?? 1;
      return {
        key,
        roleKey: String(s.role_key ?? 'writer') as PathRole,
        isApproval,
        workingDays: eff,
        afterReady,
        labelAr: String(s.label_ar ?? key),
        labelEn: String(s.label_en ?? key),
      };
    }).filter((s) => s.key);
    // `sameDayChain` is a property of the PATH, and the live row carries no such
    // field — so it comes from the seed. Dropping it here would silently put
    // every post back on one-step-per-day in production while tests (which
    // read the seed directly) kept passing.
    if (steps.length) {
      workflows[wfKey] = {
        workflowKey: wfKey, bucket, steps,
        ...(seed?.sameDayChain ? { sameDayChain: true } : {}),
      };
    }
  }
  // Seeds cover offline / fresh-DB cases; live rows always win.
  for (const [k, v] of Object.entries(DEFAULT_WORKFLOWS)) if (!workflows[k]) workflows[k] = v;

  const bucketByTypeId = new Map<string, 'post' | 'video'>();
  for (const b of (bucketRes.data as BucketRow[]) ?? []) {
    bucketByTypeId.set(b.content_type_id, b.bucket === 'video' ? 'video' : 'post');
  }
  const contentTypeWorkflow: Record<string, string> = {};
  const contentTypeBucket: Record<string, 'post' | 'video'> = {};
  for (const t of (typeRes.data as Array<ContentTypeRow & { id: string }>) ?? []) {
    const wfKey = t.workflow_id ? wfKeyById.get(t.workflow_id) : undefined;
    if (wfKey) contentTypeWorkflow[t.key] = wfKey;
    contentTypeBucket[t.key] = bucketByTypeId.get(t.id) ?? (t.key === 'video' ? 'video' : 'post');
  }

  const platformOverrides: Record<string, Partial<PlatformRules>> = {};
  for (const e of (execRes.data as Array<{ platform: string; publishing_rules: unknown }> | null) ?? []) {
    if (e.publishing_rules && typeof e.publishing_rules === 'object') {
      platformOverrides[e.platform] = e.publishing_rules as Partial<PlatformRules>;
    }
  }

  const automatable: Record<string, boolean> = {};
  const raw = autoRes.data as Record<string, unknown> | null;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) automatable[k] = v === true;
  }
  // The operator's manual list wins over connectivity: a platform kept manual on
  // purpose must not quietly start auto-posting because someone connected it.
  for (const p of settings.releaseManualPlatforms) automatable[p] = false;

  // A missing template row is a legitimate state (the month model is not
  // switched on yet) and falls back to the engine default. A FAILED read is
  // not: it would revert every committed row to 18:00 with no signal, so it is
  // surfaced rather than swallowed — the same posture `loadWorkCalendar` takes.
  if (tmplRes.error) {
    console.error('[planning] mos_month_template read failed', tmplRes.error.code, tmplRes.error.message);
  }
  const rowPublishing = rowPublishingFromTemplateRow(
    (tmplRes.data as Record<string, unknown> | null) ?? null,
  );

  const accountByPlatform: Record<string, string | null> = {};
  for (const a of (acctRes.data as Array<{ platform: string; id: string; can_publish: boolean | null }> | null) ?? []) {
    if (accountByPlatform[a.platform] === undefined || a.can_publish === true) {
      accountByPlatform[a.platform] = a.id;
    }
  }

  return {
    workflows,
    contentTypeWorkflow,
    contentTypeBucket,
    platformOverrides,
    publishing: {
      automatable,
      manualByPolicy: settings.releaseManualPlatforms,
      releaseEffortDays: settings.releaseEffortDays,
      organicOwnerRole: roleKeyToPathRole(settings.releaseOwnerRole),
      adOwnerRole: 'marketing_manager',
      accountByPlatform,
      rowPublishing,
    },
    searchBudget: settings.searchBudget,
  };
}

/** `mos_writer` → `writer`. Unknown keys fall back to the writer, who owned the
 *  old `scheduling` step, so a typo cannot silently orphan every release. */
function roleKeyToPathRole(key: string): PathRole {
  const bare = key.replace(/^mos_/, '');
  const known: PathRole[] = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'];
  return known.includes(bare as PathRole) ? (bare as PathRole) : 'writer';
}
