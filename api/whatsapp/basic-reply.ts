/**
 * POST /api/whatsapp/basic-reply
 *
 * The BASIC WhatsApp responder — fast, deterministic first-touch replies with a
 * single Kimi fallback. This is NOT a Claude Code session: the common messages
 * (greetings, ad-lead openers, "no rentals") are answered by pattern rules in
 * ~1s; only the ambiguous tail costs one Kimi API call; anything real is handed
 * off to a human. The heavy agentic "Saad" path (a real Claude session on the
 * Fly worker) stays available and is selected by whatsapp_ai_settings.responder_mode='agent'.
 *
 * Called by the WAHA webhook on every new inbound. It reuses the existing send /
 * notify / project-sheet endpoints so there is no duplicate send or audit logic:
 *   - reply text  → POST /api/whatsapp/ai-send      (gate re-check + queue + audit)
 *   - project card→ POST /api/templates/project-message (deterministic sheet)
 *   - handoff     → POST /api/whatsapp/ai-notify     (Tasks → AI notifications)
 *
 * Auth: x-wassel-ai-secret === WHATSAPP_AI_SECRET.
 * Body: { chat_wid, trigger_message?, chat_record_id?, device_id?, phone? }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { resolveProjectSheet } from '../_lib/projectSheet.js';
import { enqueueAiReply } from '../_lib/aiSend.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

// ── Node↔Web bridge (nodejs runtime ignores a returned Web Response) ─────────
async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function jsonRes(nodeRes: ServerResponse, status: number, body: unknown): void {
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', 'application/json');
  nodeRes.end(JSON.stringify(body));
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── House replies (verbatim from the whatsapp-basic-reply skill) ─────────────
const GREETING = 'أهلاً وسهلا، كيف أقدر أخدمك؟';
const QUALIFY =
  'تأمر أمر، مشاريعنا في الرياض أكثر من 50 مشروع، عشان نعرض لك الخيارات المناسبة نحتاج نعرف التالي:\n' +
  '- نوع الوحدة الي تفضلها ( شقة، دور، فيلا..)؟\n' +
  '- الأحياء أو المناطق الي تفضلها؟\n' +
  '- تحب السعر يكون أقل من كم؟';
const NO_SERVICE = 'لا الله يسلمك، هذا الشي ما هو متوفر عندنا حالياً.';
const HOLDING = 'أبشر، بيتواصل معك زميلي في أقرب وقت إن شاء الله.';
const MEDIA_HOLDING = 'أهلاً وسهلا، وصلني — لحظات ويتواصل معك زميلي.';

/** Fold Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Western so «مينا ٥٢» == «مينا 52». */
function foldDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

type Action = 'greet' | 'qualify' | 'project_sheet' | 'no_service' | 'handoff' | 'kimi';
interface Decision { action: Action; projectName?: string; reason?: string; severity?: 'info' | 'action' | 'warning'; silent?: boolean; holding?: string; reply?: string }

/** Deterministic classifier — no LLM. Returns 'kimi' only for the ambiguous tail. */
function classify(raw: string | null | undefined): Decision {
  const t = foldDigits((raw ?? '').trim());
  if (!t) return { action: 'handoff', reason: 'media', severity: 'info', holding: MEDIA_HOLDING };
  const low = t.toLowerCase();

  // B2B / spam — never sell; hand off silently with a warning note.
  if (/دعاي|الاعلان|الإعلان|عرض الخدمات|عرض خدمات|شركة متخصص|تطوير وتشغيل|توقيع اتفاقية|الاسم التجاري|وكيل تنفيذ|نادي ذكي|مسؤول التسويق|حابة اتواصل|حابه اتواصل/.test(t))
    return { action: 'handoff', reason: 'b2b', severity: 'warning', silent: true };

  // Things we don't offer.
  if (/للايجار|للإيجار|إيجار|ايجار|تأجير|أرض للبيع|ارض للبيع|محل تجاري|مكتب للايجار/.test(t))
    return { action: 'no_service' };

  // Named-project ad lead → send that project's sheet.
  const m = t.match(/مهتم.{0,8}(?:بمشروع|في مشروع|بمشروعكم)\s+(.+)/);
  if (m && m[1]) return { action: 'project_sheet', projectName: m[1].trim() };

  // Area / vague search intent → the 3-question qualification block.
  if (/مهتم بمشاريع سكني|مشاريع سكنية (?:اخرى|أخرى)|أبحث عن منزل|ابحث عن منزل|استشارة عقاري|متوفر شق|عندكم مشاريع|عندكم شقق|عندكم فلل|ابي اعرف الاسعار|أبي أعرف الأسعار/.test(t))
    return { action: 'qualify' };

  // Greeting.
  if (/^(?:وعليكم\s+)?(?:ال)?سلام|^سلام|^هلا|^هلو|^اهل|^أهل|^مرحب|^صباح|^مساء|^هاي|^أهلين|^اهلين|^hi\b|^hello|^hey|^salam|^hala/.test(low) || t.length <= 3)
    return { action: 'greet' };

  return { action: 'kimi' };
}

