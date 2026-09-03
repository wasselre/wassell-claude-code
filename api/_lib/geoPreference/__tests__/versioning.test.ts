import { describe, it, expect } from 'vitest';
import {
  planSupersessions,
  supersedeStaleOpenProposals,
  confirmability,
  isOpen,
  asOfFromTimestamp,
  type ProposalVersionRow,
  type ProposalVersionStore,
  type SubjectKey,
} from '../versioning';

/**
 * Proposal versioning / STALE handling. The whole point: a rep must never be able
 * to confirm a proposal that fresher client evidence has already overtaken.
 */

function row(id: string, as_of: number, status: ProposalVersionRow['status'] = 'pending'): ProposalVersionRow {
  return { id, as_of, status };
}

describe('planSupersessions — pure staleness planner', () => {
  it('supersedes a strictly-older OPEN proposal by the incoming one', () => {
    const existing = [row('old', 100), row('new', 200)];
    const plan = planSupersessions(existing, { id: 'new', as_of: 200 });
    expect(plan.supersede).toEqual([{ id: 'old', superseded_by: 'new' }]);
    expect(plan.kept_current).toContain('new'); // the incoming never supersedes itself
  });

  it('never supersedes the incoming proposal itself', () => {
    const plan = planSupersessions([row('x', 200)], { id: 'x', as_of: 200 });
    expect(plan.supersede).toEqual([]);
    expect(plan.kept_current).toEqual(['x']);
  });

  it('leaves already-closed (non-pending) proposals untouched', () => {
    const existing = [
      row('confirmed', 100, 'confirmed'),
      row('applied', 110, 'applied'),
      row('rejected', 120, 'rejected'),
      row('superseded', 130, 'superseded'),
    ];
    const plan = planSupersessions(existing, { id: 'fresh', as_of: 500 });
    expect(plan.supersede).toEqual([]);
    expect(plan.kept_closed.sort()).toEqual(['applied', 'confirmed', 'rejected', 'superseded']);
  });

  it('does NOT supersede an equally-fresh open proposal (strictly-newer only)', () => {
    const plan = planSupersessions([row('sibling', 200)], { id: 'incoming', as_of: 200 });
    expect(plan.supersede).toEqual([]);
    expect(plan.kept_current).toContain('sibling');
  });

  it('does NOT supersede a NEWER open proposal (out-of-order arrival)', () => {
    const plan = planSupersessions([row('newer', 300)], { id: 'incoming', as_of: 200 });
    expect(plan.supersede).toEqual([]);
    expect(plan.kept_current).toContain('newer');
  });

  it('supersedes multiple older opens at once', () => {
    const existing = [row('a', 10), row('b', 20), row('c', 30), row('closed', 5, 'applied')];
    const plan = planSupersessions(existing, { id: 'z', as_of: 100 });
    expect(plan.supersede.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
    expect(plan.supersede.every((s) => s.superseded_by === 'z')).toBe(true);
    expect(plan.kept_closed).toEqual(['closed']);
  });
});

describe('supersedeStaleOpenProposals — applies the plan through an injected store', () => {
  function makeStore(rows: ProposalVersionRow[]) {
    const calls: Array<{ id: string; superseded_by: string }> = [];
    const store: ProposalVersionStore = {
      async listForSubject(_subject: SubjectKey) {
        return rows;
      },
      async markSuperseded(id, superseded_by) {
        calls.push({ id, superseded_by });
        const r = rows.find((x) => x.id === id);
        if (r) { r.status = 'superseded'; r.superseded_by = superseded_by; }
      },
    };
    return { store, calls };
  }

  it('newer evidence supersedes the open proposal so a rep can no longer confirm it', async () => {
    const rows = [row('stale', 100), row('fresh', 200)];
    const { store, calls } = makeStore(rows);

    const plan = await supersedeStaleOpenProposals(
      store,
      { client_id: 'c1', conversation_id: 'conv-1' },
      { id: 'fresh', as_of: 200 },
    );

    expect(plan.supersede).toEqual([{ id: 'stale', superseded_by: 'fresh' }]);
    expect(calls).toEqual([{ id: 'stale', superseded_by: 'fresh' }]);

    // The stale row is now non-confirmable; the fresh one is confirmable.
    const stale = rows.find((r) => r.id === 'stale')!;
    const fresh = rows.find((r) => r.id === 'fresh')!;
    expect(stale.status).toBe('superseded');
    expect(stale.superseded_by).toBe('fresh');
    expect(confirmability(stale)).toEqual({ ok: false, reason: 'superseded' });
    expect(confirmability(fresh)).toEqual({ ok: true });
  });

  it('an empty subject (nothing open) is a valid no-op — no store writes', async () => {
    const { store, calls } = makeStore([]);
    const plan = await supersedeStaleOpenProposals(store, { client_id: 'c9' }, { id: 'fresh', as_of: 1 });
    expect(plan.supersede).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('confirmability — the confirm-boundary guard', () => {
  it('only a pending proposal is confirmable', () => {
    expect(confirmability(row('p', 1, 'pending'))).toEqual({ ok: true });
    expect(confirmability(row('p', 1, 'superseded')).ok).toBe(false);
    expect(confirmability(row('p', 1, 'confirmed')).ok).toBe(false);
    expect(confirmability(row('p', 1, 'applied')).ok).toBe(false);
    expect(confirmability(row('p', 1, 'rejected')).ok).toBe(false);
  });

  it('isOpen matches the pending-only rule', () => {
    expect(isOpen({ status: 'pending' })).toBe(true);
    expect(isOpen({ status: 'superseded' })).toBe(false);
  });
});

describe('asOfFromTimestamp — ISO → comparable recency', () => {
  it('parses ISO timestamps monotonically', () => {
    const earlier = asOfFromTimestamp('2026-09-03T10:00:00Z');
    const later = asOfFromTimestamp('2026-09-03T10:05:00Z');
    expect(later).toBeGreaterThan(earlier);
  });

  it('treats an undated/garbage proposal as the OLDEST (so any dated fresh one supersedes it)', () => {
    expect(asOfFromTimestamp(null)).toBe(0);
    expect(asOfFromTimestamp('not-a-date')).toBe(0);
    const plan = planSupersessions(
      [{ id: 'undated', as_of: asOfFromTimestamp(null), status: 'pending' }],
      { id: 'dated', as_of: asOfFromTimestamp('2026-09-03T10:00:00Z') },
    );
    expect(plan.supersede).toEqual([{ id: 'undated', superseded_by: 'dated' }]);
  });
});
