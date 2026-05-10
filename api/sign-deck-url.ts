/**
 * POST /api/sign-deck-url
 *
 * Mints a fresh 7-day signed URL for an existing deck record's stored .pptx.
 * Used when a user reopens a deck whose `file_url` has expired or just to
 * refresh the URL on every page load (cheap, no extra side effects).
 *
 * The endpoint reads `data.file_path` from the record, verifies that the
 * path's first segment is the caller's user id (defense in depth — the
 * Storage RLS policy already enforces this), creates the signed URL, and
 * also updates the record's `file_url` so future renders use the fresh URL
 * without an extra round trip.
 *
 * Request body:
 *   { recordId: string }
 *
 * Response:
 *   { file_url: string, filename: string }
 *   or { error: string }
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

const STORAGE_BUCKET = 'wassel-decks';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: { recordId?: string };
    try {
      body = (await req.json()) as { recordId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.recordId) return jsonError(400, 'recordId is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: rec, error: readErr } = await supabase
      .from('records')
      .select('data, model_id, created_by_user_id')
      .eq('id', body.recordId)
      .single();
    if (readErr || !rec) return jsonError(404, `record not found: ${readErr?.message ?? 'unknown'}`);

    const data = rec.data as { file_path?: string; filename?: string; status?: string };
    if (!data.file_path) return jsonError(404, 'record has no file yet');

    // Defense in depth: even though storage RLS gates this, refuse to sign a
    // URL for a path that isn't owned by the caller.
    const firstSegment = data.file_path.split('/')[0];
    if (firstSegment !== user.userId) return jsonError(403, 'not your file');

    const { data: signed, error: signErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(data.file_path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed) {
      return jsonError(500, `signed URL creation failed: ${signErr?.message ?? 'unknown'}`);
    }

    // Persist the fresh URL so reopens are a single round trip. Best effort —
    // a write failure here doesn't block the caller (they got their URL).
    // Pass the EXISTING created_by_user_id (or null) — see generate-deck.ts
    // for the FK-violation rationale.
    void supabase
      .rpc('record_save', {
        p_model_id: rec.model_id,
        p_id: body.recordId,
        p_data: { ...data, file_url: signed.signedUrl },
        p_created_by: (rec as { created_by_user_id: string | null }).created_by_user_id ?? null,
        p_expected_version: null,
      })
      .then(({ error }) => {
        if (error) console.error('[sign-deck-url] record_save failed:', error.message);
      });

    return jsonOk({
      file_url: signed.signedUrl,
      filename: data.filename ?? 'deck.pptx',
    });
  });
}
