// Pure Sales Queue logic — buckets follow-up records into the rep's daily views
// and computes the "active clients with no next action" audit. In-memory over
// the store (the follow-up set is small + realtime-reactive); SLA state is
// COMPUTED live (no stored sla_status — correction #1).

import type { AppRecord } from '@/types';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import { getSalesProcessConfig } from '@/lib/salesProcess/config';

export type QueueViewId =
  | 'my_tasks'
  | 'overdue'
  | 'due_now'
  | 'today'
  | 'tomorrow'
  | 'waiting'
  | 'high_priority'
  | 'no_owner'
  | 'completed'
  | 'no_next_action';

export type SlaState = 'on_time' | 'due_now' | 'overdue' | 'completed_late';

export interface QueueItem {
  followupId: string;
  clientId: string | null;
  clientName: string;
  phone: string;
  typeKey: string | null;
  scheduledISO: string | null;
  actualISO: string | null;
  followupStatus: string;
  /** WhatsApp conversation sub-state — 'replied' means the customer answered and the task needs action now. */
  whatsappState: string | null;
  /** Inbound client message received while the task was still fresh (no check-in sent) — set by the webhook reconciler. */
  clientMessagedAt: string | null;
  priority: string;
  attempt: number | null;
  clientStage: string;
  clientStatus: string;
  salesRep: string | null;
  lastActivityISO: string | null;
  sla: SlaState;
}

const OPEN_STATES = new Set(['open', 'in_progress']);

/** Client statuses that mean "we're waiting on the customer". */
const WAITING_STATUSES = new Set(['بانتظار القرار', 'بانتظار دفعة الحجز', 'يحتاج معلومات تمويل', 'تم إرسال عرض السعر', 'نقاش عائلي']);

/** Active = not a terminal/side-exit stage. */
/**
 * Stages where NO follow-up is expected — the config marks them with
 * `followup_types: []`: closed-won, unqualified, lost, «يريد إيجار» (wants a
 * rental we don't sell) and «طلب غير مجاب» (its work lives in sales_tasks, not
 * follow-ups). Derived, never hand-listed, so a new such stage drops out of the
 * no-next-action audit by itself. Matches the server backstop
 * `reconcile_stranded_clients`, whose stage list is the same five.
 */
function stagesWithoutFollowups(): Set<string> {
  return new Set(
    getSalesProcessConfig().stages
      .filter((st) => (st.followup_types?.length ?? 0) === 0)
      .map((st) => st.value),
  );
}

/** An appointment that is itself the client's next action (server parity). */
const UPCOMING_APPOINTMENT_STATES = new Set(['scheduled', 'confirmed', 'rescheduled']);

/** Today's date in Asia/Riyadh as YYYY-MM-DD. */
function riyadhToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function computeSla(item: { scheduledISO: string | null; actualISO: string | null; followupStatus: string }, now: number): SlaState {
  const sched = ms(item.scheduledISO);
  if (item.followupStatus === 'completed') {
    const act = ms(item.actualISO);
    if (sched != null && act != null && act > sched) return 'completed_late';
    return 'on_time';
  }
  if (sched == null) return 'on_time';
  const today = startOfDay(now);
  const schedDay = startOfDay(sched);
  if (schedDay < today) return 'overdue';
  if (schedDay === today && sched <= now) return 'due_now';
  if (schedDay === today) return 'due_now';
  return 'on_time';
}

export function buildQueueItems(
  followups: AppRecord[],
  clientsById: Map<string, Record<string, unknown>>,
  now: number,
): QueueItem[] {
  return followups.map((r) => {
    const d = r.data;
    const clientId = (Array.isArray(d.client_id) ? d.client_id[0] : d.client_id) as string | null;
    const client = clientId ? clientsById.get(clientId) : undefined;
    const scheduledISO = typeof d.scheduled_datetime === 'string' ? d.scheduled_datetime : null;
    const actualISO = typeof d.actual_datetime === 'string' ? d.actual_datetime : null;
    const followupStatus = (d.followup_status as string) || 'open';
    const item: QueueItem = {
      followupId: r.id,
      clientId: clientId ?? null,
      clientName: (client?.client_name as string) ?? (d.client_name as string) ?? '',
      phone: (client?.phone_number as string) ?? (d.client_phone as string) ?? '',
      typeKey: readFollowupType(d),
      scheduledISO,
      actualISO,
      followupStatus,
      whatsappState: typeof d.whatsapp_state === 'string' ? d.whatsapp_state : null,
      clientMessagedAt: typeof d.client_messaged_at === 'string' ? d.client_messaged_at : null,
      priority: (d.priority as string) ?? '',
      attempt: typeof d.followup_number === 'number' ? d.followup_number : null,
      clientStage: (client?.client_stage as string) ?? '',
      clientStatus: (client?.client_status as string) ?? '',
      salesRep: (d.sales_rep as string) ?? null,
      lastActivityISO: actualISO ?? (client?.last_activity_at as string) ?? scheduledISO,
      sla: 'on_time',
    };
    item.sla = computeSla(item, now);
    return item;
  });
}

const isOpen = (i: QueueItem) => OPEN_STATES.has(i.followupStatus);

/**
 * A WhatsApp follow-up whose customer just replied (set by the inbound webhook
 * reconciler). It must surface as actionable NOW even if its scheduled_datetime
 * is still in the future — the rep should answer while the client is engaged.
 */
const isRepliedWhatsapp = (i: QueueItem) => i.whatsappState === 'replied';

