/**
 * Transliterate an Arabic real-estate project name to English (Latin script)
 * via /api/transliterate-name. Phonetic (NOT a meaning translation): "مينا 52"
 * → "Mena 52", "الماجدية" → "Almajdiya". Used by the project-message generator
 * to fill the English body's title line.
 *
 * Cached + dedup'd in-memory for the page lifetime (a name is transliterated
 * once). THROWS on failure — the caller falls back to the original Arabic name
 * so the message still composes (e.g. offline / API down).
 */

import { supabase } from '@/lib/supabase';

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function transliterateName(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  const cached = cache.get(trimmed);
  if (cached) return cached;
  const existing = inFlight.get(trimmed);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    const res = await fetch('/api/transliterate-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ name: trimmed }),
    });
    let body: { ok?: boolean; name_en?: string; error?: string };
    try {
      body = (await res.json()) as { ok?: boolean; name_en?: string; error?: string };
    } catch {
      throw new Error(`transliterate-name returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok || !body.ok || !body.name_en) {
      throw new Error(body.error ?? `transliterate-name failed (HTTP ${res.status})`);
    }
    const result = body.name_en.trim();
    cache.set(trimmed, result);
    return result;
  })();

  inFlight.set(trimmed, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(trimmed);
  }
}
