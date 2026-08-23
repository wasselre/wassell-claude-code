// Client-side fact gathering + fetch for the AI client-context summary.
//
// The rep only ever summarizes a client they can already see, so we gather the
// facts here (from the store + RLS-scoped Supabase reads) and POST them to
// /api/client-summary, which narrates them into a short Arabic briefing. Same
// "caller resolves facts, model narrates" boundary as /api/project-ai — the
// model never touches the database.

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { listCallsForPhone } from '@/lib/hatif/client';
import { getOutcome, getFollowUpTypeConfig } from '@/lib/salesProcess';
import { buildDetailedClientPrefChips, buildGeoNameMap } from '@/pages/Chats/lib/prefChips';
import type { AppRecord } from '@/types';

// Keep the payload well under the endpoint's 24k-char cap while still covering
// the meaningful history. Newest items are kept; long text is truncated.
const MAX_FOLLOWUPS = 25;
const MAX_CALLS = 20;
const MAX_MESSAGES = 80;
const MAX_TEXT = 700;

interface FollowupFact { date: string; type: string; outcome: string; notes: string; rep: string }
interface AppointmentFact { date: string; status: string; notes: string }
interface VisitFact { date: string; rating: string; notes: string }
interface CallFact { date: string; direction: string; sentiment: string; summary: string; transcript: string }
interface MessageFact { date: string; from: 'client' | 'us'; text: string }

export interface ClientFacts {
  client: Record<string, string>;
  followups: FollowupFact[];
  appointments: AppointmentFact[];
  visits: VisitFact[];
  calls: CallFact[];
  whatsapp: MessageFact[];
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
const trunc = (v: string, n = MAX_TEXT): string => (v.length > n ? `${v.slice(0, n)}…` : v);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function recordsForClient(rows: AppRecord[] | undefined, clientId: string, slug: string): AppRecord[] {
  if (!rows) return [];
  return rows.filter((r) => {
    const v = r.data[slug];
    return v === clientId || (Array.isArray(v) && v.includes(clientId));
  });
}

/** Gather everything we know about a client into a compact, model-ready facts object. */
export async function gatherClientFacts(clientId: string, phones: string[]): Promise<ClientFacts> {
  const { models, records, users, language } = useAppStore.getState();
  const isAr = language === 'ar';

  const modelId = (name: string) => models.find((m) => m.name === name)?.id;
  const rowsOf = (name: string): AppRecord[] | undefined => {
    const id = modelId(name);
    return id ? records[id] : undefined;
  };
  const userName = (id: unknown): string => {
    if (typeof id !== 'string' || !id) return '';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '') : '';
  };
  const at = (r: AppRecord, ...slugs: string[]): string => {
    for (const s of slugs) { const v = str(r.data[s]); if (v) return v; }
    return r.created_at ?? '';
  };
  const byDateDesc = (a: { date: string }, b: { date: string }) => (b.date ?? '').localeCompare(a.date ?? '');

  // ── Client preferences (a slim, human-readable projection) ──
  const clientRec = (rowsOf('clients') ?? []).find((r) => r.id === clientId) ?? null;
  const cd = (clientRec?.data ?? {}) as Record<string, unknown>;
  const client: Record<string, string> = {};
  const addClient = (k: string, v: unknown) => { const s = str(v); if (s) client[k] = s; };
  addClient('name', cd.client_name ?? cd.name);
  addClient('stage', cd.client_stage);
  addClient('status', cd.client_status);
  addClient('language', cd.preferred_language);
  addClient('notes', cd.preference_notes);
  // Structured preferences — unit type (multiselect array), area / bedrooms / budget
  // (range objects), location (geo-id compound → resolved names), amenities,
  // purchase objective, unit-age. A naive stringify drops all of these (arrays /
  // objects), which is why the briefing used to see ONLY the budget. Reuse the
  // shared chip builder that renders them the same way the chat header does.
  const clientsModelObj = models.find((m) => m.name === 'clients') ?? null;
  const geoNames = buildGeoNameMap(models, records);
  const prefChips = clientsModelObj ? buildDetailedClientPrefChips(cd, clientsModelObj, geoNames, isAr) : [];
  const prefText = prefChips.map((c) => c.text).filter(Boolean).join(' · ');
  if (prefText) client.preferences = prefText;

