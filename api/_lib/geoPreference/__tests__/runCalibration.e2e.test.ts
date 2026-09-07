import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeSupabaseBackfillDeps } from '../backfillPorts.js';
import { runBackfillBatch } from '../backfillRunner.js';

/**
 * OPERATIONAL calibration run (RUN_CALIB=1). NOT a cleanup test — it PERSISTS the
 * 30-ish stratified calibration conversations' extraction (evidence + checkpoints
 * + review-first proposals) and builds ONE labeling batch, so the team can begin
 * reviewing. Monitors failures, duplicate proposals, and client-write activity;
 * asserts NO client preferences changed. auto_write stays false.
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
const RUN = 'calib-001';

// The 26 stratified DEV proxy-positive calibration clients (see report for the
// per-category breakdown). Deterministic list captured from the selection query.
const CLIENTS = [
  '088b82db-3f2c-42a8-8f3b-fbc46625c3fb','1cbca1a8-a773-4aa4-a833-29384b66f4e3','1ecd790d-4b45-4975-ba31-cc766437d1ae',
  '2639ff1c-71e5-4704-a220-312ab7b979f5','44de75e5-c6d8-49c3-9568-9b9349792357','4b91d26c-b2ea-48bb-866f-b8459dec9f30',
  '4f3aa350-d57a-467a-b4e7-410200aacaff','5535106b-4603-44ed-a8ca-e4bf60267afc','5fc56ec9-e02a-4f34-81a9-e7aae21de405',
  '64323a93-eefc-4836-abe0-11d1b7c359c7','645a3db0-5d8d-4917-b735-1414f1cd0d76','665e7d3a-cefe-48f8-a35f-36a6d104849a',
  '74d81674-9577-48af-8fa0-9846658ed074','78455426-b766-41f2-81be-efe6f8789d60','7860ab0e-e447-47b2-aaac-d4b59fbb44c9',
  '78988d51-2f79-4bc3-9863-330f30f6b44f','943ebef1-066c-494f-b769-5e085fd3166f','9e1dbd23-52d1-456b-829f-0978e1c858dd',
  '9f6ad594-d141-4500-9181-c499aa2dc308','a10e7488-c237-4d0f-bed3-c3b0045c579b','a1caf0a5-7016-4a55-b11e-abdd81cfaa0e',
  'c69d996e-db60-4015-aa85-b62bc55874ab','c7d831ea-403e-44a1-881f-19f335667809','c9313d1f-bbe7-4f35-a16a-b5c7c368b6aa',
  'cd3a88c9-9666-4629-bb1a-e104e7b13390','f71a4c27-de60-4734-adf9-e2fd90af0875',
];

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

describe.skipIf(!process.env.RUN_CALIB || !URL_ || !KEY)('CALIBRATION run (persists for the team)', () => {
  it('extracts 26 calibration clients → evidence/checkpoints/proposals + labeling batch, no client writes', async () => {
    // Snapshot location_items BEFORE (client-write monitor).
    const before = new Map<string, string>();
    for (const id of CLIENTS) {
      const { data } = await supabase.from('records').select('data').eq('id', id).single();
      before.set(id, JSON.stringify((data?.data as Record<string, unknown>)?.location_items ?? null));
    }

    const deps = makeSupabaseBackfillDeps(supabase, 'calib-worker', { log: (m) => console.log(m) });
    await supabase.rpc('geo_pref_backfill_enqueue', { p_run_id: RUN, p_client_ids: CLIENTS });
    const res = await runBackfillBatch(deps, { runId: RUN, max: CLIENTS.length + 5 });
    console.log('[CALIB] batch:', JSON.stringify(res));

    // Monitor: failures.
    const prog = await supabase.rpc('geo_pref_backfill_progress', { p_run_id: RUN });
    console.log('[CALIB] progress:', JSON.stringify(prog.data));
    expect(res.processed).toBeGreaterThanOrEqual(CLIENTS.length - 2); // tolerate a rare transient

    // Counts.
    const ev = await supabase.from('geo_pref_evidence').select('id, conversation_id, client_id').in('client_id', CLIENTS).eq('origin', 'model');
    const cp = await supabase.from('geo_pref_checkpoints').select('id', { count: 'exact', head: true }).in('client_id', CLIENTS).eq('origin_tag', 'model');
    const props = await supabase.from('geo_pref_proposals').select('client_id, checkpoint_id, proposed_action, status').in('client_id', CLIENTS);
    console.log('[CALIB] evidence:', ev.data?.length, 'checkpoints:', cp.count, 'proposals:', props.data?.length);

    // Monitor: duplicate proposals — no client+checkpoint pair appears twice.
    const seen = new Set<string>();
    let dupes = 0;
    for (const p of props.data ?? []) { const k = `${p.client_id}|${p.checkpoint_id}`; if (seen.has(k)) dupes++; else seen.add(k); }
    console.log('[CALIB] duplicate proposals:', dupes);
    expect(dupes).toBe(0);

    // Build ONE labeling batch from the persisted evidence.
    const subjects = (ev.data ?? []).map((e) => ({ subject_kind: 'evidence', subject_ref: e.id, conversation_id: e.conversation_id, client_id: e.client_id }));
    const { data: batch, error: bErr } = await supabase.from('geo_pref_calibration_batch').insert({
      label: RUN, split: 'dev', status: 'open', adjudication_open: false, subjects,
      assignments: [
        { annotator_id: '00000000-0000-0000-0000-0000000000a1', role: 'meaning' },
        { annotator_id: '00000000-0000-0000-0000-0000000000a2', role: 'meaning' },
        { annotator_id: '00000000-0000-0000-0000-0000000000b1', role: 'geo_operator' },
        { annotator_id: '00000000-0000-0000-0000-0000000000c1', role: 'adjudicator' },
      ],
    }).select('id').single();
    expect(bErr).toBeNull();
    console.log('[CALIB] labeling batch:', batch?.id, 'subjects:', subjects.length);

    // Monitor: client-write activity — location_items MUST be unchanged for all 26.
    let changed = 0;
    for (const id of CLIENTS) {
      const { data } = await supabase.from('records').select('data').eq('id', id).single();
      if (JSON.stringify((data?.data as Record<string, unknown>)?.location_items ?? null) !== before.get(id)) changed++;
    }
    console.log('[CALIB] client records with changed location_items:', changed);
    expect(changed).toBe(0);
  }, 1200000);
});
