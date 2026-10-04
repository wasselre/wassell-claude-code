/**
 * runChatOutcomeJob — read a WhatsApp conversation and propose the outcome of
 * the client's open follow-up. The chat twin of runCallAnalysisJob.
 *
 * CONTRACT (same as every other runner here)
 *   This file does NOT touch job status. index.ts owns claim / ready / skip /
 *   fail. Return a payload, or throw an Error whose message lands verbatim in
 *   chat_outcome_suggestions.error. Log prefix is `[run-chat]`.
 *
 * WHY IT EXISTS
 *   Measured 2026-09-27: of 704 follow-ups closed in 30 days only 100 carried an
 *   outcome a rep chose. Reps talk to clients on WhatsApp and never open the
 *   outcome picker, so the sales workflows (which trigger on the outcome) never
 *   run. This proposes the outcome from the conversation itself; the chat's task
 *   bar shows it and the rep confirms with one tap. Nothing is applied here.
 *
 * "NO DECISION YET" IS A FIRST-CLASS ANSWER
 *   Most readings land mid-conversation. Forcing a pick would put a guess in
 *   front of the rep with a confidence number attached, so the model may answer
 *   `none` and the row becomes `no_signal` (never shown).
 *
 * OUTCOME SETS
 *   whatsapp_follow_up → CHAT_WHATSAPP_OUTCOMES below: config.ts's allowed list
 *   minus `no_message_sent`, which is a rep ACTION ("I chose not to message"),
 *   not something a client can say. Guarded by workerOutcomeParity.test.ts.
 *   Call-type tasks (a booking call still open because the client wrote first)
 *   → that type's call matrix minus `no_answer`, which a chat cannot produce.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { recordAiUsage, openAiCompatTokens } from './lib/aiUsage.js';
import {
  OUTCOMES_BY_TYPE, OUTCOME_HELP, NEEDS_DATE, NEEDS_LOST_REASON, LOST_REASONS,
  parseJsonObject, str,
} from './runCallAnalysisJob.js';

export interface ChatOutcomeJob {
  id: string;
  clientId: string;
  chatRecordId: string | null;
  chatWid: string | null;
  followupId: string | null;
  followupType: string | null;
  attempts: number;
}

export interface ChatOutcomeResult {
  /** null = the conversation holds no decision yet (row → no_signal). */
  outcome: string | null;
  confidence: number;
  reasoning: string;
  summary: string;
  fields: Record<string, string>;
  quoted: string | null;
  model: string;
  lastMessageAt: string | null;
  /** The client's MAIN project, chosen from their options / the projects sent
   *  to this chat, on a positive outcome. With an interested-type outcome it is
   *  the high-interest signal (portal registration + officer notice draft). */
  mainProjectId: string | null;
  mainProjectName: string | null;
}

/** A project the model may name as the client's main one. */
interface ProjectCandidate {
  id: string;
  name: string;
  /** Where it comes from: the client's options (with status) or a send to this chat. */
  source: string;
}

/** Outcomes where the client is interested — the model also names the main project. */
const POSITIVE_OUTCOMES = new Set(['interested', 'appointment_booked', 'request_offer']);

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: ChatOutcomeJob;
}

/** COPY of config.ts whatsapp_follow_up.allowed_outcomes minus no_message_sent. */
export const CHAT_WHATSAPP_OUTCOMES = ['interested', 'appointment_booked', 'request_offer', 'recontact_later', 'not_interested', 'wants_rent', 'unanswered_request'];

/** Chat-specific wording where the call hint does not fit a written conversation. */
const CHAT_HINTS: Record<string, string> = {
  interested: 'Engaged: asks about projects, prices, locations or sends requirements, but has NOT agreed a visit.',
  appointment_booked: 'The customer agreed a specific visit day/time in the chat.',
  wants_rent: 'The customer wants to RENT, not buy.',
};

/** How many recent messages the model reads. Enough for context, bounded cost. */
const MESSAGE_WINDOW = 40;

export function allowedChatOutcomes(followupType: string | null): string[] {
  if (!followupType || followupType === 'whatsapp_follow_up') return CHAT_WHATSAPP_OUTCOMES;
  const call = OUTCOMES_BY_TYPE[followupType];
  return call ? call.filter((o) => o !== 'no_answer') : CHAT_WHATSAPP_OUTCOMES;
}

