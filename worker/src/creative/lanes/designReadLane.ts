/**
 * Design-read lane (contracts §3) — the sweep that keeps visual_design_reads
 * filled for STATIC competitor + Wassel creatives.
 *
 * Flag: mos_settings.creative_writer.design_reads_enabled — re-read every
 * tick; sleeps 30 s while off (rollback = flip the flag).
 *
 * Per tick, in order:
 *  (a) incremental — newly stored COMPETITOR static media lacking reads
 *      (targets RPC, tiers 1–4, newest first), slide level then post level;
 *  (b) published WASSEL assets/content lacking reads (tier 5 — the internal
 *      org; subject kinds wassel_file / wassel_content);
 *  (c) one backfill batch when mos_settings.creative_backfill.design_reads is
 *      enabled (shared controller, worker/src/creative/backfill.ts).
 *
 * Lane mode (mos_settings.creative_backfill.design_reads.lane):
 *  - 'runner' → enqueue ONE claude_jobs row per kind per tick
 *    (enqueueRunnerRead — the loop never awaits the runner; the runner's
 *    handlers stage, read, validate and upsert with model_used
 *    'claude-runner:design-read'). Targets already riding in a pending/running
 *    runner payload are excluded, and a queued SELF-SELECT job (empty
 *    manifest) pauses further enqueueing for that kind — it will drain the
 *    same targets.
 *  - 'worker' → direct readSlide/readPost via callCreativeRole (API roles).
 *    If the resolved role provider is 'runner' the effective lane is runner
 *    regardless of the config string — never block the loop on a runner poll.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env.js';
import { resolveCreativeRoles, type CreativeRoleConfig } from '../roles.js';
import { enqueueRunnerRead } from '../runnerProvider.js';
import { readSlide, type DesignReadDeps, type ReadOutcome, type SlideReadItem } from '../designRead/readSlide.js';
import { readPost, type PostReadPost, type PostReadSlide } from '../designRead/readPost.js';
import { subjectKindForOrgType } from '../designRead/wasselOnPublish.js';
import { DESIGN_READ_RULE_VERSION } from '../designRead/persist.js';
import {
  runBackfillBatch,
  readBackfillConfig,
  type BackfillKindHandler,
  type BackfillLane,
  type BackfillProcessOutcome,
} from '../backfill.js';
import type { ReadSubjectKind, SlideRead } from '../contracts.js';

// ── lane contract ────────────────────────────────────────────────────────────
// IDENTICAL to worker/src/creative/lanes/types.ts (owner A-WORKER, written
// first — contracts §3). Declared locally because the peer file does not exist
// yet; when it lands, delete this block and import from './types.js'.
export interface LaneDeps {
  supabase: SupabaseClient;
  env: WorkerEnv;
  workerId: string;
  sleep(ms: number): Promise<void>;
  isShuttingDown(): boolean;
  log(msg: string, extra?: unknown): void;
}
export type LaneLoop = (deps: LaneDeps) => Promise<void>;

const FLAG_SLEEP_MS = 30_000;
const TICK_SLEEP_MS = 10_000;
/** Per-tick caps — mirror the runner handler's batch ceilings so a runner
 *  enqueue fills exactly one session, and the worker lane stays bounded. */
const SLIDE_BATCH = 24;
const POST_BATCH = 6;
const WASSEL_SLIDE_BATCH = 12;
const WASSEL_POST_BATCH = 2;
const MAX_SLIDES_PER_POST = 10;
/** Stop enqueueing a kind when this many of its jobs are already queued. */
const RUNNER_QUEUE_HIGH_WATER = 8;
const RUNNER_MODEL_USED = 'claude-runner:design-read';
const COMPETITOR_TIERS = [1, 2, 3, 4] as const;

// ── settings ─────────────────────────────────────────────────────────────────

export async function readCreativeWriterFlags(sb: SupabaseClient): Promise<{ design_reads_enabled: boolean }> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'creative_writer').maybeSingle();
  if (error) throw new Error(`provider:supabase mos_settings.creative_writer read failed: ${error.message}`);
  const v = (data as { value?: unknown } | null)?.value;
  const enabled = !!(v && typeof v === 'object' && !Array.isArray(v)
    && (v as Record<string, unknown>).design_reads_enabled === true);
  return { design_reads_enabled: enabled };
}

