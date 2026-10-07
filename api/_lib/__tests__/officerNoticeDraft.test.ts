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
    expect(w.reason).toBe('استفسر عن الأسعار والمخططات والبروشور');
    expect(w.reason).not.toContain('«');
  });
  it('floors, rooms and driver/maid rooms are topics too (live drafts, 2026-10-05)', () => {
    expect(describeInterest({ message_level: 'asked', message_quote: 'الدور الاخير ٣ غرف نوم؟', appointments: 0, visits: 0 }, noLinks).reason).toBe('استفسر عن الأدوار وعدد الغرف');
    expect(describeInterest({ message_level: 'asked', message_quote: 'يتوفر غرف سائقين', appointments: 0, visits: 0 }, noLinks).reason).toBe('استفسر عن غرف السائق والخادمة');
  });
  it('a wish with no recognisable topic gets a general line', () => {
    expect(describeInterest({ message_level: 'wants', message_quote: 'عجبني مره', appointments: 0, visits: 0 }, noLinks).reason).toBe('أبدى رغبة واضحة في المشروع');
    expect(describeInterest({ message_level: 'rejected', message_quote: 'ما يناسبني', appointments: 0, visits: 0 }, noLinks).reason).toBeNull();
  });
  it('lists what the client actually did — no score', () => {
    const w = describeInterest({ message_level: null, message_quote: null, appointments: 1, visits: 0 }, links);
    expect(w.actions).toEqual([
      'اطّلع على صفحة المشروع 3 مرات خلال يومين',
      'تصفّح البروشور (5 صفحات)',
      'شاهد 62٪ من فيديو المشروع',
      'استعرض 4 من صور المشروع',
      'فتح موقع المشروع على الخريطة',
      'حجز موعداً لزيارة المشروع',
    ]);
    expect(w.actions.join(' ')).not.toMatch(/من 100/);
  });
});

describe('noticeBody', () => {
  const base = { projectName: 'يمام 17', registered: true, lowNames: [], clientName: 'KAQ', clientPhone: '0559660041' };
  it('formal and organized: greeting, one line, fact bullets, client block, closing (2026-10-07)', () => {
    const body = noticeBody({ ...base, questions: [], why: { reason: 'استفسر عن الأسعار والمخططات', actions: ['اطّلع على صفحة المشروع 3 مرات', 'تصفّح البروشور'] } });
    expect(body).toBe([
      'السلام عليكم ورحمة الله وبركاته،',
      '',
      'نفيدكم بوجود عميل مهتم بمشروع «يمام 17»، وهو مسجّل لديكم في البوابة.',
      '',
      '• سبب اهتمامه: استفسر عن الأسعار والمخططات.',
      '• تفاعله مع المشروع: اطّلع على صفحة المشروع 3 مرات، وتصفّح البروشور.',
      '',
      'بيانات العميل:',
      'الاسم: KAQ',
      'الجوال: 0559660041',
      '',
      'نأمل منكم التواصل معه، ولكم جزيل الشكر.',
    ].join('\n'));
    expect(body).not.toMatch(/جاهز|الخارطة|يبغى|كثير/);
  });
  it('the client\'s own words ride on the reason line; other projects and a question are bullets', () => {
    const body = noticeBody({ ...base, registered: false, questions: ['هل يوجد خصم؟'], lowNames: ['أكنان 25', 'يمام 16'], said: ['ابمر اشوفها'], why: { reason: 'أبدى رغبته في زيارة المشروع', actions: [] } });
    expect(body).toContain('نفيدكم بوجود عميل مهتم بمشروع «يمام 17».');
    expect(body).toContain('• سبب اهتمامه: أبدى رغبته في زيارة المشروع، ومن كلامه: «ابمر اشوفها».');
    expect(body).toContain('• مشاريع أخرى لكم أرسلناها له: «أكنان 25» و«يمام 16»، واهتمامه بها أقل.');
    expect(body).toContain('• سؤاله لكم: «هل يوجد خصم؟»');
    expect(body.endsWith('نأمل منكم التواصل معه والإفادة بخصوص سؤاله، ولكم جزيل الشكر.')).toBe(true);
  });
  it('a quote with a line break stays on one line', () => {
    const body = noticeBody({ ...base, questions: [], said: ['كم المساحة ؟', 'اللي مساحتها 136م2 \nبكم سعرها'], why: { reason: 'استفسر عن المساحات', actions: [] } });
    expect(body).toContain('• سبب اهتمامه: استفسر عن المساحات، ومن كلامه: «كم المساحة ؟»، «اللي مساحتها 136م2 بكم سعرها».');
  });
  it('no facts → no empty bullet block', () => {
    const body = noticeBody({ ...base, questions: [], why: { reason: null, actions: [] } });
    expect(body.split('\n').slice(0, 5)).toEqual(['السلام عليكم ورحمة الله وبركاته،', '', 'نفيدكم بوجود عميل مهتم بمشروع «يمام 17»، وهو مسجّل لديكم في البوابة.', '', 'بيانات العميل:']);
  });
});

describe('the visit line (operator, 2026-10-05: interest, what the client did, then the booked visit)', () => {
  it('says the day, date and time of the booking for the project', () => {
    expect(bookingLine({ at: '2026-10-05T19:00', done: false })).toBe('• موعد الزيارة: يوم الاثنين 5 أكتوبر، الساعة 7:00 مساءً.');
    expect(bookingLine({ at: '2026-10-07T10:30', done: false })).toBe('• موعد الزيارة: يوم الأربعاء 7 أكتوبر، الساعة 10:30 صباحاً.');
    expect(bookingLine({ at: '2026-10-04T12:00', done: true })).toBe('• زار المشروع يوم الأحد 4 أكتوبر، الساعة 12:00 ظهراً.');
    expect(bookingLine({ at: 'soon', done: false })).toBe('• حجز موعداً لزيارة المشروع.');
  });
  it('a booking takes the visit out of the actions and goes on its own line, below them', () => {
    const why = describeInterest({ message_level: 'wants', message_quote: 'اشوفها طبعا', appointments: 1, visits: 0 }, null, { at: '2026-10-05T19:00', done: false });
    expect(why.actions).toEqual([]);
    const body = noticeBody({ projectName: 'زنك 8', registered: true, why: { ...why, actions: ['اطّلع على صفحة المشروع مرتين'] }, lowNames: ['نخيل فستا'], clientName: 'Tareq', clientPhone: '0509153856', questions: [] });
    const lines = body.split('\n');
    expect(lines.slice(4, 8)).toEqual([
      '• سبب اهتمامه: أبدى رغبة واضحة في المشروع.',
      '• تفاعله مع المشروع: اطّلع على صفحة المشروع مرتين.',
      '• موعد الزيارة: يوم الاثنين 5 أكتوبر، الساعة 7:00 مساءً.',
      '• مشاريع أخرى لكم أرسلناها له: «نخيل فستا»، واهتمامه بها أقل.',
    ]);
  });
});
