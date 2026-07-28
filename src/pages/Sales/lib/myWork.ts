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
  /** Inbound client message received while the task was still fresh (no check-in sent) — set by the webhook reconciler. */
  clientMessagedAt: string | null;
  /** Recorded outcome (call_result), when present. */
  result: string | null;
  priority: string | null;
  salesRep: string | null;
  bucket: DayBucket;
  /** Task row creation time — drives the hot-lead 5-minute countdown. */
  createdAtISO: string | null;
  /** Client's current lifecycle stage (from the live client record). */
  clientStage: string | null;
  /** When the CLIENT RECORD itself was created — gates the hot-lead SLA. */
  clientCreatedAtISO: string | null;
}

// ---------------------------------------------------------------------------
// Priority stack (2026-07-21 — sales-process improvement plan, Workstream B)
// ---------------------------------------------------------------------------

/**
 * Priority tier of a task within the Actions tab. Lower = hotter.
 *  1 hot     — brand-new lead's booking call (client record <1h old): call <5 min.
 *  2 replied — customer replied / messaged: ball is in OUR court right now.
 *  3 overdue — scheduled day strictly before today.
 *  4 today   — due today.
 *  5 quiet   — rating requests & undated leftovers.
 */
export type PriorityTier = 1 | 2 | 3 | 4 | 5;

/** Window (ms) in which a first booking call counts as a HOT new lead. */
export const HOT_LEAD_WINDOW_MS = 60 * 60 * 1000; // still hot for 1h; countdown targets 5 min
export const HOT_LEAD_SLA_MS = 5 * 60 * 1000;

export function isHotLead(t: FollowupTask, now: number): boolean {
  if (t.typeKey !== 'appointment_booking_call') return false;
  if (t.clientStage && t.clientStage !== 'جديد') return false;
  // The CLIENT must actually be new — `client_stage === 'جديد'` alone is a bad
  // proxy for it. A lead imported months ago and never called still reads
  // 'جديد', so every retry booking call on the backlog lit up
  // "عميل جديد — اتصل الآن" with a 5-minute speed-to-lead countdown on a
  // three-month-old lead (bug 2026-07-28: 113 of the 114 clients then sitting
  // at 'جديد' were older than a week). Fail CLOSED when the client's creation
  // date is missing/unparseable: a missing badge just leaves a normal today
  // task, a false one fakes an emergency.
  const clientCreated = parseMs(t.clientCreatedAtISO);
  if (clientCreated == null || now - clientCreated > HOT_LEAD_WINDOW_MS) return false;
  const created = parseMs(t.createdAtISO);
  if (created == null) return false;
  return now - created <= HOT_LEAD_WINDOW_MS;
}

export function isCustomerTurn(t: FollowupTask): boolean {
  return t.whatsappState === 'replied' || (!t.whatsappState && !!t.clientMessagedAt);
}

/** WhatsApp task parked with the customer — lives in the Waiting tab, not Actions. */
export function isWaitingForCustomer(t: FollowupTask): boolean {
  return t.whatsappState === 'message_sent_waiting_response';
}

export function priorityTier(t: FollowupTask, now: number): PriorityTier {
  if (isHotLead(t, now)) return 1;
  if (isCustomerTurn(t)) return 2;
  if (t.bucket === 'late') return 3;
  if (t.typeKey === 'rating_request' || !t.scheduledISO) return 5;
  return 4;
}

