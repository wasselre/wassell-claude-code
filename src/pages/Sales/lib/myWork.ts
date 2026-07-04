// Shared follow-up "work" logic for the Sales Rep workspace (My Clients +
// My Tasks). Pure + in-memory over the store, so it's fast and unit-testable.
//
// Two consumers:
//   - My Tasks   → buildFollowupTasks() bucketed into today/late + call/whatsapp.
//   - My Clients → indexClientFollowups() summarizes each client's latest done
//     action + next open action + a "late" flag for the Late Clients tab.
//
// LATE is defined the way the product spec requires and the way the existing
// Sales Queue computes "overdue": a follow-up whose SCHEDULED CALENDAR DAY is
// strictly before today AND is not yet done. A task scheduled earlier *today*
// is still today's task — never late. (Mirrors queueViews.computeSla's overdue
// rule: startOfDay(scheduled) < startOfDay(now).)

import type { AppRecord } from '@/types';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import { getFollowUpTypeConfig } from '@/lib/salesProcess';

export type FollowupChannel = 'call' | 'whatsapp';

/** Day bucket of a follow-up relative to "today" (local day). */
export type DayBucket = 'late' | 'today' | 'future' | 'none';

/**
 * Statuses that mean the follow-up is DONE / closed — never surfaced as a
 * today/late task and never counted as "late". Everything else (open,
 * in_progress, scheduled, or an unknown value) is treated as still-actionable.
 */
const DONE_STATES = new Set(['completed', 'cancelled', 'skipped']);

