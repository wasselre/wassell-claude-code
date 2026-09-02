import { describe, expect, it } from 'vitest';
import { generatedHeadlines, renderDesignBrief } from '../../../../api/_lib/marketing/creative/apply';
import type { BasePackage } from '../contracts';

/**
 * Pure helpers from the apply lane (api/_lib/marketing/creative/apply.ts).
 * They live in the API package but are I/O-free; the tests live here so
 * `npx vitest run src/lib/creative` covers them.
 */

function base(partial: Partial<BasePackage>): BasePackage {
  return partial as BasePackage;
}

describe('generatedHeadlines', () => {
  it('single post → the cover lines only', () => {
    const lines = generatedHeadlines(base({
      strategy: { format: 'single' } as BasePackage['strategy'],
      design_text: { headlines: ['سكن يبدأ من ١٫٠٥ مليون', 'على الخارطة'] } as BasePackage['design_text'],
      slides: [],
    }));
    expect(lines).toEqual(['سكن يبدأ من ١٫٠٥ مليون', 'على الخارطة']);
  });

  it('carousel → cover lines + «١/٦ »-prefixed slide lines (Arabic-Indic numerals)', () => {
    const lines = generatedHeadlines(base({
      strategy: { format: 'carousel' } as BasePackage['strategy'],
      design_text: { headlines: ['الغلاف'] } as BasePackage['design_text'],
      slides: [
        { index: 1, headline: 'الغلاف' },
        { index: 2, headline: 'الموقع' },
        { index: 3, headline: '' },
      ] as BasePackage['slides'],
    }));
    expect(lines).toEqual(['الغلاف', '«١/٣ »الغلاف', '«٢/٣ »الموقع']);
  });

  it('empty headlines are dropped', () => {
    const lines = generatedHeadlines(base({
      strategy: { format: 'single' } as BasePackage['strategy'],
      design_text: { headlines: ['', '  ', 'وحيد'] } as BasePackage['design_text'],
      slides: [],
    }));
    expect(lines).toEqual(['وحيد']);
  });
});

describe('renderDesignBrief', () => {
  const pkg = base({
    visual_direction: {
      concept: 'هدوء الصحراء', mood: ['دافئ', 'فاخر'], composition: 'أفقي',
      layout: 'full_bleed_photo_text_bottom', image_treatment: 'دافئ',
      background: 'سماء الغروب', logo: { variant: 'أفقي', position: 'أسفل اليسار', color: 'نحاسي' },
      cta_placement: 'أسفل التصميم',
    } as BasePackage['visual_direction'],
    palette: [
      { hex: '#B8734F', name: 'نحاسي', role: 'primary', source: 'brand_kit' },
    ],
  });

  it('renders Arabic labels for an Arabic package', () => {
    const brief = renderDesignBrief(pkg, 'ar');
    expect(brief).toContain('الفكرة: هدوء الصحراء');
    expect(brief).toContain('#B8734F نحاسي — primary');
  });

  it('renders English labels for an English package', () => {
    const brief = renderDesignBrief(pkg, 'en');
    expect(brief).toContain('Concept: هدوء الصحراء');
    expect(brief).toContain('Palette:');
  });
});
