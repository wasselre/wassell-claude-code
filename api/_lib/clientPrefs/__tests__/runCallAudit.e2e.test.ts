import { describe, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { gatherCallConversation } from '../../geoPreference/backfillPorts.js';
import { renderConversation } from '../../geoPreference/extractor.js';
import { extractPreferences } from '../../prefExtract.js';
import { PREF_SLUG_ORDER } from '../../../../src/lib/clientPrefs/mergePrefs.js';
import { isEmptyValue } from '../../../../src/lib/salesProcess/valueEqual.js';
import { auditCall } from '../callAudit.js';
import { loadChatCard } from '../../geoPreference/chatCard.js';
import { placementSentence } from '../../geoPreference/placementText.js';
import { candidatePasses } from '../../../cron/chat-auto-read.js';

/**
 * OPERATIONAL, READ-ONLY dry run (RUN_CALLAUDIT=1): "what did customers say on a
 * call that the salesperson never logged?" For every real call (>20 s, diarized
 * transcript) in the last CALLAUDIT_DAYS days (default 60) that is linked to a
 * client, runs the preference extractor (channel 'call' — real LLM calls, ~0.3¢
 * each) and compares each suggestion with the client's CURRENT saved value:
 *   MISSED   — the client's field is empty; the call has a value → would be proposed
 *   SAME     — saved value equals the call's value
 *   DIFFERS  — saved value differs → NEVER proposed (the rep's record wins)
 * Writes NOTHING (no proposal, no client write).
 *
 * APPLY mode (RUN_CALLAUDIT=1 CALLAUDIT_APPLY=1): runs the REAL audit
 * (`auditCall`) on every call `call_audit_candidates` returns — writes
 * `client_pref_proposals` (source 'call') + `call_pref_audit` ledger rows,
 * NEVER the client. Needs migration 2026-09-29_01 applied. A call already in
 * the ledger (done / skipped) is not re-audited.
 *
 * PLACES (needs 2026-09-29_02): each candidate also gets the places pass when
 * `needs_geo` — a call whose preference audit is already done gets a GEO-ONLY
 * pass (the preference extractor is NOT re-run). Prints, per call, the places
 * outcome and every proposed line as a placement sentence, so the geo lines can
 * be inspected before deploy. Writes geo evidence / checkpoint / proposal (the
 * geography pipeline's own tables) + the ledger's geo columns, NEVER the client.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch (err) {
  // .env.local is optional — without it the suite is skipped below (no URL/KEY).
  console.error('[CALLAUDIT] .env.local not read:', (err as Error).message);
}

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAYS = Number(process.env.CALLAUDIT_DAYS ?? '60');

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

describe.skipIf(!process.env.RUN_CALLAUDIT || !!process.env.CALLAUDIT_APPLY || !URL_ || !KEY)('CALL AUDIT dry run (read-only)', () => {
  it('lists preferences said on calls but missing from the client', async () => {
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    const { data: logs, error } = await supabase
      .from('call_logs')
      .select('id, duration_seconds, hangup_time')
      .gte('created_at', since)
      .gt('duration_seconds', 20)
      .not('transcription', 'is', null);
    if (error) throw new Error(`call_logs: ${error.message}`);

    const { data: pcModel, error: mErr } = await supabase.from('models').select('id').eq('name', 'phone_calls').maybeSingle();
    if (mErr || !pcModel) throw new Error(`phone_calls model: ${mErr?.message ?? 'missing'}`);

    const tally = { calls: 0, linked: 0, missed: 0, same: 0, differs: 0, nothing: 0 };
    for (const log of (logs ?? []) as Array<{ id: string; duration_seconds: number; hangup_time: string | null }>) {
      tally.calls += 1;
      const { data: rec, error: rErr } = await supabase.from('records').select('data').eq('id', log.id).eq('model_id', pcModel.id).maybeSingle();
      if (rErr) throw new Error(`phone_calls ${log.id}: ${rErr.message}`);
      const link = (rec?.data as Record<string, unknown> | undefined)?.client_link;
      const clientId = Array.isArray(link) ? String(link[0] ?? '') : typeof link === 'string' ? link : '';
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) continue;
      tally.linked += 1;

      const conv = await gatherCallConversation(supabase, log.id);
      if (!conv) { console.log(`[CALLAUDIT] call ${log.id}: no usable transcript`); continue; }
      if (conv.speaker_labels === 'none') { console.log(`[CALLAUDIT] call ${log.id}: unlabelled speakers — the audit skips it`); continue; }

      const { data: client, error: cErr } = await supabase.from('records').select('data').eq('id', clientId).maybeSingle();
      if (cErr) throw new Error(`client ${clientId}: ${cErr.message}`);
      if (!client) { console.log(`[CALLAUDIT] call ${log.id}: client ${clientId} no longer exists — skipped`); continue; }
      const saved = client.data as Record<string, unknown>;

      const { output, model } = await extractPreferences({ channel: 'call', transcript: renderConversation(conv), entity: { kind: 'call', id: log.id } });
      const lines: string[] = [];
      for (const slug of PREF_SLUG_ORDER) {
        const s = output.suggestions[slug];
        if (!s) continue;
        const cur = saved[slug];
        const verdict = isEmptyValue(cur) ? 'MISSED' : JSON.stringify(cur) === JSON.stringify(s.value) ? 'SAME' : 'DIFFERS';
        if (verdict === 'MISSED') tally.missed += 1; else if (verdict === 'SAME') tally.same += 1; else tally.differs += 1;
        lines.push(`   ${verdict.padEnd(7)} ${slug} = ${JSON.stringify(s.value)} «${s.quote ?? ''}» (${s.confidence})${verdict === 'DIFFERS' ? `  saved: ${JSON.stringify(cur)}` : ''}`);
      }
      if (lines.length === 0) tally.nothing += 1;
      console.log(`[CALLAUDIT] call ${log.id} ${log.hangup_time ?? ''} ${log.duration_seconds}s client=${clientId} model=${model}\n${lines.join('\n') || '   (no preference said)'}`);
    }
    console.log(`[CALLAUDIT] ${JSON.stringify(tally)}`);
  }, 900_000);
});

describe.skipIf(!process.env.RUN_CALLAUDIT || !process.env.CALLAUDIT_APPLY || !URL_ || !KEY)('CALL AUDIT apply (writes proposals + ledger, never the client)', () => {
  it('audits every candidate call', async () => {
    const { data, error } = await supabase.rpc('call_audit_candidates', {
      p_now: new Date().toISOString(), p_grace: '60 minutes', p_window: `${DAYS} days`, p_limit: 500,
    });
    if (error) throw new Error(`call_audit_candidates: ${error.message}`);
    const rows = (data ?? []) as Array<{
      call_id: string; client_id: string; hangup_time: string; duration_seconds: number;
      needs_prefs?: boolean; needs_geo?: boolean;
    }>;
    const tally = {
      candidates: rows.length, geo_only: 0, done: 0, skipped: 0, failed: 0, not_claimed: 0, proposals: 0, missed_fields: 0,
      geo_done: 0, geo_skipped: 0, geo_failed: 0, geo_proposals: 0, geo_lines: 0,
    };
    for (const c of rows) {
      const passes = candidatePasses(c);
      if (!passes.needsPrefs) tally.geo_only += 1;
      const r = await auditCall(supabase, {
        callId: c.call_id, clientId: c.client_id, hangupAt: c.hangup_time,
        needsPrefs: passes.needsPrefs, needsGeo: passes.needsGeo, log: (m) => console.log(m),
      });
      if (r.reason === 'not_claimed') tally.not_claimed += 1;
      else if (r.prefsRan) {
        tally[r.status] += 1;
        if (r.proposalId) tally.proposals += 1;
        tally.missed_fields += r.missed.length;
      }

      // The places pass: its outcome, and — when it proposed places — every
      // line as the rep will read it (placement sentences).
      if (!r.geo) {
        console.log(`[CALLAUDIT/apply] call ${c.call_id} places: not due`);
        continue;
      }
      if (r.geo.status === 'done') tally.geo_done += 1;
      else if (r.geo.status === 'skipped') tally.geo_skipped += 1;
      else tally.geo_failed += 1;
      console.log(`[CALLAUDIT/apply] call ${c.call_id} client=${c.client_id} places: ${r.geo.status}${r.geo.reason ? `/${r.geo.reason}` : ''} mode=${r.geo.mode ?? '-'} proposal=${r.geo.proposalId ?? '-'}`);
      if (!r.geo.proposalId) continue;
      tally.geo_proposals += 1;
      const card = await loadChatCard(supabase, c.client_id, c.call_id);
      const p = card.proposal;
      if (!p || p.id !== r.geo.proposalId) {
        console.log(`   (the call's newest geo proposal is not the one the audit minted: ${p?.id ?? 'none'})`);
        continue;
      }
      const names = Object.fromEntries(Object.entries(card.names).map(([k, v]) => [k, { name_ar: v.name_ar, city: v.city }]));
      for (const m of card.mentions) {
        const pl = p.by_evidence[m.evidence_id];
        if (pl) {
          tally.geo_lines += 1;
          console.log(`   geo «${m.mention_span}» — ${placementSentence(pl, names)}`);
        } else {
          console.log(`   (not drawn: «${m.mention_span}» role=${m.preference_role})`);
        }
      }
    }
    console.log(`[CALLAUDIT/apply] ${JSON.stringify(tally)}`);
  }, 1_800_000);
});
