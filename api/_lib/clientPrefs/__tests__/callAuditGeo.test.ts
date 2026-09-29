import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  auditCall, clientHasPlaces, CALL_AUDIT_LEASE_SECONDS,
  type CallAuditDeps, type CallAuditFinish, type CallGeoFinish,
} from '../callAudit.js';
import type { AnalyzeOutcome } from '../../geoPreference/chatCard.js';
import type { Conversation } from '../../geoPreference/extractor.js';
import type { PrefSuggestion, PreferenceExtraction } from '../../prefExtract.js';
import type { NewPrefProposalRow } from '../extractChatPrefs.js';
import { selectVisibleCallGeo, isShowableCallGeoCard } from '../card.js';
import { candidatePasses } from '../../../cron/chat-auto-read.js';

/** Places (geography) from calls — 2026-09-29_02. Every port is injected. */

const CALL = '22222222-2222-4222-8222-222222222222';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const sb = {} as SupabaseClient;

const labelled: Conversation = {
  channel: 'call', id: CALL, speaker_labels: 'self_intro',
  turns: [
    { speaker: 'agent', text: 'hello', timestamp: '2026-09-20T10:00:00.000Z', ref: CALL },
    { speaker: 'client', text: 'villa', timestamp: '2026-09-20T10:01:00.000Z', ref: CALL },
  ],
};

const PLACES = [{ id: 'li1', kind: 'district', polarity: 'include', district_id: '33333333-3333-4333-8333-333333333333', district_label: 'x' }];

function geoOutcome(over: Partial<AnalyzeOutcome>): AnalyzeOutcome {
  return {
    status: 'pending', checkpoint_id: 'cp', proposal: null, mentions: [], names: {}, analyzed_at: null,
    stale: false, graded: false, can_reanalyze: true, customer_messages: 0,
    mode: 'extract', minted_proposal_id: null, ...over,
  };
}

function fakeDeps(over: Partial<CallAuditDeps> = {}) {
  const finishes: CallAuditFinish[] = [];
  const geoFinishes: CallGeoFinish[] = [];
  const inserts: NewPrefProposalRow[] = [];
  const order: string[] = [];
  const said: Record<string, PrefSuggestion> = {
    preferred_unit_type: { slug: 'preferred_unit_type', value: ['villa'], quote: 'villa', confidence: 80 },
  };
  const deps: CallAuditDeps = {
    claim: vi.fn(async () => true),
    finish: vi.fn(async (_id: string, f: CallAuditFinish) => { finishes.push(f); order.push('finish'); return true; }),
    geoClaim: vi.fn(async () => true),
    geoFinish: vi.fn(async (_id: string, f: CallGeoFinish) => { geoFinishes.push(f); order.push('geoFinish'); return true; }),
    gather: vi.fn(async () => labelled),
    readClient: vi.fn(async () => ({ client_name: 'x' })),
    extract: vi.fn(async (): Promise<PreferenceExtraction> => ({
      output: { suggestions: said, districts: [] }, model: 'deepseek-chat', isFallback: false,
    })),
    insertProposal: vi.fn(async (row: NewPrefProposalRow) => { inserts.push(row); return { proposalId: 'prop-1', superseded: 0 }; }),
    analyzeGeo: vi.fn(async () => geoOutcome({ minted_proposal_id: 'geo-1', mode: 'extract' })),
    ...over,
  };
  return { deps, finishes, geoFinishes, inserts, order };
}