/**
 * A FRESH WhatsApp follow-up (no check-in sent yet) whose client has already
 * messaged us. Surfaces early like a reply — but without the replied state, so
 * the rep keeps the full choice screen (including "waiting for reply").
 */
const isEarlyMessagedWhatsapp = (i: QueueItem) => !i.whatsappState && !!i.clientMessagedAt;

/** Bucket follow-up items into the queue views. A row may appear in several. */
export function bucketize(items: QueueItem[], currentUserId: string | null, now: number): Record<Exclude<QueueViewId, 'no_next_action'>, QueueItem[]> {
  const today = startOfDay(now);
  const tomorrow = today + 24 * 3600 * 1000;
  const dayOf = (iso: string | null) => { const m = ms(iso); return m == null ? null : startOfDay(m); };
  const completedCutoff = now - 30 * 24 * 3600 * 1000;

  return {
    my_tasks: items.filter((i) => isOpen(i) && i.salesRep && i.salesRep === currentUserId),
    overdue: items.filter((i) => isOpen(i) && i.sla === 'overdue'),
    // A replied (or early-messaged) WhatsApp task is due-now regardless of its scheduled time.
    due_now: items.filter((i) => isOpen(i) && (i.sla === 'due_now' || isRepliedWhatsapp(i) || isEarlyMessagedWhatsapp(i))),
    today: items.filter((i) => isOpen(i) && dayOf(i.scheduledISO) === today),
    tomorrow: items.filter((i) => isOpen(i) && dayOf(i.scheduledISO) === tomorrow),
    waiting: items.filter((i) => isOpen(i) && WAITING_STATUSES.has(i.clientStatus)),
    high_priority: items.filter((i) => isOpen(i) && (i.priority === 'high' || i.priority === 'urgent')),
    no_owner: items.filter((i) => isOpen(i) && !i.salesRep),
    completed: items
      .filter((i) => i.followupStatus === 'completed' && (ms(i.actualISO) ?? 0) >= completedCutoff)
      .sort((a, b) => (ms(b.actualISO) ?? 0) - (ms(a.actualISO) ?? 0)),
  };
}

export interface NoNextActionRow {
  clientId: string;
  clientName: string;
  phone: string;
  stage: string;
  status: string;
}

const clientIdOf = (r: AppRecord): string | undefined =>
  (Array.isArray(r.data.client_id) ? r.data.client_id[0] : r.data.client_id) as string | undefined;

/**
 * Clients who SHOULD have a next action but don't — the headline health metric,
 * which should be zero. Same rule as the server backstop
 * `reconcile_stranded_clients` (pass only non-retired clients):
 *   - the stage expects follow-ups (not closed / lost / unqualified / wants
 *     rent / unanswered request — see `stagesWithoutFollowups`);
 *   - no open or in-progress follow-up;
 *   - no upcoming appointment (scheduled / confirmed / rescheduled, dated today
 *     or later in Riyadh) — a booked visit IS the next action.
 */
export function computeNoNextAction(
  clients: AppRecord[],
  followups: AppRecord[],
  appointments: AppRecord[] = [],
  today: string = riyadhToday(),
): NoNextActionRow[] {
  const noWorkStages = stagesWithoutFollowups();
  const clientsWithOpenFollowup = new Set<string>();
  for (const f of followups) {
    if (!OPEN_STATES.has((f.data.followup_status as string) || 'open')) continue;
    const cid = clientIdOf(f);
    if (cid) clientsWithOpenFollowup.add(cid);
  }
  const clientsWithUpcomingAppointment = new Set<string>();
  for (const a of appointments) {
    if (!UPCOMING_APPOINTMENT_STATES.has(String(a.data.appointment_status ?? ''))) continue;
    const date = String(a.data.appointment_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(date) || date.slice(0, 10) < today) continue;
    const cid = clientIdOf(a);
    if (cid) clientsWithUpcomingAppointment.add(cid);
  }
  const rows: NoNextActionRow[] = [];
  for (const c of clients) {
    const stage = (c.data.client_stage as string) ?? '';
    if (noWorkStages.has(stage)) continue; // no follow-up expected at this stage
    if (clientsWithOpenFollowup.has(c.id)) continue;
    if (clientsWithUpcomingAppointment.has(c.id)) continue;
    rows.push({
      clientId: c.id,
      clientName: (c.data.client_name as string) ?? '',
      phone: (c.data.phone_number as string) ?? '',
      stage,
      status: (c.data.client_status as string) ?? '',
    });
  }
  return rows;
}

export const QUEUE_VIEW_ORDER: QueueViewId[] = [
  'my_tasks', 'due_now', 'overdue', 'today', 'tomorrow', 'waiting', 'high_priority', 'no_owner', 'completed', 'no_next_action',
];

export const QUEUE_VIEW_LABELS: Record<QueueViewId, { ar: string; en: string }> = {
  my_tasks: { ar: 'مهامي الحالية', en: 'My Tasks' },
  due_now: { ar: 'مستحقة الآن', en: 'Due Now' },
  overdue: { ar: 'متأخرة', en: 'Overdue' },
  today: { ar: 'اليوم', en: 'Today' },
  tomorrow: { ar: 'غدًا', en: 'Tomorrow' },
  waiting: { ar: 'بانتظار العميل', en: 'Waiting for Customer' },
  high_priority: { ar: 'أولوية عالية', en: 'High Priority' },
  no_owner: { ar: 'بدون مسؤول', en: 'No Owner' },
  completed: { ar: 'مكتملة', en: 'Completed' },
  no_next_action: { ar: 'بدون إجراء تالٍ', en: 'No Next Action' },
};
