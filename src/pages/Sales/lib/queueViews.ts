// Pure Sales Queue logic — buckets follow-up records into the rep's daily views
// and computes the "active clients with no next action" audit. In-memory over
// the store (the follow-up set is small + realtime-reactive); SLA state is
// COMPUTED live (no stored sla_status — correction #1).

import type { AppRecord } from '@/types';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';

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
const TERMINAL_STAGES = new Set(['غير مؤهل', 'خاسر', 'مغلق ناجح']);

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

/** Bucket follow-up items into the queue views. A row may appear in several. */
export function bucketize(items: QueueItem[], currentUserId: string | null, now: number): Record<Exclude<QueueViewId, 'no_next_action'>, QueueItem[]> {
  const today = startOfDay(now);
  const tomorrow = today + 24 * 3600 * 1000;
  const dayOf = (iso: string | null) => { const m = ms(iso); return m == null ? null : startOfDay(m); };
  const completedCutoff = now - 30 * 24 * 3600 * 1000;

  return {
    my_tasks: items.filter((i) => isOpen(i) && i.salesRep && i.salesRep === currentUserId),
    overdue: items.filter((i) => isOpen(i) && i.sla === 'overdue'),
    due_now: items.filter((i) => isOpen(i) && i.sla === 'due_now'),
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

/**
 * Active clients (stage not terminal) with NO open follow-up. The headline
 * health metric — this should be zero.
 */
export function computeNoNextAction(
  clients: AppRecord[],
  followups: AppRecord[],
): NoNextActionRow[] {
  const clientsWithOpenFollowup = new Set<string>();
  for (const f of followups) {
    if (!OPEN_STATES.has((f.data.followup_status as string) || 'open')) continue;
    const cid = (Array.isArray(f.data.client_id) ? f.data.client_id[0] : f.data.client_id) as string | undefined;
    if (cid) clientsWithOpenFollowup.add(cid);
  }
  const rows: NoNextActionRow[] = [];
  for (const c of clients) {
    const stage = (c.data.client_stage as string) ?? '';
    if (TERMINAL_STAGES.has(stage)) continue; // closed/lost/unqualified — fine
    if (clientsWithOpenFollowup.has(c.id)) continue;
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
  my_tasks: { ar: 'مهامي', en: 'My Tasks' },
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
