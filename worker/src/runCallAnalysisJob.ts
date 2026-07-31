/**
 * runCallAnalysisJob — read a finished sales call and propose the follow-up
 * outcome the rep should confirm.
 *
 * CONTRACT (same as every other runner here)
 *   This file does NOT touch job status. index.ts owns claim / ready / fail.
 *   Return a payload, or throw an Error whose message lands verbatim in
 *   call_result_suggestions.error. Log prefix is `[run-call]`.
 *
 * WHY A COPY OF THE OUTCOME MATRIX LIVES HERE
 *   The worker is a standalone npm package (rootDir:src; the Dockerfile copies
 *   only src/) and CANNOT import from the SPA's src/lib. OUTCOMES_BY_TYPE below
 *   is a verbatim copy of the call-channel `allowed_outcomes` in
 *   src/lib/salesProcess/config.ts, extracted mechanically from that file on
 *   2026-07-30 rather than transcribed by hand. Same posture as
 *   worker/src/imageGen.ts and worker/src/migrateAgent.ts: **when you change
 *   a call type's allowed outcomes in config.ts, change this map too.** A
 *   drifted map means the model proposes an outcome the Workspace refuses to
 *   render, and the rep sees an empty popup.
 *
 * THE 55% THAT COSTS NOTHING
 *   Measured on prod 2026-07-30: 55% of call-type follow-ups end `no_answer`,
 *   and those calls carry no recording and no transcript at all. Hatif's own
 *   `status` already says so. Those resolve deterministically with confidence
 *   100 and never reach DeepSeek — the model only ever sees calls where a
 *   conversation actually happened.
 *
 * SPEAKER ROLES ARE MOSTLY ABSENT
 *   100% of transcribed calls are diarized (`speaker_0`/`speaker_1`) but only
 *   3.6% carry Hatif's resolved `role` (Agent/Customer) — that field only
 *   started appearing in July 2026. Never require it: `buildDialogue` uses the
 *   role when present and otherwise infers which speaker is the agent from the
 *   company self-introduction. Getting this backwards inverts every judgement,
 *   because the whole task is "what did the CUSTOMER agree to".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';

// ── job contract ─────────────────────────────────────────────────────────────

export interface CallAnalysisJob {
  id: string;
  callRecordId: string;
  callLogId: string | null;
  clientId: string | null;
  followupId: string | null;
  /** null for kind='log_interaction' — an off-task call with no open follow-up. */
  followupType: string | null;
  kind: 'confirm_followup' | 'log_interaction';
  attempts: number;
}

export interface CallAnalysisResult {
  outcome: string;
  confidence: number;
  reasoning: string;
  summary: string;
  /** Prefilled required fields the rep edits in the popup. */
  fields: Record<string, string>;
  /** The customer's own words behind a proposed date, e.g. «بعد نص ساعة». */
  quoted: string | null;
  model: string;
  source: 'deepseek' | 'deterministic';
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: CallAnalysisJob;
}

// ── outcome matrix (COPY of src/lib/salesProcess/config.ts — keep in sync) ────

const OUTCOMES_BY_TYPE: Record<string, string[]> = {
  appointment_booking_call: ['appointment_booked', 'interested', 'no_answer', 'recontact_later', 'not_interested', 'invalid_number', 'duplicate'],
  appointment_confirmation_call: ['attendance_confirmed', 'no_answer', 'rescheduled', 'appointment_cancelled_rebook', 'appointment_cancelled_lost', 'recontact_later', 'not_interested'],
  same_day_appointment_confirmation: ['attendance_confirmed', 'no_answer', 'rescheduled', 'appointment_cancelled_lost'],
  no_show_recovery_call: ['rescheduled', 'still_interested', 'not_interested', 'no_answer', 'recontact_later'],
  follow_up_call_after_visit: ['request_offer', 'still_interested', 'needs_financing_info', 'family_discussion', 'requested_another_visit', 'visited_other_project', 'recontact_later', 'invalid_number', 'not_interested', 'no_answer'],
  offer_follow_up: ['offer_accepted', 'waiting_decision', 'needs_financing_info', 'offer_rejected', 'no_answer', 'recontact_later'],
  reservation_payment_follow_up: ['payment_received', 'payment_pending', 'no_answer', 'recontact_later'],
  financing_follow_up: ['documents_pending', 'payment_received', 'waiting_decision', 'no_answer', 'recontact_later'],
  ownership_transfer_follow_up: ['documents_pending', 'payment_received', 'no_answer'],
};

