import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { candidateFromRow, orderedTranscript, retrieveExemplars, selectDiverse, type BoostContext } from '../retrieve.js';
import type { Brief, EmbedFn, ExemplarRow, FactsPackage, RecipeRow } from '../types.js';

const WORDS = ['حياكم', 'اليوم', 'في', 'شمال', 'الرياض', 'حي', 'النرجس', 'مشروع', 'فلل', 'جاهزة', 'للسكن', 'مساحات', 'كبيرة', 'وتشطيب', 'فاخر', 'ما', 'شاء', 'الله', 'تبارك', 'الله', 'تواصلوا', 'معنا', 'للحجز', 'الآن', 'قبل', 'نفاد', 'الوحدات', 'ضمانات', 'شاملة', 'موقع', 'استراتيجي'];
function text(seed: number, len = 60): string {
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(WORDS[(seed * 7 + i * (seed + 3)) % WORDS.length]!);
  return out.join(' ');
}
function row(i: number, org: string, overrides: Partial<ExemplarRow> = {}): ExemplarRow {
  return {
    content_post_id: `p${i}`, organization_id: org, org_name: `org ${org}`, platform: 'instagram', post_type: 'reel',
    content_type: 'walkthrough', language: 'ar', views: 1000 * (i + 1), similarity: 0.9 - i * 0.01,
    transcript_text: text(i), transcript_segments: null, ocr_text: null, campaign_message: null, selling_points: ['مساحات كبيرة'],
    offer: null, unit_types: ['فلل'], district: 'النرجس', published_at: null, post_url: null, ...overrides,
  };
}
const CTX: BoostContext = { platforms: ['instagram'], language: 'ar', unitTypes: ['فلل'], district: 'النرجس', readiness: 'ready', wantOffer: false };

describe('selectDiverse (MMR + per-org cap + duplicate drop)', () => {
  it('caps 2 per organisation, spreads over ≥3 orgs, returns ≤12', () => {
    const rows: ExemplarRow[] = [];
    let i = 0;
    for (const org of ['A', 'B', 'C', 'D', 'E']) for (let k = 0; k < 5; k++) rows.push(row(i++, org));
    const cands = rows.map((r) => candidateFromRow(r, Number(r.similarity), CTX)!);
    const chosen = selectDiverse(cands);
    expect(chosen.length).toBeLessThanOrEqual(12);
    expect(chosen.length).toBeGreaterThanOrEqual(8);
    const perOrg = new Map<string, number>();
    for (const c of chosen) perOrg.set(c.row.organization_id!, (perOrg.get(c.row.organization_id!) ?? 0) + 1);
    for (const n of perOrg.values()) expect(n).toBeLessThanOrEqual(2);
    expect(perOrg.size).toBeGreaterThanOrEqual(3);
  });
  it('drops near-duplicate transcripts (5-gram overlap > 60%)', () => {
    const a = row(1, 'A');
    const dup = row(2, 'B', { transcript_text: a.transcript_text });
    const other = row(3, 'C');
    const chosen = selectDiverse([a, dup, other].map((r) => candidateFromRow(r, Number(r.similarity), CTX)!));
    expect(chosen.map((c) => c.row.content_post_id)).toEqual(['p1', 'p3']);
  });
  it('boosts raise the score above raw similarity', () => {
    const boosted = candidateFromRow(row(1, 'A'), 0.5, CTX)!;
    const plain = candidateFromRow(row(2, 'B', { platform: 'x', language: 'en', unit_types: [], district: 'x', views: null }), 0.5, CTX)!;
    expect(boosted.score).toBeGreaterThan(plain.score);
  });
});

describe('orderedTranscript', () => {
  it('orders segments by start_ms and caps at 700 chars', () => {
    const t = orderedTranscript([{ start_ms: 2000, text: 'ثانياً' }, { start_ms: 0, text: 'أولاً' }], 'fallback');
    expect(t).toBe('أولاً ثانياً');
    const long = orderedTranscript(null, text(1, 400));
    expect(long.length).toBeLessThanOrEqual(702);
  });
});

