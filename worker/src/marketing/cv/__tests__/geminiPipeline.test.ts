import { describe, expect, it, vi } from 'vitest';
import { keyframeTimes, normalizeShots, paceCutsPerMin, parseScdet, shotsFromCuts, type DetectedCut } from '../gemini/shots.js';
import { buildVideoPrompt, parseVideoOutput, type GeminiShot } from '../gemini/geminiVideo.js';
import { toAnalyzerOutput } from '../gemini/process.js';
import { coerceShotAnalysis } from '../analyzeShot.js';
import { jpegSize } from '../gemini/media.js';
import { createGeminiEmbedProvider } from '../../../ai/providers/geminiEmbed.js';
import { dailyQuotaOf, dailyQuotaRetryAfter, embeddingCostUsd, flashCostUsd, geminiPost, modalityTokens } from '../../../ai/providers/geminiHttp.js';

const shot = (start_s: number, extra: Partial<GeminiShot> = {}): GeminiShot => ({
  start_s, end_s: start_s + 1, continuous_take: false, transition_in: 'cut', summary_ar: 'ع', summary_en: `shot ${start_s}`,
  on_screen_text: [`t${start_s}`], footage: 'real', purpose: 'feature', angle: 'a', camera_movement: 'pan', pace: 'fast',
  production_method: 'drone', production_difficulty: 'easy', production_resources: ['drone'], reproducibility: 'easy',
  suitable_platforms: ['tiktok'], mood: 'calm', tags: ['shot_size:wide'], confidence: 0.9, ...extra,
});
const merge = (a: GeminiShot, b: GeminiShot): GeminiShot => ({ ...a, on_screen_text: [...a.on_screen_text, ...b.on_screen_text] });

describe('parseScdet', () => {
  it('reads score + time pairs and sorts them', () => {
    const stderr = '[scdet @ 0x1] lavfi.scd.score: 31.200, lavfi.scd.time: 4.37\nnoise\n[scdet @ 0x1] lavfi.scd.score: 12.5, lavfi.scd.time: 1.2\n';
    expect(parseScdet(stderr)).toEqual([{ t_ms: 1200, score: 12.5 }, { t_ms: 4370, score: 31.2 }]);
  });
  it('returns [] for a video with no cuts', () => {
    expect(parseScdet('frame=  100 fps=0.0')).toEqual([]);
  });
});

describe('normalizeShots', () => {
  const cuts: DetectedCut[] = [{ t_ms: 3010, score: 40 }, { t_ms: 7000, score: 8 }];
  it('snaps a boundary onto a nearby detected cut and covers exactly [0, duration]', () => {
    const out = normalizeShots([shot(0), shot(3.4), shot(6)], 9000, cuts, merge);
    expect(out.map((s) => [s.start_ms, s.end_ms])).toEqual([[0, 3010], [3010, 6000], [6000, 9000]]);
    expect(out[0]!.transition_in).toBe('start');
    expect(out[2]!.transition_out).toBe('end');
  });
  it('ignores detector reports below the hint score when snapping', () => {
    const out = normalizeShots([shot(0), shot(6.8)], 9000, cuts, merge);
    expect(out[1]!.start_ms).toBe(6800);
  });
  it('clamps a boundary past the end (Gemini overran on 2 of 20 test videos) and merges it', () => {
    const out = normalizeShots([shot(0), shot(4), shot(12)], 9000, [], merge);
    expect(out).toHaveLength(2);
    expect(out[1]!.end_ms).toBe(9000);
    expect(out[1]!.data.on_screen_text).toEqual(['t4', 't12']);
  });
  it('merges a shot shorter than the minimum into the previous one', () => {
    const out = normalizeShots([shot(0), shot(2), shot(2.05)], 5000, [], merge);
    expect(out.map((s) => s.start_ms)).toEqual([0, 2000]);
  });
  it('sorts out-of-order shots and keeps continuous takes as internal changes', () => {
    const out = normalizeShots([shot(5, { continuous_take: true, transition_in: 'cut' }), shot(0)], 8000, [], merge);
    expect(out.map((s) => s.start_ms)).toEqual([0, 5000]);
    expect(out[1]!.internal_change).toBe(true);
  });
  it('maps unknown transitions to cut and keeps dissolves', () => {
    const out = normalizeShots([shot(0), shot(2, { transition_in: 'dissolve' }), shot(4, { transition_in: 'wipe' })], 6000, [], merge);
    expect(out.map((s) => s.transition_in)).toEqual(['start', 'dissolve', 'cut']);
    expect(out[0]!.transition_out).toBe('dissolve');
  });
  it('returns [] when the model gave no shots, and refuses a zero duration', () => {
    expect(normalizeShots([], 5000, [], merge)).toEqual([]);
    expect(() => normalizeShots([shot(0)], 0, [], merge)).toThrow(/duration/);
  });
});