/** An off-task call has no follow-up type; treat it as a first-contact call. */
const DEFAULT_TYPE = 'appointment_booking_call';

/** Arabic labels + the discriminating rule for each outcome the model may pick. */
const OUTCOME_HELP: Record<string, { ar: string; hint: string }> = {
  appointment_booked:           { ar: 'تم حجز موعد', hint: 'The customer agreed to a specific visit.' },
  interested:                   { ar: 'مهتم', hint: 'Engaged, gave requirements or asked for options/WhatsApp, but did NOT commit to a visit.' },
  still_interested:             { ar: 'لا يزال مهتمًا', hint: 'Confirms continued interest after a previous step.' },
  no_answer:                    { ar: 'لا يوجد رد', hint: 'Nobody effectively answered — voicemail, instant hangup, silence, no real conversation.' },
  recontact_later:              { ar: 'إعادة تواصل لاحقًا', hint: 'Open in principle but not now, for ANY reason — busy, at work, in a meeting, driving, travelling, still deciding, "call me at 8", "next week", "after Eid".' },
  not_interested:               { ar: 'غير مهتم', hint: 'Declined outright — not looking, already bought, mismatch, or asked not to be contacted at all.' },
  invalid_number:               { ar: 'رقم خاطئ', hint: 'Wrong person; the number does not belong to the intended client.' },
  duplicate:                    { ar: 'مكرر', hint: 'Customer says the same company already contacted them about this.' },
  attendance_confirmed:         { ar: 'تم تأكيد الحضور', hint: 'Customer confirmed they will attend the booked appointment.' },
  rescheduled:                  { ar: 'تمت إعادة الجدولة', hint: 'Appointment moved to a new date/time the customer accepted.' },
  appointment_cancelled_rebook: { ar: 'إلغاء الموعد - إعادة حجز', hint: 'Appointment cancelled but the customer wants another one.' },
  appointment_cancelled_lost:   { ar: 'إلغاء الموعد - خسارة', hint: 'Appointment cancelled and the customer is out.' },
  request_offer:                { ar: 'طلب عرض سعر', hint: 'Customer asked for a written price offer.' },
  needs_financing_info:         { ar: 'يحتاج معلومات تمويل', hint: 'Customer needs financing/mortgage information before deciding.' },
  family_discussion:            { ar: 'نقاش عائلي', hint: 'Customer needs to discuss with family before deciding.' },
  requested_another_visit:      { ar: 'طلب زيارة أخرى', hint: 'Customer asked to visit again or see another project.' },
  visited_other_project:        { ar: 'زار مشروعًا آخر', hint: 'Customer says they visited/bought at a different project.' },
  offer_accepted:               { ar: 'قبول العرض', hint: 'Customer accepted the price offer.' },
  offer_rejected:               { ar: 'رفض العرض', hint: 'Customer rejected the price offer.' },
  waiting_decision:             { ar: 'بانتظار القرار', hint: 'Customer is still deciding on the offer.' },
  payment_received:             { ar: 'تم استلام الدفعة', hint: 'Customer confirmed a payment was made.' },
  payment_pending:              { ar: 'بانتظار الدفع', hint: 'Payment agreed but not yet made.' },
  documents_pending:            { ar: 'بانتظار المستندات', hint: 'Waiting on documents from the customer or the bank.' },
};

