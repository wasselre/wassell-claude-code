/**
 * Browser client for POST /api/client-prefs/from-text — the rep's free-text
 * preference note → field values (see api/client-prefs/from-text.ts). Read-only
 * on the server; the caller applies the result to the preference draft. A
 * failure THROWS with a readable message — never an empty reading that looks
 * like "the note said nothing".
 */
import { supabase } from '@/lib/supabase';
import type { ExtractionInput } from '@/lib/salesProcess/qualificationDraft';
import type { LocationItem } from '@/lib/geo/locationItems';

export interface FromTextResult {
  suggestions: ExtractionInput['suggestions'];
  location_items: LocationItem[];
  /** Places that became items in the location field. */
  understood_places: string[];
  /** Places understood but not placeable on the map (e.g. «near a metro»). */
  not_placed: string[];
}

export async function readPrefsFromText(text: string, clientId: string | null): Promise<FromTextResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch('/api/client-prefs/from-text', { method: 'POST', headers, body: JSON.stringify({ text, clientId }) });
  if (!res.ok) {
    const raw = await res.text();
    let message = '';
    try { message = (JSON.parse(raw) as { error?: string }).error ?? ''; } catch { message = raw.slice(0, 200); }
    throw new Error(message || `POST /api/client-prefs/from-text failed (${res.status})`);
  }
  return (await res.json()) as FromTextResult;
}
