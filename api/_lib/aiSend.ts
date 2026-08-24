/**
 * Shared: the one AI-reply send path — re-check the gate (unless force), resolve
 * an active device, enqueue to the scheduled-send queue (the Fly worker delivers;
 * Vercel egress to WAHA is 403-blocked), and record the audit / human-vs-AI row.
 *
 * Extracted from api/whatsapp/ai-send.ts so the in-process basic responder can
 * send directly (no internal HTTP hop) and the endpoint stays a thin wrapper.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveDefaultDeviceId } from './whatsappGateway.js';

export interface EnqueueResult {
  queued: boolean;
  sent: boolean;
  blocked?: boolean;
  reason?: string;
  wid?: string;
  audit_ok?: boolean;
  error?: string;
}

export async function enqueueAiReply(
  supa: SupabaseClient,
  opts: { chatWid: string; text: string; deviceId?: string | null; jobId?: string | null; force?: boolean },
): Promise<EnqueueResult> {
  const chatWid = (opts.chatWid ?? '').trim();
  const text = (opts.text ?? '').trim();
  if (!chatWid) return { queued: false, sent: false, error: 'chat_wid is required' };
  if (!text) return { queued: false, sent: false, error: 'body is required' };
  if (text.length > 4000) return { queued: false, sent: false, error: 'body too long (max 4000 chars)' };

  // Re-check the gate immediately before sending (a human may have replied).
  if (opts.force !== true) {
    const { data, error } = await supa.rpc('whatsapp_ai_should_reply', { p_chat_wid: chatWid });
    if (error) return { queued: false, sent: false, error: `gate check failed: ${error.message}` };
    const row = (Array.isArray(data) ? data[0] : data) as { should_reply?: boolean; reason?: string } | null;
    if (row?.should_reply !== true) return { queued: false, sent: false, blocked: true, reason: row?.reason ?? 'blocked' };
  }

  const digits = chatWid.split('@')[0] ?? '';
  if (!/^\d{8,15}$/.test(digits)) return { queued: false, sent: false, error: `unsupported chat_wid: ${chatWid}` };

  // Only an ACTIVE device may be used; a stale one dies at the gateway.
  let deviceId: string | null = null;
  const requested = opts.deviceId?.trim() || null;
  if (requested) {
    const { data: dev } = await supa
      .from('whatsapp_numbers').select('device_id').eq('device_id', requested).eq('is_active', true).maybeSingle();
    deviceId = dev?.device_id ?? null;
  }
  deviceId = deviceId ?? (await resolveDefaultDeviceId());
  if (!deviceId) return { queued: false, sent: false, error: 'no active WhatsApp device configured' };

  const { data: schedId, error: schedErr } = await supa.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: deviceId,
    p_chat_wid: chatWid,
    p_phone: `+${digits}`,
    p_body: text,
    p_media: null,
    p_reference: `ai:${opts.jobId ?? 'basic'}:${Date.now()}`,
    p_deliver_at: new Date().toISOString(),
    p_user_id: null,
  });
  if (schedErr) return { queued: false, sent: false, error: `enqueue failed: ${schedErr.message}` };
  const wid = `sched:${String(schedId)}`;

  // Audit + the human-vs-AI discriminator. A missing row makes this look
  // human-sent and would suppress future AI replies — so log loudly on failure.
  const { error: auditErr } = await supa.from('whatsapp_ai_replies').insert({
    message_wid: wid, chat_wid: chatWid, job_id: opts.jobId ?? null, body: text.slice(0, 2000),
  });
  if (auditErr) console.error('[aiSend] AUDIT INSERT FAILED — this message will look human-sent:', auditErr.message, wid);

  return { queued: true, sent: false, wid, audit_ok: !auditErr };
}
