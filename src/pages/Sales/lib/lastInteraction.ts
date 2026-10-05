// Last interaction per client — the newest moment we were in touch with a
// client on ANY channel, so the Clients tab can answer "who did we talk to
// today?" (operator, 2026-10-05).
//
// Three sources, all already in the store:
//   · a COMPLETED follow-up → its `actual_datetime` (what the rep logged);
//   · a WhatsApp chat linked to the client → `last_message_at` (either
//     direction — a reply from the client is contact too; `last_message_flow`
//     tells which side wrote last);
//   · a phone call linked to the client → `call_time`.
// Chats and calls are linked through whatever lookup field points at the
// clients model (found from the schema, not a hard-coded slug).

import type { AppModel, AppRecord } from '@/types';

export type InteractionKind = 'followup' | 'whatsapp' | 'whatsapp_in' | 'whatsapp_out' | 'call';

export interface LastInteraction {
  at: string;
  kind: InteractionKind;
}

export type InteractionWindow = 'all' | 'today' | 'yesterday' | 'week' | 'none';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function idsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(idsOf);
  if (v && typeof v === 'object') {
    const id = (v as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  }
  return typeof v === 'string' && v ? [v] : [];
}

function clientLinkSlugs(model: AppModel, clientsModelId: string): string[] {
  return model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && f.lookup_model_id === clientsModelId)
    .map((f) => f.name);
}

export function buildLastInteractionIndex(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
  clientsModelId: string,
): Map<string, LastInteraction> {
  const index = new Map<string, LastInteraction>();
  const bump = (clientId: string, at: string | null, kind: InteractionKind) => {
    if (!at) return;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const prev = index.get(clientId);
    if (!prev || t > Date.parse(prev.at)) index.set(clientId, { at, kind });
  };

  const followups = models.find((m) => m.name === 'followups');
  for (const r of followups ? records[followups.id] ?? [] : []) {
    const d = r.data as Record<string, unknown>;
    if (str(d.followup_status) !== 'completed') continue;
    const [clientId] = idsOf(d.client_id);
    if (clientId) bump(clientId, str(d.actual_datetime), 'followup');
  }

  const linked = (name: string, read: (d: Record<string, unknown>) => { at: string | null; kind: InteractionKind }) => {
    const model = models.find((m) => m.name === name);
    if (!model) return;
    const slugs = clientLinkSlugs(model, clientsModelId);
    if (!slugs.length) return;
    for (const r of records[model.id] ?? []) {
      const d = r.data as Record<string, unknown>;
      const { at, kind } = read(d);
      if (!at) continue;
      const seen = new Set<string>();
      for (const slug of slugs) {
        for (const id of idsOf(d[slug])) {
          if (seen.has(id)) continue;
          seen.add(id);
          bump(id, at, kind);
        }
      }
    }
  };
  linked('chats', (d) => ({
    at: str(d.last_message_at),
    // Older chats carry no flow — say "WhatsApp", never guess a side.
    kind: str(d.last_message_flow) === 'in' ? 'whatsapp_in' : str(d.last_message_flow) === 'out' ? 'whatsapp_out' : 'whatsapp',
  }));
  linked('phone_calls', (d) => ({ at: str(d.call_time), kind: 'call' }));

  return index;
}

/** Start of the local calendar day `daysAgo` days before `now`. */
function dayStart(now: number, daysAgo: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

export function inInteractionWindow(last: LastInteraction | undefined, win: InteractionWindow, now: number): boolean {
  if (win === 'all') return true;
  if (win === 'none') return !last;
  if (!last) return false;
  const t = Date.parse(last.at);
  if (win === 'today') return t >= dayStart(now, 0);
  if (win === 'yesterday') return t >= dayStart(now, 1) && t < dayStart(now, 0);
  return t >= dayStart(now, 6); // week = today + the 6 days before it
}

export const INTERACTION_KIND_LABEL: Record<InteractionKind, { ar: string; en: string }> = {
  followup: { ar: 'متابعة', en: 'Follow-up' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  whatsapp_in: { ar: 'واتساب من العميل', en: 'WhatsApp from client' },
  whatsapp_out: { ar: 'واتساب منا', en: 'WhatsApp from us' },
  call: { ar: 'مكالمة', en: 'Call' },
};
