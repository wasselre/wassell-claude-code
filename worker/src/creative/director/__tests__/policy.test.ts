import { describe, expect, it } from 'vitest';
import { checkAiRecommendation, findFabrication } from '../policy.js';

describe('checkAiRecommendation', () => {
  it('request_photo is always ok — it asks a human, fabricates nothing', () => {
    const v = checkAiRecommendation({ mode: 'request_photo', prompt: 'صورة خارجية للواجهة عند الغروب', must_keep: [] });
    expect(v.ok).toBe(true);
  });

  it('blocks a mode outside the §7 allowed list', () => {
    const v = checkAiRecommendation({ mode: 'make_billboard' as never, prompt: 'x', must_keep: [] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('policy_blocked:');
  });

  it('blocks English fabrication verbs targeting project nouns', () => {
    const v = checkAiRecommendation({
      mode: 'extend_background',
      prompt: 'Add a swimming pool in front of the building and change the facade color',
      must_keep: [],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('policy_blocked:');
  });

  it('blocks Arabic fabrication verbs targeting project nouns', () => {
    const v = checkAiRecommendation({
      mode: 'combine',
      prompt: 'أضف مسبحًا أمام المبنى مع إطلالة على الحديقة',
      must_keep: [],
    });
    expect(v.ok).toBe(false);
  });

  it('allows non-fabricating modes that keep the architecture', () => {
    const v = checkAiRecommendation({
      mode: 'cleanup',
      prompt: 'Remove the clutter and construction barriers, keep the building facade exactly as shot',
      must_keep: ['architecture'],
    });
    expect(v.ok).toBe(true);
  });

  it('allows benign edits that name project features without build/add/create verbs', () => {
    const v = checkAiRecommendation({
      mode: 'extend_background',
      prompt: 'Extend the evening sky above the tower, keeping every architectural line untouched',
      must_keep: [],
    });
    expect(v.ok).toBe(true);
  });

  it('supporting_visual must stay lifestyle/abstract — project nouns are banned outright', () => {
    const bad = checkAiRecommendation({ mode: 'supporting_visual', prompt: 'A warm family evening by the pool', must_keep: [] });
    expect(bad.ok).toBe(false);
    const good = checkAiRecommendation({ mode: 'supporting_visual', prompt: 'A warm abstract sunrise gradient with coffee cups on a marble table', must_keep: [] });
    expect(good.ok).toBe(true);
  });
});

describe('findFabrication', () => {
  it('returns null for clean prompts', () => {
    expect(findFabrication('color correct the white balance and lift the shadows')).toBeNull();
  });

  it('catches verb+noun within the window', () => {
    const hit = findFabrication('generate a new lobby interior with marble floors');
    expect(hit).not.toBeNull();
  });
});
