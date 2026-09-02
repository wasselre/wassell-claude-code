import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AI_MODES,
  checkAiRecommendation,
  findFabrication,
  namesProjectFeature,
} from '../policy';

// Mirror of worker/src/creative/director/__tests__/policy.test.ts — the two
// policy modules MUST agree (the worker gates generation; the API gates the
// human approval that enqueues it). Keep both test files in sync.

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

  it('a fabrication prompt in a non-fabricating mode still fails WITHOUT the architecture keep', () => {
    const v = checkAiRecommendation({
      mode: 'cleanup',
      prompt: 'Add a pool in front of the building',
      must_keep: [],
    });
    expect(v.ok).toBe(false);
  });

  it('every contracted AiMode is in the allowed list', () => {
    expect(ALLOWED_AI_MODES).toEqual([
      'cleanup', 'crop', 'color_correct', 'extend_background', 'remove_clutter',
      'combine', 'supporting_visual', 'remove_text', 'request_photo',
    ]);
  });
});

describe('findFabrication', () => {
  it('returns null for a clean prompt', () => {
    expect(findFabrication('Enhance the lighting and warm the tones')).toBeNull();
  });

  it('catches verb+noun co-occurrence inside the window (EN)', () => {
    const hit = findFabrication('create a new lobby with marble floors');
    expect(hit).not.toBeNull();
    expect(hit?.verb).toBe('create');
  });

  it('catches Arabic verb+noun after normalisation (hamza/ة folding)', () => {
    const hit = findFabrication('أنشئ البرج من جديد مع إطلالة');
    expect(hit).not.toBeNull();
  });
});

describe('namesProjectFeature', () => {
  it('null when no project noun is present', () => {
    expect(namesProjectFeature('abstract warm gradient, coffee on marble')).toBeNull();
  });
  it('names the first project noun found (AR normalised)', () => {
    expect(namesProjectFeature('صورة المسبح عند الغروب')).toBe('المسبح');
  });
});