// ── Kimi fallback — one call, tightly constrained to the same menu ───────────
const KIMI_SYSTEM = `You classify ONE inbound WhatsApp message for a Saudi real-estate company's BASIC auto-responder (سعد من وصل العقارية). Pick the single best action; DO NOT write marketing copy and NEVER invent any price, project fact, or place name.

Actions:
- "greet": a greeting/small talk → you MAY put a short warm Saudi-dialect greeting in reply_ar.
- "qualify": they want to search for a property but named no specific project → we ask the 3 standard questions (leave reply_ar empty).
- "project_sheet": they named one of our projects → put the project name in project_name (leave reply_ar empty).
- "no_service": they ask for rentals / commercial / land (we don't offer these).
- "handoff": ANYTHING else — negotiation, payment, complaint, a question you can't answer from nothing, or unclear. Default to this when unsure.

Return via the classify tool only.`;

const KIMI_TOOL = {
  name: 'classify',
  description: 'Classify the message into one basic action.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['greet', 'qualify', 'project_sheet', 'no_service', 'handoff'] },
      project_name: { type: 'string', description: 'Only for project_sheet — the project the customer named.' },
      reply_ar: { type: 'string', description: 'Only for greet — a short Arabic greeting.' },
    },
    required: ['action'],
  },
};

