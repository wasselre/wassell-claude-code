import { describe, it, expect } from 'vitest';
import { passesKeywordGate, gateMessage, normalizeGateText, isPureNoise, GATE_STEMS } from '../keywordGate.js';

describe('keyword gate — noise never passes', () => {
  it.each([
    'تمام', 'ok 👍', 'السلام عليكم', '👍🙏', 'تماااام', 'طيب طيب', 'شكرا ان شاء الله', 'وعليكم السلام ورحمة الله وبركاته',
    '؟؟', 'Thank you', 'اوكي',
  ])('«%s» is skipped', (msg) => {
    expect(passesKeywordGate([msg])).toEqual({ pass: false, reason: 'none' });
  });

  it('an empty / whitespace-only / null batch is skipped', () => {
    expect(passesKeywordGate([]).pass).toBe(false);
    expect(passesKeywordGate(['', '   ', null, undefined]).pass).toBe(false);
  });
});

describe('keyword gate — anything that may carry a preference passes', () => {
  it('«أبي فيلا» (keyword)', () => {
    expect(passesKeywordGate(['أبي فيلا'])).toEqual({ pass: true, reason: 'keyword' });
  });
  it('«٣ مليون» and «200 متر» (digits, Arabic-Indic and Latin)', () => {
    expect(passesKeywordGate(['٣ مليون'])).toEqual({ pass: true, reason: 'digits' });
    expect(passesKeywordGate(['200 متر'])).toEqual({ pass: true, reason: 'digits' });
  });
  it('«north riyadh» (English stem)', () => {
    expect(passesKeywordGate(['north riyadh']).pass).toBe(true);
  });
  it('long free text with no known word', () => {
    expect(gateMessage('والله الموضوع مو واضح لي وش تقصد بالكلام اللي قلته امس')).toEqual({ pass: true, reason: 'long' });
  });
  it('proclitics are stripped: «بحي» / «والفلل» / «للسكن»', () => {
    expect(passesKeywordGate(['بحي هادي']).pass).toBe(true);
    expect(passesKeywordGate(['والفلل']).pass).toBe(true);
    expect(passesKeywordGate(['للسكن']).pass).toBe(true);
  });
  it('a mixed batch passes when ANY message passes', () => {
    expect(passesKeywordGate(['السلام عليكم', 'تمام', 'كم سعر الشقة؟']).pass).toBe(true);
  });
});

describe('keyword gate — word-ish matching', () => {
  it('«صحيح» alone does NOT pass via «حي»; neither does «حياك»', () => {
    expect(passesKeywordGate(['صحيح']).pass).toBe(false);
    expect(passesKeywordGate(['حياك']).pass).toBe(false);
  });
  it('«كم» is not a stem (it would match «عليكم»)', () => {
    expect(GATE_STEMS).not.toContain('كم');
    expect(passesKeywordGate(['كم']).pass).toBe(false);
  });
  it('normalisation folds alef / ta marbuta / alef maqsura / tatweel / emoji', () => {
    expect(normalizeGateText('أرض إيجار آخر ـشقـةـ ابغى 👍!')).toBe('ارض ايجار اخر شقه ابغي');
    expect(isPureNoise(normalizeGateText('ok 👍 تمام'))).toBe(true);
  });
});

describe('keyword gate — the click-to-WhatsApp ad reply', () => {
  it('the singular ad line alone is noise, even with the project number', () => {
    expect(passesKeywordGate(['\u0645\u0647\u062a\u0645 \u0628\u0645\u0634\u0631\u0648\u0639 \u064a\u0645\u0627\u0645 17']).pass).toBe(false);
    expect(passesKeywordGate(['\u0645\u0647\u062a\u0645 \u0628\u0645\u0634\u0631\u0648\u0639 \u064a\u0645\u0627\u0645 \u0628\u0627\u0631\u0643 14']).pass).toBe(false);
  });
  it('the plural variant names a direction and still passes', () => {
    expect(passesKeywordGate(['\u0645\u0647\u062a\u0645 \u0628\u0645\u0634\u0627\u0631\u064a\u0639 \u0633\u0643\u0646\u064a\u0629 \u0627\u062e\u0631\u0649 \u0641\u064a \u0634\u0645\u0627\u0644 \u0627\u0644\u0631\u064a\u0627\u0636']).pass).toBe(true);
  });
  it('the ad line plus a real question passes', () => {
    expect(passesKeywordGate(['\u0645\u0647\u062a\u0645 \u0628\u0645\u0634\u0631\u0648\u0639 \u064a\u0645\u0627\u0645 \u0628\u0627\u0631\u0643 14', '\u0647\u0644 \u064a\u0648\u062c\u062f \u0648\u062d\u062f\u0627\u062a \u0644\u0644\u0625\u064a\u062c\u0627\u0631']).pass).toBe(true);
  });
});