interface MessageRow {
  flow: string | null;
  kind: string | null;
  body: string | null;
  media_caption: string | null;
  transcript: string | null;
  send_source: string | null;
  date: string | null;
}

const riyadhStamp = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

/** Oldest-first dialogue with speaker + Riyadh time on every line. */
export function buildChatDialogue(rows: MessageRow[]): { text: string; clientTurns: number } {
  let clientTurns = 0;
  const lines: string[] = [];
  for (const m of rows) {
    const text = (m.body?.trim() || m.media_caption?.trim() || (m.transcript ? `[رسالة صوتية] ${m.transcript.trim()}` : '') || '').trim();
    const content = text || (m.kind ? `[${m.kind}]` : '');
    if (!content) continue;
    const who = m.flow === 'in' ? 'العميل' : m.send_source === 'ai' ? 'المساعد الآلي' : 'المندوب';
    if (m.flow === 'in' && text) clientTurns += 1;
    lines.push(`[${riyadhStamp(m.date)}] ${who}: ${content}`);
  }
  return { text: lines.join('\n'), clientTurns };
}

/**
 * The projects the model may choose the main one from: the client's own project
 * options (any status but eliminated / not interested) plus the projects sent
 * to this chat. Capped at 25, options first.
 */
async function loadProjectCandidates(supabase: SupabaseClient, clientId: string, chatWid: string): Promise<ProjectCandidate[]> {
  const { data: models, error: mErr } = await supabase
    .from('models').select('id, name').in('name', ['client_property_options', 'all_projects']);
  if (mErr) throw new Error(`models read failed: ${mErr.message}`);
  const optionsModel = (models ?? []).find((m) => (m as { name: string }).name === 'client_property_options') as { id: string } | undefined;
  const projectsModel = (models ?? []).find((m) => (m as { name: string }).name === 'all_projects') as { id: string } | undefined;

  const out = new Map<string, ProjectCandidate>();
  if (optionsModel) {
    const { data: opts, error: oErr } = await supabase
      .from('records').select('data')
      .eq('model_id', optionsModel.id)
      .eq('data->>client_id', clientId)
      .eq('data->>source_type', 'project')
      .limit(50);
    if (oErr) throw new Error(`client options read failed: ${oErr.message}`);
    for (const r of (opts ?? []) as Array<{ data: Record<string, unknown> }>) {
      const id = typeof r.data.source_id === 'string' ? r.data.source_id : '';
      const status = typeof r.data.status === 'string' ? r.data.status : 'suitable';
      if (!id || status === 'eliminated' || status === 'not_interested') continue;
      const name = typeof r.data.source_name === 'string' ? r.data.source_name : '';
      out.set(id, { id, name, source: r.data.is_main === true ? `client option (${status}, current main)` : `client option (${status})` });
    }
  }
  const { data: sent, error: sErr } = await supabase
    .from('chat_message_projects').select('project_id, created_at')
    .eq('chat_wid', chatWid).order('created_at', { ascending: false }).limit(30);
  if (sErr) throw new Error(`chat_message_projects read failed: ${sErr.message}`);
  for (const r of (sent ?? []) as Array<{ project_id: string | null }>) {
    if (r.project_id && !out.has(r.project_id)) out.set(r.project_id, { id: r.project_id, name: '', source: 'sent in this chat' });
  }
  const list = [...out.values()].slice(0, 25);
  const nameless = list.filter((c) => !c.name).map((c) => c.id);
  if (nameless.length && projectsModel) {
    const { data: rows, error: pErr } = await supabase.from('records').select('id, data').in('id', nameless);
    if (pErr) throw new Error(`project names read failed: ${pErr.message}`);
    const names = new Map(((rows ?? []) as Array<{ id: string; data: Record<string, unknown> }>).map((r) => [r.id, String(r.data.project_name ?? r.data.name ?? '')]));
    for (const c of list) if (!c.name) c.name = names.get(c.id) ?? '';
  }
  return list.filter((c) => c.name.trim() !== '');
}