async function kimiClassify(message: string): Promise<Decision> {
  const kimiKey = process.env.KIMI_API_KEY;
  if (!kimiKey) return { action: 'handoff', reason: 'kimi_unconfigured', severity: 'action', holding: HOLDING };
  const client = new Anthropic({ apiKey: kimiKey, baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic' });
  const model = process.env.KIMI_MODEL || 'kimi-k3';
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      system: KIMI_SYSTEM,
      tools: [KIMI_TOOL],
      tool_choice: { type: 'tool', name: 'classify' },
      thinking: { type: 'disabled' as const },
      messages: [{ role: 'user', content: message.slice(0, 1500) }],
    });
    const block = resp.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return { action: 'handoff', reason: 'kimi_no_tool', severity: 'action', holding: HOLDING };
    const out = block.input as { action?: Action; project_name?: string; reply_ar?: string };
    const action = out.action ?? 'handoff';
    if (action === 'greet') return { action: 'greet', reply: (out.reply_ar || '').trim() || undefined };
    if (action === 'project_sheet') return { action: 'project_sheet', projectName: (out.project_name || '').trim() };
    if (action === 'no_service') return { action: 'no_service' };
    if (action === 'qualify') return { action: 'qualify' };
    return { action: 'handoff', reason: 'kimi_handoff', severity: 'action', holding: HOLDING };
  } catch (err) {
    console.error('[basic-reply] kimi call failed:', err instanceof Error ? err.message : String(err));
    return { action: 'handoff', reason: 'kimi_error', severity: 'action', holding: HOLDING };
  }
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  if (nodeReq.method === 'GET') return jsonRes(nodeRes, 200, { ok: true, hint: 'POST { chat_wid, trigger_message } with x-wassel-ai-secret' });
  if (nodeReq.method !== 'POST') return jsonRes(nodeRes, 405, { error: 'Method not allowed' });

  const secret = process.env.WHATSAPP_AI_SECRET;
  if (!secret) return jsonRes(nodeRes, 500, { error: 'WHATSAPP_AI_SECRET not configured' });
  const provided = (nodeReq.headers['x-wassel-ai-secret'] as string | undefined) ?? '';
  if (!constantTimeEqual(provided, secret)) return jsonRes(nodeRes, 401, { error: 'unauthorized' });

  let body: { chat_wid?: string; trigger_message?: string; chat_record_id?: string; device_id?: string; phone?: string };
  try { body = JSON.parse((await readNodeBody(nodeReq)).toString('utf-8') || '{}'); }
  catch { return jsonRes(nodeRes, 400, { error: 'invalid JSON body' }); }

  const chatWid = (body.chat_wid ?? '').trim();
  if (!chatWid) return jsonRes(nodeRes, 400, { error: 'chat_wid is required' });

  const supa = getServiceSupabase();

  // Mode routing: 'agent' → delegate to the heavy Claude-session runner (Saad).
  const { data: settings } = await supa.from('whatsapp_ai_settings').select('responder_mode').maybeSingle();
  if ((settings?.responder_mode ?? 'basic') === 'agent') {
    const { error: enqErr } = await supa.rpc('whatsapp_ai_enqueue', {
      p_chat_wid: chatWid,
      p_chat_record_id: body.chat_record_id ?? null,
      p_phone: body.phone ?? null,
      p_device_id: body.device_id ?? null,
      p_trigger_message: body.trigger_message ?? null,
    });
    if (enqErr) console.error('[basic-reply] agent enqueue failed:', enqErr.message);
    return jsonRes(nodeRes, 200, { delegated: 'agent' });
  }

  // Gate: kill switch, schedule, permanent-human-stop, reply cap.
  const { data: gate } = await supa.rpc('whatsapp_ai_should_reply', { p_chat_wid: chatWid });
  const g = Array.isArray(gate) ? gate[0] : gate;
  if (g?.should_reply !== true) return jsonRes(nodeRes, 200, { skipped: true, reason: g?.reason ?? 'blocked' });

  // Decide.
  let d = classify(body.trigger_message);
  if (d.action === 'kimi') d = await kimiClassify(foldDigits((body.trigger_message ?? '').trim()));

  // Resolve the reply text (+ handoff) per action.
  let replyText: string | null = null;
  let handoff = false;
  let severity: 'info' | 'action' | 'warning' = 'info';
  let summary = '';

  if (d.action === 'greet') {
    replyText = d.reply || GREETING;
    summary = 'ترحيب بسيط بعميل جديد.';
  } else if (d.action === 'qualify') {
    replyText = QUALIFY;
    handoff = true; severity = 'action';
    summary = 'العميل يبحث عن عقار بدون مشروع محدد — أُرسلت أسئلة التفضيلات، يحتاج متابعة مندوب للبحث.';
  } else if (d.action === 'no_service') {
    replyText = NO_SERVICE;
    summary = 'العميل يسأل عن خدمة غير متوفرة (إيجار/تجاري/أرض).';
  } else if (d.action === 'project_sheet') {
    const sheet = await resolveProjectSheet(supa, supa, { projectName: d.projectName });
    if (sheet.ok && sheet.body_ar) {
      replyText = sheet.body_ar;
      summary = `أُرسلت بطاقة مشروع «${d.projectName}» للعميل.`;
    } else {
      // Couldn't resolve the project → hand off rather than guess.
      replyText = HOLDING; handoff = true; severity = 'action';
      summary = `العميل مهتم بمشروع «${d.projectName ?? ''}» لكن تعذّر إيجاده — يحتاج متابعة مندوب.`;
    }
  } else {
    // handoff (incl. media, b2b, kimi-handoff)
    handoff = true;
    severity = d.severity ?? 'action';
    replyText = d.silent ? null : (d.holding || HOLDING);
    summary = d.reason === 'b2b'
      ? 'رسالة تسويق/جهة أعمال (ليست عميلاً) — تحتاج مراجعة بشرية.'
      : d.reason === 'media'
        ? 'العميل أرسل وسائط (صوت/صورة/ملف) بدون نص — يحتاج متابعة مندوب.'
        : 'رسالة تحتاج تدخّل بشري (تفاوض/استفسار خارج النطاق).';
  }

  // Send the reply (in-process: gate re-check + device + queue + audit).
  let sent = false;
  if (replyText) {
    const res = await enqueueAiReply(supa, { chatWid, text: replyText, deviceId: body.device_id, jobId: 'basic' });
    if (res.blocked) return jsonRes(nodeRes, 200, { action: d.action, sent: false, blocked: true, reason: res.reason });
    sent = res.queued;
  }

  // Notify the operator on handoff (direct insert — no HTTP hop).
  if (handoff) {
    const { error: notifyErr } = await supa.from('ai_notifications').insert({
      source: 'whatsapp', severity, title: null, body: summary,
      chat_wid: chatWid, chat_record_id: body.chat_record_id ?? null,
    });
    if (notifyErr) console.error('[basic-reply] notify insert failed:', notifyErr.message);
  }

  return jsonRes(nodeRes, 200, { action: d.action, sent, handoff, summary });
}
