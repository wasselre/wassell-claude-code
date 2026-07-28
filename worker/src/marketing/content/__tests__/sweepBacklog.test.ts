import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sweepContentBacklog } from '../sweepBacklog.js';

// ---------------------------------------------------------------------------
// Minimal PostgREST-shaped fake. Every builder method returns `this`; the object
// is thenable so `await`ing it anywhere in the chain resolves the canned result
// for that table. Enough to pin the STAGE SELECTION, which is the part that
// decides whether a post is ever processed at all.
// ---------------------------------------------------------------------------
interface Canned { posts?: unknown[]; media?: unknown[]; visual?: unknown[]; inFlight?: unknown[]; jobCount?: number; ocrCount?: number; leaseWon?: boolean }

function fakeSb(c: Canned) {
  const enqueued: Array<Record<string, unknown>> = [];
  const ocrInserts: Array<Record<string, unknown>> = [];

  const builder = (table: string, op: 'select' | 'update' | 'insert' | 'upsert') => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ['select', 'eq', 'in', 'lt', 'order', 'limit', 'neq']) b[m] = chain;
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'mkt_settings') return resolve({ data: c.leaseWon === false ? [] : [{ key: 'x' }], error: null });
      if (table === 'mkt_content_posts') return resolve({ data: c.posts ?? [], error: null });
      if (table === 'mkt_content_media') return resolve({ data: c.media ?? [], error: null });
      if (table === 'mkt_visual_text') return resolve({ data: c.visual ?? [], error: null });
      if (table === 'claude_jobs') return resolve({ data: [], error: null, count: c.ocrCount ?? 0 });
      if (table === 'mkt_collection_jobs') {
        // head+count call vs the params scan — the params scan asks for data.
        return resolve({ data: c.inFlight ?? [], error: null, count: c.jobCount ?? 0 });
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
const stored = (id: string, kind: string) => ({ content_post_id: id, media_kind: kind });

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
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], media: [stored('p1', 'image')], visual: [{ content_post_id: 'p1' }] });
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

  it('never enqueues a post that already has a job in flight', async () => {
    const { sb, enqueued } = fakeSb({ posts: [post('p1')], inFlight: [{ params: { content_post_id: 'p1' } }] });
    const stats = await sweepContentBacklog(sb, 'w1');
    expect(stats.media_recover).toBe(0);
    expect(enqueued).toHaveLength(0);
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