export function isDoneFollowup(status: string | null | undefined): boolean {
  return DONE_STATES.has((status ?? '').trim());
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Bucket a scheduled date into late / today / future. `late` = scheduled day
 * strictly before today; `today` = same calendar day (regardless of time of
 * day); `future` = after today; `none` = no/invalid date.
 */
export function followupDayBucket(scheduledISO: string | null | undefined, now: number): DayBucket {
  const sched = parseMs(scheduledISO);
  if (sched == null) return 'none';
  const today = startOfDay(now);
  const schedDay = startOfDay(sched);
  if (schedDay < today) return 'late';
  if (schedDay === today) return 'today';
  return 'future';
}

/**
 * Which sub-tab a follow-up belongs to. Drives the Calls vs Conversations
 * split. Resolved from the canonical sales-process config (`primary_channel`);
 * falls back to a name heuristic for types not in the config (e.g.
 * `whatsapp_follow_up`, `rating_request` → conversation; anything `*_call` →
 * call).
 */
export function followupChannel(typeKey: string | null | undefined): FollowupChannel {
  const cfg = getFollowUpTypeConfig(typeKey);
  if (cfg?.primary_channel === 'whatsapp') return 'whatsapp';
  if (cfg?.primary_channel === 'call') return 'call';
  const k = (typeKey ?? '').toLowerCase();
  if (k.includes('whatsapp') || k.includes('chat') || k.includes('rating')) return 'whatsapp';
  return 'call';
}

export interface FollowupTask {
  followupId: string;
  clientId: string | null;
  clientName: string;
  phone: string;
  typeKey: string | null;
  channel: FollowupChannel;
  scheduledISO: string | null;
  followupStatus: string;
  /** WhatsApp conversation sub-state — message sent/waiting/replied. */
  whatsappState: string | null;
  /** Recorded outcome (call_result), when present. */
  result: string | null;
  priority: string | null;
  salesRep: string | null;
  bucket: DayBucket;
}

function firstId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Build the actionable follow-up task list (today + late only; done and future
 * are dropped). Client name/phone are resolved from the live client record
 * first (freshest), falling back to the follow-up's mirror fields.
 */
export function buildFollowupTasks(
  followups: AppRecord[],
  clientsById: Map<string, Record<string, unknown>>,
  now: number,
): FollowupTask[] {
  const out: FollowupTask[] = [];
  for (const r of followups) {
    const d = r.data as Record<string, unknown>;
    const status = (str(d.followup_status) ?? 'open');
    if (isDoneFollowup(status)) continue;
    const bucket = followupDayBucket(str(d.scheduled_datetime), now);
    // Surface a task when it's due today/late OR when the customer just replied
    // to a WhatsApp follow-up — a reply needs action now, even if the task's
    // scheduled_datetime is still in the future. (Set by the inbound reconciler.)
    const repliedWhatsapp = str(d.whatsapp_state) === 'replied';
    if (bucket !== 'late' && bucket !== 'today' && !repliedWhatsapp) continue;
    const clientId = firstId(d.client_id);
    const client = clientId ? clientsById.get(clientId) : undefined;
    const typeKey = readFollowupType(d);
    out.push({
      followupId: r.id,
      clientId,
      clientName: str(client?.client_name) ?? str(d.client_name) ?? '',
      phone: str(client?.phone_number) ?? str(d.client_phone) ?? '',
      typeKey,
      channel: followupChannel(typeKey),
      scheduledISO: str(d.scheduled_datetime),
      followupStatus: status,
      whatsappState: str(d.whatsapp_state),
      result: str(d.call_result),
      priority: str(d.priority),
      salesRep: firstId(d.sales_rep),
      bucket,
    });
  }
  return out;
}

/** Scope a task list to a sales rep (sales_rep === userId). */
export function tasksForRep(tasks: FollowupTask[], userId: string | null): FollowupTask[] {
  if (!userId) return tasks;
  return tasks.filter((t) => t.salesRep === userId);
}

// ---------------------------------------------------------------------------
// Per-client follow-up summary (My Clients cards + Late Clients tab)
// ---------------------------------------------------------------------------

export interface ClientFollowupSummary {
  /** Has at least one not-done follow-up scheduled before today. */
  late: boolean;
  /** Most recently completed follow-up (by actual_datetime). */
  latest: { typeKey: string | null; result: string | null; at: string | null } | null;
  /** Earliest still-open follow-up (by scheduled_datetime). */
  next: { typeKey: string | null; scheduledISO: string | null; bucket: DayBucket } | null;
  /** Count of not-done follow-ups. */
  openCount: number;
}

const EMPTY_SUMMARY: ClientFollowupSummary = { late: false, latest: null, next: null, openCount: 0 };

export function emptyFollowupSummary(): ClientFollowupSummary {
  return EMPTY_SUMMARY;
}

/**
 * Index follow-ups by client into a per-client summary. One pass over the
 * follow-up set; safe on records with a missing client link (skipped).
 */
export function indexClientFollowups(followups: AppRecord[], now: number): Map<string, ClientFollowupSummary> {
  const map = new Map<string, ClientFollowupSummary>();
  for (const r of followups) {
    const d = r.data as Record<string, unknown>;
    const clientId = firstId(d.client_id);
    if (!clientId) continue;
    const status = str(d.followup_status) ?? 'open';
    const done = isDoneFollowup(status);
    const typeKey = readFollowupType(d);
    const scheduledISO = str(d.scheduled_datetime);
    const actualISO = str(d.actual_datetime);

    let s = map.get(clientId);
    if (!s) {
      s = { late: false, latest: null, next: null, openCount: 0 };
      map.set(clientId, s);
    }

    if (done) {
      if (status === 'completed') {
        const at = actualISO ?? null;
        const prev = s.latest?.at ? new Date(s.latest.at).getTime() : -Infinity;
        const cur = at ? new Date(at).getTime() : -Infinity;
        if (!s.latest || cur > prev) {
          s.latest = { typeKey, result: str(d.call_result), at };
        }
      }
      continue;
    }

    // Not done → contributes to open count, late flag, and next-open.
    s.openCount += 1;
    const bucket = followupDayBucket(scheduledISO, now);
    if (bucket === 'late') s.late = true;
    if (scheduledISO) {
      const prevNext = s.next?.scheduledISO ? new Date(s.next.scheduledISO).getTime() : Infinity;
      const cur = new Date(scheduledISO).getTime();
      if (!s.next || cur < prevNext) {
        s.next = { typeKey, scheduledISO, bucket };
      }
    } else if (!s.next) {
      s.next = { typeKey, scheduledISO: null, bucket: 'none' };
    }
  }
  return map;
}
