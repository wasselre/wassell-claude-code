// ============================================================================
// Self-healing backlog sweep for collected content.
//
// WHY THIS EXISTS. Content processing used to be enqueued in exactly one place —
// the collection job, behind `params.process_content === true`. No enqueue path
// ever set that flag (`mkt_enqueue_due_accounts` passes only
// {"reason":"scheduled"}), so every scheduled collection ingested posts and
// never downloaded their media. 1,104 posts sat at processing_status
// 'collected' with ZERO media rows while their CDN URLs aged toward expiry, and
// nothing anywhere reported a problem: the collection jobs were all green,
// because collecting is exactly what they did.
//
// A single enqueue site is a single point of silent failure. This sweep is the
// second, independent path: it looks at the DATA (what state are posts actually
// in?) rather than at events (did someone remember to enqueue?), so a missed
// enqueue self-heals on the next tick instead of stranding a post forever.
//
// The four stages mirror the real dependency order, and each is separately
// resumable because every underlying write is idempotent:
//
//   1. media    — 'collected' post with no stored media  → content_process(media_only)
//                 TIME-CRITICAL (CDN URLs expire), zero AI cost.
//   2. ocr      — stored images with no visual text      → claude_jobs(mkt_visual_ocr)
//                 Runs on the OCR lane: no incremental per-token API charge,
//                 included within the existing Claude subscription.
//   3. process  — media + visual text present            → content_process(full)
//                 Its vision step finds the existing visual text and skips the
//                 paid API call entirely. Ordering the stages this way is what
//                 keeps the backlog off metered vision.
//   4. intelligence — 'awaiting_intelligence'            → claude_jobs(mkt_content_enrichment)
//                 The read that decides WHICH PROJECT a post is about. Evidence
//                 is complete by this point; without this stage the facts exist
//                 and attribute to nothing. Covers images AND videos — the
//                 evidence package carries caption + transcript + frame OCR.
//
// Stages 1-3 were wired here on 2026-07-28. Stage 4's RPC had existed since
// 2026-07-28 with a single caller: a manual admin button. It therefore ran when
// someone remembered, and nobody did — 1,732 posts waited with zero jobs queued.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { repairMediaDimensions } from '../../repairMediaDimensions.js';
import { sweepApifyStorage } from '../apifyStorageSweep.js';
import { repairFileMediaMeta } from '../../repairFileMediaMeta.js';
import { backfillContentEtags } from '../../backfillContentEtags.js';
import { contentReader, isModelReader, readerPausedUntil } from './geminiEnrich.js';

export interface SweepStats { reader: string; gemini_reads: number; gemini_rereads: number; design_reads: number; reader_spend_today_usd: number; reader_over_budget: boolean; media_recover: number; visual_ocr: number; frame_jobs: number; frame_ocr: number; content_process: number; intelligence: number; cv_reenqueue: number; social_file: number; dims_repaired: number; apify_storage_swept: number; file_media_repaired: number; etags_filled: number; skipped_queue_full: boolean; skipped_not_leader: boolean }

/** Stage 5 ceilings. A cv_process job is a multi-minute GPU run on Modal, so
 *  the re-enqueue is deliberately small per tick; anything it does not reach
 *  is reached next tick. RETRY_AFTER_MS (6 h) bounds a permanently-broken video
 *  to ~4 attempts a day, the same cadence as stage 1. */
const MAX_CV_REENQUEUE = 50;

/** How long one machine owns the sweep. Must exceed the maintenance interval so
 *  exactly one machine sweeps per tick, and stay short enough that a machine
 *  dying mid-sweep costs at most one skipped round. */
const LEASE_MS = 90_000;
const LEASE_KEY = 'content_sweep_lease';

/**
 * Take the sweep lease, or return false.
 *
 * The deck-worker app runs FIVE machines and every one of them runs this
 * maintenance tick — three were observed sweeping within four seconds on the
 * first deploy. `mkt_job_enqueue` only de-duplicates jobs that carry a
 * social_account_id, and content jobs do not, so nothing below this function
 * would stop two machines enqueueing the same post: the in-flight check is read
 * before either machine's inserts land. It happened not to collide (their scans
 * were ~1s apart, longer than one machine's insert run), which is timing luck,
 * not a guarantee.
 *
 * Beyond duplicate jobs, five machines each scanning 1,000 posts plus their
 * media and visual text every tick is four times the database work for nothing.
 *
 * This is a compare-and-swap, not a read-then-write: the `lt` on the stored
 * expiry is evaluated inside the same UPDATE that claims it, so exactly one
 * machine can win regardless of timing. Losers skip silently.
 */
