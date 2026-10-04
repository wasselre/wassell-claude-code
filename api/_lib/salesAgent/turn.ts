/**
 * One turn of the WhatsApp sales agent (Phase 2, 2026-09-29).
 *
 *   load state + the chat's recent messages
 *     → UNDERSTAND the customer's new messages (understand.ts, LLM)
 *     → DECIDE the next step (decide.ts, pure)
 *     → ask the next question | SEARCH + send the best project (search.ts)
 *       | hand off to a rep (notified) | close
 *     → persist the state.
 *
 * Runs on a worker-claimed job via /api/whatsapp/agent-turn — never inside the
 * webhook. Sends are FORCED past the per-chat gate (operator choice: the agent
 * keeps going even after a rep replies); the global kill switch is checked here.
 * `dryRun` + `sim` run the real LLM + Finder but send and persist nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueAiReply } from '../aiSend.js';
import { sendProjectViaAiFlow } from '../aiSendProject.js';
import { uuidV5FromWidSync } from '../chatIngest.js';
import { decideNext, mergeSlots, type NextStep, type Slots, type Understanding } from './decide.js';
import { understandTurn, type ChatTurn } from './understand.js';
import { findBestProject, type ProjectPick } from './search.js';
import { agentText, type Gender, type Lang } from './texts.js';
import { loadAgentSettings, type AgentConversation } from './conversation.js';
import { BrainError, runBrain, type BrainOutcome } from './brain.js';
import type { Zone } from './texts.js';
import { clip } from './clip.js';
import { createTrackedLink, loadAvailableUnits, summarizeUnit } from '../trackedLinks.js';
import { alertRep, askRep, bookVisit, loadChatContext, recordVisit } from './escalation.js';
import { readLocation, matchSavedPlaces } from './geoGate.js';
import { loadSavedProfile, type SavedProfile } from './savedProfile.js';
import { draftOfficerQuestion } from '../officerNoticeDraft.js';

/** Photos in a project package go out 4 s apart; the follow-up question must
 *  land after the last one (mirrors aiSendProject's SPACING_MS). */
const MEDIA_SPACING_S = 4;
/** A handoff line is not repeated within this window (the rep is still told). */
const REPEAT_WINDOW_MS = 30 * 60_000;
/** A new conversation answers messages from this long before it started (the
 *  message that started it arrives seconds earlier; 5 min pulled in unrelated ones). */
const START_WINDOW_MS = 90_000;
/** The area the customer describes is read from this many of the latest turns. */
const AREA_TURNS = 8;

