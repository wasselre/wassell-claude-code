/**
 * GET  /api/whatsapp/ai-settings  → current config + a live "would it reply now?" probe
 * POST /api/whatsapp/ai-settings  → update it (admin only)
 *
 * Backs the Settings → «المساعد الذكي للواتساب» page. RLS does the real
 * authorization (the UPDATE policy requires wassell_is_admin), so this runs with
 * the CALLER's JWT rather than service role — a non-admin's write is refused by
 * Postgres, not by a check we could forget.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';

export const config = { runtime: 'edge' };

function scopedClient(req: Request) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Supabase env missing');
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

const INT = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.trunc(n) : null;
};

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async () => {
    const supa = scopedClient(req);

    if (req.method === 'GET') {
      const { data, error } = await supa.from('whatsapp_ai_settings').select('*').maybeSingle();
      if (error) return jsonError(500, error.message);
      // Live probe so the page can say "answering now" / "humans are on" without
      // the UI re-implementing the schedule logic.
      const { data: probe } = await supa.rpc('whatsapp_ai_should_reply', {
        p_chat_wid: '__probe__@c.us',
      });
      const p = Array.isArray(probe) ? probe[0] : probe;
      return jsonOk({
        settings: data,
        now: { would_reply: p?.should_reply === true, reason: p?.reason ?? null },
      });
    }

    if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return jsonError(400, 'invalid JSON body'); }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.is_enabled === 'boolean') patch.is_enabled = body.is_enabled;

    const start = INT(body.work_start_hour, 0, 23);
    const end   = INT(body.work_end_hour, 1, 24);
    if (body.work_start_hour !== undefined) {
      if (start === null) return jsonError(400, 'work_start_hour must be 0–23');
      patch.work_start_hour = start;
    }
    if (body.work_end_hour !== undefined) {
      if (end === null) return jsonError(400, 'work_end_hour must be 1–24');
      patch.work_end_hour = end;
    }
    // An empty or inverted window would silently mean "humans never cover" or
    // "always cover" — reject rather than let the schedule lie to the operator.
    const s = (patch.work_start_hour ?? start) as number | undefined;
    const e = (patch.work_end_hour ?? end) as number | undefined;
    if (s !== undefined && e !== undefined && s !== null && e !== null && e <= s) {
      return jsonError(400, 'work_end_hour must be greater than work_start_hour');
    }

    if (body.work_days !== undefined) {
      const days = Array.isArray(body.work_days)
        ? body.work_days.map((d) => INT(d, 1, 7)).filter((d): d is number => d !== null)
        : null;
      if (!days) return jsonError(400, 'work_days must be an array of 1–7 (Mon=1 … Sun=7)');
      patch.work_days = Array.from(new Set(days)).sort();
    }
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || !body.timezone.includes('/')) {
        return jsonError(400, 'timezone must be an IANA name, e.g. Asia/Riyadh');
      }
      patch.timezone = body.timezone;
    }
    const cap = INT(body.max_replies_per_chat, 1, 100);
    if (body.max_replies_per_chat !== undefined) {
      if (cap === null) return jsonError(400, 'max_replies_per_chat must be 1–100');
      patch.max_replies_per_chat = cap;
    }
    const quiet = INT(body.human_quiet_hours, 0, 168);
    if (body.human_quiet_hours !== undefined) {
      if (quiet === null) return jsonError(400, 'human_quiet_hours must be 0–168');
      patch.human_quiet_hours = quiet;
    }

    const { data, error } = await supa
      .from('whatsapp_ai_settings').update(patch).eq('id', true).select().maybeSingle();
    if (error) return jsonError(500, error.message);
    // RLS refuses a non-admin update by matching zero rows rather than erroring.
    if (!data) return jsonError(403, 'not permitted (admin only)');
    return jsonOk({ settings: data });
  });
}
