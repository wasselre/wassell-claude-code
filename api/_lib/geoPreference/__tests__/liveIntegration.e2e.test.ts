import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseBackfillDeps } from '../backfillPorts.js';
import { runBackfillBatch } from '../backfillRunner.js';
import { applyReview, geoPreferenceToLocationItems, type ReviewDeps, type ProposalRow } from '../../../geo-preference/review.js';
import type { GeoPreference } from '../ontology.js';

/**
 * LIVE integration test (guarded by RUN_LIVE=1). Two parts:
 *  A. Run the real pipeline over 6 DEV clients — extract (DeepSeek) → PERSIST
 *     evidence + checkpoints → resolve → gate → proposal. Verifies persistence,
 *     dedup, a labeling batch built from persisted evidence, and zero client writes.
 *  B. Synthetic confirmation — a throwaway sandbox client, a seeded proposal,
 *     applyReview('confirm') → the client's location_items ARE written + an audit
 *     row lands. This is the confirm→client-write path we never run on a real client.
 * Cleans up everything it creates.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch { /* env optional */ }

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN = 'live-int-' + Date.now();
const MAHDIYAH = 'e970534a-eace-0c3b-26b6-82068c51f8c7'; // real حي المهدية district id

let supabase: SupabaseClient;
beforeAll(() => {
  process.env.WA_EXTRACT_STUB = process.env.WA_EXTRACT_STUB ?? ''; // real LLM unless already stubbed
  if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } });
});