// ── fake Supabase: rpc + count on mkt_content_embeddings + lexical tables ──
interface Fake { embeddingsCount: number; rpcRows: ExemplarRow[]; transcripts?: unknown[]; enrichment?: unknown[] }
function fakeSb(f: Fake): SupabaseClient {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'mkt_content_embeddings') return resolve({ data: null, error: null, count: f.embeddingsCount });
      if (table === 'mkt_transcripts') return resolve({ data: f.transcripts ?? [], error: null });
      if (table === 'mkt_content_enrichment') return resolve({ data: f.enrichment ?? [], error: null });
      return resolve({ data: [], error: null });
    };
    return b;
  };
  return {
    from: (table: string) => builder(table),
    rpc: async (_name: string, _args: unknown) => ({ data: f.rpcRows, error: null }),
  } as unknown as SupabaseClient;
}
const BRIEF = { platforms: ['instagram'], language: 'ar', objective: null, audience: null, core_message: undefined, campaign: undefined } as unknown as Brief;
const FACTS: FactsPackage = { project_name: 'x', readiness: 'ready', sold_out: false, viable: true, missing: [], warnings: [], facts: [
  { id: 'F1', key: 'unit_type:فلل', class: 'unit_type', value: 'فلل', rendered_ar: 'فلل', source_field: 'unit_types', verified_at: null, claimable: true },
  { id: 'F2', key: 'location', class: 'location', value: { district: 'النرجس', city: 'الرياض' }, rendered_ar: 'النرجس، الرياض', source_field: 'location', verified_at: null, claimable: true },
] };
const RECIPE: RecipeRow = { key: 'walkthrough', label_ar: 'جولة', label_en: 'Walkthrough', structure: ['hook', 'cta'], guidance: 'g', default_duration_sec: 45, scene_count_hint: 7, retrieval_content_types: ['walkthrough'], requires_facts: [], version: 1, is_active: true };
const okEmbed: EmbedFn = async () => ({ vectors: [new Array(1024).fill(0.01)], model: 'bge-m3', version: '1', dim: 1024, cost_usd: null, provider: 'modal', latency_ms: 1 });

describe('retrieveExemplars', () => {
  it('vector path: ids E1.., ordered transcripts, diversity applied', async () => {
    const rows: ExemplarRow[] = [];
    let i = 0;
    for (const org of ['A', 'B', 'C', 'D']) for (let k = 0; k < 4; k++) rows.push(row(i++, org));
    const r = await retrieveExemplars({ sb: fakeSb({ embeddingsCount: 100, rpcRows: rows }), embed: okEmbed }, BRIEF, FACTS, RECIPE);
    expect(r.mode).toBe('vector');
    expect(r.exemplars.map((e) => e.id)).toEqual(r.exemplars.map((_, k) => `E${k + 1}`));
    expect(r.exemplars.length).toBeGreaterThanOrEqual(8);
    expect(r.embedding?.model).toBe('bge-m3');
  });
  it('EMPTY embedding store → loud lexical fallback', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const embed = vi.fn(okEmbed);
    const transcripts = [0, 1, 2].map((k) => ({
      content_post_id: `p${k}`, text: text(k, 100), segments: [], language: 'ar',
      mkt_content_posts: { organization_id: `O${k}`, platform: 'instagram', post_type: 'reel', engagement: { views: 100 }, published_at: null, post_url: null, mkt_organizations: { name_ar: `org ${k}` } },
    }));
    const enrichment = [0, 1, 2].map((k) => ({ content_post_id: `p${k}`, result: { content_type: 'walkthrough', language: 'ar' } }));
    const r = await retrieveExemplars({ sb: fakeSb({ embeddingsCount: 0, rpcRows: [], transcripts, enrichment }), embed }, BRIEF, FACTS, RECIPE);
    expect(embed).not.toHaveBeenCalled();
    expect(r.mode).toBe('lexical');
    expect(r.warnings.some((w) => /EMPTY/.test(w))).toBe(true);
    expect(err).toHaveBeenCalled();
    expect(r.exemplars.length).toBe(3);
    err.mockRestore();
  });
  it('Modal unreachable → loud lexical fallback', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const embed: EmbedFn = async () => { throw new Error('provider:modal ECONNREFUSED'); };
    const r = await retrieveExemplars({ sb: fakeSb({ embeddingsCount: 5, rpcRows: [] }), embed }, BRIEF, FACTS, RECIPE);
    expect(r.mode).toBe('lexical');
    expect(r.warnings.some((w) => /ECONNREFUSED/.test(w))).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
