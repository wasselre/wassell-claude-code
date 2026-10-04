import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { buildAiEvents, criteriaChips } from '../aiActivityText';
import type { AiActivity, AgentRun } from '../aiActivity';

// Echo the key plus its params, so assertions read what the UI would say.
const t = ((key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key)) as unknown as TFunction;

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 'r1', chat_wid: 'w', kind: 'brain', model: 'm', ms: 1000, customer_text: null, reading: null,
  searches: [], actions: {}, reply: null, reply_sent: null, reply_failed: false, guard_problems: [], tool_trace: [],
  created_at: '2026-10-05T10:00:00Z', ...over,
});

const base = (over: Partial<AiActivity>): AiActivity => ({
  scope: 'chat', chat_wids: ['w'], runs: [], stats: { customer: 0, ai: 0, rep: 0, last_ai_at: null, last_customer_at: null, sampled: 0 },
  messages: [], changes: [], outcomes: [], portal: { jobs: [], registrations: [] }, actions: [], questions: [], handoffs: [],
  bookings: [], interest: [], names: {}, ...over,
});

describe('criteriaChips', () => {
  it('describes zone, budget, near and a widened search', () => {
    const chips = criteriaChips({
      criteria: { zone: 'north', unit_types: ['شقة'], budget_max: 900000, near: [{ category: 'metro', max_km: 1 }] },
      total: 3, relaxed: null, area_understood: null, overrides: [], top: [],
    }, t, false);
    expect(chips[0]).toBe('شقة');
    expect(chips).toContain('chats.ai_act.zone_north');
    expect(chips.some((c) => c.startsWith('chats.ai_act.c_budget'))).toBe(true);
    expect(chips.some((c) => c.startsWith('chats.ai_act.c_near'))).toBe(true);
  });

  it('says "all projects" for an empty search', () => {
    expect(criteriaChips({ criteria: {}, total: 40, relaxed: null, area_understood: null, overrides: [], top: [] }, t, false))
      .toEqual(['chats.ai_act.c_everything']);
  });
});

describe('buildAiEvents', () => {
  it('turns a run into search / sent / booked events, newest first', () => {
    const d = base({
      runs: [run({
        searches: [{ criteria: {}, total: 0, relaxed: 'budget', area_understood: null, overrides: [], top: [] }],
        actions: { sent_project: { id: 'p1', name: 'أكنان 25' }, booked: { projectId: 'p1', day: 'الأحد' } },
        reply: 'أبشر',
      })],
      changes: [{ id: 'c1', kind: 'pref', field: 'budget', before_value: null, after_value: { max: 1 }, added: null, applied: true, note: null, source: 'chat', quote: 'مليون', label: null, created_at: '2026-10-05T11:00:00Z', undone_at: null }],
      names: { p1: 'أكنان 25' },
    });
    const ev = buildAiEvents(d, t, false, (s) => s, () => 'v', { withMessages: false });
    expect(ev[0].kind).toBe('change');
    const kinds = ev.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['search', 'sent', 'booked', 'ai_reply']));
    expect(ev.find((e) => e.kind === 'search')?.tone).toBe('warn');
  });

  it('includes the conversation only when asked, and skips status checks', () => {
    const d = base({
      messages: [{ chat_wid: 'w', date: '2026-10-05T09:00:00Z', by: 'customer', text: 'السلام' }],
      runs: [run({ reply: 'هلا' })],
      portal: { jobs: [{ id: 'j', portal_record_id: null, project_record_id: null, status: 'done', origin: 'auto', kind: 'status_check', error_message: null, created_at: '2026-10-05T08:00:00Z', finished_at: null }], registrations: [] },
    });
    const withMsgs = buildAiEvents(d, t, false, (s) => s, () => 'v', { withMessages: true });
    expect(withMsgs.map((e) => e.kind)).toEqual(['customer']);
    const without = buildAiEvents(d, t, false, (s) => s, () => 'v', { withMessages: false });
    expect(without.map((e) => e.kind)).toEqual(['ai_reply']);
  });
});
