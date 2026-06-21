import { describe, it, expect } from 'vitest';
import { aggregateInsights } from '../matching/telemetry';

/**
 * The admin insights dashboard reads ONLY what `aggregateInsights` returns, so
 * these tests pin the aggregation that drives every number on that screen:
 * capability/card usage, helpful rate, failed intents, complaints, errors,
 * avg response time — plus the defensive tolerance of malformed records.
 */

// A small fixture mirroring the inline shape stored on matching_chats messages.
const records = [
  {
    data: {
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          cards: [{ kind: 'recommendation' }],
          telemetry: { tools_used: ['match_projects', 'emit_recommendation'], response_ms: 2000, errored: false },
          feedback: { rating: 'up', at: '2026-06-21T10:00:00Z' },
        },
        { role: 'user' },
        {
          role: 'assistant',
          cards: [{ kind: 'comparison' }],
          telemetry: { tools_used: ['compare_projects', 'emit_comparison'], response_ms: 4000, errored: true },
          feedback: { rating: 'down', intent: 'compare', comment: 'wrong projects', at: '2026-06-21T10:05:00Z' },
        },
      ],
    },
  },
  {
    data: {
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          cards: [{ kind: 'recommendation' }],
          telemetry: { tools_used: ['match_projects'], response_ms: 3000, errored: false },
          feedback: { rating: 'down', intent: 'find_project', at: '2026-06-21T11:00:00Z' },
        },
      ],
    },
  },
];

describe('aggregateInsights', () => {
  it('counts conversations, user messages, and assistant turns', () => {
    const ins = aggregateInsights(records);
    expect(ins.conversations).toBe(2);
    expect(ins.user_messages).toBe(3);
    expect(ins.assistant_turns).toBe(3);
  });

  it('aggregates capability usage sorted by count', () => {
    const ins = aggregateInsights(records);
    // match_projects fires twice; everything else once.
    expect(ins.tool_usage[0]).toEqual({ name: 'match_projects', count: 2 });
    const compare = ins.tool_usage.find((t) => t.name === 'compare_projects');
    expect(compare?.count).toBe(1);
  });

  it('aggregates card usage', () => {
    const ins = aggregateInsights(records);
    const rec = ins.card_usage.find((c) => c.kind === 'recommendation');
    expect(rec?.count).toBe(2);
  });

  it('computes thumbs counts and helpful rate', () => {
    const ins = aggregateInsights(records);
    expect(ins.thumbs_up).toBe(1);
    expect(ins.thumbs_down).toBe(2);
    expect(ins.thumbs_up_rate).toBeCloseTo(1 / 3, 5);
  });

  it('tallies failed intents from 👎 and captures written complaints', () => {
    const ins = aggregateInsights(records);
    const intents = Object.fromEntries(ins.failed_intents.map((f) => [f.intent, f.count]));
    expect(intents).toEqual({ compare: 1, find_project: 1 });
    expect(ins.complaints).toHaveLength(1);
    expect(ins.complaints[0]).toMatchObject({ comment: 'wrong projects', intent: 'compare' });
  });

  it('counts errored turns and averages response time', () => {
    const ins = aggregateInsights(records);
    expect(ins.errored_turns).toBe(1);
    // (2000 + 4000 + 3000) / 3 = 3000
    expect(ins.avg_response_ms).toBe(3000);
  });

  it('returns null rates when there is no feedback or timing yet', () => {
    const ins = aggregateInsights([{ data: { messages: [{ role: 'assistant' }] } }]);
    expect(ins.thumbs_up_rate).toBeNull();
    expect(ins.avg_response_ms).toBeNull();
    expect(ins.assistant_turns).toBe(1);
  });

  it('tolerates malformed / empty records without throwing', () => {
    // No messages, non-array messages, missing data — all skipped, never crash.
    const ins = aggregateInsights([
      {},
      { data: {} },
      { data: { messages: 'nope' as unknown as [] } },
      { data: { messages: [] } },
    ]);
    expect(ins.conversations).toBe(0);
    expect(ins.assistant_turns).toBe(0);
    expect(ins.tool_usage).toEqual([]);
  });
});
