import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { MosMonthException } from '@/lib/marketingOS/client';

/**
 * «يحتاج قرارك» — a HELD release carries real decisions (2026-09-29):
 * «انشر الآن» (needs `publish`), «أعد الجدولة» and «ألغِ» (need `schedule`).
 * Every other line keeps its sentence + link, exactly as before.
 */
const caps = new Set<string>();
vi.mock('../../MarketingWorkspace', () => ({
  useWorkspace: () => ({ can: (c: string) => caps.has(c) }),
}));
vi.mock('@/lib/marketingOS/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketingOS/client')>()),
  publishPublication: vi.fn(), rescheduleRelease: vi.fn(), cancelRelease: vi.fn(),
}));

const { default: MonthExceptions } = await import('../MonthExceptions');

const held: MosMonthException = {
  kind: 'release_held', severity: 'blocker', subject_kind: 'release',
  subject_id: 'e51be04b-e7d0-4afa-9a5d-60e2162ce169',
  label_ar: 'فات موعده ولم يُنشر',
  detail_ar: 'P-405 · فيد — تجاوز موعده بأكثر من 24 ساعة فلم يُنشر آليًا.',
  occurred_on: '2026-09-24', project_id: null, campaign_id: null,
  action_hint: 'publish_now_reschedule_or_cancel',
};
const rowLate: MosMonthException = {
  kind: 'row_incomplete', severity: 'blocker', subject_kind: 'row', subject_id: 'row-1',
  label_ar: 'صف غير مكتمل في موعد نشره', detail_ar: null, occurred_on: '2026-09-22',
  project_id: null, campaign_id: null, action_hint: 'move_row_or_drop_late_post',
};

/** A rendered BUTTON with exactly this label — the sentence under a line may use the same words. */
const button = (label: string): RegExp => new RegExp(`<button[^>]*>${label}</button>`);

const render = (list: MosMonthException[], granted: string[]): string => {
  caps.clear();
  for (const c of granted) caps.add(c);
  return renderToStaticMarkup(
    <MemoryRouter>
      <MonthExceptions exceptions={list} isAr projectName={() => ''} />
    </MemoryRouter>,
  );
};

describe('a held release on the month page', () => {
  it('shows all three decisions to someone who can publish and schedule', () => {
    const html = render([held], ['publish', 'schedule']);
    expect(html).toMatch(button('انشر الآن'));
    expect(html).toMatch(button('أعد الجدولة'));
    expect(html).toMatch(button('ألغِ'));
    expect(html).toContain('فات موعده ولم يُنشر');
    expect(html).toContain('/m/releases/e51be04b-e7d0-4afa-9a5d-60e2162ce169');
  });

  it('never shows a button its viewer cannot use', () => {
    const scheduleOnly = render([held], ['schedule']);
    expect(scheduleOnly).not.toMatch(button('انشر الآن'));
    expect(scheduleOnly).toMatch(button('أعد الجدولة'));
    const publishOnly = render([held], ['publish']);
    expect(publishOnly).toMatch(button('انشر الآن'));
    expect(publishOnly).not.toMatch(button('أعد الجدولة'));
    const readOnly = render([held], ['read']);
    expect(readOnly).not.toMatch(button('انشر الآن'));
    expect(readOnly).not.toMatch(button('أعد الجدولة'));
  });

  it('adds no controls to any other kind of line', () => {
    const html = render([rowLate], ['publish', 'schedule']);
    expect(html).not.toMatch(button('انشر الآن'));
    expect(html).toContain('تأجيل الدفعة');
  });
});