function buildSystemPrompt(allowed: string[], nowIso: string, context: string, projects: ProjectCandidate[]): string {
  const projectList = projects.length
    ? projects.map((p, i) => `P${i + 1} — ${p.name} [${p.source}]`).join('\n')
    : '(none)';
  const list = allowed
    .map((v) => {
      const h = OUTCOME_HELP[v];
      const hint = CHAT_HINTS[v] ?? h?.hint ?? '';
      return `- ${v}${h ? ` (${h.ar})` : ''} — ${hint}`;
    })
    .join('\n');

  return `أنت مساعد لفريق مبيعات عقاري سعودي (شركة وصل العقارية). اقرأ محادثة واتساب بين المندوب والعميل، وحدد نتيجة المتابعة المفتوحة إن كانت المحادثة قد حسمتها.

${context}

The conversation is Saudi/Gulf dialect Arabic, sometimes English. Speakers:
  المندوب        = the Wassel sales rep
  المساعد الآلي  = Wassel's automated assistant (not a human rep)
  العميل         = the customer

Choose EXACTLY ONE value from this closed list, or "none":
${list}
- none — the conversation has not produced a position yet: only greetings, the rep's own messages, an unanswered question, or the customer is still mid-discussion.

Rules:
- Judge by what the CUSTOMER wrote and agreed to — never by what the rep offered or hoped for.
- Weight the MOST RECENT customer messages; an earlier position can be replaced by a later one.
- Saudi politeness is not agreement. «إن شاء الله»، «الله يعطيك العافية»، «تمام» alone are not commitments.
- Only pick appointment_booked if a visit day/time was actually agreed.
- If the customer is open but asks to be contacted later, that is recontact_later.
- When unsure between an outcome and none, answer none. A wrong suggestion costs the rep more than no suggestion.

Now is ${nowIso} (Asia/Riyadh). If the outcome needs a follow-up date, resolve the
customer's words into an ABSOLUTE ISO 8601 datetime with offset and quote the exact
Arabic phrase. «بكرة» → tomorrow 10:00. «الأسبوع الجاي» → +7 days 10:00. «بعد العيد» → null.

MAIN PROJECT. When the outcome is interested, appointment_booked or request_offer, choose the
ONE project from this list the customer is most interested in, judged by what THEY wrote
(asked about it, asked its price or units, agreed to visit it). If the customer showed no
interest in any listed project in particular, answer null. Never guess a project that is not
in the list. For any other outcome answer null.
${projectList}

Reply with ONLY this JSON object — no prose, no markdown fence:
{
  "main_project": "<P-number from the list, or null>",
  "outcome": "<one value from the list, or none>",
  "confidence": <0-100>,
  "summary": "<1-2 sentence Arabic summary of where the conversation stands>",
  "reasoning": "<one Arabic sentence: why this outcome>",
  "outcome_notes": "<Arabic CRM note: what the customer wants, or why they declined; empty for none>",
  "reschedule_datetime": "<ISO 8601 with offset, or null>",
  "quoted_phrase": "<the exact Arabic words the date or decision came from, or null>",
  "lost_reason": "<one of: ${LOST_REASONS.join(', ')} — only for a loss, else null>"
}`;
}