// ── targets ──────────────────────────────────────────────────────────────────

export interface DesignTargetRow {
  subject_kind: string;
  subject_id: string;
  post_id: string;
  slide_index: number | null;
  organization_id: string | null;
  stored_url: string | null;
  post_type: string | null;
}

/** Subjects of ONE level lacking a read for (model_used, rule_version), tier-walked newest-first. */
export async function fetchDesignTargets(
  sb: SupabaseClient,
  level: 'slide' | 'post',
  modelUsed: string,
  tiers: readonly number[],
  limit: number,
): Promise<DesignTargetRow[]> {
  const out: DesignTargetRow[] = [];
  for (const tier of tiers) {
    if (out.length >= limit) break;
    const { data, error } = await sb.rpc('creative_design_read_targets', {
      p_subject_kind: null,
      p_level: level,
      p_rule_version: DESIGN_READ_RULE_VERSION,
      p_model_used: modelUsed,
      p_tier: tier,
      p_limit: limit - out.length,
    });
    if (error) throw new Error(`provider:supabase creative_design_read_targets (${level}, tier ${tier}) failed: ${error.message}`);
    out.push(...((data ?? []) as DesignTargetRow[]));
  }
  return out;
}

// ── lane / model resolution ──────────────────────────────────────────────────

/** A role whose provider IS 'runner' forces the runner path whatever the config says. */
export function effectiveLane(configLane: BackfillLane, role: CreativeRoleConfig): BackfillLane {
  if (configLane === 'runner' || role.provider === 'runner') return 'runner';
  return 'worker';
}

/** The model_used string the upsert will carry — targets must ask with the same one. */
export function modelUsedFor(lane: BackfillLane, role: CreativeRoleConfig): string {
  return lane === 'runner' ? RUNNER_MODEL_USED : `${role.provider}:${role.model}`;
}

// ── runner in-flight dedup ───────────────────────────────────────────────────

export interface RunnerInFlight {
  count: number;
  /** A queued job with an EMPTY manifest self-selects — it will drain these targets. */
  selfSelect: boolean;
  /** Subject ids (media ids for the slide kind, post ids for the post kind) already queued. */
  ids: Set<string>;
}

export async function runnerInFlight(sb: SupabaseClient): Promise<{ slide: RunnerInFlight; post: RunnerInFlight }> {
  const slide: RunnerInFlight = { count: 0, selfSelect: false, ids: new Set() };
  const post: RunnerInFlight = { count: 0, selfSelect: false, ids: new Set() };
  const { data, error } = await sb.from('claude_jobs')
    .select('kind, payload')
    .in('kind', ['mkt_visual_design_slide', 'mkt_visual_design_post'])
    .in('status', ['pending', 'running'])
    .limit(200);
  if (error) throw new Error(`provider:supabase claude_jobs in-flight scan failed: ${error.message}`);
  for (const j of (data ?? []) as Array<{ kind: string; payload: unknown }>) {
    const bucket = j.kind === 'mkt_visual_design_slide' ? slide : post;
    bucket.count += 1;
    const payload = j.payload as { manifest_items?: unknown } | null;
    const items = payload && Array.isArray(payload.manifest_items) ? payload.manifest_items : [];
    if (items.length === 0) { bucket.selfSelect = true; continue; }
    for (const it of items as Array<Record<string, unknown>>) {
      const id = typeof it.media_id === 'string' ? it.media_id : (typeof it.post_id === 'string' ? it.post_id : null);
      if (id) bucket.ids.add(id);
    }
  }
  return { slide, post };
}

// ── processing ───────────────────────────────────────────────────────────────

function accCost(acc: number | null, c: number | null): number | null {
  if (acc === null || c === null) return null;
  return acc + c;
}

function toSlideItem(t: DesignTargetRow): SlideReadItem | null {
  if (!t.stored_url) return null;
  return {
    subject_kind: t.subject_kind as ReadSubjectKind,
    subject_id: t.subject_id,
    post_id: t.post_id,
    slide_index: t.slide_index,
    organization_id: t.organization_id,
    stored_url: t.stored_url,
  };
}

