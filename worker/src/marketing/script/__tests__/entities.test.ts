import { describe, expect, it } from 'vitest';
import { buildBlocklist, detectEntities, normAr, tokenizeAr } from '../entities.js';

describe('normAr (twin of SQL mkt_norm_ar)', () => {
  it('folds alef variants, taa marbuta, alef maqsura', () => {
    expect(normAr('أحمد إبراهيم آمال ٱلله')).toBe('احمد ابراهيم امال الله');
    expect(normAr('مدرسة')).toBe('مدرسه');
    expect(normAr('مصطفى')).toBe('مصطفي');
  });
  it('strips tatweel and diacritics', () => {
    expect(normAr('الــــرياض')).toBe('الرياض');
    expect(normAr('مُحَمَّد')).toBe('محمد');
  });
  it('unifies Arabic-Indic and Persian digits', () => {
    expect(normAr('١٢٣ ۴۵۶')).toBe('123 456');
  });
  it('collapses whitespace + lowercases', () => {
    expect(normAr('  Riva   SA ')).toBe('riva sa');
  });
  it('tokenizes on punctuation', () => {
    expect(tokenizeAr('حي النرجس، شمال الرياض!')).toEqual(['حي', 'النرجس', 'شمال', 'الرياض']);
  });
});

const RULES = { allow_developer_name: true, marketer_name: 'وصل العقارية' };

function blocklist() {
  return buildBlocklist({
    brief: { cta: 'للحجز والاستفسار: وصل العقارية' },
    exemplars: [
      { org_name: 'الرياض للتطوير', organization_id: 'o1' },
      { org_name: 'ريفا العقارية', organization_id: 'o2' },
      { org_name: 'دار الحياة', organization_id: 'o3' },
    ],
    orgs: [
      { id: 'o2', name_ar: 'ريفا العقارية', name_en: 'Riva Real Estate', website: 'https://riva.sa', handles: ['riva_sa'], hashtags: ['#ريفا_العقارية'], ctas: ['تواصل معنا ريفا العقارية 920016028'] },
    ],
    projectRecord: { marketing_document: 'للتواصل مع المسوّق 0501234567 — riva.sa — رخصة فال 1200012345' },
    developerName: 'أكنان',
    marketerName: 'ريفا العقارية',
    rules: RULES,
  });
}

describe('buildBlocklist', () => {
  it('never blocks generic words on their own', () => {
    const terms = blocklist().map((b) => b.term);
    expect(terms).not.toContain('الرياض');
    expect(terms).not.toContain('للتطوير');
    expect(terms).not.toContain('دار');
    expect(terms).not.toContain('الحياه');
    expect(terms).toContain('الرياض للتطوير');
    expect(terms).toContain('دار الحياه');
  });
  it('keeps distinctive tokens, phones, urls, licences, handles, hashtags', () => {
    const b = blocklist();
    const kinds = (k: string) => b.filter((x) => x.kind === k).map((x) => x.term);
    expect(b.some((x) => x.term === 'ريفا')).toBe(true);
    expect(kinds('phone')).toEqual(expect.arrayContaining(['0501234567', '920016028']));
    expect(kinds('url').some((u) => u.includes('riva.sa'))).toBe(true);
    expect(kinds('license')).toContain('1200012345');
    expect(kinds('handle')).toContain('@riva_sa');
    expect(kinds('hashtag')).toContain('#ريفا_العقاريه');
  });
  it('does not block Wassel or the allowed developer', () => {
    const terms = blocklist().map((b) => b.term);
    expect(terms).not.toContain('اكنان');
    expect(terms.some((t) => t.includes('وصل'))).toBe(false);
  });
  it('blocks the developer when rules forbid naming it', () => {
    const b = buildBlocklist({ brief: { cta: '' }, exemplars: [], projectRecord: {}, developerName: 'أكنان للتطوير', rules: { ...RULES, allow_developer_name: false } });
    expect(b.some((x) => x.term === 'اكنان')).toBe(true);
  });
});

describe('detectEntities', () => {
  const bl = blocklist();
  const scene = (order: number, voiceover: string, on_screen_text = '', visual = '') => ({ order, voiceover, on_screen_text, visual });

  it('no false positive on common words that are part of an org name', () => {
    const hits = detectEntities([scene(1, 'مشروع في شمال الرياض، حي النرجس — تطوير عمراني راقٍ في دار تليق بك')], bl);
    expect(hits).toEqual([]);
  });
  it('catches the full org phrase and the distinctive marketer token', () => {
    expect(detectEntities([scene(1, 'بالتعاون مع الرياض للتطوير')], bl).map((h) => h.kind)).toContain('org');
    expect(detectEntities([scene(2, 'من ريفا العقارية')], bl).length).toBeGreaterThan(0);
    expect(detectEntities([scene(3, 'تواصل مع ريفا اليوم')], bl).length).toBeGreaterThan(0);
  });
  it('catches phones / licences / urls / handles / hashtags in any field', () => {
    const kinds = (t: string, field: 'voiceover' | 'on_screen_text' = 'voiceover') =>
      detectEntities([field === 'voiceover' ? scene(1, t) : scene(1, '', t)], bl).map((h) => h.kind);
    expect(kinds('اتصل على 920016028')).toContain('phone');
    expect(kinds('٠٥٠١٢٣٤٥٦٧', 'on_screen_text')).toContain('phone');
    expect(kinds('زوروا riva.sa')).toContain('url');
    expect(kinds('تابعونا @riva_sa')).toContain('handle');
    expect(kinds('رخصة فال 1200012345', 'on_screen_text')).toContain('license');
    expect(kinds('#ريفا_العقارية', 'on_screen_text')).toContain('hashtag');
  });
  it('allows the Wassel CTA and the developer name', () => {
    const hits = detectEntities([scene(1, 'أكنان ٢٥ من أكنان — للحجز والاستفسار: وصل العقارية', 'للحجز والاستفسار: وصل العقارية')], bl, { allowedTerms: ['وصل العقارية', 'أكنان'] });
    expect(hits).toEqual([]);
  });
  it('curated competitors are caught even when not among exemplars', () => {
    const b = buildBlocklist({ brief: { cta: '' }, exemplars: [], projectRecord: {}, rules: RULES });
    expect(detectEntities([scene(1, 'شفناه على عقارماب')], b).length).toBeGreaterThan(0);
  });
});
