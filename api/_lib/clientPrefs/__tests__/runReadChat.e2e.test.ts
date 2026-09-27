import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readChatForClient } from '../readChat.js';
import { readReadState } from '../readState.js';
import { selectDueChats, type ReadCandidate } from '../dueSelection.js';
import { loadChatCard } from '../../geoPreference/chatCard.js';
import { loadPrefsCard } from '../card.js';
import { placementSentence } from '../../geoPreference/placementText.js';

/**
 * OPERATIONAL chat auto-read run (RUN_READCHAT=1 CHATCARD_CLIENT=<uuid> CHATCARD_WID=<wid>).
 * Prints the cron's current candidate selection, runs ONE manual read of the
 * given chat (the geography agent + the preference agent — real LLM calls),
 * prints the geography lines and the preference suggestions, asserts the read
 * state advanced, then proves a second 'cron' read finds nothing new. NEVER
 * writes a client record and never sends a message — it writes proposals and
 * chat_read_state only. Pick a chat that is NOT a subject of a calibration batch.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch (err) {
  // .env.local is optional — without it the suite is skipped below (no URL/KEY).
  console.error('[READCHAT] .env.local not read:', (err as Error).message);
}

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT = process.env.CHATCARD_CLIENT?.trim() || '';
const WID = process.env.CHATCARD_WID?.trim() || '';

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

describe.skipIf(!process.env.RUN_READCHAT || !URL_ || !KEY || !CLIENT || !WID)('CHAT AUTO-READ on one real chat', () => {
  it('selects, reads, advances the watermarks, and then finds nothing new', async () => {
    const now = new Date();
    const { data, error } = await supabase.rpc('chat_read_candidates', { p_now: now.toISOString(), p_window: '7 days', p_limit: 50 });
    expect(error).toBeNull();
    const sel = selectDueChats((data ?? []) as ReadCandidate[], now);
    console.log(`[READCHAT] candidates=${(data ?? []).length} due=${sel.due.length} gated=${sel.gated.length} waiting=${sel.waiting.length} leased=${sel.leased.length} backoff=${sel.backoff.length}`);
    for (const c of sel.due) console.log(`  due  ${c.chat_wid} client=${c.client_id} unread=${c.unread_count}`);

    const before = await readReadState(supabase, WID, CLIENT);
    const t0 = Date.now();
    const read = await readChatForClient(supabase, {
      clientId: CLIENT, chatWid: WID, trigger: 'manual', owner: `e2e:${now.getTime()}`, log: (m) => console.log(m),
    });
    console.log(`[READCHAT] manual read took ${Date.now() - t0} ms →`, JSON.stringify(read));
    expect(['read', 'partial']).toContain(read.outcome);

    const card = await loadChatCard(supabase, CLIENT, WID);
    const prefs = await loadPrefsCard(supabase, CLIENT, WID);
    const p = card.proposal;
    if (p) {
      const names = Object.fromEntries(Object.entries(card.names).map(([k, v]) => [k, { name_ar: v.name_ar, city: v.city }]));
      for (const m of card.mentions) {
        const pl = p.by_evidence[m.evidence_id];
        if (pl) console.log(`  geo «${m.mention_span}» — ${placementSentence(pl, names)}`);
      }
    }
    for (const [slug, s] of Object.entries(prefs.proposal?.suggestions ?? {})) {
      console.log(`  pref ${slug} = ${JSON.stringify(s.value)} «${s.quote ?? ''}» (${s.confidence})   saved: ${JSON.stringify(prefs.current_values[slug] ?? null)}`);
    }

    const after = await readReadState(supabase, WID, CLIENT);
    expect(after?.last_read_at).toBeTruthy();
    expect(after?.lease_owner).toBeNull();
    if (read.watermark) {
      if (read.prefs.ran && !read.prefs.error) expect(after?.pref_read_through).toBeTruthy();
      expect(Date.parse(after?.last_read_at ?? '')).toBeGreaterThan(Date.parse(before?.last_read_at ?? '1970-01-01'));
    }

    if (read.outcome === 'read') {
      const again = await readChatForClient(supabase, {
        clientId: CLIENT, chatWid: WID, trigger: 'cron', owner: `e2e2:${now.getTime()}`, log: (m) => console.log(m),
      });
      console.log('[READCHAT] second (cron) read →', JSON.stringify(again));
      expect(again.outcome).toBe('nothing_new');
    }
  }, 300_000);
});
