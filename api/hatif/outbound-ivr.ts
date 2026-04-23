/**
 * POST /api/hatif/outbound-ivr
 *
 * Fire an outbound IVR call. Called by the workflow engine when it executes
 * an `outbound_ivr` action. Hatif's client-secret is server-side — never
 * call Hatif's endpoint directly from the browser.
 *
 * Body shape (JSON):
 *   {
 *     destinationNumber: "+9665...",       // required, E.164
 *     channelId:         "<uuid>",         // optional; falls back to HATIF_DEFAULT_CHANNEL_ID
 *     ttsText:           "Hello {name}",   // REQUIRED unless audioFileUrl
 *     ttsVoice:          "Female" | "Male",// optional, default Female
 *     audioFileUrl:      "https://...",    // REQUIRED unless ttsText (never both)
 *     options: [
 *       { digit: "1", label: "Confirm" },  // at least one required
 *       { digit: "2", label: "Cancel" }
 *     ],
 *     externalId:        "workflow-run-42" // optional idempotency key
 *   }
 *
 * The `webhookUrl` is attached server-side to `${origin}/api/webhook/hatif-call`
 * — we don't let the caller pick it, so every IVR result flows into our
 * existing call_logs pipeline.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import {
  triggerOutboundIvr,
  defaultChannelId,
  HatifError,
  type HatifIvrOption,
} from '../_lib/hatif.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const destinationNumber = typeof input.destinationNumber === 'string' ? input.destinationNumber : '';
    if (!destinationNumber) {
      return jsonError(400, 'destinationNumber is required');
    }

    const channelId =
      (typeof input.channelId === 'string' && input.channelId) ||
      defaultChannelId() ||
      '';
    if (!channelId) {
      return jsonError(400, 'channelId is required (pass in body or set HATIF_DEFAULT_CHANNEL_ID)');
    }

    const rawOptions = Array.isArray(input.options) ? input.options : [];
    const options: HatifIvrOption[] = [];
    for (const opt of rawOptions) {
      if (opt && typeof opt === 'object') {
        const o = opt as Record<string, unknown>;
        if (typeof o.digit === 'string' && typeof o.label === 'string') {
          options.push({ digit: o.digit, label: o.label });
        }
      }
    }
    if (options.length === 0) {
      return jsonError(400, 'options must contain at least one {digit, label}');
    }

    const ttsText = typeof input.ttsText === 'string' && input.ttsText ? input.ttsText : undefined;
    const ttsVoice = input.ttsVoice === 'Male' ? 'Male' : input.ttsVoice === 'Female' ? 'Female' : undefined;
    const audioFileUrl = typeof input.audioFileUrl === 'string' && input.audioFileUrl ? input.audioFileUrl : undefined;
    const externalId = typeof input.externalId === 'string' ? input.externalId : undefined;

    // Always route IVR results into OUR webhook. The webhook handler already
    // verifies the secret and upserts into call_logs, so IVR-result events
    // land alongside regular post-call events with the same auth model.
    const secret = process.env.HATIF_WEBHOOK_SECRET ?? '';
    const origin = new URL(req.url).origin;
    const webhookUrl = secret
      ? `${origin}/api/webhook/hatif-call?secret=${encodeURIComponent(secret)}`
      : `${origin}/api/webhook/hatif-call`;

    try {
      const result = await triggerOutboundIvr({
        channelId,
        destinationNumber,
        webhookUrl,
        options,
        ttsText,
        ttsVoice: ttsVoice as 'Male' | 'Female' | undefined,
        audioFileUrl,
        externalId,
      });
      return jsonOk({
        ivrCallId: result.ivrCallId ?? null,
        channelId,
        destinationNumber,
      });
    } catch (err) {
      if (err instanceof HatifError) {
        // Map Hatif 4xx to our 4xx; Hatif 5xx becomes 502 (we're proxying).
        const status = err.status >= 500 ? 502 : err.status;
        return jsonError(status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