export async function runChatOutcomeJob({ supabase, env, job }: RunArgs): Promise<ChatOutcomeResult> {
  if (!job.chatWid) throw new Error('job has no chat_wid');
  const allowed = allowedChatOutcomes(job.followupType);

  const { data: msgs, error: msgErr } = await supabase
    .from('chat_messages')
    .select('flow, kind, body, media_caption, transcript, send_source, date')
    .eq('chat_wid', job.chatWid)
    .order('date', { ascending: false })
    .limit(MESSAGE_WINDOW);
  if (msgErr) throw new Error(`chat_messages read failed: ${msgErr.message}`);
  const rows = ((msgs ?? []) as MessageRow[]).slice().reverse();
  const lastMessageAt = rows.length ? rows[rows.length - 1]!.date : null;

  const { text: dialogue, clientTurns } = buildChatDialogue(rows);
  const empty: ChatOutcomeResult = {
    outcome: null, confidence: 100, reasoning: '', summary: '', fields: {}, quoted: null,
    model: 'deterministic', lastMessageAt, mainProjectId: null, mainProjectName: null,
  };
  if (clientTurns === 0) {
    console.log(`[run-chat] job=${job.id} no customer text in the last ${MESSAGE_WINDOW} messages → none`);
    return empty;
  }

  const { data: client, error: clientErr } = await supabase
    .from('records')
    .select('data')
    .eq('id', job.clientId)
    .maybeSingle();
  if (clientErr) throw new Error(`client read failed: ${clientErr.message}`);
  const cd = ((client as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const context = [
    `مرحلة العميل الحالية: ${String(cd.client_stage ?? 'غير معروفة')}`,
    `حالة العميل الحالية: ${String(cd.client_status ?? 'غير معروفة')}`,
    `نوع المهمة المفتوحة: ${job.followupType ?? 'whatsapp_follow_up'}`,
  ].join('\n');
  const projects = await loadProjectCandidates(supabase, job.clientId, job.chatWid);

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const base = env.DEEPSEEK_BASE_URL.replace(/\/$/, '');
  const model = env.DEEPSEEK_MODEL;
  const nowIso = new Date().toISOString();
  const started = Date.now();
  const usageRef = {
    area: 'sales' as const, callSite: 'worker/runChatOutcomeJob', operation: 'outcome',
    provider: 'deepseek' as const, model, entityKind: 'client', entityId: job.clientId,
  };

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      // 2000 was not enough: deepseek-v4-pro spends its reasoning inside the
      // same budget and 14 of the first 44 readings came back with EMPTY
      // content at exactly 2000 output tokens (2026-09-27 → 10-03).
      max_tokens: 8000,
      messages: [
        { role: 'system', content: buildSystemPrompt(allowed, nowIso, context, projects) },
        { role: 'user', content: `المحادثة (الأقدم أولًا):\n${dialogue}` },
      ],
    }),
  });
  if (!res.ok) {
    const err = new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await recordAiUsage({ ...usageRef, status: 'error', error: err.message, latencyMs: Date.now() - started });
    throw err;
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  await recordAiUsage({ ...usageRef, status: 'ok', latencyMs: Date.now() - started, ...openAiCompatTokens(body) });

  const content = body.choices?.[0]?.message?.content ?? '';
  if (!content.trim() && body.choices?.[0]?.finish_reason === 'length') {
    throw new Error('model ran out of output tokens before answering (finish_reason=length)');
  }
  const parsed = parseJsonObject(content);
  const picked = str(parsed.outcome);
  const confRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(100, Math.round(confRaw))) : 50;

  if (!picked || picked === 'none') {
    console.log(`[run-chat] job=${job.id} → none`);
    return { ...empty, confidence, summary: str(parsed.summary) ?? '', model };
  }
  if (!allowed.includes(picked)) {
    // Refusing beats guessing — an out-of-set value has no button in the chat.
    throw new Error(`model chose "${picked}" which is not allowed for ${job.followupType ?? 'whatsapp_follow_up'}`);
  }

  const fields: Record<string, string> = {};
  const notes = str(parsed.outcome_notes);
  if (notes) fields.outcome_notes = notes;
  if (NEEDS_DATE.has(picked)) {
    const iso = str(parsed.reschedule_datetime);
    const ms = iso ? Date.parse(iso) : NaN;
    if (iso && !Number.isNaN(ms)) {
      fields[picked === 'rescheduled' ? 'new_appointment_datetime' : 'reschedule_contact_date'] = new Date(ms).toISOString();
    }
  }
  if (NEEDS_LOST_REASON.has(picked)) {
    const lr = str(parsed.lost_reason);
    if (lr && LOST_REASONS.includes(lr)) fields.lost_reason = lr;
  }

  // The main project: only a P-number from the list we gave, only on a
  // positive outcome. Anything else (a name, an invented number) is dropped.
  let main: ProjectCandidate | null = null;
  if (POSITIVE_OUTCOMES.has(picked)) {
    const ref = /^P(\d{1,2})$/i.exec((str((parsed as { main_project?: unknown }).main_project) ?? '').trim());
    const idx = ref ? Number(ref[1]) - 1 : -1;
    main = idx >= 0 && idx < projects.length ? projects[idx]! : null;
  }

  console.log(`[run-chat] job=${job.id} → ${picked} (${confidence}%)${main ? ` main=${main.name}` : ''}`);
  return {
    outcome: picked,
    confidence,
    reasoning: str(parsed.reasoning) ?? '',
    summary: str(parsed.summary) ?? '',
    fields,
    quoted: str(parsed.quoted_phrase),
    model,
    lastMessageAt,
    mainProjectId: main?.id ?? null,
    mainProjectName: main?.name ?? null,
  };
}
