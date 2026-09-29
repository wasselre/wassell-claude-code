import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  auditCall, emptyOnlySuggestions, customerSaidIt, callProposalKey, CALL_AUDIT_LEASE_SECONDS,
  type CallAuditDeps, type CallAuditFinish, type CallGeoFinish,
} from '../callAudit.js';
import type { AnalyzeOutcome } from '../../geoPreference/chatCard.js';
import type { Conversation } from '../../geoPreference/extractor.js';
import type { PrefSuggestion, PreferenceExtraction } from '../../prefExtract.js';
import type { NewPrefProposalRow } from '../extractChatPrefs.js';
import { shapeCallProposals } from '../card.js';

const CALL = '22222222-2222-4222-8222-222222222222';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const sb = {} as SupabaseClient; // every port is injected — the client is never touched

const sug = (slug: string, value: unknown): PrefSuggestion => ({ slug, value, quote: 'villa', confidence: 80 });

const labelled: Conversation = {
  channel: 'call', id: CALL, speaker_labels: 'self_intro',
  turns: [
    { speaker: 'agent', text: 'hello', timestamp: '2026-09-20T10:00:00.000Z', ref: CALL },
    { speaker: 'client', text: 'villa', timestamp: '2026-09-20T10:01:00.000Z', ref: CALL },
  ],
};

function fakeDeps(over: Partial<CallAuditDeps> = {}, said: Record<string, PrefSuggestion> = {
  preferred_unit_type: sug('preferred_unit_type', ['فيلا']),
  budget: sug('budget', { max: 3000000 }),
}) {
  const finishes: CallAuditFinish[] = [];
  const inserts: NewPrefProposalRow[] = [];
  const geoFinishes: CallGeoFinish[] = [];
  const order: string[] = [];
  const deps: CallAuditDeps = {
    claim: vi.fn(async () => true),
    finish: vi.fn(async (_id: string, f: CallAuditFinish) => { finishes.push(f); return true; }),
    gather: vi.fn(async () => labelled),
    readClient: vi.fn(async () => ({ client_name: 'x', budget: { max: 2000000 } })),
    extract: vi.fn(async (): Promise<PreferenceExtraction> => ({
      output: { suggestions: said, districts: ['النرجس'] }, model: 'deepseek-chat', isFallback: false,
    })),
    insertProposal: vi.fn(async (row: NewPrefProposalRow) => { inserts.push(row); return { proposalId: 'prop-1', superseded: 0 }; }),
    geoClaim: vi.fn(async () => true),
    geoFinish: vi.fn(async (_id: string, f: CallGeoFinish) => { geoFinishes.push(f); order.push('geoFinish'); return true; }),
    analyzeGeo: vi.fn(async () => geoOutcome({ minted_proposal_id: 'geo-1', mode: 'extract' })),
    ...over,
  };
  // Record the order of the two finishes (the geo result must land inside the lease).
  const finishImpl = deps.finish;
  deps.finish = vi.fn(async (id: string, f: CallAuditFinish) => { order.push('finish'); return finishImpl(id, f); });
  return { deps, finishes, inserts, geoFinishes, order };
}

/** A minimal AnalyzeOutcome (only mode + minted_proposal_id matter to the audit). */
function geoOutcome(over: Partial<AnalyzeOutcome>): AnalyzeOutcome {
  return {
    status: 'pending', checkpoint_id: 'cp', proposal: null, mentions: [], names: {}, analyzed_at: null,
    stale: false, graded: false, can_reanalyze: true, customer_messages: 0,
    mode: 'extract', minted_proposal_id: null, ...over,
  };
}

describe('emptyOnlySuggestions', () => {
  it('keeps only fields EMPTY on the client; a same or different saved value is dropped', () => {
    const r = emptyOnlySuggestions(
      {
        preferred_unit_type: sug('preferred_unit_type', ['فيلا']),
        budget: sug('budget', { max: 3000000 }),
        preferred_area: sug('preferred_area', { min: 200 }),
        preferred_bedrooms: sug('preferred_bedrooms', { min: 4 }),
      },
      { preferred_unit_type: [], budget: { max: 3000000 }, preferred_area: { min: 150 }, preferred_bedrooms: { min: null, max: null } },
    );
    expect(Object.keys(r.kept).sort()).toEqual(['preferred_bedrooms', 'preferred_unit_type']);
    expect(r.droppedFilled.sort()).toEqual(['budget', 'preferred_area']);
  });
});

