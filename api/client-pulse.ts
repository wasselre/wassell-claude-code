/**
 * GET /api/client-pulse — what is happening with every client the caller can
 * see: interest level (hot / warm / quiet / unknown / closed) and why, the top
 * project, the current situation, the last action (by the AI or a person), the
 * last contact, and the visit. Powers the Sales client list (operator,
 * 2026-10-08: "one list with all of the clients … hot clients … what's
 * happening … the last action … the top project … if they want to visit").
 *
 * All of it is derived in SQL by `client_pulse(ids)` (migration
 * 2026-10-08_05) from recorded facts — no model call.
 *
 * Gate: the caller's own Supabase session lists the client ids it may see
 * (records RLS, keyset-paginated — never cut at 1,000); only those ids go to
 * the service-role function, which reads chats and officer lines a rep cannot
 * browse directly.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from './_lib/auth.js';
import { getServiceSupabase } from './_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

const PAGE = 1000;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const svc = getServiceSupabase();

    const { data: model, error: mErr } = await svc.from('models').select('id').eq('name', 'clients').maybeSingle();
    if (mErr) return jsonError(500, `clients model lookup failed: ${mErr.message}`);
    const modelId = (model as { id?: string } | null)?.id;
    if (!modelId) return jsonError(500, 'clients model not found');

    // Every client the caller may see — keyset pages (id order), to an empty page.
    const ids: string[] = [];
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const { data, error } = await scoped.from('records').select('id')
        .eq('model_id', modelId).gt('id', after).order('id', { ascending: true }).limit(PAGE);
      if (error) return jsonError(500, `visible clients read failed: ${error.message}`);
      const page = (data ?? []) as Array<{ id: string }>;
      for (const r of page) ids.push(r.id);
      if (page.length < PAGE) break;
      after = page[page.length - 1]!.id;
    }
    if (!ids.length) return jsonOk({ clients: [] });

    const { data: rows, error: pErr } = await svc.rpc('client_pulse', { p_client_ids: ids });
    if (pErr) return jsonError(500, `client pulse failed: ${pErr.message}`);
    return jsonOk({ clients: rows ?? [] });
  });
}
