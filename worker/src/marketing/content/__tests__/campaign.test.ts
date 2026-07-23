import { describe, it, expect } from 'vitest';
import { campaignSignature, distinguishingSignal, groupingConfidence, normalizeSignal } from '../campaignSignature';
import { classifyYtError } from '../ytdlp';

const ORG = '8b531cca-f882-4c4c-9d5c-93465213b793';
const P1 = '6ff3010b-4252-4566-bc6f-db842bd99a48';
const P2 = '83a6a789-c022-4d6e-bef1-6d484fb1a4e0';

describe('campaign signature (deterministic, not project-alone)', () => {
  it('is stable for the same org+project+offer', () => {
    const a = campaignSignature(ORG, P1, { offer: 'دفعة أولى 10%' });
    const b = campaignSignature(ORG, P1, { offer: '  دفعة أولى، 10%! ' }); // normalization strips punct + trims
    expect(a?.signature).toBeTruthy();
    expect(a?.signature).toBe(b?.signature);
  });
  it('different offers for the SAME project → different campaigns', () => {
    const a = campaignSignature(ORG, P1, { offer: 'تملّك غير السعوديين' });
    const b = campaignSignature(ORG, P1, { offer: 'دفعة أولى 10%' });
    expect(a?.signature).not.toBe(b?.signature);
  });
  it('same offer on DIFFERENT projects → different campaigns', () => {
    const a = campaignSignature(ORG, P1, { offer: 'عرض خاص' });
    const b = campaignSignature(ORG, P2, { offer: 'عرض خاص' });
    expect(a?.signature).not.toBe(b?.signature);
  });
  it('NO project → not campaigned (null)', () => {
    expect(campaignSignature(ORG, null, { offer: 'عرض خاص' })).toBeNull();
  });
  it('general branding → not campaigned even with a project', () => {
    expect(campaignSignature(ORG, P1, { is_general_branding: true, campaign_message: 'بيعة ولي العهد' })).toBeNull();
  });
  it('project with NO distinguishing signal → not campaigned (project alone is never enough)', () => {
    expect(campaignSignature(ORG, P1, { content_type: 'brand' })).toBeNull();
    expect(campaignSignature(ORG, P1, { offer: 'a' })).toBeNull(); // too short
  });
  it('falls back offer → payment_plan → message → objective', () => {
    expect(distinguishingSignal({ payment_plan: 'دفعة 20 بالمئة' })?.kind).toBe('payment_plan');
    expect(distinguishingSignal({ campaign_message: 'مجتمع يلهم يومك في حي لبن' })?.kind).toBe('message');
    expect(distinguishingSignal({ objective: 'project_launch' })?.kind).toBe('objective');
    expect(distinguishingSignal({})).toBeNull();
  });
  it('normalizeSignal strips punctuation + tatweel + collapses ws', () => {
    expect(normalizeSignal('  عرض،  خاص!!  ')).toBe('عرض خاص');
  });
});

describe('grouping confidence', () => {
  it('rises with corroborating signals', () => {
    const lone = groupingConfidence({ members: 1, platforms: 1, reusedCreatives: 0, hasOffer: false });
    const rich = groupingConfidence({ members: 3, platforms: 3, reusedCreatives: 1, hasOffer: true });
    expect(lone).toBe(0.5);
    expect(rich).toBeGreaterThan(lone);
    expect(rich).toBeLessThanOrEqual(1);
  });
});

describe('yt-dlp error classification', () => {
  it('classifies terminal YouTube conditions', () => {
    expect(classifyYtError('ERROR: Private video. Sign in if you...')).toBe('private');
    expect(classifyYtError('ERROR: Sign in to confirm your age')).toBe('age_restricted');
    expect(classifyYtError('ERROR: Video unavailable. This video has been removed')).toBe('unavailable');
    expect(classifyYtError('ERROR: The uploader has not made this video available in your country')).toBe('region_blocked');
    expect(classifyYtError('File is larger than max-filesize')).toBe('too_large');
    expect(classifyYtError('some other failure')).toBe('error');
  });
});
