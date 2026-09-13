/**
 * Campaign planning actions — preview, revise, commit, and the reads around them.
 *
 * The commit protocol (plan v2.1 §4.4) in one place, because it is the part
 * that must be exactly right:
 *
 *   1. TypeScript re-plans against the LIVE ledger (the same `planCampaign` the
 *      preview ran, so a drift is detectable rather than silently absorbed).
 *   2. If that re-plan differs from the stored proposal, nothing is written:
 *      the fresh plan is stored as a new revision and the caller gets 409
 *      `plan_changed` with a human-readable diff.
 *   3. Otherwise `mos_campaign_plan_commit` runs the write inside ONE
 *      transaction that (a) takes `pg_advisory_xact_lock(hashtext('mos_work_ledger'))`
 *      — the lock every other ledger writer also takes — (b) re-checks the
 *      snapshot hash, (c) INDEPENDENTLY re-sums every touched (user, day,
 *      bucket) against capacity in SQL, and only then (d) materialises.
 *
 * Two campaign approvals therefore cannot both book the same designer day: the
 * second one either sees a changed hash or fails the SQL capacity re-check, and
 * in both cases it is re-planned rather than clobbering.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import {
  planCampaign, DEFAULT_RULES,
  type PlanInput, type PlanResult,
} from '../../../../src/lib/marketingOS/scheduling/index.js';
import { loadPlanningSettings, loadRuleSet, loadWorkloadSnapshot, riyadhToday } from './snapshot.js';

export interface PlanCtx {
  sb: SupabaseClient;
  svc: SupabaseClient | null;
  body: Record<string, unknown>;
  userId: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

function fail(where: string, e: { code?: string; message: string; details?: string } | null): Response {
  console.error(`[planning] ${where} failed`, e?.code, e?.message, e?.details);
  return jsonError(500, e?.message ?? `${where} failed`);
}

/** A canonical fingerprint of everything a human approved: who, when, where. */
export function planSignature(plan: PlanResult): string {
  const stages = plan.items.flatMap((i) =>
    i.stages.map((s) => `${i.key}|${s.stepKey}|${s.assigneeUserId ?? '-'}|${s.start}|${s.end}`));
  const places = plan.items.flatMap((i) =>
    i.placements.map((p) => `${i.key}@${p.platform}|${p.day}|${p.slotIndex}`));
  return [...stages, ...places].sort().join('\n');
}

