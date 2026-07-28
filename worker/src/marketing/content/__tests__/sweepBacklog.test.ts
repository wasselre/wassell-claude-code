import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sweepContentBacklog } from '../sweepBacklog.js';

// ---------------------------------------------------------------------------
// Minimal PostgREST-shaped fake. Every builder method returns `this`; the object
// is thenable so `await`ing it anywhere in the chain resolves the canned result
// for that table. Enough to pin the STAGE SELECTION, which is the part that
// decides whether a post is ever processed at all.
// ---------------------------------------------------------------------------
interface Canned { posts?: unknown[]; media?: unknown[]; visual?: unknown[]; inFlight?: unknown[]; ocrInFlight?: unknown[]; jobCount?: number; ocrCount?: number; leaseWon?: boolean }

/** PostgREST's server-side row cap. The fake enforces it so a `.limit()` that
 *  exceeds it cannot silently pass in tests while truncating in production. */
const DB_MAX_ROWS = 1000;

function fakeSb(c: Canned) {
  const enqueued: Array<Record<string, unknown>> = [];
  const ocrInserts: Array<Record<string, unknown>> = [];

  const builder = (table: string, op: 'select' | 'update' | 'insert' | 'upsert') => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    let range: [number, number] | null = null;
    for (const m of ['select', 'eq', 'in', 'lt', 'order', 'limit', 'neq']) b[m] = chain;
    b.range = (from: number, to: number) => { range = [from, to]; return b; };
    // Emulates the server: honour .range() and NEVER return more than the cap.
    const page = (rows: unknown[]) => {
      const [from, to] = range ?? [0, DB_MAX_ROWS - 1];
      return rows.slice(from, Math.min(to + 1, from + DB_MAX_ROWS));
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'mkt_settings') return resolve({ data: c.leaseWon === false ? [] : [{ key: 'x' }], error: null });
      if (table === 'mkt_content_posts') return resolve({ data: page(c.posts ?? []), error: null });
      if (table === 'mkt_content_media') return resolve({ data: page(c.media ?? []), error: null });
      if (table === 'mkt_visual_text') return resolve({ data: page(c.visual ?? []), error: null });
      if (table === 'claude_jobs') return resolve({ data: page(c.ocrInFlight ?? []), error: null, count: c.ocrCount ?? 0 });
      if (table === 'mkt_collection_jobs') {
        // head+count call vs the params scan — the params scan asks for data.
        return resolve({ data: page(c.inFlight ?? []), error: null, count: c.jobCount ?? 0 });
      }
      return resolve({ data: [], error: null, count: 0 });
    };
    if (op === 'insert') { b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }); }
    return b;
  };

  const sb = {
    from(table: string) {
      return {
        select: () => builder(table, 'select'),
        update: () => builder(table, 'update'),
        upsert: () => builder(table, 'upsert'),
        insert: (row: Record<string, unknown>) => { if (table === 'claude_jobs') ocrInserts.push(row); return builder(table, 'insert'); },
      };
    },
    rpc: (fn: string, params: Record<string, unknown>) => {
      if (fn === 'mkt_job_enqueue') enqueued.push(params);
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  return { sb, enqueued, ocrInserts };
}

const post = (id: string) => ({ id, post_type: 'image' });
/** Media rows carry a real id — OCR coverage is tracked per media, so a fixture
 *  without ids lets `undefined === undefined` pass tests that prove nothing. */
const stored = (pid: string, kind: string, mid = `${pid}-m0`) =>
  ({ id: mid, content_post_id: pid, media_kind: kind, download_status: 'stored', updated_at: new Date(0).toISOString() });
const failed = (pid: string, kind: string, ageMs: number, mid = `${pid}-mf`) =>
  ({ id: mid, content_post_id: pid, media_kind: kind, download_status: 'failed', updated_at: new Date(Date.now() - ageMs).toISOString() });
const ocrd = (mid: string) => ({ content_media_id: mid });
const HOUR = 60 * 60 * 1000;

describe('sweepContentBacklog', () => {
  it('enqueues media recovery for a collected post with no stored media', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(1);
    expect(enqueued[0].p_params).toMatchObject({ content_post_id: 'p1', media_only: true });
    // Recovery must be media-only: paying for vision before the free OCR lane
    // has had a chance to read the images is the cost bug this ordering avoids.
    expect(stats.content_process).toBe(0);
  });

  it('sends stored-but-unread images to the OCR lane, not to metered vision', async () => {
    const { sb, ocrInserts, enqueued } = fakeSb({ posts: [post('p1')], media: [stored('p1', 'image')] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.visual_ocr).toBe(1);
    expect((ocrInserts[0] as { kind: string }).kind).toBe('mkt_visual_ocr');
    expect((ocrInserts[0].payload as { post_ids: string[] }).post_ids).toEqual(['p1']);
    // Not eligible for full processing yet — its visual text does not exist.
    expect(enqueued.filter((e) => !(e.p_params as { media_only?: boolean }).media_only)).toHaveLength(0);
    expect(stats.media_recover).toBe(0);
  });

  it('promotes a post to full processing once media AND visual text exist', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], media: [stored('p1', 'image')], visual: [ocrd('p1-m0')] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.content_process).toBe(1);
    expect(stats.visual_ocr).toBe(0);
    expect((enqueued[0].p_params as { media_only?: boolean }).media_only).toBeUndefined();
  });

  it('promotes a video-only post with no OCR-able media straight to full processing', async () => {
    // Its evidence is the transcript, so waiting for visual text would strand it
    // forever — the exact shape of stall this sweep exists to prevent.
    const { sb } = fakeSb({ posts: [post('p1')], media: [stored('p1', 'video')] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.content_process).toBe(1);
    expect(stats.visual_ocr).toBe(0);
  });

  it('does not re-attempt a recently failed download every tick', async () => {
    // A YouTube video the datacenter IP is bot-checked out of never acquires
    // stored media, so without a cooldown it would be re-enqueued forever.
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], media: [failed('p1', 'video', 1 * HOUR)] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('does re-attempt a failed download once the cooldown has passed', async () => {
    const { sb } = fakeSb({ posts: [post('p1')], media: [failed('p1', 'video', 9 * HOUR)] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(1);
  });

  it('never enqueues a post that already has a job in flight', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], inFlight: [{ params: { content_post_id: 'p1' } }] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('sees past the 1,000-row PostgREST cap', async () => {
    // The regression this pins: the scan asked for 3,000 rows, PostgREST capped
    // it at 1,000 without saying so, and because the scan is ordered oldest-
    // first every returned post already had media. needMedia computed to ZERO
    // and the sweep logged `media_recover=0` while 103 newer posts sat
    // unrecovered. Nothing errored; the number was just quietly wrong.
    const many = Array.from({ length: 1200 }, (_, i) => post(`p${i}`));
    // The first 1,000 are done; only the tail past the cap still needs media.
    const done = many.slice(0, 1000).map((p) => stored(p.id, 'image'));
    const { sb, enqueued } = fakeSb({ posts: many, media: done, visual: many.slice(0, 1000).map((p) => ocrd(p.id + '-m0')) });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(200);
    expect(enqueued.filter((e) => (e.p_params as { media_only?: boolean }).media_only)).toHaveLength(200);
    // The 1,000 already-complete posts are past the cap too, and they are the
    // ones stage 3 promotes — so paging has to hold for every stage, not just
    // the one that surfaced the bug.
    expect(stats.content_process).toBeGreaterThan(0);
  });

  it('re-offers a post whose OTHER images are still unread', async () => {
    // The stranded-images regression. Coverage used to be a per-POST question —
    // "does this post have any visual_text?" — so reading ONE image of a
    // five-image carousel marked the whole post finished and the rest were never
    // offered again. Measured live: 36 posts holding 303 permanently unread
    // images. Coverage is per MEDIA.
    const { sb, ocrInserts } = fakeSb({
      posts: [post('p1')],
      media: [stored('p1', 'image', 'p1-a'), stored('p1', 'image', 'p1-b')],
      visual: [ocrd('p1-a')],
    });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.visual_ocr).toBe(1);
    expect((ocrInserts[0].payload as { post_ids: string[] }).post_ids).toEqual(['p1']);
  });

  it('does not re-enqueue a post already sitting in an OCR batch', async () => {
    // Stage 2 had no in-flight guard, so every tick re-queued posts that were
    // already spoken for. The lane then spent its capacity proving there was
    // nothing to do: 13 of 15 consecutive jobs returned images: 0.
    const { sb, ocrInserts } = fakeSb({
      posts: [post('p1')],
      media: [stored('p1', 'image')],
      ocrInFlight: [{ payload: { post_ids: ['p1'] } }],
    });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.visual_ocr).toBe(0);
    expect(ocrInserts).toHaveLength(0);
  });

  it('does nothing when another machine holds the sweep lease', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], leaseWon: false });
    const stats = await sweepContentBacklog(sb, 'w2');
    expect(stats.skipped_not_leader).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('stops enqueueing when the queue is already deep', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], jobCount: 5000 });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.skipped_queue_full).toBe(true);
    expect(enqueued).toHaveLength(0);
  });
});