describe('auditCall — the places pass', () => {
  it('fresh call: prefs AND places in one lease; the geo result is recorded BEFORE the preference finish', async () => {
    const { deps, geoFinishes, order } = fakeDeps();
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.prefsRan).toBe(true);
    expect(r).toMatchObject({ status: 'done', proposalId: 'prop-1' });
    expect(r.geo).toEqual({ status: 'done', reason: null, proposalId: 'geo-1', mode: 'extract' });
    expect(deps.claim).toHaveBeenCalledWith(CALL, CLIENT, CALL_AUDIT_LEASE_SECONDS);
    expect(deps.geoClaim).not.toHaveBeenCalled();
    expect(deps.gather).toHaveBeenCalledTimes(1); // ONE conversation for both passes
    expect(deps.readClient).toHaveBeenCalledTimes(1);
    const a = (deps.analyzeGeo as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(a[0]).toBe(CLIENT);
    expect(a[1]).toBe(CALL);
    expect((a[2] as { conversation: Conversation }).conversation).toBe(labelled);
    expect(geoFinishes).toEqual([{ status: 'done', reason: null, proposalId: 'geo-1' }]);
    expect(order).toEqual(['geoFinish', 'finish']);
  });

  it('GEO-ONLY pass (prefs already audited): geo claim, NO preference extractor, NO preference finish', async () => {
    const { deps, finishes, geoFinishes, inserts } = fakeDeps();
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, needsPrefs: false, needsGeo: true, deps });
    expect(deps.geoClaim).toHaveBeenCalledWith(CALL, CALL_AUDIT_LEASE_SECONDS);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(finishes).toEqual([]);
    expect(r.prefsRan).toBe(false);
    expect(r.geo).toMatchObject({ status: 'done', proposalId: 'geo-1' });
    expect(geoFinishes).toHaveLength(1);
  });

  it('geo-only pass not claimed ⇒ skipped/not_claimed, nothing runs, nothing finishes', async () => {
    const { deps } = fakeDeps({ geoClaim: vi.fn(async () => false) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, needsPrefs: false, needsGeo: true, deps });
    expect(r).toMatchObject({ status: 'skipped', reason: 'not_claimed', prefsRan: false, geo: null });
    expect(deps.gather).not.toHaveBeenCalled();
    expect(deps.geoFinish).not.toHaveBeenCalled();
  });

  it('needs_geo=false ⇒ the geography pipeline never runs and no geo result is written', async () => {
    const { deps } = fakeDeps();
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, needsPrefs: true, needsGeo: false, deps });
    expect(deps.analyzeGeo).not.toHaveBeenCalled();
    expect(deps.geoFinish).not.toHaveBeenCalled();
    expect(r.geo).toBeNull();
  });

  it('a client that HAS places ⇒ geo skipped/has_places, no geography read (never overwrite)', async () => {
    const { deps, geoFinishes } = fakeDeps({ readClient: vi.fn(async () => ({ location_items: PLACES })) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(deps.analyzeGeo).not.toHaveBeenCalled();
    expect(r.geo).toMatchObject({ status: 'skipped', reason: 'has_places', proposalId: null });
    expect(geoFinishes).toEqual([{ status: 'skipped', reason: 'has_places', proposalId: null }]);
  });

  it('clientHasPlaces: parsed location_items, empty / missing ⇒ no places', () => {
    expect(clientHasPlaces({ location_items: PLACES })).toBe(true);
    expect(clientHasPlaces({})).toBe(false);
    expect(clientHasPlaces({ location_items: [] })).toBe(false);
    expect(clientHasPlaces({ location_items: null })).toBe(false);
  });

  it('unlabelled call ⇒ geo skipped/unlabelled, no geography read', async () => {
    const { deps, geoFinishes } = fakeDeps({ gather: vi.fn(async () => ({ ...labelled, speaker_labels: 'none' as const })) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.geo).toMatchObject({ status: 'skipped', reason: 'unlabelled' });
    expect(deps.analyzeGeo).not.toHaveBeenCalled();
    expect(geoFinishes[0]).toMatchObject({ status: 'skipped', reason: 'unlabelled' });
  });

  it('client gone ⇒ geo skipped/client_missing', async () => {
    const { deps } = fakeDeps({ readClient: vi.fn(async () => null) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, needsPrefs: false, deps });
    expect(r.geo).toMatchObject({ status: 'skipped', reason: 'client_missing' });
  });

  it('nothing drawable (the gate ignored it) ⇒ geo done/no_places, no proposal', async () => {
    const { deps } = fakeDeps({ analyzeGeo: vi.fn(async () => geoOutcome({ minted_proposal_id: null, mode: 're_review' })) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.geo).toEqual({ status: 'done', reason: 'no_places', proposalId: null, mode: 're_review' });
  });

  it('read a moment ago (cool-down) ⇒ geo failed/cooldown so the ledger retries it', async () => {
    const { deps } = fakeDeps({ analyzeGeo: vi.fn(async () => geoOutcome({ minted_proposal_id: null, mode: 'skipped_recent' })) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.geo).toMatchObject({ status: 'failed', reason: 'cooldown' });
  });

  it('a geography failure is recorded as geo failed; the preference result is unaffected', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, finishes, geoFinishes } = fakeDeps({ analyzeGeo: vi.fn(async () => { throw new Error('geo extractor down'); }) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r).toMatchObject({ status: 'done', proposalId: 'prop-1' });
    expect(r.geo).toMatchObject({ status: 'failed', reason: 'geo extractor down' });
    expect(geoFinishes).toEqual([{ status: 'failed', reason: 'geo extractor down', proposalId: null }]);
    expect(finishes[0]).toMatchObject({ status: 'done', proposalId: 'prop-1' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a failing geo finish is reported as geo failed, and the preference finish still runs', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, finishes } = fakeDeps({ geoFinish: vi.fn(async () => { throw new Error('rpc down'); }) });
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, deps });
    expect(r.geo?.status).toBe('failed');
    expect(r.geo?.reason).toContain('geo finish failed: rpc down');
    expect(finishes).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('nothing due ⇒ no claim at all', async () => {
    const { deps } = fakeDeps();
    const r = await auditCall(sb, { callId: CALL, clientId: CLIENT, needsPrefs: false, needsGeo: false, deps });
    expect(r).toMatchObject({ status: 'skipped', reason: 'nothing_due' });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.geoClaim).not.toHaveBeenCalled();
  });
});

describe('candidatePasses (cron) — the candidate row decides the passes', () => {
  const base = { call_id: CALL, client_id: CLIENT, hangup_time: '2026-09-20T10:05:00Z', duration_seconds: 60 };
  it('new shape: prefs + geo, geo-only, prefs-only', () => {
    expect(candidatePasses({ ...base, needs_prefs: true, needs_geo: true })).toEqual({ needsPrefs: true, needsGeo: true });
    expect(candidatePasses({ ...base, needs_prefs: false, needs_geo: true })).toEqual({ needsPrefs: false, needsGeo: true });
    expect(candidatePasses({ ...base, needs_prefs: true, needs_geo: false })).toEqual({ needsPrefs: true, needsGeo: false });
  });
  it('old shape (migration 2026-09-29_02 not applied) ⇒ prefs only, never geo', () => {
    expect(candidatePasses(base)).toEqual({ needsPrefs: true, needsGeo: false });
  });
});

describe('call places on the card — only the audit-minted proposals', () => {
  const since = '2026-09-28T12:00:00.000Z';
  const audit = [
    { call_id: 'c1', geo_proposal_id: 'g-open' },
    { call_id: 'c2', geo_proposal_id: 'g-applied-recent' },
    { call_id: 'c3', geo_proposal_id: 'g-rejected-old' },
    { call_id: 'c4', geo_proposal_id: 'g-superseded' },
    { call_id: 'c5', geo_proposal_id: 'g-missing' },
    { call_id: 'c6', geo_proposal_id: 'g-must' },
  ];
  const props = [
    { id: 'g-open', status: 'pending', reviewed_at: null },
    { id: 'g-applied-recent', status: 'applied', reviewed_at: '2026-09-29T08:00:00.000Z' },
    { id: 'g-rejected-old', status: 'rejected', reviewed_at: '2026-09-20T08:00:00.000Z' },
    { id: 'g-superseded', status: 'superseded', reviewed_at: null },
    { id: 'g-must', status: 'must_confirm', reviewed_at: null },
    // A leftover calibration proposal for the same client — not in the ledger, never shown.
    { id: 'g-calibration', status: 'pending', reviewed_at: null },
  ];
  it('open + decided in the last 24 h, in ledger order; superseded / old / unknown dropped', () => {
    expect(selectVisibleCallGeo(audit, props, since).map((a) => a.geo_proposal_id)).toEqual(['g-open', 'g-applied-recent', 'g-must']);
  });

  const prop = (id: string, status: string, placed: boolean): NonNullable<AnalyzeOutcome['proposal']> => ({
    id, version: 1, status, proposed_action: 'confirm', expression: { schema_version: 'geo-pref/v7', groups: [] },
    by_evidence: placed ? { e1: { polarity: 'include', operation: 'district_polygon', element_ids: ['d'], resolved: true, label: 'x' } } : {},
    items: [], items_by_evidence: {}, verifier: null,
  });
  it("shows a call's card only for the audit's own proposal, and an open one only with a line to save", () => {
    expect(isShowableCallGeoCard(geoOutcome({ proposal: prop('g1', 'pending', true) }), 'g1')).toBe(true);
    expect(isShowableCallGeoCard(geoOutcome({ proposal: prop('g1', 'pending', false) }), 'g1')).toBe(false);
    expect(isShowableCallGeoCard(geoOutcome({ proposal: prop('other', 'pending', true) }), 'g1')).toBe(false);
    expect(isShowableCallGeoCard(geoOutcome({ proposal: null }), 'g1')).toBe(false);
    expect(isShowableCallGeoCard(geoOutcome({ proposal: prop('g1', 'applied', true) }), 'g1')).toBe(true);
  });
});
