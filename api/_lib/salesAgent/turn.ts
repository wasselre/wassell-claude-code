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

/** Photos in a project package go out 4 s apart; the follow-up question must
 *  land after the last one (mirrors aiSendProject's SPACING_MS). */
const MEDIA_SPACING_S = 4;
/** A handoff line is not repeated within this window (the rep is still told). */
const REPEAT_WINDOW_MS = 30 * 60_000;

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
}

async function loadRecentTurns(
  svc: SupabaseClient, chatWid: string, sinceIso: string,
): Promise<{ turns: ChatTurn[]; newestCustomerAt: string | null; deviceId: string | null; newCustomerText: string }> {
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
  const newText: string[] = [];
  const turns: ChatTurn[] = rows.map((r) => {
    // A voice note counts as the customer's words once transcribed.
    const text = (r.body ?? r.transcript ?? r.media_caption ?? '').trim() || `[${r.kind}]`;
    const isNew = r.flow === 'in' && r.date > sinceIso;
    if (r.flow === 'in') {
      deviceId = r.device_id ?? deviceId;
      if (isNew) { newestCustomerAt = r.date; newText.push(text); }
    }
    return { who: r.flow === 'in' ? 'customer' : 'us', text, isNew };
  });
  return { turns, newestCustomerAt, deviceId, newCustomerText: newText.join(' ') };
}

async function notifyRep(svc: SupabaseClient, chatWid: string, body: string): Promise<void> {
  const { error } = await svc.from('ai_notifications').insert({
    source: 'whatsapp', severity: 'action', title: null, body,
    chat_wid: chatWid, chat_record_id: uuidV5FromWidSync(chatWid),
  });
  if (error) console.error('[salesAgent] rep notification failed:', error.message);
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

  const maxTurns = settings?.agent_max_turns ?? 20;
  const lang0: Lang = conv.slots.lang ?? 'ar';

  // Reply cap per conversation: hand to a rep rather than talk forever.
  if (conv.turns >= maxTurns) {
    const replies = [agentText.holding(lang0)];
    const notify = 'وصلت محادثة المساعد الآلي الحد الأعلى للردود — تحتاج متابعة مندوب.';
    if (!dryRun) {
      await enqueueAiReply(svc, { chatWid, text: replies[0]!, jobId: 'agent', force: true });
      await notifyRep(svc, chatWid, notify);
      await svc.from('wa_agent_conversations').update({ status: 'handed_off', updated_at: new Date().toISOString() }).eq('chat_wid', chatWid);
    }
    return { skipped: 'turn_cap', replies, notify, status: 'handed_off' };
  }

  // ── What did the customer say since our last turn? ─────────────────────
  // First turn: include the message that started the conversation.
  const sinceIso = conv.last_turn_at ?? new Date(new Date(conv.created_at).getTime() - 5 * 60_000).toISOString();
  let turns: ChatTurn[]; let newestCustomerAt: string | null; let deviceId: string | null; let newCustomerText: string;
  if (sim) {
    turns = sim.messages.map((m) => ({ who: m.who, text: m.text, isNew: m.isNew ?? m.who === 'customer' }));
    newestCustomerAt = new Date().toISOString();
    deviceId = null;
    newCustomerText = turns.filter((t) => t.isNew && t.who === 'customer').map((t) => t.text).join(' ');
  } else {
    ({ turns, newestCustomerAt, deviceId, newCustomerText } = await loadRecentTurns(svc, chatWid, sinceIso));
  }
  if (!turns.some((t) => t.isNew && t.who === 'customer')) return { skipped: 'nothing_new' };

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
  const quote = newCustomerText.slice(0, 200);

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