describe('shotsFromCuts / keyframeTimes / paceCutsPerMin', () => {
  it('uses only cuts at or above the hint score', () => {
    expect(shotsFromCuts(10000, [{ t_ms: 2000, score: 30 }, { t_ms: 5000, score: 7 }, { t_ms: 8000, score: 12 }]))
      .toEqual([{ shot_no: 0, start_ms: 0, end_ms: 2000 }, { shot_no: 1, start_ms: 2000, end_ms: 8000 }, { shot_no: 2, start_ms: 8000, end_ms: 10000 }]);
  });
  it('one keyframe for a short shot, three for a long one, all inside the shot', () => {
    expect(keyframeTimes(1000, 3000)).toEqual([2000]);
    expect(keyframeTimes(0, 8000)).toEqual([2000, 4000, 6000]);
    for (const t of keyframeTimes(500, 560)) { expect(t).toBeGreaterThanOrEqual(500); expect(t).toBeLessThanOrEqual(560); }
  });
  it('counts boundaries plus certain cuts the shot list missed', () => {
    // 2 boundaries + 1 certain cut not near either = 3 cuts in 30 s = 6/min
    expect(paceCutsPerMin([0, 10000, 20000], [{ t_ms: 10200, score: 50 }, { t_ms: 25000, score: 30 }, { t_ms: 27000, score: 12 }], 30000)).toBe(6);
    expect(paceCutsPerMin([0], [], 0)).toBeNull();
  });
});

describe('Gemini video reply', () => {
  it('parses a fenced JSON reply', () => {
    const o = parseVideoOutput('```json\n{"summary_ar":"س","summary_en":"s","shots":[]}\n```');
    expect(o.shots).toEqual([]);
    expect(o.summary_en).toBe('s');
  });
  it('fails loudly on a reply with no shots array', () => {
    expect(() => parseVideoOutput('{"summary_en":"s"}')).toThrow(/^provider:gemini reply has no shots array/);
    expect(() => parseVideoOutput('not json')).toThrow(/^provider:gemini returned unparseable JSON/);
  });
  it('the prompt separates certain from possible cuts and states the duration', () => {
    const p = buildVideoPrompt({ durationMs: 45130, cuts: [{ t_ms: 4370, score: 40 }, { t_ms: 5230, score: 12 }, { t_ms: 6000, score: 7 }], transcript: [], transcriptLanguage: null, contentType: null, campaignMessage: null, partialNote: null });
    expect(p).toContain('certain: 4.37');
    expect(p).toContain('possible (may be false alarms from flashes or fast motion): 5.23');
    expect(p).not.toContain('6.00');
    expect(p).toContain('end at 45.13');
    expect(p).toContain('copied EXACTLY in its original language');
  });
  it('maps a Gemini shot onto the drawer contract with validated tags', () => {
    const { analysis, tags } = coerceShotAnalysis(toAnalyzerOutput(shot(0, { tags: ['shot_size:wide', 'setting:garden'], purpose: 'hook', camera_movement: 'drone' })), { transition_in: 'start', transition_out: 'cut', edit_pace_local: 12 });
    expect(analysis.purpose).toBe('hook');
    expect(analysis.camera_movement).toBe('drone');
    expect(analysis.rejected_tags).toEqual(['setting:garden']);
    expect(tags).toEqual(expect.arrayContaining(['shot_size:wide', 'purpose:hook', 'motion:drone', 'reproducibility:easy']));
  });
});

describe('Gemini pricing (rates cited in geminiHttp.ts)', () => {
  it('prices flash input + output, and doubles from 2027-01-01', () => {
    expect(flashCostUsd(1_000_000, 1_000_000, 0, Date.UTC(2026, 9, 4))).toBe(4.5);
    expect(flashCostUsd(1_000_000, 1_000_000, 0, Date.UTC(2027, 0, 1))).toBe(9);
  });
  it('bills implicitly cached input at the cached rate', () => {
    // 12,584 in of which 7,360 cached, 2,429 out — the measured call of 2026-10-04.
    expect(flashCostUsd(12_584, 2_429, 7_360, Date.UTC(2026, 9, 4))).toBeCloseTo((5_224 * 0.75 + 7_360 * 0.075 + 2_429 * 3.75) / 1e6, 6);
  });
  it('reads modality details under either spelling', () => {
    expect(modalityTokens({ promptTokenCount: 10, promptTokensDetails: [{ modality: 'VIDEO', tokenCount: 9 }] }).video).toBe(9);
  });
  it('prices embedding tokens by modality', () => {
    const u = { promptTokenCount: 1_258_000, promptTokenDetails: [{ modality: 'IMAGE', tokenCount: 1_000_000 }, { modality: 'TEXT', tokenCount: 258_000 }] };
    expect(modalityTokens(u)).toMatchObject({ image: 1_000_000, text: 258_000 });
    expect(embeddingCostUsd(u)).toBeCloseTo(0.45 + 0.0516, 6);
  });
});

