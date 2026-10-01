/**
 * Replay REAL customer chats through the sales agent (dry run — nothing is
 * sent, nothing about the real chat is read or written by the agent).
 *
 * For each chat, each customer TURN (a run of customer messages with no reply
 * of ours in between) is replayed in "shadow" mode: the agent sees the real
 * history up to that point — including what the rep actually said — and writes
 * the reply it WOULD have sent. It cannot free-run the conversation: the
 * customer's next message was written in answer to the rep, not to the agent.
 *
 * A grader (Claude Sonnet 5.5, metered as scripts/agentReplay/grader) then
 * compares the agent's reply with the rep's real reply. Prices and stock have
 * changed since many of these chats, so the grader judges whether the agent's
 * answer makes sense TODAY, not whether it matches an old price.
 *
 * Usage (from the repo root; real model spend, ~$0.03 per turn):
 *   npx tsx scripts/agent-replay/run.mts <chats.json> <out.json> [maxTurnsPerChat=6] [before=2026-09-29]
 * ONLY=12,14 replays just those chat numbers (1-based, the order of the file).
 * <chats.json> is a JSON array of chat wids — keep it OUTSIDE the repo
 * (customer phone numbers). The agent runs under a synthetic chat id
 * (dryrun-replay-N@c.us), so ledger rows are recognisable as test traffic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
// @ts-expect-error — plain .mjs helper without types
import { trackedAnthropic, loadScriptEnv } from '../lib/aiUsage.mjs';

loadScriptEnv();
const root = process.cwd();
const { getServiceSupabase } = await import(pathToFileURL(`${root}/api/_lib/supabaseServer.ts`).href);
const { runAgentTurn } = await import(pathToFileURL(`${root}/api/_lib/salesAgent/turn.ts`).href);
const { projectFacts } = await import(pathToFileURL(`${root}/api/_lib/salesAgent/catalog.ts`).href);
const svc = getServiceSupabase();

const [chatsFile, outFile, maxTurnsArg, beforeArg] = process.argv.slice(2);
if (!chatsFile || !outFile) { console.error('usage: run.mts <chats.json> <out.json> [maxTurns] [before]'); process.exit(1); }
const CHATS: string[] = JSON.parse(readFileSync(chatsFile, 'utf8'));
const MAX_TURNS = Number(maxTurnsArg ?? 6);
const BEFORE = beforeArg ?? '2026-09-29';
const CONTEXT = 20;          // prior messages the agent sees
const CONC = 4;

const grader = trackedAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), {
  area: 'sales', callSite: 'scripts/agentReplay/grader', operation: 'replay_grade', meta: { run_kind: 'operator_script' },
});

type Msg = { flow: string; kind: string; body: string | null; transcript: string | null; media_caption: string | null; date: string };
type M = { who: 'customer' | 'us'; text: string };

const SKIP = new Set(['reaction', 'sticker', 'revoked', 'e2e_notification', 'notification', 'call_log', 'ciphertext']);
function render(m: Msg): string | null {
  if (SKIP.has(m.kind)) return null;
  const t = (m.body ?? m.transcript ?? '').trim();
  if (m.kind === 'text') return t || null;
  if (m.kind === 'audio') return t ? `(رسالة صوتية) ${t}` : '[رسالة صوتية]';
  const label = m.kind === 'image' ? 'صورة' : m.kind === 'video' ? 'فيديو' : m.kind === 'document' ? 'ملف' : m.kind;
  const cap = (m.media_caption ?? '').trim();
  return cap ? `[${label}] ${cap}` : `[${label}]`;
}

async function loadChat(wid: string): Promise<M[]> {
  const out: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from('chat_messages').select('flow, kind, body, transcript, media_caption, date')
      .eq('chat_wid', wid).lt('date', BEFORE).order('date').order('id').range(from, from + 999);
    if (error) throw new Error(`messages read failed: ${error.message}`);
    for (const m of (data ?? []) as Msg[]) {
      const text = render(m);
      if (text) out.push({ who: m.flow === 'in' ? 'customer' : 'us', text });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

const GRADER = `You grade a WhatsApp sales AI for a Saudi real-estate marketer (Wassel). For ONE moment of a real past conversation you get: the recent context, the customer's message(s), what the human rep ACTUALLY replied, and what the AI would have replied (plus the actions it took: searches, projects or units it sent, questions it asked a colleague, hand-offs).

Judge the AI's reply on its own merits, then against the rep's.
- "ai_saw" is exactly what the AI's tools returned this turn (search results with each project's district, readiness, fitting units, prices, sizes, distances; unit searches; floor-plan checks), and "project_facts" is the database record of projects it sent. A claim supported by either is CORRECT even if the rep didn't mention it. A claim that matches project_facts (ready/off-plan, district, prices, sizes, down payment) is CORRECT even if the rep didn't mention it. Only a claim that contradicts project_facts, or that nothing supports, is wrong_or_invented.
- Stock and prices have changed since this chat: do NOT mark the AI wrong because its project or price differs from the rep's; mark it wrong only if it misunderstood the customer, contradicts what the customer said, answers a different question, invents something, or promises something it cannot.
- The rep can do things the AI cannot (call, negotiate, use private knowledge). An AI hand-off or «I'll check with a colleague» is RIGHT when the request needs that.
- Voice: short, Najdi colloquial, one question at most, like a real rep.

Answer ONLY with JSON:
{"understood":0-2,"correct":0-2,"helpful":0-2,"voice":0-2,
 "compare":"better"|"same"|"worse",
 "issue":"none"|"misunderstood"|"wrong_or_invented"|"should_hand_off"|"unnecessary_hand_off"|"unnecessary_question"|"missed_question"|"tone"|"other",
 "reason":"<one plain English sentence>"}`;

// Today's facts for every project the agent named in its actions, so the grader
// can check «جاهز», prices and districts instead of guessing (pilot 1: 13 of 15
// "invented" flags were true facts the grader could not see).
const factsCache = new Map<string, unknown>();
async function factsFor(tools: string[]): Promise<unknown[]> {
  const names = new Set<string>();
  for (const t of tools) {
    const m = t.match(/^(?:send|send_units|facts) (.+?)(?: ×\d+| \+\d+ answers)?$/) ?? t.match(/^find «.*?» → (.+)$/);
    if (m && !/candidates|not ours|REFUSED|FAILED/.test(m[1]!)) names.add(m[1]!.trim());
  }
  const out: unknown[] = [];
  for (const name of names) {
    if (!factsCache.has(name)) {
      const { data, error } = await svc.from('records').select('id').eq('data->>project_name', name).limit(1);
      if (error) throw new Error(`facts lookup failed: ${error.message}`);
      const id = (data ?? [])[0]?.id as string | undefined;
      factsCache.set(name, id ? await projectFacts(svc, id) : null);
    }
    const f = factsCache.get(name);
    if (f) out.push(f);
  }
  return out;
}

async function grade(ctx: M[], customer: string[], rep: string[], agent: string[], tools: string[], seen: unknown[] = []): Promise<Record<string, unknown>> {
  const project_facts = await factsFor(tools);
  const payload = {
    ai_saw: JSON.stringify(seen).slice(0, 14000),
    project_facts,
    context: ctx.slice(-14).map((m) => `${m.who === 'customer' ? 'CUSTOMER' : 'REP'}: ${m.text.slice(0, 400)}`),
    customer_now: customer,
    rep_actually_replied: rep.length ? rep.map((r) => r.slice(0, 600)) : ['(no reply before the customer wrote again)'],
    ai_would_reply: agent.length ? agent : ['(no reply)'],
    ai_actions: tools,
  };
  const res = await grader.messages.create({
    model: 'claude-sonnet-5-5', max_tokens: 1500, system: GRADER,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = res.content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : '')).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'grader returned no JSON', raw: text.slice(0, 300) };
  try { return JSON.parse(m[0]); } catch (e) { return { error: `grader JSON: ${(e as Error).message}`, raw: text.slice(0, 300) }; }
}

async function replayChat(wid: string, n: number) {
  const msgs = await loadChat(wid);
  const turns: unknown[] = [];
  let i = 0;
  while (i < msgs.length && turns.length < MAX_TURNS) {
    if (msgs[i]!.who !== 'customer') { i++; continue; }
    const start = i;
    while (i < msgs.length && msgs[i]!.who === 'customer') i++;
    const burst = msgs.slice(start, i).map((m) => m.text);
    const repStart = i;
    while (i < msgs.length && msgs[i]!.who === 'us') i++;
    const rep = msgs.slice(repStart, i).map((m) => m.text);
    const history = msgs.slice(Math.max(0, start - CONTEXT), start);
    const sim = {
      messages: [
        ...history.map((m) => ({ who: m.who, text: m.text, isNew: false })),
        ...burst.map((t) => ({ who: 'customer' as const, text: t, isNew: true })),
      ],
    };
    const t0 = Date.now();
    let agent: string[] = []; let tools: string[] = []; let seen: unknown[] = []; let err: string | null = null;
    try {
      const r = await runAgentTurn(svc, `dryrun-replay-${n}@c.us`, { dryRun: true, sim }) as { replies?: string[]; brain?: { toolTrace?: string[]; facts?: unknown[] }; skipped?: string };
      agent = r.replies ?? [];
      // No brain block = the model was unavailable and the rules agent answered.
      tools = r.brain?.toolTrace ?? (r.skipped ? [`skipped: ${r.skipped}`] : ['(rules agent fallback)']);
      seen = r.brain?.facts ?? [];
    } catch (e) { err = (e as Error).message; }
    const secs = Math.round((Date.now() - t0) / 1000);
    let g: Record<string, unknown> = {};
    try { g = err ? { error: 'agent failed' } : await grade(history, burst, rep, agent, tools, seen); } catch (e) { g = { error: `grader failed: ${(e as Error).message}` }; }
    turns.push({ context: history.slice(-6), customer: burst, rep, agent, tools, secs, error: err, grade: g, seen_size: JSON.stringify(seen).length });
  }
  return { n, turns_total: msgs.filter((m, k) => m.who === 'customer' && (k === 0 || msgs[k - 1]!.who !== 'customer')).length, turns };
}

// REGRADE=1: <chats.json> is instead a previous <out.json>; grade only the turns
// whose grade is missing (no agent re-run) and write the result to <out.json>.
if (process.env.REGRADE) {
  type Turn = { context: M[]; customer: string[]; rep: string[]; agent: string[]; tools: string[]; grade?: Record<string, unknown> };
  const prev = JSON.parse(readFileSync(chatsFile, 'utf8')) as Array<{ turns?: Turn[] }>;
  // REGRADE=all re-grades every turn (e.g. after the grader learned something).
  const todo = prev.flatMap((c) => c.turns ?? []).filter((t) => process.env.REGRADE === 'all' || !t.grade?.compare);
  let k = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (k < todo.length) {
      const t = todo[k++]!;
      try { t.grade = await grade(t.context, t.customer, t.rep, t.agent, t.tools); } catch (e) { t.grade = { error: `grader failed: ${(e as Error).message}` }; }
    }
  }));
  writeFileSync(outFile, JSON.stringify(prev, null, 1), 'utf8');
  console.log(`regraded ${todo.length}; still missing ${todo.filter((t) => !t.grade?.compare).length}`);
  process.exit(0);
}

// ONLY=12,14 re-runs just those chat numbers (e.g. after a provider outage).
const only = new Set((process.env.ONLY ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0));
const queue = CHATS.map((_, k) => k).filter((k) => !only.size || only.has(k + 1));
const results: unknown[] = [];
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < queue.length) {
    const k = queue[next++]!;
    try {
      results.push(await replayChat(CHATS[k]!, k + 1));
    } catch (e) {
      console.error(`chat ${k + 1} failed:`, (e as Error).message);
      results.push({ n: k + 1, error: (e as Error).message, turns: [] });
    }
    writeFileSync(outFile, JSON.stringify(results, null, 1), 'utf8');
    console.log(`chat ${k + 1} done`);
  }
}));
console.log('ALL DONE');