describe.skipIf(!process.env.RUN_LIVE || !URL_ || !KEY)('LIVE integration (prod)', () => {
  it('A. 6 DEV clients → evidence + checkpoints persisted, proposals, labeling batch, no client writes', async () => {
    // Pick 6 DEV proxy-positive clients with the richest transcripts.
    const picks = await supabase.rpc('geo_pref_backfill_progress', { p_run_id: '__none__' }); // warm RPC path
    expect(picks.error).toBeNull();
    const { data: devRows } = await supabase
      .from('geo_pref_gold_split').select('client_id').eq('split', 'dev').eq('frame', 'proxy_positive').limit(400);
    const candidates = (devRows ?? []).map((r) => r.client_id as string);
    // Rank by transcript length via a lightweight join.
    const ranked: Array<{ id: string; len: number }> = [];
    for (const id of candidates.slice(0, 60)) {
      const { data: calls } = await supabase
        .from('records').select('data').eq('model_id',
          (await supabase.from('models').select('id').eq('name', 'phone_calls').single()).data!.id)
        .filter('data->>client_link', 'eq', id);
      const len = (calls ?? []).reduce((a, r) => a + String((r.data as Record<string, unknown>).transcription_text ?? '').length, 0);
      if (len > 400) ranked.push({ id, len });
      if (ranked.length >= 6) break;
    }
    const clients = ranked.slice(0, 6).map((r) => r.id);
    expect(clients.length).toBeGreaterThanOrEqual(3);

    // Snapshot location_items BEFORE (to prove no client write).
    const before = new Map<string, string>();
    for (const id of clients) {
      const { data } = await supabase.from('records').select('data').eq('id', id).single();
      before.set(id, JSON.stringify((data?.data as Record<string, unknown>)?.location_items ?? null));
    }

    const deps = makeSupabaseBackfillDeps(supabase, 'live-int-worker', { log: (m) => console.log(m) });
    const enq = await supabase.rpc('geo_pref_backfill_enqueue', { p_run_id: RUN, p_client_ids: clients });
    expect(enq.error).toBeNull();
    const res = await runBackfillBatch(deps, { runId: RUN, max: clients.length });
    console.log('[LIVE-A] batch:', JSON.stringify(res));
    expect(res.processed).toBe(clients.length);
    expect(res.failed).toBe(0);

    // Evidence + checkpoints persisted (origin='model') for these clients.
    const { count: evCount } = await supabase
      .from('geo_pref_evidence').select('*', { count: 'exact', head: true })
      .in('client_id', clients).eq('origin', 'model');
    const { count: cpCount } = await supabase
      .from('geo_pref_checkpoints').select('*', { count: 'exact', head: true })
      .in('client_id', clients).eq('origin_tag', 'model');
    console.log('[LIVE-A] evidence:', evCount, 'checkpoints:', cpCount);
    expect((evCount ?? 0)).toBeGreaterThan(0);
    expect((cpCount ?? 0)).toBeGreaterThanOrEqual(clients.length); // one checkpoint per processed client

    // Build a labeling calibration batch from the persisted evidence.
    const { data: evRows } = await supabase
      .from('geo_pref_evidence').select('id, conversation_id, client_id').in('client_id', clients).eq('origin', 'model').limit(200);
    const subjects = (evRows ?? []).map((e) => ({ subject_kind: 'evidence', subject_ref: e.id, conversation_id: e.conversation_id, client_id: e.client_id }));
    const { data: batch, error: batchErr } = await supabase.from('geo_pref_calibration_batch').insert({
      label: RUN, split: 'dev', status: 'open', subjects,
      assignments: [{ annotator_id: '00000000-0000-0000-0000-0000000000a1', role: 'meaning' }],
    }).select('id').single();
    expect(batchErr).toBeNull();
    console.log('[LIVE-A] calibration batch subjects:', subjects.length);
    expect(subjects.length).toBeGreaterThan(0);

    // No client write anywhere.
    for (const id of clients) {
      const { data } = await supabase.from('records').select('data').eq('id', id).single();
      expect(JSON.stringify((data?.data as Record<string, unknown>)?.location_items ?? null)).toBe(before.get(id));
    }

    // Cleanup this run's artifacts (leave gold split + policy alone).
    await supabase.from('geo_pref_calibration_batch').delete().eq('id', batch!.id);
    await supabase.from('geo_pref_review_audit').delete().in('proposal_id',
      ((await supabase.from('geo_pref_proposals').select('id').in('client_id', clients)).data ?? []).map((p) => p.id));
    await supabase.from('geo_pref_proposals').delete().in('client_id', clients);
    await supabase.from('geo_pref_evidence').delete().in('client_id', clients).eq('origin', 'model');
    await supabase.from('geo_pref_checkpoints').delete().in('client_id', clients).eq('origin_tag', 'model');
    await supabase.from('geo_pref_backfill_jobs').delete().eq('run_id', RUN);
  }, 600000);

  it('B. synthetic confirmation → client location_items written + audit row', async () => {
    const clientsModelId = (await supabase.from('models').select('id').eq('name', 'clients').single()).data!.id as string;
    const owner = (await supabase.from('records').select('created_by_user_id').eq('model_id', clientsModelId).not('created_by_user_id', 'is', null).limit(1).maybeSingle()).data?.created_by_user_id as string | null ?? null;
    const clientId = crypto.randomUUID();

    // Create a throwaway sandbox client (unfrozen clients model → records).
    const ins = await supabase.from('records').insert({
      id: clientId, model_id: clientsModelId,
      data: { client_name: '🧪 GeoPref Test ' + Date.now(), phone_number: '966500000000' },
      created_by_user_id: owner,
    });
    expect(ins.error).toBeNull();

    // Seed a pending proposal that would add المهدية as a district include.
    const expr: GeoPreference = {
      schema_version: 'v7', groups: [{
        id: 'g1', role: 'primary', strength: 'soft', priority: 1,
        clauses: [{ op: 'include', anyOf: [{ geometry_id: 'geo:test', recipe: {
          operation: 'district_polygon', source_anchors: [], resolved_element_ids: [MAHDIYAH],
          geo_data_version: 'test', resolver_version: 'test', compiled_at: new Date().toISOString(),
        } }] }],
      }],
    };
    const seeded = await supabase.from('geo_pref_proposals').insert({
      client_id: clientId, proposed_action: 'write_soft', status: 'pending', proposed_expression: expr, gate_signals: {},
    }).select('*').single();
    expect(seeded.error).toBeNull();

    // applyReview('confirm') with real ports (the write mirrors the handler: merge onto location_items).
    const deps: ReviewDeps = {
      async getProposal(id) {
        const { data } = await supabase.from('geo_pref_proposals').select('*').eq('id', id).single();
        return (data ?? null) as ProposalRow | null;
      },
      async applyToClient(cid, items) {
        const { data: cur } = await supabase.from('records').select('data').eq('id', cid).single();
        const beforeItems = ((cur?.data as Record<string, unknown>)?.location_items as unknown[]) ?? [];
        const after = [...beforeItems, ...items];
        const { error } = await supabase.from('records').update({ data: { ...(cur!.data as object), location_items: after } }).eq('id', cid);
        if (error) throw new Error(error.message);
        return { before: beforeItems as never, after: after as never };
      },
      async updateProposal(id, patch, expectedStatus) {
        const { error } = await supabase.from('geo_pref_proposals').update(patch).eq('id', id).eq('status', expectedStatus);
        if (error) throw new Error(error.message);
      },
      async insertAudit(row) {
        const { error } = await supabase.from('geo_pref_review_audit').insert({
          proposal_id: row.proposal_id, reviewer: row.reviewer_id, action: row.action,
          before_state: { status: row.status_before, items: row.location_items_before },
          after_state: { status: row.status_after, items: row.location_items_after, applied: row.applied },
        });
        if (error) throw new Error(error.message);
      },
      now: () => new Date().toISOString(),
    };

    const outcome = await applyReview(deps, { proposalId: seeded.data!.id, action: 'confirm', reviewerId: '00000000-0000-0000-0000-0000000000ee' });
    console.log('[LIVE-B] confirm outcome:', outcome.status, 'applied=', outcome.applied);
    expect(outcome.applied).toBe(true);
    expect(outcome.status).toBe('applied');

    // The client's location_items now contain the المهدية district item.
    const { data: after } = await supabase.from('records').select('data').eq('id', clientId).single();
    const items = ((after?.data as Record<string, unknown>)?.location_items as Array<Record<string, unknown>>) ?? [];
    const expectedItems = geoPreferenceToLocationItems(expr);
    expect(items.length).toBe(expectedItems.length);
    expect(JSON.stringify(items)).toContain(MAHDIYAH);
    // An audit row landed.
    const audit = await supabase.from('geo_pref_review_audit').select('action').eq('proposal_id', seeded.data!.id);
    expect((audit.data ?? []).length).toBeGreaterThanOrEqual(1);

    // Cleanup: audit → proposal → sandbox client.
    await supabase.from('geo_pref_review_audit').delete().eq('proposal_id', seeded.data!.id);
    await supabase.from('geo_pref_proposals').delete().eq('id', seeded.data!.id);
    await supabase.from('records').delete().eq('id', clientId);
  }, 120000);
});