/** Sort for the Actions tab: tier asc, then scheduled asc (oldest first). */
export function byPriority(now: number) {
  return (a: FollowupTask, b: FollowupTask): number => {
    const ta = priorityTier(a, now);
    const tb = priorityTier(b, now);
    if (ta !== tb) return ta - tb;
    const av = a.scheduledISO ? Date.parse(a.scheduledISO) : Infinity;
    const bv = b.scheduledISO ? Date.parse(b.scheduledISO) : Infinity;
    return av - bv;
  };
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
  clientsById: Map<string, AppRecord>,
  now: number,
): FollowupTask[] {
  const out: FollowupTask[] = [];
  for (const r of followups) {
    const d = r.data as Record<string, unknown>;
    const status = (str(d.followup_status) ?? 'open');
    if (isDoneFollowup(status)) continue;
    let bucket = followupDayBucket(str(d.scheduled_datetime), now);
    // Surface a task when it's due today/late OR when the customer just replied
    // to a WhatsApp follow-up — a reply needs action now, even if the task's
    // scheduled_datetime is still in the future. (Set by the inbound reconciler.)
    const repliedWhatsapp = str(d.whatsapp_state) === 'replied';
    // A FRESH WhatsApp task (no check-in yet) whose client already messaged us
    // surfaces early too — same promotion as a reply, without the replied state.
    const earlyMessaged = !str(d.whatsapp_state) && !!str(d.client_messaged_at);
    if (bucket !== 'late' && bucket !== 'today' && !repliedWhatsapp && !earlyMessaged) continue;
    // Promote a replied/early-messaged task that isn't already overdue into
    // TODAY so the My Tasks page (which renders only the today + late sections)
    // shows it — a future-scheduled reply must appear now, not be dropped.
    if ((repliedWhatsapp || earlyMessaged) && bucket !== 'late') bucket = 'today';
    const clientId = firstId(d.client_id);
    const client = clientId ? clientsById.get(clientId) : undefined;
    const cd = client?.data as Record<string, unknown> | undefined;
    const typeKey = readFollowupType(d);
    out.push({
      followupId: r.id,
      clientId,
      clientName: str(cd?.client_name) ?? str(d.client_name) ?? '',
      phone: str(cd?.phone_number) ?? str(d.client_phone) ?? '',
      typeKey,
      channel: followupChannel(typeKey),
      scheduledISO: str(d.scheduled_datetime),
      followupStatus: status,
      whatsappState: str(d.whatsapp_state),
      clientMessagedAt: str(d.client_messaged_at),
      result: str(d.call_result),
      priority: str(d.priority),
      salesRep: firstId(d.sales_rep),
      bucket,
      createdAtISO: r.created_at ?? null,
      clientStage: str(cd?.client_stage),
      clientCreatedAtISO: client?.created_at ?? null,
    });
  }
  return out;
}

/**
 * Build the WAITING-tab task list: WhatsApp tasks parked with the customer
 * (message_sent_waiting_response), regardless of day bucket — including
 * future-dated ones that buildFollowupTasks drops. Sorted by sent_at desc.
 */
export function buildWaitingTasks(
  followups: AppRecord[],
  clientsById: Map<string, AppRecord>,
  now: number,
): FollowupTask[] {
  const out: FollowupTask[] = [];
  for (const r of followups) {
    const d = r.data as Record<string, unknown>;
    const status = str(d.followup_status) ?? 'open';
    if (isDoneFollowup(status)) continue;
    if (str(d.whatsapp_state) !== 'message_sent_waiting_response') continue;
    const clientId = firstId(d.client_id);
    const client = clientId ? clientsById.get(clientId) : undefined;
    const cd = client?.data as Record<string, unknown> | undefined;
    const typeKey = readFollowupType(d);
    out.push({
      followupId: r.id,
      clientId,
      clientName: str(cd?.client_name) ?? str(d.client_name) ?? '',
      phone: str(cd?.phone_number) ?? str(d.client_phone) ?? '',
      typeKey,
      channel: followupChannel(typeKey),
      scheduledISO: str(d.scheduled_datetime),
      followupStatus: status,
      whatsappState: str(d.whatsapp_state),
      clientMessagedAt: str(d.client_messaged_at),
      result: str(d.call_result),
      priority: str(d.priority),
      salesRep: firstId(d.sales_rep),
      bucket: followupDayBucket(str(d.scheduled_datetime), now),
      createdAtISO: r.created_at ?? null,
      clientStage: str(cd?.client_stage),
      clientCreatedAtISO: client?.created_at ?? null,
    });
  }
  return out.sort((a, b) => {
    const av = typeof a.scheduledISO === 'string' ? Date.parse(a.scheduledISO) : 0;
    const bv = typeof b.scheduledISO === 'string' ? Date.parse(b.scheduledISO) : 0;
    return bv - av;
  });
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