  // ── Follow-ups ──
  const followups: FollowupFact[] = recordsForClient(rowsOf('followups'), clientId, 'client_id')
    .map((r) => {
      const type = first(r.data.followup_type);
      const cfg = getFollowUpTypeConfig(typeof type === 'string' ? type : null);
      const outcome = getOutcome(str(r.data.call_result));
      return {
        date: at(r, 'actual_datetime', 'scheduled_datetime', 'call_time'),
        type: cfg ? (isAr ? cfg.label_ar : cfg.label_en) : str(type),
        outcome: outcome ? (isAr ? outcome.label_ar : outcome.label_en) : '',
        notes: trunc(str(r.data.outcome_notes) || str(r.data.notes)),
        rep: userName(r.data.sales_rep),
      };
    })
    .sort(byDateDesc)
    .slice(0, MAX_FOLLOWUPS);

  // ── Appointments ──
  const appointments: AppointmentFact[] = recordsForClient(rowsOf('appointments'), clientId, 'client_id')
    .map((r) => ({
      date: at(r, 'appointment_date', 'scheduled_datetime'),
      status: str(r.data.appointment_status),
      notes: trunc(str(r.data.notes)),
    }))
    .sort(byDateDesc);

  // ── Visits ──
  const visits: VisitFact[] = recordsForClient(rowsOf('visits'), clientId, 'client_id')
    .map((r) => ({
      date: at(r, 'visit_date'),
      rating: str(r.data.visit_rating),
      notes: trunc(str(r.data.visit_notes) || str(r.data.notes)),
    }))
    .sort(byDateDesc);

  // ── Phone calls (with AI summary + transcript) ──
  const uniquePhones = Array.from(new Set(phones.map((p) => (p ?? '').trim()).filter(Boolean)));
  const callLists = await Promise.all(uniquePhones.map((p) => listCallsForPhone(p).catch(() => [])));
  const callById = new Map<string, CallFact & { id: string }>();
  for (const list of callLists) {
    for (const c of list) {
      callById.set(c.id, {
        id: c.id,
        date: c.creation_time,
        direction: c.direction === 'inbound' ? (isAr ? 'واردة' : 'inbound') : (isAr ? 'صادرة' : 'outbound'),
        sentiment: c.sentiment && c.sentiment !== 'unknown' ? c.sentiment : '',
        summary: trunc(str(c.summary)),
        transcript: trunc(str(c.transcription?.text)),
      });
    }
  }
  const calls: CallFact[] = Array.from(callById.values())
    .sort(byDateDesc)
    .slice(0, MAX_CALLS)
    .map(({ id: _id, ...rest }) => rest);

  // ── WhatsApp messages (from the client's linked chat(s)) ──
  let whatsapp: MessageFact[] = [];
  const chatRows = (rowsOf('chats') ?? []).filter((r) => str(r.data.client_link) === clientId);
  const wids = chatRows.map((r) => str(r.data.wid)).filter(Boolean);
  if (supabase && wids.length > 0) {
    const pages = await Promise.all(
      wids.map((wid) =>
        supabase!
          .from('chat_messages')
          .select('flow,body,kind,date')
          .eq('chat_wid', wid)
          .order('date', { ascending: false })
          .limit(MAX_MESSAGES)
          .then((res) => res.data ?? [])
          .then((rows) => rows as Array<{ flow: string; body: string | null; kind: string | null; date: string }>),
      ),
    ).catch(() => [] as Array<Array<{ flow: string; body: string | null; kind: string | null; date: string }>>);
    whatsapp = pages
      .flat()
      .filter((m) => str(m.body))
      .map((m) => ({ date: m.date, from: m.flow === 'in' ? ('client' as const) : ('us' as const), text: trunc(str(m.body)) }))
      .sort(byDateDesc)
      .slice(0, MAX_MESSAGES)
      .reverse(); // oldest→newest for readability
  }

  return { client, followups, appointments, visits, calls, whatsapp };
}

/** Whether there is any real history to summarize (avoids a pointless LLM call). */
export function hasSummarizableHistory(f: ClientFacts): boolean {
  return (
    f.followups.length > 0 ||
    f.appointments.length > 0 ||
    f.visits.length > 0 ||
    f.calls.length > 0 ||
    f.whatsapp.length > 0 ||
    Object.keys(f.client).length > 2 // more than just stage/status
  );
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** POST the gathered facts to /api/client-summary and return the Arabic briefing. */
export async function fetchClientSummary(
  facts: ClientFacts,
  language: 'ar' | 'en',
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/client-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ facts, language }),
    signal,
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(b?.error ?? `client-summary failed (${res.status})`);
  }
  const json = (await res.json()) as { result?: string };
  const out = (json.result ?? '').trim();
  if (!out) throw new Error('empty summary');
  return out;
}

// Per-client in-memory cache so re-opening the Context step doesn't regenerate.
const cache = new Map<string, string>();
export const clientSummaryCache = {
  get: (clientId: string) => cache.get(clientId),
  set: (clientId: string, summary: string) => cache.set(clientId, summary),
  clear: (clientId: string) => cache.delete(clientId),
};
