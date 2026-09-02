import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readSlide, type DesignReadDeps, type SlideReadItem } from '../designRead/readSlide';
import { readPost, type PostReadPost, type PostReadSlide } from '../designRead/readPost';
import type { CreativeCallResult } from '../roles';
import type { PostRead, SlideRead } from '../contracts';

const goodSlideRead = (): SlideRead => ({
  slide_role: 'cover',
  layout: 'full_bleed_photo_text_bottom',
  text_position: 'band_bottom',
  text_share: 0.3,
  density: 'medium',
  hierarchy: ['headline', 'price', 'logo'],
  typography: { arabic_style: 'modern_sans', size_levels: 3, weight_contrast: 'high', latin_present: false, numerals: 'western' },
  palette: [
    { hex: '#4A2C2A', role: 'band', share: 0.2 },
    { hex: '#F5EDE0', role: 'text', share: 0.1 },
  ],
  palette_family: 'warm',
  image: { present: true, kind: 'render', subject: 'exterior', treatment: ['darkened_for_text'] },
  logo: { present: true, position: 'top_right', variant: 'light', size: 'small' },
  cta: { present: true, treatment: 'phone' },
  decoration: ['gold_rule'],
  branding_intensity: 2,
  mood: ['luxurious'],
  negative_space: 'balanced',
  readability: { contrast_ok: true, notes: '' },
  style_tags: ['minimal_luxury'],
  notes: '',
});

const goodPostRead = (n: number): PostRead => ({
  format: n === 1 ? 'single' : 'carousel',
  slide_count: n,
  role_sequence: Array.from({ length: n }, (_, i) => (i === 0 ? 'cover' : i === n - 1 ? 'cta' : 'feature')) as PostRead['role_sequence'],
  narrative_arc: 'hook → features → CTA',
  information_progression: 'broad_to_specific',
  cover_to_cta: { promise_kept: true, cta_slide_index: n, cta_type: 'call', notes: '' },
  slide_relationships: n > 1 ? [{ from: 1, to: 2, relation: 'continues' }] : [],
  recurring_layout: { template_used: true, layout_family: 'full_bleed_photo_text_bottom', varies_on: ['photo'], fixed: ['band'] },
  visual_continuity: { palette_consistent: true, typography_consistent: true, logo_consistent: true, image_treatment_consistent: true, score: 0.9 },
  design_system: { palette: [{ hex: '#4A2C2A', role: 'band' }], typography: { display: 'modern_sans' }, decoration: [], logo_rules: 'top right' },
  content_density_profile: Array.from({ length: n }, () => 'medium') as PostRead['content_density_profile'],
  branding_intensity: 2,
  image_strategy: { mix: { render: 1 }, asset_dependency: 'one render per slide', reusability: 'template' },
  copy_design_relationship: 'copy leads',
  mood: ['luxurious'],
  style_tags: ['minimal_luxury'],
  strengths: ['clear hierarchy'],
  weaknesses: ['small cta'],
  learnable: { structure: 'cover + features + cta', hierarchy: 'headline first', avoid: 'clutter' },
  summary: 'A clean carousel.',
});

function fakeCallRole<T>(output: T, opts: Partial<CreativeCallResult<T>> = {}) {
  return vi.fn(async (): Promise<CreativeCallResult<T>> => ({
    output,
    usage: { in: 100, out: 50 },
    cost_usd: 0.005,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    version: null,
    latency_ms: 12,
    ...opts,
  }));
}