export async function processSlideTargets(
  sb: SupabaseClient,
  targets: DesignTargetRow[],
  lane: BackfillLane,
  inFlight: RunnerInFlight,
  log: (msg: string, extra?: unknown) => void,
): Promise<BackfillProcessOutcome> {
  const items = targets.map(toSlideItem).filter((x): x is SlideReadItem => x !== null && !inFlight.ids.has(x.subject_id));
  if (items.length === 0) return { processed: 0, failed: 0, costUsd: null };

  if (lane === 'runner') {
    if (inFlight.selfSelect || inFlight.count >= RUNNER_QUEUE_HIGH_WATER) {
      log('designReadLane: runner slide queue busy — leaving targets for the queued job', { count: inFlight.count, selfSelect: inFlight.selfSelect });
      return { processed: 0, failed: 0, costUsd: null, note: 'runner queue busy' };
    }
    const jobId = await enqueueRunnerRead(
      sb,
      'mkt_visual_design_slide',
      items.map((it) => ({
        media_id: it.subject_id, post_id: it.post_id, stored_url: it.stored_url,
        carousel_index: it.slide_index, org: it.organization_id, subject_kind: it.subject_kind,
      })),
    );
    log(`designReadLane: enqueued runner slide job ${jobId} (${items.length} slides)`);
    return { processed: items.length, failed: 0, costUsd: 0 };
  }

  let processed = 0, failed = 0;
  let cost: number | null = 0;
  const deps: DesignReadDeps = { sb, log };
  for (const item of items) {
    try {
      const out: ReadOutcome = await readSlide(item, deps);
      processed += 1;
      cost = accCost(cost, out.cost_usd);
    } catch (e) {
      // One unreadable slide must not kill the batch — logged, counted, next tick retries.
      failed += 1;
      console.error(`[designReadLane] slide read failed for ${item.subject_id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { processed, failed, costUsd: cost };
}

/** All stored images of a post + the latest stored slide read per image (evidence). */
export async function fetchPostSlides(sb: SupabaseClient, postId: string): Promise<PostReadSlide[]> {
  const { data: media, error: mErr } = await sb.from('mkt_content_media')
    .select('id, carousel_index, stored_url')
    .eq('content_post_id', postId)
    .eq('media_kind', 'image')
    .eq('download_status', 'stored')
    .not('stored_url', 'is', null)
    .order('carousel_index', { ascending: true })
    .limit(MAX_SLIDES_PER_POST);
  if (mErr) throw new Error(`provider:supabase post slides query failed for ${postId}: ${mErr.message}`);
  const slides = ((media ?? []) as Array<{ id: string; carousel_index: number; stored_url: string | null }>)
    .filter((m) => !!m.stored_url)
    .map((m) => ({ media_id: m.id, carousel_index: m.carousel_index, stored_url: m.stored_url as string, slide_read: null as SlideRead | null }));
  if (slides.length === 0) return [];

  const { data: reads, error: rErr } = await sb.from('visual_design_reads')
    .select('subject_id, read, created_at')
    .eq('level', 'slide')
    .eq('status', 'done')
    .eq('post_id', postId)
    .order('created_at', { ascending: false });
  if (rErr) throw new Error(`provider:supabase slide reads query failed for ${postId}: ${rErr.message}`);
  const latest = new Map<string, SlideRead>();
  for (const r of (reads ?? []) as Array<{ subject_id: string; read: unknown }>) {
    if (!latest.has(r.subject_id)) latest.set(r.subject_id, r.read as SlideRead);
  }
  for (const s of slides) s.slide_read = latest.get(s.media_id) ?? null;
  return slides;
}

export async function processPostTargets(
  sb: SupabaseClient,
  targets: DesignTargetRow[],
  lane: BackfillLane,
  inFlight: RunnerInFlight,
  log: (msg: string, extra?: unknown) => void,
): Promise<BackfillProcessOutcome> {
  const posts = targets.filter((t) => !inFlight.ids.has(t.subject_id));
  if (posts.length === 0) return { processed: 0, failed: 0, costUsd: null };

  if (lane === 'runner') {
    if (inFlight.selfSelect || inFlight.count >= RUNNER_QUEUE_HIGH_WATER) {
      log('designReadLane: runner post queue busy — leaving targets for the queued job', { count: inFlight.count, selfSelect: inFlight.selfSelect });
      return { processed: 0, failed: 0, costUsd: null, note: 'runner queue busy' };
    }
    const jobId = await enqueueRunnerRead(
      sb,
      'mkt_visual_design_post',
      posts.map((t) => ({
        post_id: t.subject_id, org: t.organization_id, subject_kind: t.subject_kind, post_type: t.post_type,
      })),
    );
    log(`designReadLane: enqueued runner post job ${jobId} (${posts.length} posts)`);
    return { processed: posts.length, failed: 0, costUsd: 0 };
  }

  let processed = 0, failed = 0;
  let cost: number | null = 0;
  const deps: DesignReadDeps = { sb, log };
  for (const t of posts) {
    try {
      const slides = await fetchPostSlides(sb, t.subject_id);
      if (slides.length === 0) { failed += 1; console.error(`[designReadLane] post ${t.subject_id}: no stored slides`); continue; }
      const out = await readPost({
        subject_kind: t.subject_kind as ReadSubjectKind,
        subject_id: t.subject_id,
        organization_id: t.organization_id,
        post_type: t.post_type,
      }, slides, deps);
      processed += 1;
      cost = accCost(cost, out.cost_usd);
    } catch (e) {
      failed += 1;
      console.error(`[designReadLane] post read failed for ${t.subject_id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { processed, failed, costUsd: cost };
}

// ── backfill handler (design reads) ─────────────────────────────────────────

export type DesignBackfillTarget =
  | { level: 'slide'; item: SlideReadItem }
  | { level: 'post'; post: PostReadPost; slides: PostReadSlide[] };

export interface DesignReadsBackfillArgs {
  sb: SupabaseClient;
  slideLane: BackfillLane;
  postLane: BackfillLane;
  slideModel: string;
  postModel: string;
  /** Runner in-flight snapshot — subjects already queued are skipped so a
   *  pending runner job is not re-enqueued every tick. */
  inFlight?: { slide: RunnerInFlight; post: RunnerInFlight };
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * The design_reads kind handler for the shared controller. Tiers 1–4 come from
 * creative_design_read_targets; tier 0 is the PILOT — pilot_ids are
 * mkt_content_posts ids (see docs/eval/creative-design-read-pilot.json, owner
 * A-AI) and both levels of those posts are read, minus subjects that already
 * carry a read for the current (model_used, rule_version).
 */
export function designReadsBackfillHandler(args: DesignReadsBackfillArgs): BackfillKindHandler<DesignBackfillTarget> {
  const { sb, log } = args;
  const noop: RunnerInFlight = { count: 0, selfSelect: false, ids: new Set() };

  async function fetchPilot(pilotIds: string[], limit: number): Promise<DesignBackfillTarget[]> {
    const ids = pilotIds.slice(0, 50);
    const { data: posts, error: pErr } = await sb.from('mkt_content_posts')
      .select('id, organization_id, post_type, platform').in('id', ids);
    if (pErr) throw new Error(`provider:supabase pilot posts query failed: ${pErr.message}`);
    const postRows = (posts ?? []) as Array<{ id: string; organization_id: string | null; post_type: string | null; platform: string | null }>;
    if (postRows.length === 0) return [];

    const orgIds = [...new Set(postRows.map((p) => p.organization_id).filter((x): x is string => !!x))];
    const orgTypes = new Map<string, string>();
    if (orgIds.length > 0) {
      const { data: orgs, error: oErr } = await sb.from('mkt_organizations').select('id, org_type').in('id', orgIds);
      if (oErr) throw new Error(`provider:supabase pilot orgs query failed: ${oErr.message}`);
      for (const o of (orgs ?? []) as Array<{ id: string; org_type: string }>) orgTypes.set(o.id, o.org_type);
    }

    const { data: media, error: mErr } = await sb.from('mkt_content_media')
      .select('id, content_post_id, carousel_index, stored_url')
      .in('content_post_id', postRows.map((p) => p.id))
      .eq('media_kind', 'image').eq('download_status', 'stored')
      .not('stored_url', 'is', null)
      .order('carousel_index', { ascending: true });
    if (mErr) throw new Error(`provider:supabase pilot media query failed: ${mErr.message}`);
    const mediaRows = (media ?? []) as Array<{ id: string; content_post_id: string; carousel_index: number; stored_url: string | null }>;

    // Exclude subjects that already carry a read for the CURRENT (model, rule).
    const subjectIds = [...mediaRows.map((m) => m.id), ...postRows.map((p) => p.id)];
    const have = new Set<string>();
    for (let i = 0; i < subjectIds.length; i += 200) {
      const { data: reads, error: rErr } = await sb.from('visual_design_reads')
        .select('subject_id, level, model_used')
        .in('subject_id', subjectIds.slice(i, i + 200))
        .eq('rule_version', DESIGN_READ_RULE_VERSION);
      if (rErr) throw new Error(`provider:supabase pilot existing-reads query failed: ${rErr.message}`);
      for (const r of (reads ?? []) as Array<{ subject_id: string; level: string; model_used: string }>) {
        const want = r.level === 'slide' ? args.slideModel : args.postModel;
        if (r.model_used === want) have.add(`${r.level}:${r.subject_id}`);
      }
    }

    const out: DesignBackfillTarget[] = [];
    for (const p of postRows) {
      if (out.length >= limit) break;
      const orgType = p.organization_id ? orgTypes.get(p.organization_id) ?? null : null;
      const slides = mediaRows
        .filter((m) => m.content_post_id === p.id && !!m.stored_url)
        .map((m) => ({ media_id: m.id, carousel_index: m.carousel_index, stored_url: m.stored_url as string, slide_read: null }));
      if (slides.length === 0) continue;
      for (const m of mediaRows.filter((x) => x.content_post_id === p.id && !!x.stored_url)) {
        if (out.length >= limit) break;
        if (have.has(`slide:${m.id}`)) continue;
        out.push({
          level: 'slide',
          item: {
            subject_kind: subjectKindForOrgType('slide', orgType),
            subject_id: m.id,
            post_id: p.id,
            slide_index: m.carousel_index,
            organization_id: p.organization_id,
            stored_url: m.stored_url as string,
          },
        });
      }
      if (out.length < limit && !have.has(`post:${p.id}`)) {
        out.push({
          level: 'post',
          post: {
            subject_kind: subjectKindForOrgType('post', orgType),
            subject_id: p.id,
            organization_id: p.organization_id,
            post_type: p.post_type,
            platform: p.platform,
          },
          slides,
        });
      }
    }
    return out;
  }

  return {
    kind: 'design_reads',
    async fetchTargets({ tier, limit, pilotIds }) {
      if (tier === 0) return fetchPilot(pilotIds, limit);
      const out: DesignBackfillTarget[] = [];
      const skipSlide = new Set(args.inFlight?.slide.ids ?? []);
      const skipPost = new Set(args.inFlight?.post.ids ?? []);
      const slideRows = await fetchDesignTargets(sb, 'slide', args.slideModel, [tier], limit);
      for (const r of slideRows) {
        if (skipSlide.has(r.subject_id)) continue;
        const item = toSlideItem(r);
        if (item) out.push({ level: 'slide', item });
      }
      if (out.length < limit) {
        const postRows = await fetchDesignTargets(sb, 'post', args.postModel, [tier], limit - out.length);
        for (const r of postRows) {
          if (skipPost.has(r.subject_id)) continue;
          const slides = await fetchPostSlides(sb, r.subject_id);
          if (slides.length === 0) continue;
          out.push({
            level: 'post',
            post: {
              subject_kind: r.subject_kind as ReadSubjectKind,
              subject_id: r.subject_id,
              organization_id: r.organization_id,
              post_type: r.post_type,
            },
            slides,
          });
        }
      }
      return out;
    },
    async processBatch(targets) {
      const slides = targets.filter((t): t is Extract<DesignBackfillTarget, { level: 'slide' }> => t.level === 'slide');
      const posts = targets.filter((t): t is Extract<DesignBackfillTarget, { level: 'post' }> => t.level === 'post');
      let processed = 0, failed = 0;
      let cost: number | null = 0;

      if (slides.length > 0) {
        const rows: DesignTargetRow[] = slides.map((s) => ({
          subject_kind: s.item.subject_kind, subject_id: s.item.subject_id, post_id: s.item.post_id,
          slide_index: s.item.slide_index, organization_id: s.item.organization_id,
          stored_url: s.item.stored_url, post_type: null,
        }));
        const out = await processSlideTargets(sb, rows, args.slideLane, noop, log ?? (() => {}));
        processed += out.processed; failed += out.failed; cost = accCost(cost, out.costUsd);
      }
      if (posts.length > 0) {
        if (args.postLane === 'runner') {
          const jobId = await enqueueRunnerRead(sb, 'mkt_visual_design_post', posts.map((p) => ({
            post_id: p.post.subject_id, org: p.post.organization_id,
            subject_kind: p.post.subject_kind, post_type: p.post.post_type,
          })));
          log?.(`designReadLane: enqueued runner post backfill job ${jobId} (${posts.length} posts)`);
          processed += posts.length;
        } else {
          const deps: DesignReadDeps = { sb, log };
          for (const p of posts) {
            try {
              const out = await readPost(p.post, p.slides, deps);
              processed += 1; cost = accCost(cost, out.cost_usd);
            } catch (e) {
              failed += 1;
              console.error(`[designReadLane] backfill post read failed for ${p.post.subject_id}:`, e instanceof Error ? e.message : e);
            }
          }
        }
      }
      return { processed, failed, costUsd: cost };
    },
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

/** One lane tick — exported for tests. */
export async function designReadTick(
  sb: SupabaseClient,
  log: (msg: string, extra?: unknown) => void,
  workerId: string,
): Promise<void> {
  const roles = await resolveCreativeRoles(sb);
  const cfg = await readBackfillConfig(sb, 'design_reads');
  const slideLane = effectiveLane(cfg.lane, roles.design_read_slide);
  const postLane = effectiveLane(cfg.lane, roles.design_read_post);
  const slideModel = modelUsedFor(slideLane, roles.design_read_slide);
  const postModel = modelUsedFor(postLane, roles.design_read_post);
  const inFlight = (slideLane === 'runner' || postLane === 'runner')
    ? await runnerInFlight(sb)
    : { slide: { count: 0, selfSelect: false, ids: new Set<string>() }, post: { count: 0, selfSelect: false, ids: new Set<string>() } };

  // (a) incremental competitor statics — slide then post
  const slideTargets = await fetchDesignTargets(sb, 'slide', slideModel, COMPETITOR_TIERS, SLIDE_BATCH);
  await processSlideTargets(sb, slideTargets, slideLane, inFlight.slide, log);
  const postTargets = await fetchDesignTargets(sb, 'post', postModel, COMPETITOR_TIERS, POST_BATCH);
  await processPostTargets(sb, postTargets, postLane, inFlight.post, log);

  // (b) published Wassel assets/content lacking reads (tier 5, internal org)
  const wasselSlides = await fetchDesignTargets(sb, 'slide', slideModel, [5], WASSEL_SLIDE_BATCH);
  await processSlideTargets(sb, wasselSlides, slideLane, inFlight.slide, log);
  const wasselPosts = await fetchDesignTargets(sb, 'post', postModel, [5], WASSEL_POST_BATCH);
  await processPostTargets(sb, wasselPosts, postLane, inFlight.post, log);

  // (c) one shared-controller backfill batch when enabled
  if (cfg.enabled && !cfg.paused_at) {
    const result = await runBackfillBatch(
      designReadsBackfillHandler({ sb, slideLane, postLane, slideModel, postModel, inFlight, log }),
      { sb, workerId, log },
    );
    log('designReadLane: backfill batch', result);
  }
}

export const designReadLoop: LaneLoop = async (deps) => {
  const { supabase: sb, workerId, sleep, isShuttingDown, log } = deps;
  for (;;) {
    if (isShuttingDown()) return;
    let sleepMs = TICK_SLEEP_MS;
    try {
      const flags = await readCreativeWriterFlags(sb);
      if (!flags.design_reads_enabled) {
        sleepMs = FLAG_SLEEP_MS;
      } else {
        await designReadTick(sb, log, workerId);
      }
    } catch (e) {
      // A failed tick (settings read, targets RPC, enqueue) must not kill the
      // loop — logged loudly, retried next tick.
      console.error('[designReadLane] tick failed:', e instanceof Error ? e.message : e);
    }
    await sleep(sleepMs);
  }
};
