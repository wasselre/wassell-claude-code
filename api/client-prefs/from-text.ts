/**
 * POST /api/client-prefs/from-text — the rep types the client's preferences in
 * plain words and gets them back as FIELD VALUES (2026-10-05, operator).
 *
 * Body: { text: string (≤ 2,000 chars), clientId?: uuid }
 * → {
 *     suggestions: { [slug]: { value, quote, confidence } }   // unit type, bedrooms,
 *                                                              // budget, purpose,
 *                                                              // ready/off-plan, size, amenities
 *     location_items: LocationItem[]                           // places, as the location field stores them
 *     understood_places: string[]                              // what the geography reader understood
 *   }
 *
 * Two existing readers, run in parallel, nothing new invented:
 *   · the preference extractor (api/_lib/prefExtract — DeepSeek → Haiku, metered)
 *     reads the note as the client's own words;
 *   · the geography agent (geoGate.readPlaceItems — the same pipeline as the
 *     WhatsApp agent and the places card) turns any place into location_items.
 * READ-ONLY: nothing is written here. The SPA applies the result to the
 * preference draft as AI-filled values (marked for review) and the panel's
 * autosave persists them.
 *
 * Auth: a signed-in user; with a clientId, the caller must be able to see that
 * client under their own RLS.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { extractPreferences } from '../_lib/prefExtract.js';
import { readPlaceItems } from '../_lib/salesAgent/geoGate.js';
import {
  readNodeBodyLimited, PayloadTooLargeError, sendPayloadTooLarge, MAX_REQUEST_BODY_BYTES,
} from '../_lib/httpBody.js';

export const config = {
  runtime: 'nodejs',
  // One extraction call + the geography pipeline (~10–25 s for a place-heavy note).
  maxDuration: 120,
};

const SERVICE_NAME = 'api:client-prefs-from-text';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBodyLimited(nodeReq, MAX_REQUEST_BODY_BYTES);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let req: Request;
  try {
    req = await nodeToWebRequest(nodeReq);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return sendPayloadTooLarge(nodeRes, err.limitBytes);
    throw err;
  }

  const resp = await withAuth(req, async (user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
    let body: { text?: unknown; clientId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return jsonError(400, 'text is required');
    if (text.length > MAX_TEXT) return jsonError(400, `text is longer than ${MAX_TEXT} characters`);
    const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;
    if (clientId && !UUID_RE.test(clientId)) return jsonError(400, 'clientId must be a uuid');
    if (clientId) await assertCanAccessRecord(req, clientId, SERVICE_NAME);

    const sb = makeServiceClient(SERVICE_NAME);
    if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    const started = Date.now();
    try {
      // The note is read as the client's own words (one «العميل» line).
      const [prefs, places] = await Promise.all([
        extractPreferences({ channel: 'chat', transcript: `[1] العميل: ${text.replace(/\s+/g, ' ')}`, entity: clientId ? { kind: 'client', id: clientId } : null }),
        readPlaceItems(sb, text, clientId),
      ]);
      const suggestions: Record<string, { value: unknown; quote: string | null; confidence: number }> = {};
      for (const [slug, s] of Object.entries(prefs.output.suggestions)) {
        suggestions[slug] = { value: s.value, quote: s.quote, confidence: s.confidence };
      }
      // What actually became a place in the field (labels of the items), and what
      // was understood but could not be put on the map (e.g. «near a metro» with
      // no station named) — reported, never silently dropped.
      const itemLabel = (i: (typeof places.items)[number]) =>
        ((i as { district_label?: string }).district_label ?? (i as { element_label?: string }).element_label ?? (i as { label?: string }).label ?? '').trim();
      const placed = [...new Set(places.items.map(itemLabel).filter(Boolean))];
      const notPlaced = places.understood.map((u) => u.place).filter((p) => p && !placed.includes(p));
      console.log(`[client-prefs/from-text] client=${clientId ?? '-'} by=${user.userId} fields=${Object.keys(suggestions).join(',') || '-'} places=${places.items.length} model=${prefs.model} ${Date.now() - started}ms`);
      return jsonOk({ suggestions, location_items: places.items, understood_places: placed, not_placed: [...new Set(notPlaced)] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[client-prefs/from-text] client=${clientId ?? '-'} failed:`, msg);
      return jsonError(500, msg);
    }
  });

  await writeWebResponseToNode(resp, nodeRes);
}
