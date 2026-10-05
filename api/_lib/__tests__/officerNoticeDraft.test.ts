import { describe, it, expect } from 'vitest';
import { describeInterest, noticeBody } from '../officerNoticeDraft.js';

const noLinks = null;
const links = {
  sessions: 3, open_days: 2, brochure_pages: 5, brochure_seconds: 40, videos_played: 1,
  max_video_pct: 62, photos_opened: 4, units_opened: 0, opened_map: true,
};

describe('describeInterest — a general reason and the exact actions (operator, 2026-10-05)', () => {
  it('turns the customer\'s words into topics, never quotes them', () => {
    const w = describeInterest({ message_level: 'asked', message_quote: 'البروشور و المخطط و الأسعار', appointments: 0, visits: 0 }, noLinks);
    expect(w.reason).toBe('سأل عن الأسعار والمخططات والبروشور');
    expect(w.reason).not.toContain('«');
  });
  it('floors, rooms and driver/maid rooms are topics too (live drafts, 2026-10-05)', () => {
    expect(describeInterest({ message_level: 'asked', message_quote: 'الدور الاخير ٣ غرف نوم؟', appointments: 0, visits: 0 }, noLinks).reason).toBe('سأل عن الأدوار وعدد الغرف');
    expect(describeInterest({ message_level: 'asked', message_quote: 'يتوفر غرف سائقين', appointments: 0, visits: 0 }, noLinks).reason).toBe('سأل عن غرف السائق والخادمة');
  });
  it('a wish with no recognisable topic gets a general line', () => {
    expect(describeInterest({ message_level: 'wants', message_quote: 'عجبني مره', appointments: 0, visits: 0 }, noLinks).reason).toBe('أبدى رغبة واضحة في المشروع');
    expect(describeInterest({ message_level: 'rejected', message_quote: 'ما يناسبني', appointments: 0, visits: 0 }, noLinks).reason).toBeNull();
  });
  it('lists what the client actually did — no score', () => {
    const w = describeInterest({ message_level: null, message_quote: null, appointments: 1, visits: 0 }, links);
    expect(w.actions).toEqual([
      'فتح صفحة المشروع 3 مرات في يومين',
      'تصفّح البروشور (5 صفحات)',
      'شاهد فيديو المشروع (62٪ منه)',
      'فتح 4 صور',
      'فتح موقع المشروع على الخريطة',
      'حجز موعد زيارة',
    ]);
    expect(w.actions.join(' ')).not.toMatch(/من 100/);
  });
});

describe('noticeBody', () => {
  const base = { projectName: 'يمام 17', registered: true, lowNames: [], clientName: 'KAQ', clientPhone: '0559660041' };
  it('no ready / off-plan tag; reason and actions on their own lines', () => {
    const body = noticeBody({ ...base, questions: [], why: { reason: 'سأل عن الأسعار والمخططات', actions: ['فتح صفحة المشروع 3 مرات'] } });
    expect(body).toBe([
      'السلام عليكم،',
      'عندنا عميل مهتم كثير بمشروع «يمام 17»، وهو مسجّل عندكم في البوابة.',
      'سبب الاهتمام: سأل عن الأسعار والمخططات.',
      'ما قام به العميل: فتح صفحة المشروع 3 مرات.',
      'العميل: KAQ — رقمه: 0559660041',
      'نتمنى تتواصلون معه، ويعطيك العافية.',
    ].join('\n'));
    expect(body).not.toMatch(/جاهز|الخارطة/);
  });
});