const SYSTEM_KINDS = ['reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'ciphertext', 'revoked'];

export interface SimInput {
  messages: Array<{ who: 'customer' | 'us'; text: string; isNew?: boolean }>;
  conversation?: Partial<AgentConversation>;
}

export interface TurnResult {
  skipped?: string;
  step?: NextStep;
  understanding?: Understanding;
  slots?: Slots;
  replies?: string[];
  project?: ProjectPick | null;
  notify?: string | null;
  status?: AgentConversation['status'];
  sent?: boolean;
  model?: string;
  /** Brain (v2) turns: what it did. */
  brain?: Pick<BrainOutcome, 'toolTrace' | 'guardProblems' | 'replyFailed' | 'searches'> & {
    project?: string | null; handoff?: string | null;
    /** Ids of what was sent — for the dry-run accuracy tests. */
    projectId?: string | null; units?: { projectId: string; name: string; unitIds: string[] } | null;
    /** Dry run only: the tool results the reply was written from (for graders). */
    facts?: unknown[];
  };
}

async function loadRecentTurns(
  svc: SupabaseClient, chatWid: string, sinceIso: string,
): Promise<{ turns: ChatTurn[]; newestCustomerAt: string | null; deviceId: string | null; newCustomerText: string; lastOursAt: string | null }> {
  const { data, error } = await svc
    .from('chat_messages')
    .select('flow, kind, body, transcript, media_caption, date, device_id')
    .eq('chat_wid', chatWid)
    .not('kind', 'in', `(${SYSTEM_KINDS.join(',')})`)
    .order('date', { ascending: false })
    .limit(20);
  if (error) throw new Error(`sales agent: messages read failed: ${error.message}`);
  const rows = ((data ?? []) as Array<{
    flow: string; kind: string; body: string | null; transcript: string | null; media_caption: string | null; date: string; device_id: string | null;
  }>).reverse();
  let newestCustomerAt: string | null = null;
  let deviceId: string | null = null;
  let lastOursAt: string | null = null;
  const newText: string[] = [];
  const turns: ChatTurn[] = rows.map((r) => {
    // A voice note counts as the customer's words once transcribed.
    const text = (r.body ?? r.transcript ?? r.media_caption ?? '').trim() || `[${r.kind}]`;
    const isNew = r.flow === 'in' && r.date > sinceIso;
    if (r.flow === 'in') {
      deviceId = r.device_id ?? deviceId;
      if (isNew) { newestCustomerAt = r.date; newText.push(text); }
    } else if (!isNew) {
      lastOursAt = r.date;
    }
    return { who: r.flow === 'in' ? 'customer' : 'us', text, isNew, at: r.date };
  });

  // Our own replies still in the send queue are part of the conversation too.
  // A reply waits behind the project's media (10–15 s), so the next turn used
  // to start before it reached chat_messages, not see it, and answer the same
  // thing again in other words (2026-10-04: two «أكنان 25…» lines 2 s apart).
  const { data: queued, error: qErr } = await svc
    .from('scheduled_whatsapp_jobs')
    .select('body, status, created_at')
    .eq('chat_wid', chatWid)
    .like('reference', 'ai%')
    .in('status', ['queued', 'running', 'sent'])
    .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
    .order('created_at', { ascending: true });
  if (qErr) throw new Error(`sales agent: queued replies read failed: ${qErr.message}`);
  const seen = new Set(turns.filter((t) => t.who === 'us').map((t) => t.text.trim()));
  let added = false;
  for (const q of (queued ?? []) as Array<{ body: string | null; created_at: string }>) {
    const body = (q.body ?? '').trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    turns.push({ who: 'us', text: body, isNew: false, at: q.created_at });
    added = true;
  }
  if (added) turns.sort((x, y) => (x.at ?? '').localeCompare(y.at ?? ''));
  return { turns, newestCustomerAt, deviceId, newCustomerText: newText.join(' '), lastOursAt };
}

async function notifyRep(svc: SupabaseClient, chatWid: string, body: string): Promise<void> {
  try {
    const ctx = await loadChatContext(svc, chatWid);
    await alertRep(svc, ctx, {
      title: 'المساعد الآلي يحتاج مندوب', body, kind: 'handoff', dedupe: `agent-h:${chatWid}:${Date.now()}`,
    });
  } catch (err) {
    console.error('[salesAgent] rep notification failed:', err instanceof Error ? err.message : String(err));
  }
}

interface PendingAnswer { id: string; question: string; answer: string }

/** Rep answers waiting to be passed on, and questions still with a rep. */
async function loadQuestions(svc: SupabaseClient, chatWid: string): Promise<{ pending: PendingAnswer[]; open: string[] }> {
  const { data, error } = await svc.from('wa_agent_questions')
    .select('id, question, answer, status, relayed_at').eq('chat_wid', chatWid)
    .in('status', ['open', 'answered']).order('created_at', { ascending: true }).limit(20);
  if (error) { console.error('[salesAgent] questions read failed:', error.message); return { pending: [], open: [] }; }
  const rows = (data ?? []) as Array<{ id: string; question: string; answer: string | null; status: string; relayed_at: string | null }>;
  return {
    pending: rows.filter((r) => r.status === 'answered' && !r.relayed_at && r.answer).map((r) => ({ id: r.id, question: r.question, answer: r.answer as string })),
    open: rows.filter((r) => r.status === 'open').map((r) => r.question),
  };
}

function slotsSummary(s: Slots): string {
  const zoneAr: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب', center: 'وسط' };
  return [
    s.zone ? `${zoneAr[s.zone] ?? s.zone} الرياض` : null,
    s.unit_types?.length ? s.unit_types.join('/') : null,
    s.bedrooms_min ? `${s.bedrooms_min} غرف` : null,
    // Numbers the way reps say them: «2 مليون», «1.5 مليون», «800 ألف».
    s.budget_max
      ? `حد ${s.budget_max >= 1_000_000 ? `${+(s.budget_max / 1_000_000).toFixed(2)} مليون` : `${Math.round(s.budget_max / 1000)} ألف`}`
      : null,
  ].filter(Boolean).join('، ') || 'بدون تفاصيل';
}

export async function runAgentTurn(
  svc: SupabaseClient,
  chatWid: string,
  opts: { dryRun?: boolean; sim?: SimInput } = {},
): Promise<TurnResult> {
  const sim = opts.sim;
  const dryRun = opts.dryRun === true || !!sim;

  const settings = await loadAgentSettings(svc);
  if (!sim) {
    if (!settings?.is_enabled) return { skipped: 'disabled' };
    if (settings.agent_mode === 'off') return { skipped: 'agent_off' };
  }

  // ── State ──────────────────────────────────────────────────────────────
  let conv: AgentConversation | null;
  if (sim) {
    conv = {
      chat_wid: chatWid, status: 'active', source: 'test', ad_project_id: null, slots: { city: 'الرياض' },
      asked: null, sent_project_ids: [], turns: 0, last_turn_at: null, created_at: new Date(0).toISOString(),
      ...(sim.conversation ?? {}),
    } as AgentConversation;
  } else {
    const { data, error } = await svc.from('wa_agent_conversations').select('*').eq('chat_wid', chatWid).maybeSingle();
    if (error) throw new Error(`sales agent: conversation read failed: ${error.message}`);
    conv = (data as AgentConversation | null) ?? null;
  }
  if (!conv || conv.status !== 'active') return { skipped: 'no_active_conversation' };

  // A rep pressed «إيقاف المساعد» in this chat — the agent stays silent, even
  // for a turn queued a moment before the press.
  if (!sim) {
    const { data: chatRow, error: pErr } = await svc.from('records').select('data->ai_paused').eq('id', uuidV5FromWidSync(chatWid)).maybeSingle();
    if (pErr) throw new Error(`sales agent: chat read failed: ${pErr.message}`);
    if ((chatRow as { ai_paused?: unknown } | null)?.ai_paused === true) return { skipped: 'paused_by_rep' };
  }

  const maxTurns = settings?.agent_max_turns ?? 20;
  const lang0: Lang = conv.slots.lang ?? 'ar';

  // Reply cap per conversation: hand to a rep rather than talk forever.
  if (conv.turns >= maxTurns) {
    const replies = [agentText.holding(lang0)];
    const notify = 'وصلت محادثة المساعد الآلي الحد الأعلى للردود — تحتاج متابعة مندوب.';
    if (!dryRun) {
      await enqueueAiReply(svc, { chatWid, text: replies[0]!, jobId: 'agent', force: true });
      await notifyRep(svc, chatWid, notify);
      // Stop the agent in this chat the same way a rep would: the chat shows as
      // stopped and a rep presses «تشغيل المساعد» to hand it back.
      const { error: capErr } = await svc.rpc('whatsapp_ai_set_chat_paused', {
        p_chat_record_id: uuidV5FromWidSync(chatWid), p_paused: true, p_user_id: null, p_reason: 'turn_cap',
      });
      if (capErr) {
        console.error(`[salesAgent] turn-cap pause failed chat=${chatWid}:`, capErr.message);
        await svc.from('wa_agent_conversations').update({ status: 'handed_off', updated_at: new Date().toISOString() }).eq('chat_wid', chatWid);
      }
    }
    return { skipped: 'turn_cap', replies, notify, status: 'handed_off' };
  }

  // ── What did the customer say since our last turn? ─────────────────────
  // First turn: include the message that started the conversation.
  const sinceIso = conv.last_turn_at ?? new Date(new Date(conv.created_at).getTime() - START_WINDOW_MS).toISOString();
  let turns: ChatTurn[]; let newestCustomerAt: string | null; let deviceId: string | null; let newCustomerText: string;
  let lastOursAt: string | null = null;
  if (sim) {
    turns = sim.messages.map((m) => ({ who: m.who, text: m.text, isNew: m.isNew ?? m.who === 'customer' }));
    newestCustomerAt = new Date().toISOString();
    deviceId = null;
    newCustomerText = turns.filter((t) => t.isNew && t.who === 'customer').map((t) => t.text).join(' ');
  } else {
    ({ turns, newestCustomerAt, deviceId, newCustomerText, lastOursAt } = await loadRecentTurns(svc, chatWid, sinceIso));
  }
  const questions = sim ? { pending: [], open: [] } : await loadQuestions(svc, chatWid);
  const hasNew = turns.some((t) => t.isNew && t.who === 'customer');
  if (!hasNew && !questions.pending.length) return { skipped: 'nothing_new' };

  // ── Brain (v2): writes its own reply, narrows, answers from facts ─────────
  // v1 below is the fallback: it runs only when the brain failed BEFORE any side
  // effect (nothing sent, watermark not committed), so it can never double-send.
  if ((settings?.agent_brain ?? 'llm') === 'llm') {
    try {
      return await runBrainTurn(svc, {
        chatWid, conv, turns, newestCustomerAt, deviceId, newCustomerText, lastOursAt, dryRun,
        model: settings?.agent_model || 'claude-opus-5-5',
        effort: settings?.agent_effort ?? 'low',
        pending: questions.pending, openQuestions: questions.open, hasNew,
      });
    } catch (err) {
      if (!(err instanceof BrainError) || err.sideEffects) throw err;
      console.error(`[salesAgent] brain failed — falling back to the rules agent chat=${chatWid}: ${err.message}`);
    }
  }

  // Nothing new from the customer, only a colleague's answer to pass on, and the
  // brain is unavailable: send the rep's own words rather than lose the answer.
  if (!hasNew) {
    if (dryRun) return { skipped: 'nothing_new' };
    for (const p of questions.pending) {
      const res = await enqueueAiReply(svc, { chatWid, text: p.answer, deviceId, jobId: 'agent', force: true });
      if (!res.queued) { console.error(`[salesAgent] answer relay failed chat=${chatWid}: ${res.error ?? res.reason ?? 'unknown'}`); continue; }
      await svc.from('wa_agent_questions').update({ relayed_at: new Date().toISOString() }).eq('id', p.id);
    }
    return { skipped: 'relayed_verbatim' };
  }

  // ── Understand → decide ────────────────────────────────────────────────
  const { u, model } = await understandTurn(turns, conv.slots, conv.asked, { chatWid });
  const { slots, changed } = mergeSlots(conv.slots, u);
  const sentCount = conv.sent_project_ids.length;
  const step = decideNext(slots, u, { sentCount, slotsChanged: changed });
  const lang: Lang = slots.lang ?? 'ar';
  const g: Gender = slots.gender ?? 'm';

  const replies: string[] = [];
  let project: ProjectPick | null = null;
  let notify: string | null = null;
  let status: AgentConversation['status'] = 'active';
  let asked: string | null = conv.asked;
  const quote = clip(newCustomerText, 200);

  switch (step.kind) {
    case 'ask': {
      if (step.slot === 'zone') replies.push(agentText.askZone(lang, g));
      else if (step.slot === 'unit_type') {
        // The very first question of a region lead acknowledges the region.
        replies.push(conv.asked == null && slots.zone ? agentText.askUnitTypeWithIntro(lang, g, slots.zone) : agentText.askUnitType(lang, g));
      } else if (step.slot === 'bedrooms') replies.push(agentText.askBedrooms(lang, g));
      else replies.push(agentText.askBudget(lang));
      asked = step.slot;
      break;
    }
    case 'search': {
      const exclude = [...conv.sent_project_ids, ...(conv.ad_project_id ? [conv.ad_project_id] : [])];
      project = await findBestProject(svc, slots, exclude);
      if (project) {
        const missingType = project.relaxed === 'unit_type' && slots.unit_types?.length === 1 ? slots.unit_types[0] : null;
        // A changed ask (new region / type / bedrooms) starts a new search, so its
        // first result is not «خيار ثاني» (live test: east after north).
        replies.push(agentText.afterProject(
          lang, slots.zone ?? null, project.outsideZone, sentCount === 0 || changed,
          missingType, project.relaxed === null && !project.outsideZone,
        ));
        asked = 'more';
      } else {
        replies.push(sentCount ? agentText.noMoreResults(lang) : agentText.noResults(lang));
        notify = `المساعد الآلي ما لقى مشروعاً ${sentCount ? 'إضافياً ' : ''}يطابق طلب العميل (${slotsSummary(slots)}) — يحتاج بحث مندوب.`;
        asked = null;
      }
      break;
    }
    case 'handoff': {
      replies.push(step.reason === 'interested' ? agentText.interested(lang) : agentText.holding(lang));
      const proj = slots.last_project_name ? ` «${slots.last_project_name}»` : '';
      notify = step.reason === 'interested'
        ? `العميل مهتم بمشروع${proj} ويبي زيارة — رتّب له موعد. (${slotsSummary(slots)})`
        : step.reason === 'question'
          ? `العميل سأل عن المشروع${proj} ويحتاج رد مندوب: «${quote}»`
          : step.reason === 'human'
            ? `العميل طلب التواصل مع مندوب: «${quote}»`
            : `رسالة من العميل تحتاج متابعة مندوب: «${quote}»`;
      asked = null;
      break;
    }
    case 'stop': {
      replies.push(agentText.close(lang));
      status = 'done';
      asked = null;
      break;
    }
  }

  if (project) slots.last_project_name = project.projectName;

  // Never say the same handoff line twice in a row. Two customer messages 16 s
  // apart became two turns that each replied «بيتواصل معك زميلي…» (live test
  // 2026-09-29). The rep is still notified of the new message.
  const now = Date.now();
  if (step.kind === 'handoff' && replies.length === 1 && replies[0] === slots.last_reply
      && slots.last_reply_at && now - new Date(slots.last_reply_at).getTime() < REPEAT_WINDOW_MS) {
    replies.length = 0;
  }
  if (replies.length) {
    slots.last_reply = replies[replies.length - 1];
    slots.last_reply_at = new Date(now).toISOString();
  }
  const result: TurnResult = { step, understanding: u, slots, replies, project, notify, status, model };
  if (dryRun) return { ...result, sent: false };

  // ── Persist FIRST ───────────────────────────────────────────────────────
  // Saving the watermark before sending makes a turn AT-MOST-ONCE to the
  // customer: if anything below throws, the job's retry finds "nothing new"
  // instead of sending the same messages twice. A failed send is surfaced to a
  // rep (notification + log) rather than retried. The watermark is the newest
  // customer message we answered, so a message that arrived mid-turn is answered
  // by the next turn.
  const { error: upErr } = await svc.from('wa_agent_conversations').update({
    slots, asked, status,
    turns: conv.turns + 1,
    last_turn_at: newestCustomerAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('chat_wid', chatWid);
  if (upErr) throw new Error(`sales agent: state save failed: ${upErr.message}`);

  // ── Send ───────────────────────────────────────────────────────────────
  let followUpDelay = 0;
  let afterPrefix: string | null = null;
  if (project) {
    const flow = await sendProjectViaAiFlow(svc, {
      chatWid, projectId: project.projectId, deviceId, jobId: 'agent',
      onlyOurProjects: true, allowAi: false, force: true, lang,
    });
    if (flow.queued) {
      followUpDelay = ((flow.media_queued ?? 0) + 1) * MEDIA_SPACING_S + MEDIA_SPACING_S;
      // The delay is only a floor: a video can take minutes. The queue holds the
      // follow-up until every job of THIS package (aiSendProject's
      // `ai-project:<jobId>:<projectId>:<i>` references) has finished.
      afterPrefix = `ai-project:agent:${project.projectId}:`;
      const { error: sErr } = await svc.from('wa_agent_conversations')
        .update({ sent_project_ids: [...conv.sent_project_ids, project.projectId] }).eq('chat_wid', chatWid);
      if (sErr) console.error(`[salesAgent] sent-list save failed chat=${chatWid}:`, sErr.message);
    } else {
      // The package didn't go — don't ask «ناسبك؟» about nothing; a rep takes it.
      console.error(`[salesAgent] project send failed chat=${chatWid} project=${project.projectId}: ${flow.error ?? flow.reason ?? 'unknown'}`);
      replies.splice(0, replies.length, agentText.holding(lang));
      notify = `المساعد الآلي اختار «${project.projectName}» للعميل لكن تعذّر إرساله (${flow.error ?? flow.reason ?? ''}) — يحتاج مندوب.`;
      await svc.from('wa_agent_conversations').update({ asked: null }).eq('chat_wid', chatWid);
    }
  }
  let allSent = true;
  for (const text of replies) {
    const res = await enqueueAiReply(svc, {
      chatWid, text, deviceId, jobId: 'agent', force: true, delaySeconds: followUpDelay, afterPrefix,
    });
    if (!res.queued) {
      allSent = false;
      console.error(`[salesAgent] reply enqueue failed chat=${chatWid}: ${res.error ?? res.reason ?? 'unknown'}`);
      notify = `${notify ? `${notify} — ` : ''}تعذّر إرسال رد المساعد الآلي للعميل — يحتاج مندوب.`;
    }
  }
  if (notify) await notifyRep(svc, chatWid, notify);

  return { ...result, notify, sent: allSent };
}

// ── Brain (v2) turn ───────────────────────────────────────────────────────────

const ZONE_AR: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب', center: 'وسط' };

async function projectNames(svc: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data, error } = await svc.from('records').select('id, data').in('id', ids);
  if (error) { console.error('[salesAgent] project name lookup failed:', error.message); return out; }
  for (const r of (data ?? []) as Array<{ id: string; data: Record<string, unknown> | null }>) {
    const n = r.data?.project_name;
    if (typeof n === 'string' && n.trim()) out.set(r.id, n.trim());
  }
  return out;
}

function riyadhNow(): string {
  const now = new Date();
  // Weekday + DATE + time: the agent turns «بكرة» / «الخميس» into a real day.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
  const rest = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `${rest}, date ${day}`;
}

async function runBrainTurn(
  svc: SupabaseClient,
  a: {
    chatWid: string; conv: AgentConversation; turns: ChatTurn[]; newestCustomerAt: string | null;
    deviceId: string | null; newCustomerText: string; lastOursAt: string | null; dryRun: boolean;
    model: string; effort: 'low' | 'medium' | 'high';
    pending: PendingAnswer[]; openQuestions: string[]; hasNew: boolean;
  },
): Promise<TurnResult> {
  const { chatWid, conv, dryRun } = a;
  const slots: Slots = { ...conv.slots };
  // The language of the customer's LATEST message (a burst may mix; live test:
  // an English opener was answered in Arabic because an older Arabic line counted).
  const latest = [...a.turns].reverse().find((t) => t.who === 'customer' && t.isNew)?.text ?? a.newCustomerText;
  const lang: Lang = /[؀-ۿ]/.test(latest) ? 'ar' : /[A-Za-z]{2,}/.test(latest) ? 'en' : (slots.lang ?? 'ar');
  slots.lang = lang;

  // The lead passed on the ad's project when they asked for OTHER projects.
  const exclude = conv.source === 'ad_other_projects' && conv.ad_project_id ? [conv.ad_project_id] : [];
  const knownIds = [...new Set([...conv.sent_project_ids, ...(conv.ad_project_id ? [conv.ad_project_id] : [])])];
  const names = await projectNames(svc, knownIds);
  const nameOf = (id: string) => names.get(id) ?? id;

  const stateLines: string[] = [`Now in Riyadh: ${riyadhNow()}.`];
  if (conv.source === 'ad_other_projects' && conv.ad_project_id) {
    stateLines.push(`Came from an ad for «${nameOf(conv.ad_project_id)}» and asked for OTHER projects — never offer «${nameOf(conv.ad_project_id)}».`);
  } else if (conv.ad_project_id) {
    stateLines.push(`Came from an ad for «${nameOf(conv.ad_project_id)}» (project_id ${conv.ad_project_id}).`);
  } else {
    stateLines.push('Wrote to us directly.');
  }
  if (conv.sent_project_ids.length) {
    stateLines.push(`Already sent to them: ${conv.sent_project_ids.map((id) => `«${nameOf(id)}» (project_id ${id})`).join('، ')}.`);
  }
  const wants = [
    slots.zone ? `${ZONE_AR[slots.zone] ?? slots.zone} الرياض` : null,
    slots.districts?.length ? `أحياء: ${slots.districts.join('، ')}` : null,
    slots.unit_types?.length ? slots.unit_types.join('/') : null,
    slots.bedrooms_min ? `${slots.bedrooms_min}+ غرف` : null,
    slots.budget_max ? `حد ${slots.budget_max}` : null,
    slots.readiness ? (slots.readiness === 'ready' ? 'جاهز' : 'على الخارطة') : null,
  ].filter(Boolean);
  if (wants.length) {
    const age = slots.last_reply_at ? Math.round((Date.now() - new Date(slots.last_reply_at).getTime()) / 60_000) : null;
    stateLines.push(`Known wishes from EARLIER messages${age !== null ? ` (last used ${age >= 120 ? `${Math.round(age / 60)} hours` : `${age} minutes`} ago)` : ''} — may be stale, follow what they say now: ${wants.join('، ')}.`);
  }
  // The client's SAVED profile (CRM): what reps and the chat/call readers
  // already know. A failed read only costs this turn that context — logged.
  let saved: SavedProfile | null = null;
  try {
    saved = await loadSavedProfile(svc, (await loadChatContext(svc, chatWid)).clientId);
    if (saved?.line) stateLines.push(saved.line);
  } catch (err) {
    console.error(`[salesAgent] saved profile not loaded chat=${chatWid}:`, err instanceof Error ? err.message : String(err));
  }
  if (slots.gender === 'f') stateLines.push('The customer is a woman — use feminine forms.');
  if (slots.handed_off_at) stateLines.push(`Already handed to a colleague at ${slots.handed_off_at} — don't promise that again.`);
  for (const p of a.pending) stateLines.push(`A colleague ANSWERED the question you asked («${p.question}»): «${p.answer}» — pass it on now.`);
  for (const q of a.openQuestions) stateLines.push(`Still with a colleague, no answer yet: «${q}» — don't ask it again; if the customer asks, say you're still checking.`);
  if (a.lastOursAt) {
    const hours = Math.round((Date.now() - new Date(a.lastOursAt).getTime()) / 3_600_000);
    if (hours >= 20) stateLines.push(`Our last message was ${hours} hours ago — greet first.`);
  }

  // Commit the turn (watermark + count) exactly once, before the first thing the
  // customer or a rep would see. Nothing seen yet ⇒ a crash is retried cleanly.
  let committed = false;
  const commit = async () => {
    if (committed || dryRun) { committed = true; return; }
    committed = true;
    const { error } = await svc.from('wa_agent_conversations').update({
      turns: conv.turns + 1,
      // A relay-only turn (no new customer message) must not move the watermark
      // past a message that arrives while it runs.
      last_turn_at: a.newestCustomerAt ?? conv.last_turn_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('chat_wid', chatWid);
    if (error) throw new BrainError(`state save failed: ${error.message}`, false);
  };

  let sentIds = [...conv.sent_project_ids];
  let mediaQueued = 0;
  const outcome = await runBrain(
    {
      chatWid, lang, turns: a.turns, stateLines, sentProjectIds: conv.sent_project_ids,
      // The conversation started ~5 min before created_at (the message that started it).
      conversationStartedAt: new Date(new Date(conv.created_at).getTime() - START_WINDOW_MS).toISOString(),
      excludeProjectIds: exclude, knownProjectIds: knownIds, narrowTurns: slots.narrow_turns ?? 0,
      instruction: a.hasNew ? null : 'There is NO new customer message. A colleague answered the question you asked (see the state): pass the answer on to the customer now, in your own short voice, numbers exactly as given.',
    },
    {
      beforeSideEffect: commit,
      sendProject: async (projectId) => {
        const more = await projectNames(svc, [projectId]);
        const name = more.get(projectId) ?? '';
        if (dryRun) return { ok: true, name, mediaQueued: 0 };
        const flow = await sendProjectViaAiFlow(svc, {
          chatWid, projectId, deviceId: a.deviceId, jobId: 'agent', onlyOurProjects: true, allowAi: false, force: true, lang,
        });
        if (!flow.queued) return { ok: false, error: flow.error ?? flow.reason ?? 'not queued' };
        mediaQueued = flow.media_queued ?? 0;
        sentIds = [...sentIds, projectId];
        const { error } = await svc.from('wa_agent_conversations').update({ sent_project_ids: sentIds }).eq('chat_wid', chatWid);
        if (error) console.error(`[salesAgent] sent-list save failed chat=${chatWid}:`, error.message);
        return { ok: true, name, mediaQueued };
      },
      sendUnits: async (projectId, unitIds) => {
        const name = (await projectNames(svc, [projectId])).get(projectId) ?? '';
        if (dryRun) return { ok: true, name };
        try {
          const link = await createTrackedLink(svc, {
            projectId, chatWid, conversationRecordId: uuidV5FromWidSync(chatWid), deviceId: a.deviceId, sentVia: 'agent',
            ...(unitIds.length === 1 ? { unitId: unitIds[0] } : { focus: 'units' as const, unitIds }),
          });
          const url = unitIds.length === 1 ? link.unitUrl : link.urls.units;
          if (!url) return { ok: false, error: 'no units link for this project' };
          let text: string;
          if (unitIds.length === 1) {
            // The unit's own facts, from the record — never from the model.
            const u = (await loadAvailableUnits(svc, projectId)).map(summarizeUnit).find((x) => x.id === unitIds[0]);
            if (!u) return { ok: false, error: 'unit is no longer available' };
            const facts = lang === 'en'
              ? [u.type, u.bedrooms !== null ? `${u.bedrooms} bedrooms` : null, u.area !== null ? `${Math.round(u.area)} m²` : null, u.price !== null ? `${u.price.toLocaleString('en-US')} SAR` : null]
              : [u.type, u.bedrooms !== null ? `${u.bedrooms} غرف` : null, u.area !== null ? `${Math.round(u.area)} م²` : null, u.price !== null ? `${u.price.toLocaleString('en-US')} ريال` : null];
            text = `🏠 ${name}${u.code ? ` · ${u.code}` : ''}\n${facts.filter(Boolean).join(' · ')}\n${url}`;
          } else {
            text = lang === 'en'
              ? `🏠 ${name}: ${unitIds.length} available units for you\n${url}`
              : `🏠 ${name}: ${unitIds.length} وحدات متاحة تناسب طلبك\n${url}`;
          }
          const res = await enqueueAiReply(svc, {
            chatWid, text, deviceId: a.deviceId, jobId: 'agent', force: true, projectId,
            reference: `ai-project:agent:${projectId}:units:${Date.now()}`,
          });
          if (!res.queued) return { ok: false, error: res.error ?? res.reason ?? 'not queued' };
          return { ok: true, name };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[salesAgent] units send failed chat=${chatWid} project=${projectId}:`, msg);
          return { ok: false, error: msg };
        }
      },
      askRep: async (question, note, projectId) => {
        if (dryRun) return { ok: true };
        try {
          const pname = projectId ? ((await projectNames(svc, [projectId])).get(projectId) ?? null) : null;
          await askRep(svc, chatWid, { question, note, projectId, projectName: pname });
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[salesAgent] ask_rep failed chat=${chatWid}:`, msg);
          return { ok: false, error: msg };
        }
      },
      bookVisit: async (projectId, day, slot, time) => {
        if (dryRun) return { ok: true };
        try {
          const pname = (await projectNames(svc, [projectId])).get(projectId) ?? '';
          const r = await bookVisit(svc, chatWid, { projectId, projectName: pname, day, slot, time });
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[salesAgent] book_visit failed chat=${chatWid} project=${projectId}:`, msg);
          return { ok: false, error: msg };
        }
      },
      // Read-only: the geography agent over the CURRENT conversation's last
      // turns (cached per text). The whole chat history piled up every place
      // ever named — old visits, «الجنوب», «الفرسان بعيد» — and the "area"
      // covered ~16,000 records, i.e. nothing was narrowed (2026-10-04).
      savedArea: async () => (saved && saved.items.length ? matchSavedPlaces(svc, saved.items, saved.placeLabels) : null),
      readArea: () => {
        const startedAt = new Date(new Date(conv.created_at).getTime() - START_WINDOW_MS).toISOString();
        const current = a.turns.filter((t) => !t.at || t.at >= startedAt);
        return readLocation(svc, current.slice(-AREA_TURNS).map((t) => ({ who: t.who, text: t.text })), null);
      },
      recordVisit: async (projectId, day) => {
        if (dryRun) return { ok: true };
        try {
          const pname = (await projectNames(svc, [projectId])).get(projectId) ?? '';
          const r = await recordVisit(svc, chatWid, { projectId, projectName: pname, day });
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[salesAgent] record_visit failed chat=${chatWid} project=${projectId}:`, msg);
          return { ok: false, error: msg };
        }
      },
      handoff: async (reason, note) => {
        slots.handed_off_at = new Date().toISOString();
        if (dryRun) return;
        await notifyRep(svc, chatWid, `المساعد الآلي (${reason}): ${note}`);
        // A discount / last-price / payment question → the project's officer,
        // as a draft with the customer's own words (AI tab, needs approval).
        const projectId = sentIds[sentIds.length - 1];
        if (reason === 'negotiation' && projectId && a.newCustomerText.trim()) {
          try {
            const ctx = await loadChatContext(svc, chatWid);
            if (ctx.clientId) {
              const r = await draftOfficerQuestion(svc, { clientId: ctx.clientId, projectId, clientChatWid: chatWid, question: a.newCustomerText });
              console.log(`[salesAgent] officer question chat=${chatWid} project=${projectId} → ${r.status}`);
            }
          } catch (err) {
            // The rep was already notified above; the officer draft is extra.
            console.error(`[salesAgent] officer question draft failed chat=${chatWid}:`, err instanceof Error ? err.message : String(err));
          }
        }
      },
    },
    { model: a.model, effort: a.effort, svc },
  );

  // A reply that failed the guard after a side effect → a safe fixed line.
  let reply = outcome.reply;
  let notify: string | null = null;
  if (outcome.replyFailed) {
    // Units already went out with their own caption + link: nothing more to say
    // is better than a generic "one moment" line after them.
    reply = outcome.sent
      ? agentText.afterProject(lang, slots.zone ?? null, false, true)
      : outcome.sentUnits ? null
        : (!a.hasNew && a.pending.length) ? a.pending.map((p) => p.answer).join('\n')
          : agentText.holding(lang);
    if (!outcome.sent && !outcome.sentUnits && !outcome.handoff && !outcome.asked && !outcome.booked && a.hasNew) notify = `المساعد الآلي لم يستطع صياغة رد آمن للعميل — يحتاج متابعة مندوب: «${clip(a.newCustomerText, 200)}»`;
  }

  // Never the same line twice in a row within the window (e.g. two quick messages).
  const now = Date.now();
  if (reply && reply === slots.last_reply && slots.last_reply_at && now - new Date(slots.last_reply_at).getTime() < REPEAT_WINDOW_MS) {
    reply = null;
  }

  if (outcome.lastCriteria) {
    const c = outcome.lastCriteria;
    if (c.zone) slots.zone = c.zone as Zone;
    if (c.unit_types?.length) slots.unit_types = c.unit_types;
    if (c.bedrooms_min) slots.bedrooms_min = c.bedrooms_min;
    if (c.budget_max) slots.budget_max = c.budget_max;
    if (c.readiness) slots.readiness = c.readiness;
    slots.districts = c.districts?.length ? c.districts : undefined;
    if (c.city) slots.city = c.city;
  }
  if (outcome.sent) slots.last_project_name = outcome.sent.name;
  // Narrowing streak: a reply that searched a big set and did not send counts;
  // a send or a small set resets it (the send gate lets go after two).
  if (outcome.sent || (outcome.lastTotal !== null && outcome.lastTotal <= 3)) slots.narrow_turns = 0;
  else if (outcome.lastTotal !== null && outcome.lastTotal > 3) slots.narrow_turns = (slots.narrow_turns ?? 0) + 1;
  if (reply) { slots.last_reply = reply; slots.last_reply_at = new Date(now).toISOString(); }

  const stepKind: NextStep = outcome.ended
    ? { kind: 'stop' }
    : outcome.handoff
      ? { kind: 'handoff', reason: 'question' }
      : outcome.sent ? { kind: 'search' } : { kind: 'ask', slot: 'zone' };
  const result: TurnResult = {
    step: stepKind, slots, replies: reply ? [reply] : [], notify, status: outcome.ended ? 'done' : 'active', model: outcome.model,
    brain: {
      toolTrace: outcome.toolTrace, guardProblems: outcome.guardProblems, replyFailed: outcome.replyFailed,
      searches: outcome.searches, project: outcome.sent?.name ?? null, handoff: outcome.handoff?.reason ?? null,
      projectId: outcome.sent?.projectId ?? null,
      units: outcome.sentUnits ? { projectId: outcome.sentUnits.projectId, name: outcome.sentUnits.name, unitIds: outcome.sentUnits.unitIds } : null,
      ...(dryRun ? { facts: (outcome.grounding ?? []).filter((g) => g !== null && typeof g === 'object') } : {}),
    },
  };
  if (dryRun) return { ...result, sent: false };

  await commit();
  const { error: upErr } = await svc.from('wa_agent_conversations').update({
    slots, asked: null, status: outcome.ended ? 'done' : 'active', updated_at: new Date().toISOString(),
  }).eq('chat_wid', chatWid);
  if (upErr) console.error(`[salesAgent] state save failed after the turn chat=${chatWid}:`, upErr.message);

  let sent = true;
  if (reply) {
    // After a project package: a floor delay, and the queue holds the line until
    // every photo/video/document of THAT package has gone (after_prefix).
    const res = await enqueueAiReply(svc, {
      chatWid, text: reply, deviceId: a.deviceId, jobId: 'agent', force: true,
      delaySeconds: outcome.sent ? (mediaQueued + 1) * MEDIA_SPACING_S + MEDIA_SPACING_S : outcome.sentUnits ? MEDIA_SPACING_S : 0,
      // Held until the project package / the units link has gone out, so the
      // line never lands before what it talks about.
      afterPrefix: outcome.sent
        ? `ai-project:agent:${outcome.sent.projectId}:`
        : outcome.sentUnits ? `ai-project:agent:${outcome.sentUnits.projectId}:` : null,
    });
    if (!res.queued) {
      sent = false;
      console.error(`[salesAgent] reply enqueue failed chat=${chatWid}: ${res.error ?? res.reason ?? 'unknown'}`);
      notify = `${notify ? `${notify} — ` : ''}تعذّر إرسال رد المساعد الآلي للعميل — يحتاج مندوب.`;
    }
  }
  // The colleague's answer reached the customer (in this reply): mark it passed on.
  if (a.pending.length && reply && sent) {
    const { error: rErr } = await svc.from('wa_agent_questions')
      .update({ relayed_at: new Date().toISOString() }).in('id', a.pending.map((p) => p.id));
    if (rErr) console.error(`[salesAgent] relay stamp failed chat=${chatWid}:`, rErr.message);
  }
  if (notify) await notifyRep(svc, chatWid, notify);
  console.log(`[salesAgent] brain chat=${chatWid} model=${outcome.model} tools=[${outcome.toolTrace.join(' ; ')}] reply=${reply ? 'yes' : 'none'}${outcome.replyFailed ? ' (fallback line)' : ''}`);
  return { ...result, notify, sent };
}
