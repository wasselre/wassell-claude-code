import { describe, it, expect, vi } from 'vitest';
import {
  applyPrefReview, prefOptionsFromSchema, PrefReviewError,
  type PrefReviewDeps, type PrefProposalRow, type PrefDecisionPatch,
} from '../review.js';
import { buildPrefPatch, buildFillEmptyPatch } from '../../../src/lib/clientPrefs/mergePrefs.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function proposal(over: Partial<PrefProposalRow> = {}): PrefProposalRow {
  return {
    id: 'p1', client_id: CLIENT, chat_wid: '9665@c.us', status: 'pending', version: 3,
    suggestions: {
      preferred_unit_type: { slug: 'preferred_unit_type', value: ['فيلا'], quote: 'أبي فيلا', confidence: 90 },
      budget: { slug: 'budget', value: { max: 3000000 }, quote: 'ثلاثة مليون', confidence: 80 },
    },
    ...over,
  };
}

function fakeDeps(p: PrefProposalRow | null, client: Record<string, unknown> = { preferred_unit_type: ['شقة'] }) {
  const writes: Array<Record<string, unknown>> = [];
  const decisions: PrefDecisionPatch[] = [];
  const deps: PrefReviewDeps = {
    getProposal: vi.fn(async () => p),
    assertCanAccess: vi.fn(async () => {}),
    loadOptions: vi.fn(async () => ({ preferred_unit_type: ['فيلا', 'شقة'] })),
    writeClient: vi.fn(async (_clientId, suggestions, fields, options, mode) => {
      if (mode === 'fill_empty') {
        const r = buildFillEmptyPatch(client, suggestions, fields, options);
        if (Object.keys(r.patch).length) writes.push(r.patch);
        return { before: {}, written: r.patch, dropped: r.dropped, skippedFilled: r.skippedFilled };
      }
      const r = buildPrefPatch(client, suggestions, fields, options);
      writes.push(r.patch);
      return { before: {}, written: r.patch, dropped: r.dropped, skippedFilled: [] };
    }),
    markDecided: vi.fn(async (_id: string, patch: PrefDecisionPatch) => { decisions.push(patch); }),
    now: () => '2026-09-27T12:00:00Z',
  };
  return { deps, writes, decisions };
}

describe('applyPrefReview', () => {
  it('dismiss never writes the client, and still checks permission', async () => {
    const { deps, writes, decisions } = fakeDeps(proposal());
    const out = await applyPrefReview(deps, { proposalId: 'p1', action: 'dismiss', reviewerId: 'u1' });
    expect(out.status).toBe('dismissed');
    expect(deps.writeClient).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(deps.assertCanAccess).toHaveBeenCalledWith(CLIENT);
    expect(decisions[0]).toMatchObject({ status: 'dismissed', decided_by: 'u1' });
  });

  it('save writes ONLY the ticked fields and checks permission', async () => {
    const { deps, writes, decisions } = fakeDeps(proposal());
    const out = await applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['preferred_unit_type'], expectedVersion: 3 });
    expect(writes).toEqual([{ preferred_unit_type: ['شقة', 'فيلا'] }]);
    expect(out.saved_fields).toEqual(['preferred_unit_type']);
    expect(deps.assertCanAccess).toHaveBeenCalledWith(CLIENT);
    expect(decisions[0]).toMatchObject({ status: 'saved', saved_fields: ['preferred_unit_type'], after_values: { preferred_unit_type: ['شقة', 'فيلا'] } });
  });

  it('409 on a stale version, before any write', async () => {
    const { deps } = fakeDeps(proposal());
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['budget'], expectedVersion: 2 }))
      .rejects.toMatchObject({ status: 409 });
    expect(deps.writeClient).not.toHaveBeenCalled();
  });

  it('409 on a proposal that is no longer pending', async () => {
    const { deps } = fakeDeps(proposal({ status: 'superseded' }));
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'dismiss', reviewerId: 'u1' })).rejects.toMatchObject({ status: 409 });
    expect(deps.markDecided).not.toHaveBeenCalled();
  });

  it('404 / 400 guards: missing proposal, empty save, unknown or unsuggested field', async () => {
    await expect(applyPrefReview(fakeDeps(null).deps, { proposalId: 'x', action: 'dismiss', reviewerId: 'u1' })).rejects.toMatchObject({ status: 404 });
    const { deps } = fakeDeps(proposal());
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: [] })).rejects.toMatchObject({ status: 400 });
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['client_name'] })).rejects.toMatchObject({ status: 400 });
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['preferred_area'] })).rejects.toMatchObject({ status: 400 });
    expect(deps.writeClient).not.toHaveBeenCalled();
  });

  it('a denied permission stops the save before the write', async () => {
    const { deps } = fakeDeps(proposal());
    deps.assertCanAccess = vi.fn(async () => { throw new PrefReviewError(403, 'no access'); });
    await expect(applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['budget'] })).rejects.toMatchObject({ status: 403 });
    expect(deps.writeClient).not.toHaveBeenCalled();
  });
});