interface UpsertCall { name: string; params: Record<string, unknown> }
function fakeSb(): { sb: SupabaseClient; calls: UpsertCall[] } {
  const calls: UpsertCall[] = [];
  const sb = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === 'visual_design_read_upsert') return { data: 'read-row-1', error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const item: SlideReadItem = {
  subject_kind: 'competitor_media',
  subject_id: 'media-1',
  post_id: 'post-1',
  slide_index: 0,
  organization_id: 'org-1',
  stored_url: 'https://cdn.example/0.jpg',
};

const post: PostReadPost = {
  subject_kind: 'competitor_post',
  subject_id: 'post-1',
  organization_id: 'org-1',
  post_type: 'carousel',
};

const slides: PostReadSlide[] = [
  { media_id: 'media-1', carousel_index: 0, stored_url: 'https://cdn.example/0.jpg', slide_read: goodSlideRead() },
  { media_id: 'media-2', carousel_index: 1, stored_url: 'https://cdn.example/1.jpg', slide_read: null },
];

afterEach(() => vi.restoreAllMocks());

describe('readSlide', () => {
  it('reads one slide and upserts with model_used + cost from the result', async () => {
    const { sb, calls } = fakeSb();
    const deps: DesignReadDeps = { sb, callRole: fakeCallRole(goodSlideRead()), embedImage: async () => null };
    const out = await readSlide(item, deps);
    expect(out.read_row_id).toBe('read-row-1');
    expect(out.model_used).toBe('anthropic:claude-sonnet-5');
    expect(out.cost_usd).toBe(0.005);
    expect(calls).toHaveLength(1);
    const p = calls[0].params;
    expect(calls[0].name).toBe('visual_design_read_upsert');
    expect(p.p_subject_kind).toBe('competitor_media');
    expect(p.p_subject_id).toBe('media-1');
    expect(p.p_level).toBe('slide');
    expect(p.p_model_task).toBe('design_read_slide');
    expect(p.p_model_used).toBe('anthropic:claude-sonnet-5');
    expect(p.p_rule_version).toBe('v1');
    expect(p.p_cost_usd).toBe(0.005);
    expect(p.p_embedding).toBeNull();
  });

  it('attaches the embedding when the embedder provides one', async () => {
    const { sb, calls } = fakeSb();
    const vec = Array.from({ length: 768 }, () => 0.01);
    const deps: DesignReadDeps = { sb, callRole: fakeCallRole(goodSlideRead()), embedImage: async () => vec };
    await readSlide(item, deps);
    const emb = calls[0].params.p_embedding;
    expect(typeof emb).toBe('string');
    expect((emb as string).startsWith('[0.01,0.01')).toBe(true);
  });

  it('persists WITHOUT the embedding when the embedder throws (never fatal)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sb, calls } = fakeSb();
    const deps: DesignReadDeps = {
      sb,
      callRole: fakeCallRole(goodSlideRead()),
      embedImage: async () => { throw new Error('provider:modal down'); },
    };
    const out = await readSlide(item, deps);
    expect(out.read_row_id).toBe('read-row-1');
    expect(calls[0].params.p_embedding).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('REJECTS a read with an invalid enum (validation_unrepaired)', async () => {
    const { sb, calls } = fakeSb();
    const bad = { ...goodSlideRead(), density: 'very_high' } as unknown as SlideRead;
    const deps: DesignReadDeps = { sb, callRole: fakeCallRole(bad), embedImage: async () => null };
    await expect(readSlide(item, deps)).rejects.toThrow(/validation_unrepaired:/);
    expect(calls).toHaveLength(0); // nothing persisted
  });
});

describe('readPost', () => {
  it('reads a whole carousel (all slides, in order) and upserts level post', async () => {
    const { sb, calls } = fakeSb();
    const callRole = fakeCallRole(goodPostRead(2));
    const deps: DesignReadDeps = { sb, callRole };
    const out = await readPost(post, slides, deps);
    expect(out.read_row_id).toBe('read-row-1');
    expect(calls).toHaveLength(1);
    const p = calls[0].params;
    expect(p.p_level).toBe('post');
    expect(p.p_subject_kind).toBe('competitor_post');
    expect(p.p_subject_id).toBe('post-1');
    expect(p.p_post_id).toBe('post-1');
    expect(p.p_slide_index).toBeNull();
    expect(p.p_model_task).toBe('design_read_post');
    // images passed in carousel order, both slides
    const req = callRole.mock.calls[0][1];
    expect(req.images).toHaveLength(2);
    expect(req.images?.[0]).toEqual({ url: 'https://cdn.example/0.jpg' });
  });

  it('REJECTS a post read whose slide_count disagrees with the slides given', async () => {
    const { sb, calls } = fakeSb();
    const deps: DesignReadDeps = { sb, callRole: fakeCallRole(goodPostRead(3)) }; // says 3, we gave 2
    await expect(readPost(post, slides, deps)).rejects.toThrow(/validation_unrepaired:/);
    expect(calls).toHaveLength(0);
  });

  it('refuses to read a post with no slides', async () => {
    const { sb } = fakeSb();
    const deps: DesignReadDeps = { sb, callRole: fakeCallRole(goodPostRead(1)) };
    await expect(readPost(post, [], deps)).rejects.toThrow(/validation_unrepaired:/);
  });
});
