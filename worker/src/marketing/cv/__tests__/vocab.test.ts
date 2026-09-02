import { describe, it, expect } from 'vitest';
import { ALL_TAGS, CV_VOCAB, VOCAB_GROUPS, isVocabValue, tagValue, validateTags, vocabForPrompt } from '../vocab.js';

describe('cv vocabulary', () => {
  it('matches contracts §6 group by group', () => {
    expect(VOCAB_GROUPS).toEqual(['shot_size', 'setting', 'subject', 'graphic', 'motion', 'light', 'purpose', 'reproducibility']);
    expect(CV_VOCAB.shot_size).toEqual(['wide', 'medium', 'close', 'extreme_close', 'aerial']);
    expect(CV_VOCAB.purpose).toEqual(['hook', 'location', 'product', 'feature', 'proof', 'offer', 'cta', 'brand']);
    expect(ALL_TAGS).toContain('setting:amenity_pool');
    expect(ALL_TAGS.length).toBe(5 + 13 + 10 + 7 + 7 + 4 + 8 + 3);
  });

  it('keeps only vocabulary tags, deduped, in order — and reports the rest', () => {
    const r = validateTags(['shot_size:wide', 'setting:garden', 'Shot_Size: Wide', 'motion:drone', '', 42, null, 'purpose:hook']);
    expect(r.valid).toEqual(['shot_size:wide', 'motion:drone', 'purpose:hook']);
    expect(r.rejected).toEqual(['setting:garden']);
  });

  it('normalises spacing/case before matching', () => {
    expect(validateTags(['SETTING : Exterior Facade']).valid).toEqual(['setting:exterior_facade']);
  });

  it('tolerates null/undefined input', () => {
    expect(validateTags(null)).toEqual({ valid: [], rejected: [] });
    expect(validateTags(undefined)).toEqual({ valid: [], rejected: [] });
  });

  it('exposes group lookups for structured fields', () => {
    expect(isVocabValue('purpose', 'hook')).toBe(true);
    expect(isVocabValue('purpose', 'intro')).toBe(false);
    expect(tagValue(['motion:drone', 'purpose:cta'], 'purpose')).toBe('cta');
    expect(tagValue(['motion:drone'], 'purpose')).toBeNull();
  });

  it('renders the vocabulary for prompts one group per line', () => {
    const text = vocabForPrompt();
    expect(text.split('\n')).toHaveLength(8);
    expect(text).toContain('light: day, golden, night, studio');
  });
});
