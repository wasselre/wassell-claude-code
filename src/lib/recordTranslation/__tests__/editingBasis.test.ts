/**
 * The localized editing contract's basis/commit logic (bilingual W3b —
 * REV 4 §B10 tests E1–E5). The invariant that must never break: an UNCHANGED
 * localized display is never written back as source.
 */
import { describe, it, expect } from 'vitest';
import { computeBasis, commitKind } from '../editing';

const AR_SRC = 'الوحدة قريبة من المسجد';
const EN_TRANS = 'The unit is close to the mosque';
const RID = 'rec-1';
const FIELD = 'notes';

const withTranslation = (id: string, path: string, lang: string) =>
  lang === 'en' ? EN_TRANS : null;
const noTranslation = () => null;

describe('computeBasis', () => {
  it('same-language value → source basis (Arabic UI, Arabic value)', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'ar', withTranslation);
    expect(b.kind).toBe('source');
    expect(b.shownText).toBe(AR_SRC);
  });

  it('cross-language with a translation → translation basis (English UI)', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'en', withTranslation);
    expect(b.kind).toBe('translation');
    expect(b.shownText).toBe(EN_TRANS);
    expect(b.sourceText).toBe(AR_SRC);
  });

  it('cross-language without a translation → pending_source (shows raw source)', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'en', noTranslation);
    expect(b.kind).toBe('pending_source');
    expect(b.shownText).toBe(AR_SRC);
  });

  it('no record id → always source basis (new records edit normally)', () => {
    const b = computeBasis(undefined, FIELD, AR_SRC, 'en', withTranslation);
    expect(b.kind).toBe('source');
  });

  it('scriptless value (numbers/codes) → source basis, never translated', () => {
    const b = computeBasis(RID, FIELD, '12345', 'en', withTranslation);
    expect(b.kind).toBe('source');
  });
});

describe('commitKind — the five contract flows', () => {
  it('E1: unchanged localized display is NEVER written (none)', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'en', withTranslation);
    expect(commitKind(b, EN_TRANS)).toBe('none');
  });

  it('E1b: unchanged source is not written either', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'ar', withTranslation);
    expect(commitKind(b, AR_SRC)).toBe('none');
  });

  it('E2: editing a shown translation → translation_correction (source untouched)', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'en', withTranslation);
    expect(commitKind(b, 'The unit is next to the mosque')).toBe('translation_correction');
  });

  it('E4: editing the source in its own language → source_edit', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'ar', withTranslation);
    expect(commitKind(b, AR_SRC + ' وتطل على حديقة')).toBe('source_edit');
  });

  it('E5: editing a pending source shown cross-language → source_edit', () => {
    const b = computeBasis(RID, FIELD, AR_SRC, 'en', noTranslation);
    expect(commitKind(b, AR_SRC + ' 250م')).toBe('source_edit');
  });
});
