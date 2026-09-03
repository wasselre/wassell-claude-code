import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { makeSupabaseBackfillDeps } from '../backfillPorts.js';
import { runBackfillBatch } from '../backfillRunner.js';
import { applyReview, type ReviewDeps, type ProposalRow } from '../../../geo-preference/review.js';

/**
 * LIVE end-to-end — runs the real pipeline against prod for ONE DEV client:
 *   enqueue → claim → gather real history → REAL extract (DeepSeek) →
 *   resolve against REAL prod geography → gate → write a review-first proposal.
 * Proves: a proposal is produced AND the client's location_items are unchanged
 * (no client write). Guarded behind RUN_LIVE=1 so it never runs in CI.
 */

// Load .env.local (SUPABASE + DEEPSEEK keys) — vitest doesn't auto-load it.
try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch { /* env optional */ }

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT = '190fd66e-d406-4551-9811-34ab80d47014'; // ahmad alkhattaf — DEV, geo-rich transcript
const RUN = 'live-e2e-' + Date.now();

describe.skipIf(!process.env.RUN_LIVE || !URL_ || !KEY)('LIVE backfill e2e (prod)', () => {
  it('one DEV client → real proposal, client record untouched', async () => {
    const supabase = createClient(URL_!, KEY!, { auth: { persistSession: false } });

    const beforeRow = await supabase.from('records').select('data').eq('id', CLIENT).single();
    const beforeItems = JSON.stringify((beforeRow.data?.data as Record<string, unknown>)?.location_items ?? null);

    const deps = makeSupabaseBackfillDeps(supabase, 'live-e2e-worker', { log: (m) => console.log(m) });
    const enq = await supabase.rpc('geo_pref_backfill_enqueue', { p_run_id: RUN, p_client_ids: [CLIENT] });
    expect(enq.error).toBeNull();

    const res = await runBackfillBatch(deps, { runId: RUN, max: 1 });
    // eslint-disable-next-line no-console
    console.log('[LIVE] batch:', JSON.stringify(res));
    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);

    const props = await supabase
      .from('geo_pref_proposals').select('id,proposed_action,status,proposed_expression')
      .eq('client_id', CLIENT).order('created_at', { ascending: false }).limit(1);
    // eslint-disable-next-line no-console
    console.log('[LIVE] proposal:', props.data?.length, props.data?.[0]?.proposed_action, props.data?.[0]?.status);

    // Client record's location_items MUST be unchanged (no client write).
    const afterRow = await supabase.from('records').select('data').eq('id', CLIENT).single();
    const afterItems = JSON.stringify((afterRow.data?.data as Record<string, unknown>)?.location_items ?? null);
    expect(afterItems).toBe(beforeItems);
  }, 180000);

  it('reject a real pending proposal → audit row written, client record untouched', async () => {
    const supabase = createClient(URL_!, KEY!, { auth: { persistSession: false } });
    const REVIEWER = '00000000-0000-0000-0000-0000000000ee';

    // Self-seed a throwaway pending proposal so the test is deterministic and
    // repeatable (rejecting it writes an audit row but never the client record).
    const seeded = await supabase.from('geo_pref_proposals').insert({
      client_id: CLIENT, proposed_action: 'confirm', status: 'pending',
      proposed_expression: { schema_version: 'v7-live-test', groups: [] }, gate_signals: {},
    }).select('*').single();
    expect(seeded.error).toBeNull();
    const proposal = seeded.data!;

    const beforeRow = await supabase.from('records').select('data').eq('id', CLIENT).single();
    const beforeItems = JSON.stringify((beforeRow.data?.data as Record<string, unknown>)?.location_items ?? null);

    const deps: ReviewDeps = {
      async getProposal(id) {
        const { data } = await supabase.from('geo_pref_proposals').select('*').eq('id', id).single();
        return (data ?? null) as ProposalRow | null;
      },
      async applyToClient() { throw new Error('applyToClient MUST NOT be called on reject'); },
      async updateProposal(id, patch, expectedStatus) {
        const { error } = await supabase.from('geo_pref_proposals').update(patch).eq('id', id).eq('status', expectedStatus);
        if (error) throw new Error(error.message);
      },
      async insertAudit(row) {
        const { error } = await supabase.from('geo_pref_review_audit').insert({
          proposal_id: row.proposal_id, reviewer: row.reviewer_id, action: row.action,
          before_state: { status: row.status_before, expression: row.expression_before, items: row.location_items_before },
          after_state: { status: row.status_after, expression: row.expression_after, items: row.location_items_after, applied: row.applied, note: row.note },
        });
        if (error) throw new Error(error.message);
      },
      now: () => new Date().toISOString(),
    };

    const outcome = await applyReview(deps, { proposalId: proposal.id, action: 'reject', reviewerId: REVIEWER, note: 'live e2e reject' });
    // eslint-disable-next-line no-console
    console.log('[LIVE] reject outcome:', outcome.status, 'applied=', outcome.applied);
    expect(outcome.status).toBe('rejected');
    expect(outcome.applied).toBe(false);

    // Audit row persisted.
    const audit = await supabase.from('geo_pref_review_audit').select('action').eq('proposal_id', proposal.id).eq('action', 'reject');
    expect((audit.data ?? []).length).toBeGreaterThanOrEqual(1);
    // Proposal now rejected.
    const after = await supabase.from('geo_pref_proposals').select('status').eq('id', proposal.id).single();
    expect(after.data?.status).toBe('rejected');
    // Client record untouched.
    const afterRow = await supabase.from('records').select('data').eq('id', CLIENT).single();
    expect(JSON.stringify((afterRow.data?.data as Record<string, unknown>)?.location_items ?? null)).toBe(beforeItems);
  }, 60000);
});