/** Human-readable difference between two plans, for the 409 body. */
function diffPlans(before: PlanResult, after: PlanResult): Array<{ item: string; was: string; now: string }> {
  const idx = (p: PlanResult): Map<string, string> => {
    const m = new Map<string, string>();
    for (const i of p.items) {
      for (const s of i.stages) m.set(`${i.key}|${s.stepKey}`, `${s.assigneeUserId ?? '-'} ${s.start}→${s.end}`);
    }
    return m;
  };
  const a = idx(before);
  const b = idx(after);
  const out: Array<{ item: string; was: string; now: string }> = [];
  for (const [k, was] of a) {
    const now = b.get(k);
    if (now !== was) out.push({ item: k, was, now: now ?? '—' });
  }
  for (const [k, now] of b) if (!a.has(k)) out.push({ item: k, was: '—', now });
  return out.slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* input parsing                                                       */
/* ------------------------------------------------------------------ */

function parsePlanInput(raw: Record<string, unknown>, publishBufferDays: number): PlanInput | string {
  const kind = raw.kind === 'paid' ? 'paid' : 'organic';
  const rangeStart = str(raw.range_start);
  const rangeEnd = str(raw.range_end);
  if (!rangeStart || !rangeEnd) return 'range_start and range_end are required';

  const projects = Array.isArray(raw.projects) ? raw.projects.map((p) => {
    const r = asRecord(p);
    return {
      projectId: String(r.project_id ?? ''),
      projectName: str(r.project_name) ?? undefined,
      posts: Math.max(0, Math.floor(Number(r.posts ?? 0) || 0)),
      videos: Math.max(0, Math.floor(Number(r.videos ?? 0) || 0)),
    };
  }).filter((p) => p.projectId) : [];
  if (!projects.length) return 'at least one project is required';

  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.map((p) => String(p)).filter(Boolean) : [];
  if (kind === 'organic' && !platforms.length) return 'at least one platform is required';

  const frequency = Array.isArray(raw.frequency) ? raw.frequency.map((f) => {
    const r = asRecord(f);
    return {
      platform: String(r.platform ?? ''),
      perDay: Math.max(1, Math.floor(Number(r.per_day ?? 1) || 1)),
      weekdays: Array.isArray(r.weekdays)
        ? (r.weekdays as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        : null,
      times: Array.isArray(r.times) ? (r.times as unknown[]).map(String) : undefined,
    };
  }).filter((f) => f.platform) : [];

  const paid = Array.isArray(raw.paid) ? raw.paid.map((c) => {
    const r = asRecord(c);
    const pol = asRecord(r.policy);
    return {
      executionKey: String(r.execution_key ?? `exec:${String(r.platform ?? 'meta')}`),
      executionId: str(r.execution_id),
      platform: String(r.platform ?? 'meta'),
      policy: {
        slateSize: Math.max(1, Number(pol.slate_size ?? 5)),
        keepMin: Math.max(0, Number(pol.keep_min ?? 1)),
        cycleDays: Math.max(1, Number(pol.cycle_days ?? 7)),
        minRemainingDays: Math.max(0, Number(pol.min_remaining_days ?? 3)),
        leadTimeWorkingDays: Math.max(1, Number(pol.lead_time_working_days ?? 7)),
        fifthPolicy: pol.fifth_policy === 'B' ? 'B' as const : 'A' as const,
        bankedSpares: Array.isArray(pol.banked_spares) ? (pol.banked_spares as unknown[]).map((b) => {
          const rb = asRecord(b);
          return { slotId: String(rb.slot_id ?? ''), availableFrom: String(rb.available_from ?? '') };
        }).filter((b) => b.slotId && b.availableFrom) : [],
      },
    };
  }) : [];

  const ov = asRecord(raw.overrides);
  return {
    campaignId: str(raw.campaign_id),
    campaignRef: str(raw.campaign_ref) ?? undefined,
    kind,
    projects,
    platforms,
    rangeStart,
    rangeEnd,
    frequency,
    crossPost: Boolean(raw.cross_post),
    publishBufferDays: Number.isFinite(Number(raw.publish_buffer_days))
      ? Number(raw.publish_buffer_days) : publishBufferDays,
    paid: kind === 'paid' ? paid : undefined,
    overrides: {
      lockedPlacements: Array.isArray(ov.locked_placements) ? (ov.locked_placements as unknown[]).map((l) => {
        const r = asRecord(l);
        return {
          itemKey: String(r.item_key ?? ''), platform: String(r.platform ?? ''),
          day: String(r.day ?? ''), index: Math.max(0, Number(r.index ?? 0)),
        };
      }).filter((l) => l.itemKey && l.day) : undefined,
      lockedAssignees: asRecord(ov.locked_assignees) as Record<string, string>,
      droppedItemKeys: Array.isArray(ov.dropped_item_keys)
        ? (ov.dropped_item_keys as unknown[]).map(String) : undefined,
    },
  };
}

/** Everything the SQL commit needs to create rows, in snake_case. */
function materialisePayload(input: PlanInput, plan: PlanResult): Record<string, unknown> {
  return {
    campaign_id: input.campaignId,
    kind: input.kind,
    range_start: input.rangeStart,
    range_end: input.rangeEnd,
    cross_post: input.crossPost,
    executions: (input.kind === 'paid'
      ? (input.paid ?? []).map((c) => ({
        key: c.executionKey, platform: c.platform, execution_id: c.executionId,
        refresh_policy: {
          slate_size: c.policy.slateSize, keep_min: c.policy.keepMin,
          cycle_days: c.policy.cycleDays, min_remaining_days: c.policy.minRemainingDays,
          lead_time_working_days: c.policy.leadTimeWorkingDays, fifth_policy: c.policy.fifthPolicy,
        },
      }))
      : input.platforms.map((p) => ({
        key: `exec:${p}`, platform: p, execution_id: null,
        publishing_rules: input.frequency.find((f) => f.platform === p) ?? null,
      }))),
    items: plan.items.map((i) => ({
      key: i.key,
      title: i.title,
      content_type_key: i.contentTypeKey,
      project_id: i.projectId,
      workflow_key: i.workflowKey,
      need_at: i.needAt,
      required_ready_at: i.requiredReadyAt,
      production_start: i.productionStart,
      priority: i.priority,
      stage_deadlines: Object.fromEntries(i.stages.map((s) => [s.stepKey, s.deadline])),
      stage_assignees: Object.fromEntries(i.stages.map((s) => [s.stepKey, s.assigneeUserId])),
      placements: i.placements.map((p) => ({
        platform: p.platform, execution_key: p.executionKey, planned_at: p.plannedAt,
        day: p.day, batch_key: p.batchKey, slot_index: p.slotIndex,
        grid_row: p.gridRow, grid_col: p.gridCol,
      })),
      slot: i.slot ? {
        execution_key: i.slot.executionKey, cycle_round: i.slot.cycleRound,
        slot_index: i.slot.slotIndex, kind: i.slot.kind,
      } : null,
    })),
    batches: plan.batches.map((b) => ({
      key: b.key, execution_key: b.executionKey, platform: b.platform,
      day: b.day, sequence: b.sequence, item_keys: b.itemKeys,
    })),
    cycles: plan.cycles.map((c) => ({
      execution_key: c.executionKey, round: c.round, refresh_on: c.refreshOn,
      ready_by: c.readyBy, production_start_on: c.productionStartOn,
      decision_due_on: c.decisionDueOn, produced: c.produced,
      banked_spare_slot_id: c.bankedSpareSlotId,
    })),
  };
}

function reservationsPayload(plan: PlanResult): unknown[] {
  return plan.reservations.map((r) => ({
    item_key: r.itemKey, step_key: r.stepKey, role_key: r.roleKey, bucket: r.bucket,
    assignee_user_id: r.assigneeUserId, planned_start: r.plannedStart,
    planned_end: r.plannedEnd, weight: r.weight,
  }));
}

/* ------------------------------------------------------------------ */
/* campaign_plan_preview                                               */
/* ------------------------------------------------------------------ */

export async function campaignPlanPreview(ctx: PlanCtx): Promise<Response> {
  const settings = await loadPlanningSettings(ctx.sb);
  if (!settings.previewEnabled) return jsonError(503, 'campaign planning preview is switched off');

  const parsed = parsePlanInput(asRecord(ctx.body.input), settings.publishBufferDays);
  if (typeof parsed === 'string') return jsonError(400, parsed);

  let snapshot; let rules;
  try {
    [snapshot, rules] = await Promise.all([
      loadWorkloadSnapshot(ctx.sb, settings),
      loadRuleSet(ctx.sb, settings),
    ]);
  } catch (e) {
    return fail('snapshot/rules', { message: e instanceof Error ? e.message : String(e) });
  }

  const plan = planCampaign(parsed, snapshot, rules ?? DEFAULT_RULES);

  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');
  const { data, error } = await svc.from('mos_campaign_plans').insert({
    campaign_id: parsed.campaignId,
    status: 'proposed',
    input: parsed as unknown as Record<string, unknown>,
    plan: plan as unknown as Record<string, unknown>,
    feasibility: {
      feasible: plan.feasible,
      infeasible_proof: plan.infeasibleProof,
      search_incomplete: plan.searchIncomplete,
      conflicts: plan.conflicts,
      alternatives: plan.alternatives,
    },
    snapshot_hash: plan.snapshotHash,
    engine_version: plan.engineVersion,
    created_by_user_id: ctx.userId,
  }).select('id').single();
  if (error) return fail('mos_campaign_plans insert', error);

  return jsonOk({
    plan_id: (data as { id: string }).id,
    plan,
    people: snapshot.people,
    today: snapshot.today,
    calendar: snapshot.calendar,
  });
}

/* ------------------------------------------------------------------ */
/* campaign_plan_revise                                                */
/* ------------------------------------------------------------------ */

export async function campaignPlanRevise(ctx: PlanCtx): Promise<Response> {
  const planId = str(ctx.body.plan_id);
  if (!planId) return jsonError(400, 'plan_id is required');
  const settings = await loadPlanningSettings(ctx.sb);

  const { data: row, error } = await ctx.sb
    .from('mos_campaign_plans').select('id, status, input').eq('id', planId).maybeSingle();
  if (error) return fail('mos_campaign_plans read', error);
  if (!row) return jsonError(404, 'plan not found');
  if ((row as { status: string }).status !== 'proposed') {
    return jsonError(409, 'only a proposed plan can be revised');
  }

  const stored = asRecord((row as { input: unknown }).input);
  const overrides = asRecord(ctx.body.overrides);
  const merged = { ...stored, overrides: { ...asRecord(stored.overrides), ...overrides } };
  const parsed = parsePlanInput(toSnake(merged), settings.publishBufferDays);
  if (typeof parsed === 'string') return jsonError(400, parsed);

  let snapshot; let rules;
  try {
    [snapshot, rules] = await Promise.all([
      loadWorkloadSnapshot(ctx.sb, settings),
      loadRuleSet(ctx.sb, settings),
    ]);
  } catch (e) {
    return fail('snapshot/rules', { message: e instanceof Error ? e.message : String(e) });
  }
  const plan = planCampaign(parsed, snapshot, rules ?? DEFAULT_RULES);

  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');
  const { error: upErr } = await svc.from('mos_campaign_plans').update({
    input: parsed as unknown as Record<string, unknown>,
    plan: plan as unknown as Record<string, unknown>,
    feasibility: {
      feasible: plan.feasible, infeasible_proof: plan.infeasibleProof,
      search_incomplete: plan.searchIncomplete, conflicts: plan.conflicts,
      alternatives: plan.alternatives,
    },
    snapshot_hash: plan.snapshotHash,
  }).eq('id', planId);
  if (upErr) return fail('mos_campaign_plans update', upErr);

  return jsonOk({ plan_id: planId, plan, people: snapshot.people, today: snapshot.today });
}

/** The stored input is already camelCase (it is a PlanInput); re-key for the parser. */
function toSnake(input: Record<string, unknown>): Record<string, unknown> {
  return {
    campaign_id: input.campaignId,
    campaign_ref: input.campaignRef,
    kind: input.kind,
    projects: Array.isArray(input.projects) ? (input.projects as unknown[]).map((p) => {
      const r = asRecord(p);
      return { project_id: r.projectId, project_name: r.projectName, posts: r.posts, videos: r.videos };
    }) : [],
    platforms: input.platforms,
    range_start: input.rangeStart,
    range_end: input.rangeEnd,
    frequency: Array.isArray(input.frequency) ? (input.frequency as unknown[]).map((f) => {
      const r = asRecord(f);
      return { platform: r.platform, per_day: r.perDay, weekdays: r.weekdays, times: r.times };
    }) : [],
    cross_post: input.crossPost,
    publish_buffer_days: input.publishBufferDays,
    paid: Array.isArray(input.paid) ? (input.paid as unknown[]).map((c) => {
      const r = asRecord(c);
      const pol = asRecord(r.policy);
      return {
        execution_key: r.executionKey, execution_id: r.executionId, platform: r.platform,
        policy: {
          slate_size: pol.slateSize, keep_min: pol.keepMin, cycle_days: pol.cycleDays,
          min_remaining_days: pol.minRemainingDays,
          lead_time_working_days: pol.leadTimeWorkingDays, fifth_policy: pol.fifthPolicy,
          banked_spares: Array.isArray(pol.bankedSpares) ? (pol.bankedSpares as unknown[]).map((b) => {
            const rb = asRecord(b);
            return { slot_id: rb.slotId, available_from: rb.availableFrom };
          }) : [],
        },
      };
    }) : [],
    overrides: (() => {
      const ov = asRecord(input.overrides);
      return {
        locked_placements: Array.isArray(ov.lockedPlacements) ? (ov.lockedPlacements as unknown[]).map((l) => {
          const r = asRecord(l);
          return { item_key: r.itemKey, platform: r.platform, day: r.day, index: r.index };
        }) : [],
        locked_assignees: ov.lockedAssignees ?? {},
        dropped_item_keys: ov.droppedItemKeys ?? [],
      };
    })(),
  };
}

/* ------------------------------------------------------------------ */
/* campaign_plan_commit                                                */
/* ------------------------------------------------------------------ */

export async function campaignPlanCommit(ctx: PlanCtx): Promise<Response> {
  const planId = str(ctx.body.plan_id);
  if (!planId) return jsonError(400, 'plan_id is required');
  const settings = await loadPlanningSettings(ctx.sb);
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');

  const { data: row, error } = await ctx.sb.from('mos_campaign_plans')
    .select('id, campaign_id, status, input, plan, snapshot_hash').eq('id', planId).maybeSingle();
  if (error) return fail('mos_campaign_plans read', error);
  if (!row) return jsonError(404, 'plan not found');
  const stored = row as {
    id: string; campaign_id: string | null; status: string;
    input: Record<string, unknown>; plan: PlanResult; snapshot_hash: string;
  };
  if (stored.status === 'approved') {
    // Idempotent: committing the same plan twice is a no-op, not an error.
    return jsonOk({ ok: true, plan_id: planId, already_approved: true });
  }
  if (stored.status !== 'proposed') return jsonError(409, `plan is ${stored.status}`);

  const parsed = parsePlanInput(toSnake(stored.input), settings.publishBufferDays);
  if (typeof parsed === 'string') return jsonError(400, parsed);

  // ---- step 1: re-plan against the LIVE ledger, with the same engine.
  let snapshot; let rules;
  try {
    [snapshot, rules] = await Promise.all([
      loadWorkloadSnapshot(ctx.sb, settings),
      loadRuleSet(ctx.sb, settings),
    ]);
  } catch (e) {
    return fail('snapshot/rules', { message: e instanceof Error ? e.message : String(e) });
  }
  const fresh = planCampaign(parsed, snapshot, rules ?? DEFAULT_RULES);

  // ---- step 2: did anything a human approved move?
  if (planSignature(fresh) !== planSignature(stored.plan)) {
    const diff = diffPlans(stored.plan, fresh);
    const { error: revErr } = await svc.from('mos_campaign_plans').update({
      plan: fresh as unknown as Record<string, unknown>,
      snapshot_hash: fresh.snapshotHash,
      feasibility: {
        feasible: fresh.feasible, infeasible_proof: fresh.infeasibleProof,
        search_incomplete: fresh.searchIncomplete, conflicts: fresh.conflicts,
        alternatives: fresh.alternatives,
      },
    }).eq('id', planId);
    if (revErr) return fail('mos_campaign_plans revise-on-conflict', revErr);
    return jsonError(409, JSON.stringify({
      error: 'plan_changed',
      error_ar: `تغيّر الحمل أثناء المراجعة: تحرّك ${diff.length} بندًا. راجع الخطة المحدَّثة قبل الاعتماد.`,
      error_en: `The workload changed while you were reviewing: ${diff.length} item(s) moved. Review the refreshed plan before approving.`,
      diff,
      plan: fresh,
    }));
  }

  // ---- step 3: the database has the last word.
  const { data: res, error: rpcErr } = await svc.rpc('mos_campaign_plan_commit', {
    p_plan_id: planId,
    p_reservations: reservationsPayload(fresh),
    p_expected_hash: fresh.snapshotHash,
    p_materialise: materialisePayload(parsed, fresh),
    p_actor: ctx.userId,
  });
  if (rpcErr) {
    const msg = rpcErr.message ?? '';
    // Classify by MESSAGE first, code second (repo rule).
    if (/plan_changed/.test(msg) || rpcErr.code === 'WS409') {
      return jsonError(409, JSON.stringify({
        error: /capacity_conflict/.test(msg) ? 'capacity_conflict' : 'plan_changed',
        error_ar: /capacity_conflict/.test(msg)
          ? 'لم تعد الخطة تناسب السعة المتاحة. أعد المعاينة.'
          : 'تغيّر الحمل أثناء المراجعة. أعد المعاينة.',
        error_en: /capacity_conflict/.test(msg)
          ? 'The plan no longer fits the available capacity. Re-run the preview.'
          : 'The workload changed while you were reviewing. Re-run the preview.',
        detail: msg,
      }));
    }
    return fail('mos_campaign_plan_commit', rpcErr);
  }
  return jsonOk({ ok: true, plan_id: planId, created: res });
}

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

export async function campaignPlanGet(ctx: PlanCtx): Promise<Response> {
  const campaignId = str(ctx.body.campaign_id);
  const planId = str(ctx.body.plan_id);
  if (!campaignId && !planId) return jsonError(400, 'campaign_id or plan_id is required');
  let q = ctx.sb.from('mos_campaign_plans')
    .select('id, campaign_id, status, input, plan, feasibility, snapshot_hash, engine_version, created_at, approved_at')
    .order('created_at', { ascending: false }).limit(5);
  q = planId ? q.eq('id', planId) : q.eq('campaign_id', campaignId as string);
  const { data, error } = await q;
  if (error) return fail('mos_campaign_plans list', error);
  return jsonOk({ plans: data ?? [] });
}

export async function campaignRollup(ctx: PlanCtx): Promise<Response> {
  const campaignId = str(ctx.body.campaign_id);
  if (!campaignId) return jsonError(400, 'campaign_id is required');
  const { data, error } = await ctx.sb.rpc('mos_campaign_rollup', {
    p_campaign_id: campaignId,
    p_execution_id: str(ctx.body.execution_id),
  });
  if (error) return fail('mos_campaign_rollup', error);
  return jsonOk({ rollup: data });
}

export async function workloadCalendar(ctx: PlanCtx): Promise<Response> {
  const from = str(ctx.body.from) ?? riyadhToday();
  const to = str(ctx.body.to) ?? from;
  const settings = await loadPlanningSettings(ctx.sb);
  let snapshot;
  try {
    snapshot = await loadWorkloadSnapshot(ctx.sb, settings);
  } catch (e) {
    return fail('snapshot', { message: e instanceof Error ? e.message : String(e) });
  }
  return jsonOk({
    today: snapshot.today,
    calendar: snapshot.calendar,
    people: snapshot.people,
    ledger: snapshot.ledger.filter((r) => r.day >= from && r.day <= to),
  });
}

export async function contentAdReadiness(ctx: PlanCtx): Promise<Response> {
  const contentId = str(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');
  const { data, error } = await ctx.sb.rpc('content_ad_readiness', {
    p_content_id: contentId,
    p_execution_id: str(ctx.body.execution_id),
  });
  if (error) return fail('content_ad_readiness', error);
  return jsonOk({ readiness: data });
}

/**
 * Everything the Capacity settings screen edits, read back so it shows the
 * LIVE values instead of the engine's seeds. Without this the step-effort grid
 * could only display defaults, and a save would look like it had no effect.
 */
export async function capacityConfigGet(ctx: PlanCtx): Promise<Response> {
  const settings = await loadPlanningSettings(ctx.sb);
  const [capsRes, holidaysRes, effortRes, roleLoadRes, rolesRes, usersRes] = await Promise.all([
    ctx.sb.from('mos_user_capacity').select('user_id, bucket, daily_slots'),
    ctx.sb.from('mos_holidays').select('day, label_ar, label_en').order('day'),
    ctx.sb.from('mos_step_effort').select('workflow_key, step_key, bucket, working_days'),
    ctx.sb.from('mos_role_load').select('role_id, bucket, daily_new_tasks'),
    ctx.sb.from('roles').select('id, key, label_ar, label_en').eq('domain', 'marketing'),
    ctx.sb.from('users').select('id, email, role_assignments').eq('is_active', true),
  ]);
  for (const [label, res] of [
    ['mos_user_capacity', capsRes], ['mos_holidays', holidaysRes],
    ['mos_step_effort', effortRes], ['mos_role_load', roleLoadRes],
    ['roles', rolesRes], ['users', usersRes],
  ] as const) {
    if (res.error) return fail(label, res.error);
  }
  return jsonOk({
    settings,
    user_caps: capsRes.data ?? [],
    holidays: holidaysRes.data ?? [],
    step_effort: effortRes.data ?? [],
    role_load: roleLoadRes.data ?? [],
    roles: rolesRes.data ?? [],
    users: usersRes.data ?? [],
    today: riyadhToday(),
  });
}

export async function capacityConfigSave(ctx: PlanCtx): Promise<Response> {
  const svc = ctx.svc;
  if (!svc) return jsonError(500, 'service client unavailable');
  const caps = Array.isArray(ctx.body.user_caps) ? ctx.body.user_caps as unknown[] : null;
  const holidays = Array.isArray(ctx.body.holidays) ? ctx.body.holidays as unknown[] : null;
  const effort = Array.isArray(ctx.body.step_effort) ? ctx.body.step_effort as unknown[] : null;
  const weekend = Array.isArray(ctx.body.weekend_days) ? ctx.body.weekend_days as unknown[] : null;

  if (caps) {
    const rows = caps.map((c) => {
      const r = asRecord(c);
      return {
        user_id: String(r.user_id ?? ''), bucket: String(r.bucket ?? 'post'),
        daily_slots: Math.max(0, Math.floor(Number(r.daily_slots ?? 0) || 0)),
        updated_at: new Date().toISOString(),
      };
    }).filter((r) => r.user_id);
    if (rows.length) {
      const { error } = await svc.from('mos_user_capacity').upsert(rows, { onConflict: 'user_id,bucket' });
      if (error) return fail('mos_user_capacity upsert', error);
    }
  }
  if (holidays) {
    const rows = holidays.map((h) => {
      const r = asRecord(h);
      return {
        day: String(r.day ?? ''),
        label_ar: str(r.label_ar) ?? 'إجازة',
        label_en: str(r.label_en) ?? 'Holiday',
      };
    }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day));
    const { error: delErr } = await svc.from('mos_holidays').delete().gte('day', '1900-01-01');
    if (delErr) return fail('mos_holidays clear', delErr);
    if (rows.length) {
      const { error } = await svc.from('mos_holidays').insert(rows);
      if (error) return fail('mos_holidays insert', error);
    }
  }
  if (effort) {
    const rows = effort.map((e) => {
      const r = asRecord(e);
      return {
        workflow_key: String(r.workflow_key ?? ''), step_key: String(r.step_key ?? ''),
        bucket: String(r.bucket ?? '*'),
        working_days: Math.max(0.25, Number(r.working_days ?? 1) || 1),
        updated_at: new Date().toISOString(),
      };
    }).filter((r) => r.workflow_key && r.step_key);
    if (rows.length) {
      const { error } = await svc.from('mos_step_effort')
        .upsert(rows, { onConflict: 'workflow_key,step_key,bucket' });
      if (error) return fail('mos_step_effort upsert', error);
    }
  }
  if (weekend) {
    const days = weekend.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const { data: cur } = await svc.from('mos_settings').select('value').eq('key', 'planning').maybeSingle();
    const value = { ...asRecord((cur as { value?: unknown } | null)?.value), weekend_days: days };
    const { error } = await svc.from('mos_settings').upsert({
      key: 'planning', value, updated_by_user_id: ctx.userId, updated_at: new Date().toISOString(),
    });
    if (error) return fail('mos_settings.planning upsert', error);
  }
  return jsonOk({ ok: true });
}