async function acquireSweepLease(sb: SupabaseClient, workerId: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  // Seed the row once; concurrent seeds collide on the primary key and the
  // loser simply proceeds to the CAS below.
  await sb.from('mkt_settings').upsert({ key: LEASE_KEY, value: { owner: null, until: new Date(0).toISOString() } }, { onConflict: 'key', ignoreDuplicates: true });
  const { data, error } = await sb.from('mkt_settings')
    .update({ value: { owner: workerId, until } })
    .eq('key', LEASE_KEY)
    .lt('value->>until', now.toISOString())   // ISO-8601 UTC sorts chronologically as text
    .select('key');
  // A failed CAS is indistinguishable from "another machine holds it" by the
  // returned rows alone — both give zero. Swallowing the error would mean a
  // broken lease query silently disables the entire sweep, and the backlog it
  // exists to drain would quietly stop draining. Fail loud instead.
  if (error) throw new Error(`sweep: lease acquire failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Per-tick enqueue ceilings. Sized against measured throughput, NOT guessed:
 * the maintenance tick runs every WATCHDOG_INTERVAL_MS (5 min) and the internal
 * provider allows 3 concurrent jobs, each media-only recovery taking ~1.2s —
 * about 750 jobs per window. Ceilings far below that starve the workers (the
 * first tuning enqueued 60 per 5 minutes and left the queue empty for most of
 * the window); ceilings far above it build a queue so deep its own tail becomes
 * invisible. These sit just under one window's worth of work.
 */
const MAX_MEDIA_ENQUEUE = 400;
// 150 -> 600 (2026-10-05 catch-up): 8 general machines x 3 slots read ~550
// posts per 5-minute window; at 150 the sweep left 11,000 collected posts waiting.
const MAX_PROCESS_ENQUEUE = 600;
const MAX_OCR_BATCHES = 20;
/** Posts per OCR job. Sized to FILL the runner's OCR_BATCH_MAX (24 images), not
 *  guessed: stored images average 1.61 per post, so 15 posts = ~24 images. At the
 *  previous 7 a batch offered ~11 images and never even reached the old cap of
 *  12, so raising that cap alone would have changed nothing. If OCR_BATCH_MAX
 *  moves again, move this with it - they are one setting expressed in two units. */
const OCR_POSTS_PER_BATCH = 15;
/** Stop enqueueing entirely above this backlog so the sweep can't outrun the workers. */
const QUEUE_HIGH_WATER = 2000; // 900 -> 2000 with the larger per-tick ceilings above
const OCR_QUEUE_HIGH_WATER = 150;
/** Video-frame stages. FRAME_JOBS_PER_TICK worker jobs (download + ffmpeg, no
 *  model) per 5-minute tick; frames are then read FRAMES_PER_BATCH at a time —
 *  the runner's own per-session image cap — so one session reads four videos. */
const FRAME_JOBS_PER_TICK = 40;
const FRAMES_PER_BATCH = 24;
const MAX_FRAME_BATCHES = 10;
/** Stage 4 ceilings. Deliberately the tightest in the file: this is the ONLY
 *  stage that spends model capacity per post, on a singleton lane shared with
 *  the owner's other work. Enough to keep the lane fed, never enough to build a
 *  queue that commits hours of capacity before anyone can look at the output. */
const MAX_ENRICH_JOBS_PER_TICK = 10;
/** Gemini reader (content.reader = 'gemini'): posts waiting for a decision that
 *  get a full read per tick, and posts read by an OLDER reader (the runner) that
 *  are re-read per tick. Each read is one content_process job on the internal
 *  provider, ~6-15 s each. Raised 60/40 -> 300/200 per 5-minute tick for the
 *  2026-10-05 catch-up: at 60/40 the sweep, not the machines, capped reading at
 *  ~1,200 posts an hour. The daily budget below still bounds the spend. */
const MAX_GEMINI_READS_PER_TICK = 300;
const MAX_GEMINI_REREADS_PER_TICK = 200;
/** Image posts read before design reads existed (2026-10-05) get a design-only pass. */
const MAX_DESIGN_READS_PER_TICK = 150;
/** Daily ceiling on Gemini reader spend unless mkt_settings
 *  `content.reader_daily_budget_usd` says otherwise. At ~$0.004 an image post
 *  and ~$0.014 a video (60-post test, 2026-10-04) $25 is ~2,000 posts a day. */
const DEFAULT_READER_BUDGET_USD = 25;
const ENRICH_QUEUE_HIGH_WATER = 30;
const ENRICH_POSTS_PER_BATCH = 15;
/** Minimum gap before re-attempting a post whose media download already failed.
 *  Long enough that a permanently-dead URL costs ~4 attempts a day instead of
 *  288, short enough that a transient outage still self-heals the same day. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** How many 'collected' posts to examine per tick. Must stay comfortably ABOVE
 *  the real backlog or the tail of the scan is never even considered — at 1,000
 *  it was already below the 1,135 posts actually sitting in 'collected'. */
const SCAN_LIMIT = 3000;

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** PostgREST caps every response at `db-max-rows` (1,000 on this project) and
 *  says nothing when it truncates — `.limit(3000)` silently returns 1,000. That
 *  cap already cost this codebase months of under-reported counts (see the
 *  Silent Failures notes), and it cost this sweep too: ordered oldest-first, the
 *  scan returned the 1,000 oldest posts, all of which already had media, so
 *  `needMedia` computed to ZERO while 103 newer posts sat unrecovered and the
 *  log cheerfully read `media_recover=0`. Always page; never trust one call. */
const PAGE = 1000;
async function pageAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  max: number,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await run(from, Math.min(from + PAGE, max) - 1);
    if (error) throw new Error(`sweep: ${what} failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Every post holding at least one stored image nobody has read yet — across the
 * WHOLE corpus, at any processing_status.
 *
 * Two full scans (~5k rows each on today's corpus) rather than a join, because
 * PostgREST cannot join. Cheap enough for a 5-minute tick, and the alternative —
 * inferring OCR work from the post lifecycle — is what stranded 625 images.
 */
async function postsWithUnreadImages(sb: SupabaseClient): Promise<string[]> {
  const media = await pageAll<{ id: string; content_post_id: string }>(
    (from, to) => sb.from('mkt_content_media').select('id, content_post_id')
      .eq('download_status', 'stored').in('media_kind', ['image', 'thumbnail'])
      .order('id', { ascending: true }).range(from, to),
    50_000, 'ocr media scan');
  const read = new Set<string>();
  // 200 ids per `.in()`, not 1000. PostgREST puts the list in the QUERY STRING,
  // so 1,000 UUIDs is a ~37 KB URL and the server answers 400 Bad Request — the
  // whole sweep then threw on every tick and enqueued nothing, while the OCR
  // queue sat empty with 625 images unread. The failure was loud in the function
  // and invisible in the outcome, which is the worst combination.
  for (const batch of chunk(media.map((m) => m.id), 200)) {
    const rows = await pageAll<{ content_media_id: string }>(
      (from, to) => sb.from('mkt_visual_text').select('content_media_id')
        .in('content_media_id', batch).order('id', { ascending: true }).range(from, to),
      50_000, 'ocr visual-text scan');
    for (const r of rows) read.add(r.content_media_id);
  }
  const out = new Set<string>();
  for (const m of media) if (!read.has(m.id)) out.add(m.content_post_id);
  return [...out];
}

export async function sweepContentBacklog(sb: SupabaseClient, workerId: string): Promise<SweepStats> {
  const stats: SweepStats = { reader: 'runner', gemini_reads: 0, gemini_rereads: 0, design_reads: 0, reader_spend_today_usd: 0, reader_over_budget: false, media_recover: 0, visual_ocr: 0, frame_jobs: 0, frame_ocr: 0, content_process: 0, intelligence: 0, cv_reenqueue: 0, social_file: 0, dims_repaired: 0, apify_storage_swept: 0, file_media_repaired: 0, etags_filled: 0, skipped_queue_full: false, skipped_not_leader: false };

  if (!(await acquireSweepLease(sb, workerId))) { stats.skipped_not_leader = true; return stats; }

  // Which reader decides projects. Under 'gemini' the runner lanes (stages 2,
  // 2a, 2b, 4) are not fed at all; full content_process passes read and decide.
  const reader = await contentReader(sb);
  stats.reader = reader;
  let readerBudgetOk = true;
  if (isModelReader(reader)) {
    const spend = await readerSpendToday(sb);
    const budget = await readerBudgetUsd(sb);
    stats.reader_spend_today_usd = Math.round(spend * 100) / 100;
    const pausedUntil = await readerPausedUntil(sb);
    readerBudgetOk = spend < budget && Date.now() >= pausedUntil;
    stats.reader_over_budget = !readerBudgetOk;
  }

  // ── backlog depth guard ───────────────────────────────────────────────────
  const { count: queuedCount } = await sb.from('mkt_collection_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'content_process').in('status', ['queued', 'running']);
  if ((queuedCount ?? 0) >= QUEUE_HIGH_WATER) { stats.skipped_queue_full = true; return stats; }

  // Oldest first: a post's media URLs expire with age, so the oldest unrecovered
  // post is the one closest to being permanently unrecoverable.
  //
  // 'failed' is in scope, not just 'collected'. A post lands on 'failed' when its
  // job exhausts attempts — but the sweep's whole premise is that state is
  // recoverable later (stage 1 re-downloads media the job could not get). Scoping
  // the scan to 'collected' meant that the moment a post failed it left the
  // sweep's view PERMANENTLY, even after the media it was missing had since been
  // stored. Measured: 906 posts sat at 'failed', and 899 of them already had at
  // least one STORED media row — recovered by this very sweep, after the status
  // had already been written. They were one enqueue away from processing and
  // nothing could ever issue it. Same class of bug as the header note above, and
  // as stage 2's global scope: a status is an event, and gating self-healing on
  // an event is how work gets stranded. Both re-entry paths stay bounded — stage
  // 1 by RETRY_AFTER_MS, stage 3 by requiring stored media — so the genuinely
  // dead (7 of the 906) cost one attempt per cooldown, not a retry storm.
  const posts = await pageAll<{ id: string }>(
    (from, to) => sb.from('mkt_content_posts')
      .select('id, post_type')
      .in('processing_status', ['collected', 'failed'])
      .order('published_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })   // total order — a tie on published_at must not reshuffle between pages
      .range(from, to),
    SCAN_LIMIT, 'post scan');
  // NO early return on an empty scan. Stages 1-3 read this 'collected'/'failed'
  // set and become no-ops without it (every loop below iterates an empty array),
  // but stages 2 and 4 have their OWN scopes — unread images anywhere in the
  // corpus, and posts at 'awaiting_intelligence'. Returning here would tie them
  // to a set they do not depend on, and that is not hypothetical: the corpus is
  // currently 4 posts at 'collected' against 1,732 awaiting intelligence, so an
  // early return would disable the intelligence stage exactly when it matters.
  const postIds = posts.map((p) => p.id);

  // ── current state of those posts: media + visual text + already-queued jobs ─
  const storedAny = new Set<string>();
  const storedImagey = new Set<string>();
  /** Every stored image/thumbnail, with its post. OCR coverage is a per-MEDIA
   *  fact, not a per-post one — see the hasVisualText note below. */
  const imageyMedia: Array<{ id: string; pid: string }> = [];
  const lastAttemptAt = new Map<string, number>();
  // Chunked at 100 posts, not 200: a carousel can carry many media rows, and a
  // chunk that reaches the 1,000-row cap would truncate silently — the same trap
  // as the post scan. Paged as well, so even a pathological chunk is complete.
  for (const ids of chunk(postIds, 100)) {
    // Failed rows are read too, not just stored ones: their timestamp is how we
    // know a post was already ATTEMPTED. Selecting only stored rows would make
    // a permanently-dead URL look identical to a post nobody has tried yet.
    const data = await pageAll<{ id: string; content_post_id: string; media_kind: string; download_status: string; updated_at: string }>(
      (from, to) => sb.from('mkt_content_media')
        .select('id, content_post_id, media_kind, download_status, updated_at')
        .in('content_post_id', ids).order('id', { ascending: true }).range(from, to),
      10_000, 'media scan');
    for (const m of data) {
      const pid = m.content_post_id as string;
      const at = Date.parse((m.updated_at as string) ?? '') || 0;
      if (at > (lastAttemptAt.get(pid) ?? 0)) lastAttemptAt.set(pid, at);
      if (m.download_status !== 'stored') continue;
      storedAny.add(pid);
      if (m.media_kind === 'image' || m.media_kind === 'thumbnail') {
        storedImagey.add(pid);
        imageyMedia.push({ id: m.id, pid });
      }
    }
  }
  // OCR coverage is tracked per MEDIA. Tracking it per POST — "does this post
  // have any visual_text at all?" — marks a five-image carousel finished the
  // moment ONE of its images is read, and the post is then never offered again,
  // so the other four are stranded permanently. Measured live: 36 posts holding
  // 303 unread images had already been written off that way.
  const ocrdMedia = new Set<string>();
  const mediaIds = imageyMedia.map((m) => m.id);
  for (const ids of chunk(mediaIds, 100)) {
    const data = await pageAll<{ content_media_id: string }>(
      (from, to) => sb.from('mkt_visual_text').select('content_media_id')
        .in('content_media_id', ids).order('id', { ascending: true }).range(from, to),
      10_000, 'visual-text scan');
    for (const v of data) ocrdMedia.add(v.content_media_id);
  }
  /** Posts with at least one stored image nobody has read yet. */
  const postsNeedingOcr = new Set<string>();
  for (const m of imageyMedia) if (!ocrdMedia.has(m.id)) postsNeedingOcr.add(m.pid);
  /** Retained for stage 3: "this post has SOME visual text" is the right test
   *  for whether an enrichment run would find OCR evidence to work with. */
  const hasVisualText = new Set<string>();
  for (const m of imageyMedia) if (ocrdMedia.has(m.id)) hasVisualText.add(m.pid);
  // Already-queued content_process work — never enqueue a second job for a post
  // that is already owned by one (that is how a queue turns into a retry storm).
  const inFlight = new Set<string>();
  {
    // Paged, and errors surface: a truncated in-flight set means re-enqueueing
    // posts that already have a job. That errs in the safe direction (the work
    // is idempotent) but it wastes queue slots the depth guard then counts.
    const data = await pageAll<{ params: { content_post_id?: string } | null }>(
      (from, to) => sb.from('mkt_collection_jobs')
        .select('params').eq('kind', 'content_process').in('status', ['queued', 'running'])
        .order('id', { ascending: true }).range(from, to),
      QUEUE_HIGH_WATER + PAGE, 'in-flight scan');
    for (const j of data) {
      const pid = j.params?.content_post_id;
      if (pid) inFlight.add(pid);
    }
  }

  // ── stage 1: media recovery ───────────────────────────────────────────────
  // A post whose download genuinely cannot succeed — a YouTube video the
  // datacenter IP is bot-checked out of, an image URL that is simply dead —
  // would otherwise be re-enqueued every single tick, forever, because it never
  // acquires stored media. Retrying is right (most failures ARE transient), but
  // it has to be bounded: re-attempt at most once per RETRY_AFTER_MS.
  const retryCutoff = Date.now() - RETRY_AFTER_MS;
  const needMedia = postIds.filter((id) =>
    !storedAny.has(id) && !inFlight.has(id) && (lastAttemptAt.get(id) ?? 0) < retryCutoff);
  for (const id of needMedia.slice(0, MAX_MEDIA_ENQUEUE)) {
    await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: id, from: 'sweep', media_only: true }, p_priority: 30, p_requested_by: null, p_fallback_of: null });
    stats.media_recover++;
  }

  // ── stage 2: OCR on the free lane ─────────────────────────────────────────
  // Posts already sitting in a queued/running OCR batch are EXCLUDED. Stages 1
  // and 3 always had this guard; stage 2 did not, so every tick re-enqueued
  // posts that were already spoken for. The lane then burned its capacity
  // proving there was nothing to do: 13 of 15 consecutive jobs returned
  // `images: 0, skipped_already_ocr: 7-10`. The queue looked busy and the
  // corpus barely moved — 13 jobs advanced it by 18 images.
  const ocrInFlight = new Set<string>();
  {
    const rows = await pageAll<{ payload: { post_ids?: string[] } | null }>(
      (from, to) => sb.from('claude_jobs').select('payload')
        .eq('kind', 'mkt_visual_ocr').in('status', ['pending', 'running'])
        .order('id', { ascending: true }).range(from, to),
      OCR_QUEUE_HIGH_WATER + PAGE, 'ocr in-flight scan');
    for (const r of rows) for (const pid of r.payload?.post_ids ?? []) ocrInFlight.add(pid);
  }
  // Stage 2's scope is GLOBAL, not the 'collected' set the other stages use.
  // Whether an image has been read has nothing to do with its post's processing
  // status — but scoping OCR to 'collected' meant that the moment stage 3
  // promoted a post out of 'collected', any image still unread inside it became
  // invisible to this sweep forever. Measured when the queue drained to zero
  // with work outstanding: 625 unread images, and NOT ONE of them in a
  // 'collected' post — 411 sat in posts marked 'failed', 134 in
  // 'awaiting_intelligence', 80 in 'processed'.
  //
  // `postsNeedingOcr` (the 'collected'-scoped set) is still computed above and
  // still drives stage 3's readiness test; it is simply not the OCR scope.
  const needOcr = reader === 'runner' ? (await postsWithUnreadImages(sb)).filter((id) => !ocrInFlight.has(id)) : [];
  if (needOcr.length > 0) {
    const { count: ocrQueued } = await sb.from('claude_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'mkt_visual_ocr').in('status', ['pending', 'running']);
    if ((ocrQueued ?? 0) < OCR_QUEUE_HIGH_WATER) {
      for (const batch of chunk(needOcr, OCR_POSTS_PER_BATCH).slice(0, MAX_OCR_BATCHES)) {
        const { error } = await sb.from('claude_jobs').insert({ kind: 'mkt_visual_ocr', payload: { post_ids: batch, from: 'sweep' }, status: 'pending' });
        if (error) throw new Error(`sweep: ocr enqueue failed: ${error.message}`);
        stats.visual_ocr++;
      }
    }
  }

  // ── stage 2a: stored videos whose frames were never taken ─────────────────
  // The cover picture is read in stage 2, and full processing then used to
  // treat "has visual text" as "done" — so the frames, where the price / offer /
  // phone overlays are, went unread for 1,167 of 1,406 videos. The backlog
  // lives in the data (mkt_videos_needing_frames), not in a one-off script.
  if (reader === 'runner') {
    const { data, error } = await sb.rpc('mkt_videos_needing_frames', { p_limit: FRAME_JOBS_PER_TICK });
    if (error) throw new Error(`sweep: videos-needing-frames failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ content_post_id: string }>) {
      const { error: enqErr } = await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: row.content_post_id, from: 'sweep', mode: 'frames_only' }, p_priority: 60, p_requested_by: null, p_fallback_of: null });
      if (enqErr) throw new Error(`sweep: frames job enqueue failed: ${enqErr.message}`);
      stats.frame_jobs++;
    }
  }

  // ── stage 2b: staged frames → the same free OCR lane, under the same cap ──
  if (reader === 'runner') {
    const { count: ocrQueued } = await sb.from('claude_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'mkt_visual_ocr').in('status', ['pending', 'running']);
    if ((ocrQueued ?? 0) < OCR_QUEUE_HIGH_WATER) {
      // mkt_video_frames_pending excludes frames already inside a queued or
      // running job, so each batch is inserted before the next is asked for.
      for (let i = 0; i < MAX_FRAME_BATCHES; i++) {
        const { data, error } = await sb.rpc('mkt_video_frames_pending', { p_limit: FRAMES_PER_BATCH });
        if (error) throw new Error(`sweep: pending-frames failed: ${error.message}`);
        const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (ids.length === 0) break;
        const { error: insErr } = await sb.from('claude_jobs').insert({ kind: 'mkt_visual_ocr', payload: { frame_ids: ids, from: 'sweep-frames' }, status: 'pending' });
        if (insErr) throw new Error(`sweep: frame ocr enqueue failed: ${insErr.message}`);
        stats.frame_ocr++;
        if (ids.length < FRAMES_PER_BATCH) break;
      }
    }
  }

  // ── stage 2c: TikTok videos whose file never arrived ──────────────────────
  // The RPC enqueues nothing unless Apify is enabled and not paused, so this
  // cannot spend while collection is stopped. One bounded job per account per
  // 20 h, three attempts per video.
  {
    const { error } = await sb.rpc('mkt_enqueue_tiktok_redownloads', { p_max_jobs: 3 });
    if (error) throw new Error(`sweep: tiktok redownload enqueue failed: ${error.message}`);
  }

  // ── stage 3: full processing, once the evidence is on hand ────────────────
  // Eligible = media stored AND (visual text present OR nothing to OCR). The
  // second arm covers video-only posts, whose evidence is the transcript.
  // Under the Gemini reader a post is ready as soon as its media is stored —
  // Gemini reads the images itself, there is no OCR lane to wait for.
  const readyForFull = postIds.filter((id) =>
    storedAny.has(id) && !inFlight.has(id) && (isModelReader(reader) || hasVisualText.has(id) || !storedImagey.has(id)));
  const processCap = isModelReader(reader) ? (readerBudgetOk ? MAX_PROCESS_ENQUEUE : 0) : MAX_PROCESS_ENQUEUE;
  for (const id of readyForFull.slice(0, processCap)) {
    await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: id, from: 'sweep' }, p_priority: 40, p_requested_by: null, p_fallback_of: null });
    stats.content_process++;
  }

  // ── stage 4: intelligence — the read that turns evidence into attribution ──
  // A post at 'awaiting_intelligence' has everything: media stored, video
  // transcribed, images OCR'd, facts extracted. All that is missing is the
  // decision about WHICH PROJECT it is about — and without that the facts exist
  // but attribute to nothing, which is why confirmed attributions looked tiny
  // beside the fact count.
  //
  // `mkt_enqueue_intelligence` has existed since 2026-07-28 and works. Its only
  // caller was a manual admin action in api/marketing.ts, so in practice it ran
  // when someone remembered — and nobody did: 1,732 posts sat awaiting a read
  // with ZERO enrichment jobs queued. Same shape as the other three stages
  // before today (a capable mechanism nothing invoked), so it belongs on the
  // same state-driven tick as the rest.
  //
  // IMAGES AND VIDEOS BOTH. The RPC does not filter on post_type, and the
  // evidence package carries caption + transcript (16k) + OCR, so a reel is read
  // from what was said in it and what was shown on its frames. Video posts were
  // never excluded — they were simply never enqueued.
  //
  // This is the one stage that spends model capacity per post, so it is the most
  // tightly bounded: it tops the queue up to ENRICH_QUEUE_HIGH_WATER and stops.
  // The lane is a singleton, drains at its own pace, and parks itself on a
  // subscription limit (claude_job_block) rather than hammering.
  if (isModelReader(reader) && readerBudgetOk) {
    // Posts left waiting for the runner, and posts an older reader decided,
    // get a full Gemini read (content_process re-uses stored media and
    // transcripts; only the read itself is new).
    const awaitingIds = (await pageAll<{ id: string }>(
      (from, to) => sb.from('mkt_content_posts').select('id')
        .eq('processing_status', 'awaiting_intelligence')
        .order('id', { ascending: true }).range(from, to),
      MAX_GEMINI_READS_PER_TICK * 4, 'awaiting scan')).map((r) => r.id).filter((id) => !inFlight.has(id));
    for (const id of awaitingIds.slice(0, MAX_GEMINI_READS_PER_TICK)) {
      const { error } = await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: id, from: 'sweep-gemini' }, p_priority: 45, p_requested_by: null, p_fallback_of: null });
      if (error) throw new Error(`sweep: gemini read enqueue failed: ${error.message}`);
      inFlight.add(id);
      stats.gemini_reads++;
    }
    // Re-read: done decisions by a non-Gemini reader, newest posts first is not
    // needed — order by id keeps the walk stable across ticks.
    const olderReads = await pageAll<{ content_post_id: string }>(
      (from, to) => sb.from('mkt_content_enrichment').select('content_post_id')
        .eq('status', 'done').or('model.is.null,and(model.not.like.gemini*,model.not.like.gpt-*)')
        .order('content_post_id', { ascending: true }).range(from, to),
      MAX_GEMINI_REREADS_PER_TICK * 4, 'reread scan');
    for (const r of olderReads.filter((x) => !inFlight.has(x.content_post_id)).slice(0, MAX_GEMINI_REREADS_PER_TICK)) {
      const { error } = await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: r.content_post_id, from: 'sweep-gemini-reread' }, p_priority: 70, p_requested_by: null, p_fallback_of: null });
      if (error) throw new Error(`sweep: gemini re-read enqueue failed: ${error.message}`);
      inFlight.add(r.content_post_id);
      stats.gemini_rereads++;
    }
    // Design reads for image posts read before 2026-10-05, and retries of a
    // failed design read (the RPC stops offering a post after 3 attempts).
    const { data: due, error: dueErr } = await sb.rpc('mkt_design_read_due', { p_limit: MAX_DESIGN_READS_PER_TICK * 2 });
    if (dueErr) throw new Error(`sweep: design read scan failed: ${dueErr.message}`);
    for (const d of ((due ?? []) as Array<{ content_post_id: string }>).filter((x) => !inFlight.has(x.content_post_id)).slice(0, MAX_DESIGN_READS_PER_TICK)) {
      const { error } = await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: d.content_post_id, mode: 'design_only', from: 'sweep-design' }, p_priority: 75, p_requested_by: null, p_fallback_of: null });
      if (error) throw new Error(`sweep: design read enqueue failed: ${error.message}`);
      inFlight.add(d.content_post_id);
      stats.design_reads++;
    }
  }
  const { count: enrichQueued } = reader === 'runner'
    ? await sb.from('claude_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'mkt_content_enrichment').in('status', ['pending', 'running'])
    : { count: ENRICH_QUEUE_HIGH_WATER };
  let budget = Math.min(MAX_ENRICH_JOBS_PER_TICK, ENRICH_QUEUE_HIGH_WATER - (enrichQueued ?? 0));
  if (budget > 0) {
    // The RPC is per-organization, so find the orgs that actually have unread
    // posts rather than walking every org we know about.
    const awaiting = await pageAll<{ organization_id: string | null }>(
      (from, to) => sb.from('mkt_content_posts').select('organization_id')
        .eq('processing_status', 'awaiting_intelligence')
        .order('id', { ascending: true }).range(from, to),
      20_000, 'intelligence org scan');
    const orgs = [...new Set(awaiting.map((a) => a.organization_id).filter((o): o is string => !!o))];
    for (const org of orgs) {
      if (budget <= 0) break;
      const { data, error } = await sb.rpc('mkt_enqueue_intelligence', { p_org: org, p_batch: ENRICH_POSTS_PER_BATCH, p_max_jobs: budget });
      if (error) throw new Error(`sweep: intelligence enqueue failed: ${error.message}`);
      const made = Number(data ?? 0);
      stats.intelligence += made;
      budget -= made;
    }
  }

  // ── stage 5: visual intelligence self-heal (W-CV, 2026-09-02) ─────────────
  // A cv video sits at 'queued' when its job was never enqueued (or was dropped
  // by a deploy mid-claim) and at 'failed' when it exhausted attempts. Both are
  // recoverable later — a Modal outage clears, a source URL comes back — so,
  // like stage 1, they are re-offered on a 6-hour cadence, oldest first, capped
  // per tick. mkt_cv_enqueue_video is idempotent: a video that already owns an
  // active job is a no-op (job_enqueue dedups on the active partial index).
  // Only when cv.enabled — the DB flag is the single switch for the system, and
  // claim_next refuses when it is off anyway; enqueueing into a paused queue
  // would only pile up work nobody asked for.
  {
    const { data: cvOn, error: cvErr } = await sb.rpc('mkt_cv_enabled');
    if (cvErr) throw new Error(`sweep: mkt_cv_enabled failed: ${cvErr.message}`);
    if (cvOn === true) {
      const cutoffIso = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
      const { data: stale, error: staleErr } = await sb.from('mkt_cv_videos')
        .select('id, content_media_id, status')
        .in('status', ['queued', 'failed'])
        .eq('owner', 'competitor')
        .not('content_media_id', 'is', null)
        .lt('updated_at', cutoffIso)
        .order('updated_at', { ascending: true })
        .limit(MAX_CV_REENQUEUE);
      if (staleErr) throw new Error(`sweep: cv stale-video scan failed: ${staleErr.message}`);
      for (const v of (stale ?? []) as Array<{ id: string; content_media_id: string; status: string }>) {
        const { error } = await sb.rpc('mkt_cv_enqueue_video', { p_content_media_id: v.content_media_id, p_priority: 120 });
        if (error) {
          // The RPC raises `permanent:` when the media row is no longer a stored
          // video (deleted / re-collected). That is one video's problem, not the
          // sweep's — log it and keep offering the rest. Every other error kind
          // is also logged here; none is hidden.
          console.error(`[sweep] cv re-enqueue video=${v.id} (${v.status}) failed: ${error.message}`);
          continue;
        }
        stats.cv_reenqueue++;
      }
    }
  }

  // ── stage 6: social-media → Files registration (2026-09-13) ─────────────
  // Attributed posts whose stored photos/videos have no `files` row yet.
  // social_file_backfill is capped by social_file_settings.max_queue_depth and
  // is a no-op while the bridge is disabled, so this costs nothing when idle.
  try {
    const { data, error } = await sb.rpc('social_file_backfill', { p_limit: 50 });
    if (error) console.error(`[sweep] social_file_backfill failed: ${error.message}`);
    else stats.social_file = Number(data ?? 0);
  } catch (e) {
    console.error(`[sweep] social_file_backfill threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── stage 7: geometry repair (2026-09-15) ───────────────────────────────
  // yt-dlp gives no width/height, so YouTube videos land without dimensions
  // and therefore without an aspect ratio in the Library. One ffprobe each,
  // from OUR bucket — the originals cannot be re-fetched (YouTube blocks
  // datacenter IPs). Small batch per tick; idempotent, so it goes quiet once
  // everything is filled.
  try {
    const r = await repairMediaDimensions(sb, { limit: 25 });
    stats.dims_repaired = r.fixed;
    if (r.errors.length > 0) console.error(`[sweep] dimension repair: ${r.errors.length} failed, first: ${r.errors[0]}`);
  } catch (e) {
    console.error(`[sweep] dimension repair threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── stage 8: Apify storage cleanup (2026-09-21) ─────────────────────────
  // Delete datasets / video stores our Apify runs left behind once our own
  // copy exists. They were billed hourly for 31 days ($4.98 of a $29 month).
  // Small batch per tick; see apifyStorageSweep.ts for the safety rule.
  try {
    const r = await sweepApifyStorage(sb, { limit: 25 });
    stats.apify_storage_swept = r.swept;
    if (r.errors.length > 0) console.error(`[sweep] apify storage: ${r.errors.length} run(s) failed, first: ${r.errors[0]}`);
  } catch (e) {
    console.error(`[sweep] apify storage sweep threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── stage 9: files media metadata repair (2026-09-21; images added 09-27) ─
  // Dimensions + duration are header reads (ffprobe for video, sharp for image,
  // no AI), but only the social-intake scraper probes at ingest — the marketing
  // bulk import, older user uploads and every server creator did not, leaving
  // ~8,200 images with no width/height and ~200 videos with no duration. The
  // Library ratio filter is blind to un-sized images and "send the longest
  // video" cannot rank a length-less video. This fills both, one signed-fetch +
  // header read at a time, from OUR bucket. Idempotent (only touches rows still
  // missing the metadata); goes quiet once drained, catches any future path.
  try {
    const r = await repairFileMediaMeta(sb, { limit: 25 });
    stats.file_media_repaired = r.fixed;
    if (r.errors.length > 0) console.error(`[sweep] file media repair: ${r.errors.length} failed, first: ${r.errors[0]}`);
  } catch (e) {
    console.error(`[sweep] file media repair threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── stage 10: files content_etag backfill (2026-09-27) ──────────────────
  // The duplicate-detection key is `content_etag` (Storage's own MD5), read via
  // one indexed storage.list lookup — NO byte download. Every server-side file
  // creator (compressed PDFs, generated docs, social-intake bridge, worker
  // outputs) left it NULL, so ~1,750 files are invisible to the duplicate check.
  // This fills them from Storage metadata. Idempotent; skips multipart eTags
  // (a `-<n>` hash-of-hashes is not a usable dedup key), same as the upload path.
  try {
    const r = await backfillContentEtags(sb, { limit: 100 });
    stats.etags_filled = r.filled;
    if (r.errors.length > 0) console.error(`[sweep] etag backfill: ${r.errors.length} failed, first: ${r.errors[0]}`);
  } catch (e) {
    console.error(`[sweep] etag backfill threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  return stats;
}


/** Gemini reader spend (post reads + image design reads) since Riyadh midnight, from the ai_usage ledger. */
async function readerSpendToday(sb: SupabaseClient): Promise<number> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const since = new Date(`${day}T00:00:00+03:00`).toISOString();
  const rows = await pageAll<{ cost_usd: number | null }>(
    (from, to) => sb.from('ai_usage').select('cost_usd')
      .in('call_site', ['worker/marketing/geminiRead', 'worker/marketing/openaiRead', 'worker/marketing/geminiDesign', 'worker/marketing/openaiDesign']).gte('created_at', since)
      .order('id', { ascending: true }).range(from, to),
    200_000, 'reader spend scan');
  return rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
}

async function readerBudgetUsd(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.from('mkt_settings').select('value').eq('key', 'content.reader_daily_budget_usd').maybeSingle();
  if (error) throw new Error(`content.reader_daily_budget_usd read failed: ${error.message}`);
  const n = Number((data as { value?: unknown } | null)?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_READER_BUDGET_USD;
}