describe('auditCall', () => {
  it('proposes only the empty fields, as ONE call proposal, and finishes done', async () => {
    const { deps, finishes, inserts } = fakeDeps();
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, hangupAt: '2026-09-20T10:05:00.000Z', deps });
    expect(deps.claim).toHaveBeenCalledWith(CALL, CLIENT, CALL_AUDIT_LEASE_SECONDS);
    expect(r).toMatchObject({ status: 'done', proposalId: 'prop-1', missed: ['preferred_unit_type'], droppedFilled: ['budget'] });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      client_id: CLIENT, chat_wid: callProposalKey(CALL), source: 'call', call_id: CALL,
      call_at: '2026-09-20T10:05:00.000Z', source_watermark: '2026-09-20T10:05:00.000Z',
      trigger: 'call_audit', source_message_count: 2, model: 'deepseek-chat',
    });
    // Only the kept field is suggested; the before-snapshot carries all six slugs.
    expect(Object.keys(inserts[0]!.suggestions)).toEqual(['preferred_unit_type']);
    expect(inserts[0]!.current_values).toMatchObject({ budget: { max: 2000000 }, preferred_unit_type: null });
    // Districts are never proposed from a call.
    expect(JSON.stringify(inserts[0])).not.toContain('النرجس');
    expect(finishes).toEqual([{ status: 'done', reason: null, proposalId: 'prop-1', missed: ['preferred_unit_type'] }]);
    const ex = (deps.extract as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { channel: string; transcript: string; entity: unknown };
    expect(ex.channel).toBe('call');
    expect(ex.transcript).toContain('العميل: villa');
    expect(ex.entity).toEqual({ kind: 'call', id: CALL });
  });

  it('not claimed ⇒ skipped/not_claimed WITHOUT finishing (another runner owns it)', async () => {
    const { deps } = fakeDeps({ claim: vi.fn(async () => false) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r).toMatchObject({ status: 'skipped', reason: 'not_claimed' });
    expect(deps.finish).not.toHaveBeenCalled();
    expect(deps.gather).not.toHaveBeenCalled();
  });

  it('unlabelled speakers ⇒ skipped/unlabelled, no model call', async () => {
    const { deps, finishes } = fakeDeps({ gather: vi.fn(async () => ({ ...labelled, speaker_labels: 'none' as const })) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r).toMatchObject({ status: 'skipped', reason: 'unlabelled' });
    expect(deps.extract).not.toHaveBeenCalled();
    expect(finishes[0]).toMatchObject({ status: 'skipped', reason: 'unlabelled' });
  });

  it('no transcript ⇒ skipped/no_transcript', async () => {
    const { deps, finishes } = fakeDeps({ gather: vi.fn(async () => null) });
    expect(await auditCall(sb, { callId: CALL, clientId: CLIENT, deps })).toMatchObject({ status: 'skipped', reason: 'no_transcript' });
    expect(finishes[0]).toMatchObject({ status: 'skipped', reason: 'no_transcript' });
  });

  it('client gone ⇒ skipped/client_missing, no proposal', async () => {
    const { deps, inserts } = fakeDeps({ readClient: vi.fn(async () => null) });
    expect(await auditCall(sb, { callId: CALL, clientId: CLIENT, deps })).toMatchObject({ status: 'skipped', reason: 'client_missing' });
    expect(inserts).toEqual([]);
  });

  it('everything said is already on the client ⇒ done/all_filled, no proposal', async () => {
    const { deps, inserts, finishes } = fakeDeps({}, { budget: sug('budget', { max: 3000000 }) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r).toMatchObject({ status: 'done', reason: 'all_filled', proposalId: null, missed: [], droppedFilled: ['budget'] });
    expect(inserts).toEqual([]);
    expect(finishes[0]).toMatchObject({ status: 'done', reason: 'all_filled', proposalId: null });
  });

  it('nothing said ⇒ done/no_preferences', async () => {
    const { deps, inserts } = fakeDeps({}, {});
    expect(await auditCall(sb, { callId: CALL, clientId: CLIENT, deps })).toMatchObject({ status: 'done', reason: 'no_preferences' });
    expect(inserts).toEqual([]);
  });

  it('an extractor failure is recorded as failed (finish still runs) and returned, never thrown', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, finishes } = fakeDeps({ extract: vi.fn(async () => { throw new Error('both providers down'); }) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r).toMatchObject({ status: 'failed', reason: 'both providers down', proposalId: null });
    expect(finishes).toEqual([{ status: 'failed', reason: 'both providers down', proposalId: null, missed: [] }]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a failing finish is reported as failed (the lease expires and the ledger retries)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakeDeps({ finish: vi.fn(async () => { throw new Error('rpc down'); }) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('finish failed: rpc down');
    errSpy.mockRestore();
  });

  it('without a hang-up time the last turn dates the proposal', async () => {
    const { deps, inserts } = fakeDeps();
    await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(inserts[0]!.call_at).toBe('2026-09-20T10:01:00.000Z');
  });
});

describe('shapeCallProposals (card)', () => {
  it('attaches the FRESH value of each proposal slug only', () => {
    const rows = [{
      id: 'a', version: 1, status: 'pending' as const, call_id: CALL, call_at: null,
      suggestions: { budget: sug('budget', { max: 1 }) }, created_at: 'x', decided_at: null, saved_fields: null,
    }];
    const out = shapeCallProposals(rows, { budget: { max: 5 }, preferred_area: { min: 2 } });
    expect(out[0]!.current_values).toEqual({ budget: { max: 5 } });
  });
});

// Real lines from the 2026-09-29 dry run: the model quoted the SALESPERSON in
// 3 of 14 suggestions. The guard must reject those and keep the customer's own.
describe('customerSaidIt — the quote must be the customer\'s words', () => {
  const call: Conversation = {
    channel: 'call', id: 'c1', speaker_labels: 'hatif_role',
    turns: [
      { speaker: 'agent', text: 'أنتِ تبحثين عن شقة في شمال الرياض، صح؟', timestamp: null, ref: 'c1' },
      { speaker: 'client', text: 'إيه صحيح. بس ما يـ- ما يكتر عن 900 ألف.', timestamp: null, ref: 'c1' },
      { speaker: 'agent', text: 'أبديت اهتمامك تملك وحدة عقارية بالرياض', timestamp: null, ref: 'c1' },
      { speaker: 'client', text: 'فيها سطح، فيها غرفة الخادمة؟ ضروري.', timestamp: null, ref: 'c1' },
    ],
  };
  it('rejects a quote only the salesperson said', () => {
    expect(customerSaidIt(call, 'أنتِ تبحثين عن شقة في شمال الرياض')).toBe(false);
    expect(customerSaidIt(call, 'أبديت اهتمامك تملك وحدة عقارية بالرياض')).toBe(false);
  });
  it('accepts the customer\'s words, across punctuation and hesitation dashes', () => {
    expect(customerSaidIt(call, 'ما يـ- ما يكتر عن 900')).toBe(true);
    expect(customerSaidIt(call, 'فيها سطح، فيها غرفة الخادمة')).toBe(true);
  });
  it('every fragment of an elided quote must be the customer\'s', () => {
    expect(customerSaidIt(call, 'إيه صحيح... فيها سطح')).toBe(true);
    expect(customerSaidIt(call, 'إيه صحيح... تبحثين عن شقة')).toBe(false);
  });
  it('bracketed editor notes are ignored; an empty quote fails', () => {
    expect(customerSaidIt(call, 'ما يكتر عن 900 [العميل لم ينفِ]')).toBe(true);
    expect(customerSaidIt(call, null)).toBe(false);
    expect(customerSaidIt(call, '')).toBe(false);
  });
});
