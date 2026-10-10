// nextStep — the agent owns the next step; the AI proposes it (2026-10-10).
//
// Review cards live in `next_step_reviews` (server: api/_lib/nextStep.ts,
// endpoint /api/next-step). This module is the browser half: list my cards,
// find the card a just-completed follow-up opened (the popup), and decide.
// A completed follow-up announces itself with `announceFollowupCompleted`, so
// the popup host can ask for its card without every save path knowing about it.

import { supabase } from '@/lib/supabase';

export type NextChannel = 'call' | 'ai_whatsapp' | 'agent_whatsapp';
export interface NextPlan { channel: NextChannel; at: string }

export interface NextStepCard {
  id: string;
  client_id: string;
  owner_user_id: string | null;
  kind: 'after_call' | 'conversation' | 'visit_booked';
  status: 'pending' | 'decided' | 'auto_applied' | 'dismissed';
  source_followup_id: string | null;
  followup_id: string | null;
  suggestion_id: string | null;
  appointment_id: string | null;
  call_result: string | null;
  summary: string | null;
  client_quote: string | null;
  suggested_result: string | null;
  suggested_confidence: number | null;
  suggested_next: NextPlan | null;
  apply_error: string | null;
  decided_at: string | null;
  created_at: string;
  client_name: string | null;
  client_phone: string | null;
  chat_record_id: string | null;
  planned_next: NextPlan | null;
  planned_task_id: string | null;
  appointment: { date: string | null; status: string | null } | null;
}

export type DecideInput =
  | { action: 'agree'; next?: NextPlan }
  | { action: 'change'; next: NextPlan }
  | { action: 'ack' };

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const res = await fetch('/api/next-step', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    console.error(`[nextStep] ${String(body.action)} failed:`, msg);
    throw new Error(msg);
  }
  return payload as T;
}

export async function fetchMyNextSteps(): Promise<NextStepCard[]> {
  if (!supabase) return [];
  return (await call<{ cards: NextStepCard[] }>({ action: 'list' })).cards ?? [];
}

export async function fetchCardForFollowup(followupId: string): Promise<NextStepCard | null> {
  if (!supabase) return null;
  return (await call<{ card: NextStepCard | null }>({ action: 'for_followup', followup_id: followupId })).card;
}

export async function decideNextStep(id: string, input: DecideInput): Promise<void> {
  await call({ action: 'decide', id, input });
}

/** Fired after a PERSON completes a follow-up (every save path calls it). */
export const FOLLOWUP_COMPLETED_EVENT = 'wassel:followup-completed';
export function announceFollowupCompleted(followupId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOLLOWUP_COMPLETED_EVENT, { detail: { followupId } }));
}
/** Fired when a card is decided anywhere, so lists refresh. */
export const NEXT_STEP_CHANGED_EVENT = 'wassel:next-step-changed';
export function announceNextStepChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(NEXT_STEP_CHANGED_EVENT));
}

/** Results that lead to another contact — the only ones that open a «next step» card. */
export const NEXT_CONTACT_RESULTS = new Set(['interested', 'no_answer', 'wrong_time', 'recontact_later']);

/** «in N days» at 10:00 Riyadh, as an ISO string. */
export function inDaysAtTen(days: number, from = new Date()): string {
  const local = new Date(from.getTime() + 3 * 3_600_000);
  local.setUTCDate(local.getUTCDate() + days);
  local.setUTCHours(10, 0, 0, 0);
  return new Date(local.getTime() - 3 * 3_600_000).toISOString();
}

/** Who decided the next steps of a period (the Sales overview — the ownership measure). */
export interface NextStepStats { byAgent: number; byDefault: number; pendingNow: number }

/** Counts by `decided_at` in [fromIso, toIso); pending = waiting right now. RLS scopes the rows. An error throws. */
export async function fetchNextStepStats(fromIso: string, toIso: string): Promise<NextStepStats> {
  if (!supabase) return { byAgent: 0, byDefault: 0, pendingNow: 0 };
  const count = async (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count: n, error } = await build(base());
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const base = () => supabase!.from('next_step_reviews').select('id', { count: 'exact', head: true });
  const [byAgent, byDefault, pendingNow] = await Promise.all([
    count((q) => q.eq('status', 'decided').gte('decided_at', fromIso).lt('decided_at', toIso)),
    count((q) => q.eq('status', 'auto_applied').gte('decided_at', fromIso).lt('decided_at', toIso)),
    count((q) => q.eq('status', 'pending')),
  ]);
  return { byAgent, byDefault, pendingNow };
}