/** Outcomes that need a reschedule/appointment datetime prefilled. */
const NEEDS_DATE = new Set(['recontact_later', 'rescheduled', 'appointment_cancelled_rebook']);
/** Outcomes that need a lost_reason prefilled. */
const NEEDS_LOST_REASON = new Set(['not_interested', 'invalid_number', 'duplicate', 'appointment_cancelled_lost', 'offer_rejected', 'visited_other_project']);
/** lost_reason dropdown values (followups model). */
const LOST_REASONS = ['price', 'location', 'unit_not_suitable', 'bought_elsewhere', 'not_serious', 'financing_issue', 'timing_issue', 'invalid_number', 'duplicate', 'other'];

// ── transcript reconstruction ────────────────────────────────────────────────

interface TranscriptWord { text?: string; role?: string; speaker?: string }

/**
 * Rebuild a speaker-labelled dialogue.
 *
 * Priority: Hatif's own `role` (3.6% of calls) → infer the agent from the
 * company self-introduction → assume the first speaker is the customer, which
 * is right for an outbound call because the callee answers first («ألو»).
 */
export function buildDialogue(transcription: unknown): string {
  const t = transcription as { text?: string; words?: TranscriptWord[] } | null;
  const words = Array.isArray(t?.words) ? t!.words! : null;
  if (!words || words.length === 0) {
    const flat = (t?.text ?? '').trim();
    return flat ? `غير معروف: ${flat}` : '';
  }

  const hasRoles = words.some((w) => w?.role === 'Agent' || w?.role === 'Customer');
  let agentSpeaker: string | null = null;

  if (!hasRoles) {
    // The agent is whoever says «معك ... من شركة ... العقارية». Scan per speaker.
    const bySpeaker = new Map<string, string>();
    for (const w of words) {
      const sp = w?.speaker ?? '_';
      bySpeaker.set(sp, `${bySpeaker.get(sp) ?? ''} ${w?.text ?? ''}`);
    }
    for (const [sp, text] of bySpeaker) {
      if (/شرك[ةه]|العقاري|معك\s|معي\s/.test(text)) { agentSpeaker = sp; break; }
    }
    if (agentSpeaker === null) {
      // Outbound: the callee picks up and speaks first, so first ≠ agent.
      const first = words.find((w) => w?.speaker)?.speaker ?? null;
      const other = words.find((w) => w?.speaker && w.speaker !== first)?.speaker ?? null;
      agentSpeaker = other;
    }
  }

  const lines: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    lines.push(`${current}: ${buf.join(' ')}`);
    buf = [];
  };
  for (const w of words) {
    const text = typeof w?.text === 'string' ? w.text : '';
    if (!text) continue;
    const who = hasRoles
      ? (w.role === 'Agent' ? 'المندوب' : w.role === 'Customer' ? 'العميل' : 'غير معروف')
      : (w.speaker != null && w.speaker === agentSpeaker ? 'المندوب' : 'العميل');
    if (who !== current) { flush(); current = who; }
    buf.push(text);
  }
  flush();
  return lines.join('\n');
}

/**
 * True when nothing worth analysing happened: no customer turn with real
 * content. Voicemail greetings and «ألو ألو» hangups land here, and they are
 * `no_answer` regardless of what Hatif's status field claims.
 */
