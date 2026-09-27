import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { analyzeChatConversation, loadChatCard, type ChatCard } from '../chatCard.js';
import { placementSentence } from '../placementText.js';

/**
 * OPERATIONAL chat-card run (RUN_CHATCARD=1 CHATCARD_CLIENT=<uuid> CHATCARD_WID=<wid>).
 * Runs the rep path for ONE real WhatsApp chat: analyzeChatConversation (one
 * extraction + one verifier call when the chat was never read) → loadChatCard,
 * and prints the card as a rep would read it. Then calls analyze again at once
 * to prove the cool-down (no second LLM run). NEVER writes a client record and
 * never sends a message — it writes only evidence / checkpoint / proposal /
 * verifier, exactly like the backfill. Pick a chat that is NOT a subject of a
 * calibration batch.
 */

try {
  const env = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch (err) {
  // .env.local is optional — without it the suite is skipped below (no URL/KEY).
  console.error('[CHATCARD] .env.local not read:', (err as Error).message);
}

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT = process.env.CHATCARD_CLIENT?.trim() || '';
const WID = process.env.CHATCARD_WID?.trim() || '';

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

function printCard(label: string, card: ChatCard & { mode?: string }): void {
  const lines: string[] = [`[CHATCARD] ── ${label} ──`];
  lines.push(`status=${card.status} mode=${card.mode ?? '-'} analyzed_at=${card.analyzed_at} stale=${card.stale} graded=${card.graded} can_reanalyze=${card.can_reanalyze}`);
  const p = card.proposal;
  if (p) {
    lines.push(`proposal=${p.id} v${p.version} action=${p.proposed_action} items=${p.items.length} verifier=${p.verifier ? `${p.verifier.status}/${p.verifier.overall}` : 'none'}`);
    const names = Object.fromEntries(Object.entries(card.names).map(([k, v]) => [k, { name_ar: v.name_ar, city: v.city }]));
    const doubt = new Map((p.verifier?.mentions ?? []).map((m) => [m.evidence_id, m]));
    for (const polarity of ['include', 'exclude'] as const) {
      lines.push(polarity === 'include' ? 'يريد:' : 'لا يريد:');
      for (const m of card.mentions) {
        const pl = p.by_evidence[m.evidence_id];
        if (!pl || pl.polarity !== polarity) continue;
        const v = doubt.get(m.evidence_id);
        lines.push(`  [${pl.resolved ? 'x' : ' '}] «${m.mention_span}» — ${placementSentence(pl, names)}${v && v.verdict !== 'right' ? `   ⚠ ${v.verdict}: ${v.reason}` : ''}`);
      }
    }
    const off = card.mentions.filter((m) => !p.by_evidence[m.evidence_id]);
    if (off.length) lines.push(`not on the map: ${off.map((m) => `«${m.mention_span}» (${m.preference_role})`).join('، ')}`);
    if (p.verifier?.missed.length) lines.push(`قد يكون العميل ذكر أيضًا: ${p.verifier.missed.map((m) => `«${m.span}»`).join('، ')}`);
  } else {
    lines.push(`no proposal; mentions=${card.mentions.length}`);
  }
  console.log(lines.join('\n'));
}

describe.skipIf(!process.env.RUN_CHATCARD || !URL_ || !KEY || !CLIENT || !WID)('CHAT CARD on one real chat', () => {
  it('analyzes the chat, loads the card, and honours the cool-down', async () => {
    const before = await loadChatCard(supabase, CLIENT, WID);
    printCard('before', before);

    const t0 = Date.now();
    const analyzed = await analyzeChatConversation(supabase, CLIENT, WID, { workerId: 'chatcard-e2e', log: (m) => console.log(m) });
    console.log(`[CHATCARD] analyze took ${Date.now() - t0} ms`);
    printCard('after analyze', analyzed);
    expect(analyzed.status).not.toBe('none');
    expect(['extract', 're_review', 'skipped_recent']).toContain(analyzed.mode);

    const loaded = await loadChatCard(supabase, CLIENT, WID);
    printCard('loadChatCard', loaded);
    expect(loaded.status).toBe(analyzed.status);
    expect(loaded.proposal?.id ?? null).toBe(analyzed.proposal?.id ?? null);

    // Cool-down: an immediate second click must not run the pipeline again.
    const again = await analyzeChatConversation(supabase, CLIENT, WID, { workerId: 'chatcard-e2e' });
    console.log(`[CHATCARD] immediate re-analyze → mode=${again.mode}`);
    expect(again.mode).toBe('skipped_recent');
    expect(again.proposal?.id ?? null).toBe(loaded.proposal?.id ?? null);
  }, 600000);
});
