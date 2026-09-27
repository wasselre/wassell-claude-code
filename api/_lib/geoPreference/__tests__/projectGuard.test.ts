import { describe, it, expect } from 'vitest';
import {
  projectHead, deriveProjectHeads, isProjectMention, projectMentionsIn, normalizeProjectText,
} from '../projectGuard.js';

/**
 * Project-name guard — the calib-003 defect (2026-09-27): «مينا 52» and
 * «الماجدية 163» are OUR projects and were extracted as map anchors. Names are
 * the real shapes from all_projects («مينا 52 - النرجس», «الماجدية فيلج (Al
 * Majdiah Village)», «الفلاح», «صفا 52», «م ش087»).
 */

const PROJECTS = [
  'مينا 52 - النرجس', 'مينا 51 - التعاون', 'الماجدية 163', 'الماجدية فيلج (Al Majdiah Village)',
  'مشروع مسقا 26', 'الفلاح', 'الضواحي', 'سول', 'https://arjanarch.sa/', 'م ش087', 'شقق كالما _العارض AR270',
];
const DISTRICTS = ['حي الفلاح', 'حي النرجس', 'حي التعاون', 'حي العارض', 'حي الضواحي'];

describe('projectHead', () => {
  it('cuts the qualifier off a project name and normalizes digits', () => {
    expect(projectHead('مينا 52 - النرجس')).toBe('مينا 52');
    expect(projectHead('مينا ٥٢ - النرجس')).toBe('مينا 52');
    expect(projectHead('الماجدية فيلج (Al Majdiah Village)')).toBe('الماجديه فيلج');
    expect(projectHead('مشروع مسقا 26')).toBe('مسقا 26');
    expect(projectHead('شقق كالما _العارض AR270')).toBe('شقق كالما');
  });
  it('rejects URLs and codes too short to mean anything', () => {
    expect(projectHead('https://arjanarch.sa/')).toBe('');
    expect(projectHead('م ش')).toBe('');
  });
});

describe('deriveProjectHeads', () => {
  it('keeps real project heads and DROPS any head that is also a district name', () => {
    const heads = deriveProjectHeads(PROJECTS, DISTRICTS);
    expect(heads).toContain('مينا 52');
    expect(heads).toContain('الماجديه 163');
    expect(heads).toContain('سول');
    // «الفلاح» / «الضواحي» are districts before they are our projects.
    expect(heads).not.toContain('الفلاح');
    expect(heads).not.toContain('الضواحي');
    expect(heads).not.toContain('');
  });
});

describe('isProjectMention', () => {
  const heads = deriveProjectHeads(PROJECTS, DISTRICTS);
  it('matches the project exactly, with Arabic digits, and with a «مشروع» prefix', () => {
    expect(isProjectMention('مينا 52', heads)).toBe(true);
    expect(isProjectMention('مينا ٥٢', heads)).toBe(true);
    expect(isProjectMention('مشروع مينا 52', heads)).toBe(true);
    expect(isProjectMention('الماجدية 163', heads)).toBe(true);
    expect(isProjectMention('الماجدية163', heads)).toBe(false); // not a token we would ever emit — no accidental glue match
  });
  it('a single-word head must equal the WHOLE span — never a substring', () => {
    expect(isProjectMention('سول', heads)).toBe(true);
    expect(isProjectMention('سولار', heads)).toBe(false);
    expect(isProjectMention('حي سول', heads)).toBe(true); // «حي» is stripped like any anchor token
  });
  it('a real district is never a project mention', () => {
    expect(isProjectMention('النرجس', heads)).toBe(false);
    expect(isProjectMention('الفلاح', heads)).toBe(false);
    expect(isProjectMention('حي التعاون', heads)).toBe(false);
  });
});

describe('projectMentionsIn', () => {
  const heads = deriveProjectHeads(PROJECTS, DISTRICTS);
  it('lists only the heads that occur in the conversation text', () => {
    const text = '[1] العميل: ابي شقة في مينا ٥٢ بالنرجس\n[2] المندوب: عندنا الماجدية 163 كذلك';
    expect(projectMentionsIn(text, heads)).toEqual(['الماجديه 163', 'مينا 52']);
  });
  it('a single-word head needs a whole-token hit', () => {
    expect(projectMentionsIn('ابي شقة قريبة من السولار', heads)).toEqual([]);
    expect(projectMentionsIn('مشروع سول حلو', heads)).toEqual(['سول']);
  });
});

describe('normalizeProjectText', () => {
  it('folds digits, hamza/taa/alef-maqsura, harakat and punctuation', () => {
    expect(normalizeProjectText('مَشروع الماجديّة ١٦٣ - النرجس!')).toBe('الماجديه 163 النرجس');
  });
});