function isNonConversation(dialogue: string, durationSeconds: number | null): boolean {
  if (!dialogue) return true;
  const customerText = dialogue
    .split('\n')
    .filter((l) => l.startsWith('العميل:'))
    .map((l) => l.slice('العميل:'.length))
    .join(' ')
    .replace(/[.،؟!,?]/g, ' ')
    .trim();
  // Strip pure phatics — greetings and hello-hello carry no decision.
  const stripped = customerText
    .replace(/\b(ألو|الو|هلا|أهلا|أهلًا|مرحبا|مرحبًا|السلام|عليكم|ورحمة|الله|وبركاته|نعم|أيوه|أيوة|إي|hello|hi|yes)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length < 12) return true;
  if ((durationSeconds ?? 0) > 0 && durationSeconds! < 6) return true;
  return false;
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(allowed: string[], callTimeIso: string): string {
  const list = allowed
    .map((v) => {
      const h = OUTCOME_HELP[v];
      return h ? `- ${v} (${h.ar}) — ${h.hint}` : `- ${v}`;
    })
    .join('\n');

  return `أنت مساعد لفريق مبيعات عقاري سعودي (شركة وصل العقارية). اقرأ نص مكالمة هاتفية صادرة بين مندوب المبيعات والعميل، واختر نتيجة المتابعة الصحيحة.

The transcript is Saudi/Gulf dialect Arabic, often with English code-switching. Speakers:
  المندوب  = the Wassel sales agent who placed the call
  العميل   = the customer who received it

Choose EXACTLY ONE outcome from this closed list:
${list}

Rules:
- Judge by what the CUSTOMER says and agrees to — never by what the agent proposes or hopes for.
- Saudi phone politeness is not agreement. «إن شاء الله»، «الله يعطيك العافية»، «أرسل لي واتساب» are soft closes, not commitments.
- Only pick an appointment/booking outcome if a visit was actually agreed.
- If the customer is open but not available now — for ANY reason — that is recontact_later.

The call happened at ${callTimeIso} (Asia/Riyadh). If your chosen outcome needs a
follow-up date, resolve the customer's own words into an ABSOLUTE ISO 8601
datetime, and quote the exact Arabic phrase you resolved it from.
Examples: «بعد نص ساعة» → +30 minutes. «الأسبوع الجاي» → +7 days, 10:00.
«الساعة ثمانية بالليل» → today 20:00. «بعد العيد» → leave the date null and say so.

Reply with ONLY this JSON object — no prose, no markdown fence:
{
  "outcome": "<one value from the list above>",
  "confidence": <0-100>,
  "summary": "<2-3 sentence Arabic summary of the call>",
  "reasoning": "<one Arabic sentence: why this outcome>",
  "outcome_notes": "<Arabic note for the CRM explaining the customer's position — what they want, or why they declined>",
  "reschedule_datetime": "<ISO 8601 with offset, or null>",
  "quoted_phrase": "<the exact Arabic words the date came from, or null>",
  "lost_reason": "<one of: ${LOST_REASONS.join(', ')} — only when the outcome is a loss, else null>"
}`;
}

interface DeepSeekRaw {
  outcome?: unknown; confidence?: unknown; summary?: unknown; reasoning?: unknown;
  outcome_notes?: unknown; reschedule_datetime?: unknown; quoted_phrase?: unknown; lost_reason?: unknown;
}

function parseJsonObject(raw: string): DeepSeekRaw {
  let t = raw.trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();     // reasoning models
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`model returned no JSON: ${t.slice(0, 200)}`);
  return JSON.parse(t.slice(start, end + 1)) as DeepSeekRaw;
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

async function askDeepSeek(
  env: WorkerEnv, dialogue: string, allowed: string[], callTimeIso: string, durationSeconds: number | null,
): Promise<CallAnalysisResult> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const base = env.DEEPSEEK_BASE_URL.replace(/\/$/, '');
  const model = env.DEEPSEEK_MODEL;

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: buildSystemPrompt(allowed, callTimeIso) },
        {
          role: 'user',
          content: `مدة المكالمة: ${durationSeconds ?? 'غير معروفة'} ثانية\n\nنص المكالمة:\n${dialogue}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonObject(content);

  const outcome = str(parsed.outcome);
  if (!outcome || !allowed.includes(outcome)) {
    // Refusing beats guessing: an out-of-set value would render as an empty
    // popup, and a silently coerced one would put a wrong answer in front of
    // the rep with the AI's confidence attached.
    throw new Error(`model chose "${outcome ?? '(none)'}" which is not allowed for this follow-up type`);
  }

  const fields: Record<string, string> = {};
  const notes = str(parsed.outcome_notes);
  if (notes) fields.outcome_notes = notes;

  if (NEEDS_DATE.has(outcome)) {
    const iso = str(parsed.reschedule_datetime);
    const ms = iso ? Date.parse(iso) : NaN;
    if (iso && !Number.isNaN(ms)) {
      const slot = outcome === 'rescheduled' ? 'new_appointment_datetime' : 'reschedule_contact_date';
      fields[slot] = new Date(ms).toISOString();
    }
    // No date resolved («بعد العيد») → leave it blank for the rep. Never invent one.
  }
  if (NEEDS_LOST_REASON.has(outcome)) {
    const lr = str(parsed.lost_reason);
    if (lr && LOST_REASONS.includes(lr)) fields.lost_reason = lr;
  }

  const confRaw = Number(parsed.confidence);
  return {
    outcome,
    confidence: Number.isFinite(confRaw) ? Math.max(0, Math.min(100, Math.round(confRaw))) : 50,
    reasoning: str(parsed.reasoning) ?? '',
    summary: str(parsed.summary) ?? '',
    fields,
    quoted: str(parsed.quoted_phrase),
    model,
    source: 'deepseek',
  };
}

// ── runner ───────────────────────────────────────────────────────────────────

/** Hatif statuses that mean the call never connected to a person. */
const UNCONNECTED = new Set(['no_answer', 'missed', 'rejected_by_callee', 'rejected_by_caller', 'failed', 'cancelled', 'ringing']);

export async function runCallAnalysisJob({ supabase, env, job }: RunArgs): Promise<CallAnalysisResult> {
  const { data: call, error } = await supabase
    .from('call_logs')
    .select('id, status, duration_seconds, creation_time, transcription, recording_url')
    .eq('id', job.callLogId ?? job.callRecordId)
    .maybeSingle();
  if (error) throw new Error(`call_logs read failed: ${error.message}`);
  if (!call) throw new Error(`no call_logs row for ${job.callLogId ?? job.callRecordId}`);

  const allowedType = job.followupType && OUTCOMES_BY_TYPE[job.followupType] ? job.followupType : DEFAULT_TYPE;
  const allowed = OUTCOMES_BY_TYPE[allowedType]!;
  const duration = typeof call.duration_seconds === 'number' ? call.duration_seconds : null;
  const callTimeIso = typeof call.creation_time === 'string' ? call.creation_time : new Date().toISOString();

  // 1. Deterministic no-answer — the 55% that never reaches the model.
  const status = typeof call.status === 'string' ? call.status : '';
  const dialogue = buildDialogue(call.transcription);
  if (UNCONNECTED.has(status) || isNonConversation(dialogue, duration)) {
    if (!allowed.includes('no_answer')) {
      throw new Error(`call did not connect but "no_answer" is not allowed for ${allowedType}`);
    }
    console.log(`[run-call] job=${job.id} deterministic no_answer (status=${status || 'n/a'}, ${duration ?? '?'}s)`);
    return {
      outcome: 'no_answer',
      confidence: 100,
      reasoning: 'لم تتم المكالمة فعليًا — لا يوجد رد من العميل.',
      summary: 'لم يرد العميل على المكالمة.',
      fields: {},
      quoted: null,
      model: 'deterministic',
      source: 'deterministic',
    };
  }

  // 2. A real conversation → ask the model.
  console.log(`[run-call] job=${job.id} analysing ${dialogue.length} chars, type=${allowedType}`);
  const result = await askDeepSeek(env, dialogue, allowed, callTimeIso, duration);
  console.log(`[run-call] job=${job.id} → ${result.outcome} (${result.confidence}%)`);
  return result;
}
