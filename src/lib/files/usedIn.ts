/**
 * Client for the Phase 1 read-only "Used in" panel.
 *
 * FEATURE-FLAGGED AND OFF BY DEFAULT. The projection it reads is an
 * observability layer: it grants nothing, and no production surface should show
 * it until the backfill has been verified against production data.
 *
 * Enable per environment with `VITE_FEATURE_FILE_LINKS=1`.
 */
import { supabase } from '@/lib/supabase';

export interface UsedInLink {
  link_id: string;
  role: string;
  record_id: string;
  /** Required for identity: record ids are only unique PER MODEL. */
  model_id: string;
  model_name: string | null;
  model_label_ar: string | null;
  model_label_en: string | null;
  /** Null when the record carries no recognisable title field. */
  title: string | null;
}

export interface UsedInResult {
  links: UsedInLink[];
  /** Reserved. Always 0 until product approves exposing restricted-use counts. */
  hiddenCount: number;
}

/** The panel ships dark. One env var turns it on, per environment. */
export function fileLinksEnabled(): boolean {
  return (import.meta.env.VITE_FEATURE_FILE_LINKS as string | undefined) === '1';
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Records this file is linked to, filtered to what the caller may see.
 *
 * Throws on transport failure so the caller can render a real error — the panel
 * must not fail to a blank box (repo rule: fail loudly).
 */
export async function fetchUsedIn(fileId: string): Promise<UsedInResult> {
  const res = await fetch('/api/files/used-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fileId }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<UsedInResult> & { error?: string };
  if (!res.ok) {
    console.error('[files] used-in lookup failed', res.status, body.error);
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return { links: body.links ?? [], hiddenCount: body.hiddenCount ?? 0 };
}

/** Identity of a target record. Record ids are only unique PER MODEL, so the
 *  model is part of the key everywhere — the RLS predicate, the endpoint's
 *  title lookup, and here. Grouping on the bare uuid would silently merge two
 *  different business records that happen to share one. */
export function recordKey(l: { model_id: string; record_id: string }): string {
  return `${l.model_id}|${l.record_id}`;
}

/**
 * Group links so one record reads as ONE relationship even when several roles
 * or several source occurrences produced it. The panel shows business meaning,
 * not projection mechanics.
 */
export function groupByRecord(links: UsedInLink[]): Array<{
  key: string;
  record_id: string;
  model_id: string;
  model_name: string | null;
  model_label_ar: string | null;
  model_label_en: string | null;
  title: string | null;
  roles: string[];
}> {
  const byRecord = new Map<string, ReturnType<typeof groupByRecord>[number]>();
  for (const l of links) {
    const k = recordKey(l);
    const cur = byRecord.get(k);
    if (cur) {
      if (!cur.roles.includes(l.role)) cur.roles.push(l.role);
      continue;
    }
    byRecord.set(k, {
      key: k,
      record_id: l.record_id,
      model_id: l.model_id,
      model_name: l.model_name,
      model_label_ar: l.model_label_ar,
      model_label_en: l.model_label_en,
      title: l.title,
      roles: [l.role],
    });
  }
  return Array.from(byRecord.values());
}
