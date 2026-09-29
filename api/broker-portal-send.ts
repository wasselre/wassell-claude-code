/**
 * POST /api/broker-portal-send  (ANONYMOUS — the broker-portal token is the credential)
 *
 * Body:
 *   { token, action: 'message', projectId }
 *       → { message: { ar, en } | null }   the exact text our line would send
 *         (saved template when its numbers are current, else the deterministic
 *         sheet — no AI call), for the broker's "copy message" button.
 *   { token, action: 'send', projectId, clientPhone, clientName?, brokerName,
 *     brokerPhone?, lang? }
 *       → { ok: true, media_queued } | { ok: false, reason }
 *
 * The send reuses sendProjectViaAiFlow — the SAME package the WhatsApp bot
 * sends (message → brochure → photos) on the default (sales) line — with a
 * first paragraph naming the broker, so the client knows who sent it and a rep
 * who picks up the reply knows the source.
 *
 * Every send is a first message to a stranger's number from our MAIN line —
 * the traffic WhatsApp restricts (463) and bans. The limits live in the
 * row-locked `broker_portal_send_claim` RPC (portal switch + daily cap, one
 * send per client per project per 24 h, 3 projects per client per 24 h,
 * 10 sends per hashed IP per hour). Do not add a send path that skips it.
 *
 * nodejs runtime: the send path (whatsappGateway / waha) is the one the bot
 * endpoints run on nodejs, so this endpoint does too.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'node:crypto';
import { makeServiceClient } from './_lib/serviceClient.js';
import { portalProject, resolvePortal } from './_lib/brokerPortal.js';
import { resolveProjectMessagePreview, sendProjectViaAiFlow } from './_lib/aiSendProject.js';
import { canonKsaPhone } from './_lib/careers.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 16_384) return null;
    chunks.push(b);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (e) {
    console.error('[broker-portal-send] bad JSON body:', (e as Error).message);
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function ipHash(req: IncomingMessage): string | null {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    || (req.headers['x-real-ip'] as string | undefined)
    || req.socket.remoteAddress
    || '';
  if (!fwd) return null;
  // Hashed so the log never stores a raw IP.
  return createHash('sha256').update(`broker-portal:${fwd}`).digest('hex').slice(0, 32);
}

function introLine(lang: 'ar' | 'en', clientName: string, brokerName: string, brokerPhone: string | null): string {
  if (lang === 'en') {
    const hi = clientName ? `Hello ${clientName},` : 'Hello,';
    return `${hi} here is the project information your real-estate broker ${brokerName}${brokerPhone ? ` (${brokerPhone})` : ''} asked us to send you.`;
  }
  const hi = clientName ? `مرحباً ${clientName}،` : 'مرحباً،';
  return `${hi} هذه معلومات المشروع التي طلب الوسيط العقاري ${brokerName}${brokerPhone ? ` (${brokerPhone})` : ''} إرسالها لك.`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { send(res, 405, { error: `Method ${req.method} not allowed` }); return; }
  const body = await readJson(req);
  if (!body) { send(res, 400, { error: 'invalid JSON body' }); return; }

  const svc = makeServiceClient('api:broker-portal-send');
  if (!svc) { send(res, 500, { error: 'Supabase env vars missing' }); return; }

  try {
    const portal = await resolvePortal(svc, s(body.token, 128));
    if (!portal) { send(res, 404, { error: 'link not available' }); return; }
    const project = await portalProject(svc, portal, s(body.projectId, 64));
    if (!project) { send(res, 404, { error: 'project not available' }); return; }

    if (body.action === 'message') {
      const message = await resolveProjectMessagePreview(svc, project.id);
      send(res, 200, { message, can_send: portal.send_enabled });
      return;
    }

    if (body.action !== 'send') { send(res, 400, { error: 'unknown action' }); return; }

    const phone = canonKsaPhone(s(body.clientPhone, 32));
    if (!phone) { send(res, 200, { ok: false, reason: 'invalid_phone' }); return; }
    const brokerName = s(body.brokerName, 80);
    if (brokerName.length < 2) { send(res, 200, { ok: false, reason: 'broker_name_required' }); return; }
    const brokerPhoneRaw = s(body.brokerPhone, 32);
    const brokerPhone = brokerPhoneRaw ? canonKsaPhone(brokerPhoneRaw) : null;
    if (brokerPhoneRaw && !brokerPhone) { send(res, 200, { ok: false, reason: 'invalid_broker_phone' }); return; }
    const clientName = s(body.clientName, 80);
    const lang: 'ar' | 'en' = body.lang === 'en' ? 'en' : 'ar';
    const digits = phone.slice(1);

    const { data: claimRows, error: claimErr } = await svc.rpc('broker_portal_send_claim', {
      p_portal_id: portal.id,
      p_project_id: project.id,
      p_client_phone: digits,
      p_client_name: clientName || null,
      p_broker_name: brokerName,
      p_broker_phone: brokerPhone,
      p_lang: lang,
      p_ip_hash: ipHash(req),
    });
    if (claimErr) throw new Error(`send claim failed: ${claimErr.message}`);
    const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as { ok: boolean; reason: string | null; send_id: string | null } | null;
    if (!claim?.ok || !claim.send_id) { send(res, 200, { ok: false, reason: claim?.reason ?? 'unavailable' }); return; }

    const result = await sendProjectViaAiFlow(svc, {
      chatWid: `${digits}@c.us`,
      projectId: project.id,
      jobId: `broker-${claim.send_id}`,
      // The broker explicitly asked for this send; the bot's "a human took over
      // this chat" gate does not apply to a first, requested delivery.
      force: true,
      allowAi: false,
      lang,
      introText: introLine(lang, clientName, brokerName, brokerPhone),
    });

    const ok = result.queued === true;
    const { error: finErr } = await svc.rpc('broker_portal_send_finish', {
      p_send_id: claim.send_id,
      p_status: ok ? 'queued' : 'failed',
      p_error: ok ? null : (result.error ?? result.reason ?? 'not queued'),
      p_media_queued: result.media_queued ?? 0,
    });
    if (finErr) console.error('[broker-portal-send] finish log failed:', finErr.message, claim.send_id);

    if (!ok) {
      console.error('[broker-portal-send] send not queued:', result.error ?? result.reason, claim.send_id);
      send(res, 200, { ok: false, reason: 'send_failed' });
      return;
    }
    send(res, 200, { ok: true, media_queued: result.media_queued ?? 0 });
  } catch (e) {
    console.error('[broker-portal-send] failed:', (e as Error).message);
    send(res, 500, { error: (e as Error).message });
  }
}
