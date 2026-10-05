import { describe, it, expect } from 'vitest';
import { describeInterest, noticeBody, bookingLine } from '../officerNoticeDraft.js';

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

describe('the visit line (operator, 2026-10-05: interest, what the client did, then the booked visit)', () => {
  it('says the day, date and time of the booking for the project', () => {
    expect(bookingLine({ at: '2026-10-05T19:00', done: false }, 'زنك 8')).toBe('حجز العميل موعد زيارة لمشروع «زنك 8» يوم الاثنين 5 أكتوبر الساعة 7:00 مساءً.');
    expect(bookingLine({ at: '2026-10-07T10:30', done: false }, 'زنك 8')).toBe('حجز العميل موعد زيارة لمشروع «زنك 8» يوم الأربعاء 7 أكتوبر الساعة 10:30 صباحاً.');
    expect(bookingLine({ at: '2026-10-04T12:00', done: true }, 'جزيل')).toBe('زار العميل مشروع «جزيل» يوم الأحد 4 أكتوبر الساعة 12:00 ظهراً.');
  });
  it('a booking takes the visit out of the actions and goes on its own line, below them', () => {
    const why = describeInterest({ message_level: 'wants', message_quote: 'اشوفها طبعا', appointments: 1, visits: 0 }, null, { at: '2026-10-05T19:00', done: false });
    expect(why.actions).toEqual([]);
    const body = noticeBody({ projectName: 'زنك 8', registered: true, why: { ...why, actions: ['فتح صفحة المشروع مرتين'] }, lowNames: ['نخيل فستا'], clientName: 'Tareq', clientPhone: '0509153856', questions: [] });
    const lines = body.split('\n');
    expect(lines.slice(2, 5)).toEqual([
      'سبب الاهتمام: أبدى رغبة واضحة في المشروع.',
      'ما قام به العميل: فتح صفحة المشروع مرتين.',
      'حجز العميل موعد زيارة لمشروع «زنك 8» يوم الاثنين 5 أكتوبر الساعة 7:00 مساءً.',
    ]);
  });
});