describe('gemini embedding provider (no network)', () => {
  const role = { provider: 'gemini' as const, model: 'gemini-embedding-2', dim: 768 };
  const okBatch = (n: number, dim: number) => new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: new Array(dim).fill(0.1) })), usageMetadata: { promptTokenCount: 258 * n, promptTokenDetails: [{ modality: 'IMAGE', tokenCount: 258 * n }] } }), { status: 200 });

  it('downloads images, sends them inline and asks for the role dimension', async () => {
    const api = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ outputDimensionality: number; content: { parts: Array<{ inline_data?: { mime_type: string } }> } }> };
      expect(body.requests[0]!.outputDimensionality).toBe(768);
      expect(body.requests[0]!.content.parts[0]!.inline_data!.mime_type).toBe('image/jpeg');
      return okBatch(body.requests.length, 768);
    });
    const img = vi.fn(async () => new Response(new Uint8Array([0xFF, 0xD8, 1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const p = createGeminiEmbedProvider({ apiKey: 'k', fetch: api as unknown as typeof fetch, fetchImage: img as unknown as typeof fetch });
    const r = await p.embed(role, { image_urls: ['https://a/1.jpg', 'https://a/2.jpg'] });
    expect(r.vectors).toHaveLength(2);
    expect(r.dim).toBe(768);
    expect(r.cost_usd).toBeCloseTo((516 / 1e6) * 0.45, 6);
  });
  it('refuses a vector of the wrong length', async () => {
    const api = vi.fn(async () => okBatch(1, 512));
    const p = createGeminiEmbedProvider({ apiKey: 'k', fetch: api as unknown as typeof fetch });
    await expect(p.embed({ ...role, dim: 768 }, { texts: ['x'] })).rejects.toThrow(/^provider:gemini vector 0 has length 512, expected 768/);
  });
  it('refuses a role without a dimension', async () => {
    const p = createGeminiEmbedProvider({ apiKey: 'k', fetch: vi.fn() as unknown as typeof fetch });
    await expect(p.embed({ provider: 'gemini', model: 'gemini-embedding-2' }, { texts: ['x'] })).rejects.toThrow(/needs a dim/);
  });
  it('retries a 503 and then succeeds', async () => {
    let n = 0;
    const api = vi.fn(async () => (++n === 1 ? new Response('high demand', { status: 503 }) : okBatch(1, 1024)));
    const p = createGeminiEmbedProvider({ apiKey: 'k', fetch: api as unknown as typeof fetch, sleep: async () => {} });
    const r = await p.embed({ ...role, dim: 1024 }, { texts: ['x'] });
    expect(r.vectors[0]).toHaveLength(1024);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('embedQuery returns a visual 768 and a text 1024 vector from one request', async () => {
    const api = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ outputDimensionality: number }> };
      expect(body.requests.map((r) => r.outputDimensionality)).toEqual([768, 1024]);
      return new Response(JSON.stringify({ embeddings: [{ values: new Array(768).fill(0) }, { values: new Array(1024).fill(0) }] }), { status: 200 });
    });
    const p = createGeminiEmbedProvider({ apiKey: 'k', fetch: api as unknown as typeof fetch });
    const q = await p.embedQuery('villa');
    expect(q.image_vec).toHaveLength(768);
    expect(q.text_vec).toHaveLength(1024);
  });
});

describe('jpegSize', () => {
  it('reads width/height from the SOF0 marker', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0xD0, 0x05, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(jpegSize(buf)).toEqual({ height: 720, width: 1280 });
  });
});

describe('per-day quota (seen live 2026-10-04: the key was on the free tier)', () => {
  const body = JSON.stringify({ error: { code: 429, details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56717s' }] } }, null, 2);
  it('recognises a per-day quota and its retry time', () => {
    expect(dailyQuotaOf(body)).toEqual({ quota: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retryAfterSec: 56717 });
    expect(dailyQuotaOf(body.replace('PerDay', 'PerMinute'))).toBeNull();
  });
  it('fails at once instead of retrying, with a message the worker can defer on', async () => {
    const api = vi.fn(async () => new Response(body, { status: 429 }));
    const err = await geminiPost('/v1beta/x', {}, { apiKey: 'k', fetch: api as unknown as typeof fetch, sleep: async () => {} }).catch((e: Error) => e);
    expect(api).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toMatch(/^provider:gemini daily_quota_exhausted GenerateRequestsPerDay/);
    expect(dailyQuotaRetryAfter((err as Error).message)).toBe(56717);
    expect(dailyQuotaRetryAfter('provider:gemini HTTP 503')).toBeNull();
  });
  it('still retries a per-minute 429, waiting as long as Google asks', async () => {
    const waits: number[] = [];
    let n = 0;
    const api = vi.fn(async () => (++n === 1 ? new Response(JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProject' }] }, { retryDelay: '7s' }] } }), { status: 429 }) : new Response('{"ok":1}', { status: 200 })));
    await geminiPost('/v1beta/x', {}, { apiKey: 'k', fetch: api as unknown as typeof fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([7500]);
  });
});