describe('applyPrefReview — call-audit proposals are fill-empty-only', () => {
  const callProposal = (): PrefProposalRow => proposal({
    chat_wid: 'call:22222222-2222-4222-8222-222222222222', source: 'call',
  });

  it('a field filled since the call is skipped, reported, and not written; the empty one is', async () => {
    // budget was logged by the rep after the call; the unit type is still empty.
    const { deps, writes, decisions } = fakeDeps(callProposal(), { preferred_unit_type: [], budget: { max: 1500000 } });
    const out = await applyPrefReview(deps, {
      proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['preferred_unit_type', 'budget'], expectedVersion: 3,
    });
    expect(deps.writeClient).toHaveBeenCalledWith(CLIENT, expect.anything(), ['preferred_unit_type', 'budget'], expect.anything(), 'fill_empty');
    expect(writes).toEqual([{ preferred_unit_type: ['فيلا'] }]);
    expect(out.skipped_filled).toEqual(['budget']);
    expect(out.saved_fields).toEqual(['preferred_unit_type']);
    expect(decisions[0]).toMatchObject({ status: 'saved', saved_fields: ['preferred_unit_type'] });
  });

  it('nothing writable ⇒ still marked saved, with empty saved_fields and every field in skipped_filled', async () => {
    const { deps, writes, decisions } = fakeDeps(callProposal(), { preferred_unit_type: ['شقة'], budget: { min: 1 } });
    const out = await applyPrefReview(deps, {
      proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['preferred_unit_type', 'budget'],
    });
    expect(writes).toEqual([]);
    expect(out.status).toBe('saved');
    expect(out.saved_fields).toEqual([]);
    expect(out.skipped_filled).toEqual(['preferred_unit_type', 'budget']);
    expect(decisions[0]).toMatchObject({ status: 'saved', saved_fields: [] });
  });

  it('a chat proposal keeps merge mode and reports no skipped_filled', async () => {
    const { deps } = fakeDeps(proposal());
    const out = await applyPrefReview(deps, { proposalId: 'p1', action: 'save', reviewerId: 'u1', fields: ['budget'] });
    expect(deps.writeClient).toHaveBeenCalledWith(CLIENT, expect.anything(), ['budget'], expect.anything(), 'merge');
    expect(out.skipped_filled).toEqual([]);
  });

  it('dismissing a call proposal never writes', async () => {
    const { deps } = fakeDeps(callProposal());
    const out = await applyPrefReview(deps, { proposalId: 'p1', action: 'dismiss', reviewerId: 'u1' });
    expect(out.status).toBe('dismissed');
    expect(deps.writeClient).not.toHaveBeenCalled();
  });
});

describe('prefOptionsFromSchema', () => {
  it('reads option VALUES of the set-kind preference fields only', () => {
    const schema = {
      sections: [
        { fields: [
          { name: 'purchase_objective', options: [{ value: 'residential', label_ar: 'سكن' }, { value: 'investment' }] },
          { name: 'client_status', options: [{ value: 'مهتم' }] },
        ] },
        { fields: [{ name: 'preferred_amenities', options: [{ value: 'مسبح' }] }, { name: 'budget' }] },
      ],
    };
    expect(prefOptionsFromSchema(schema)).toEqual({ purchase_objective: ['residential', 'investment'], preferred_amenities: ['مسبح'] });
  });
});
