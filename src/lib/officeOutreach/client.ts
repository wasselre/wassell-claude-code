/**
 * Office outreach — the SPA's calls into the SQL RPCs defined in
 * supabase/migrations/2026-09-28_office_outreach.sql. Same posture as
 * useAiNotifications: a bespoke, RLS-gated surface that is not a model, so it
 * is read here rather than through the records store.
 *
 * Every refusal from the database arrives as SQLSTATE WS422 with a stable key
 * (outreach_no_line, outreach_paused, …); `outreachErrorText` turns the key into
 * a sentence a rep can act on. Nothing here swallows an error — each call
 * returns `{ error }` and the caller surfaces it.
 */
import { supabase } from '@/lib/supabase';

export interface OutreachCandidate {
  office_id: string;
  office_name: string | null;
  phone: string;
  district_id: string | null;
  district_name: string | null;
  match_kind: 'district' | 'city';
  last_contacted_at: string | null;
  replied_before: boolean;
  do_not_contact: boolean;
  recently_contacted: boolean;
  in_this_request: boolean;
}

export interface OutreachRow {
  id: string;
  request_id: string;
  office_id: string;
  office_phone: string;
  office_name: string | null;
  status: 'queued' | 'sent' | 'failed' | 'cancelled';
  body: string;
  deliver_at: string;
  sent_at: string | null;
  replied_at: string | null;
  reply_preview: string | null;
  error: string | null;
  created_at: string;
}

export interface RampStep { from_day: number; per_day: number; min_gap_s: number; max_gap_s: number }

export interface LineStatus {
  device_id: string | null;
  line_active: boolean;
  line_started_on: string | null;
  line_age_days: number | null;
  per_day: number;
  min_gap_s: number;
  max_gap_s: number;
  warming_up: boolean;
  next_step_day: number | null;
  today_scheduled: number;
  sent_7d: number;
  replied_7d: number;
  paused_until: string | null;
  pause_reason: string | null;
  half_cap_until: string | null;
  send_start_hour: number;
  send_end_hour: number;
  recontact_days: number;
  ramp: RampStep[];
  low_reply_rate: number;
  low_reply_min_sent: number;
  queued: number;
  can_send: boolean;
}

export interface EnqueueResult {
  queued: number;
  skipped: { office_id: string; reason: string }[];
  first_at: string | null;
  last_at: string | null;
  per_day: number;
}

type Res<T> = { data: T; error: null } | { data: null; error: string };

const NO_DB = 'Supabase is not configured';

function errText(e: { message?: string } | null | undefined): string {
  return e?.message ?? 'unknown error';
}

/** PostgREST returns at most this many rows per response. */
const PAGE_ROWS = 1000;

/**
 * Every qualified office for a request. A city-wide match returns thousands
 * (5,031 for one Riyadh request), past PostgREST's 1,000-row response cap, so
 * this PAGES until a short page — never a silent cut at 1,000. The SQL order is
 * total (final tie-break on id, 2026-09-28_office_outreach_candidates_order),
 * so pages neither overlap nor skip.
 */
export async function fetchCandidates(requestId: string, includeCity: boolean): Promise<Res<OutreachCandidate[]>> {
  if (!supabase) return { data: null, error: NO_DB };
  const all: OutreachCandidate[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .rpc('office_outreach_candidates', { p_request_id: requestId, p_include_city: includeCity })
      .range(from, from + PAGE_ROWS - 1);
    if (error) return { data: null, error: errText(error) };
    const page = (data ?? []) as OutreachCandidate[];
    all.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return { data: all, error: null };
}

export async function fetchOutreach(requestIds: string[]): Promise<Res<OutreachRow[]>> {
  if (!supabase) return { data: null, error: NO_DB };
  if (requestIds.length === 0) return { data: [], error: null };
  const all: OutreachRow[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('office_outreach')
      .select('id, request_id, office_id, office_phone, office_name, status, body, deliver_at, sent_at, replied_at, reply_preview, error, created_at')
      .in('request_id', requestIds)
      .order('deliver_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_ROWS - 1);
    if (error) return { data: null, error: errText(error) };
    const page = (data ?? []) as OutreachRow[];
    all.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return { data: all, error: null };
}

export async function fetchLineStatus(): Promise<Res<LineStatus>> {
  if (!supabase) return { data: null, error: NO_DB };
  const { data, error } = await supabase.rpc('office_outreach_line_status');
  if (error) return { data: null, error: errText(error) };
  return { data: data as LineStatus, error: null };
}

export async function enqueueOutreach(requestId: string, messages: { office_id: string; body: string }[]): Promise<Res<EnqueueResult>> {
  if (!supabase) return { data: null, error: NO_DB };
  const { data, error } = await supabase.rpc('office_outreach_enqueue', { p_request_id: requestId, p_messages: messages });
  if (error) return { data: null, error: errText(error) };
  return { data: data as EnqueueResult, error: null };
}

export async function cancelOutreach(requestId: string): Promise<Res<number>> {
  if (!supabase) return { data: null, error: NO_DB };
  const { data, error } = await supabase.rpc('office_outreach_cancel', { p_request_id: requestId });
  if (error) return { data: null, error: errText(error) };
  return { data: Number(data ?? 0), error: null };
}

export async function saveOutreachSettings(patch: Record<string, unknown>): Promise<Res<LineStatus>> {
  if (!supabase) return { data: null, error: NO_DB };
  const { data, error } = await supabase.rpc('office_outreach_settings_save', { p: patch });
  if (error) return { data: null, error: errText(error) };
  return { data: data as LineStatus, error: null };
}

/** A database refusal key → a sentence the rep can act on. */
export function outreachErrorText(raw: string, isAr: boolean): string {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  if (raw.includes('outreach_no_line')) return L('لم يُحدَّد رقم واتساب مخصص لمراسلة المكاتب بعد — يضبطه المسؤول من «إعدادات الإرسال».', 'No dedicated WhatsApp line is set for offices yet — an admin sets it in «Sending settings».');
  if (raw.includes('outreach_warming_up')) return L('الرقم الجديد في فترة التهيئة ولا يرسل للمكاتب بعد، حتى لا يُحظر.', 'The new line is still warming up and cannot message offices yet, so it is not banned.');
  if (raw.includes('outreach_paused')) return L('الإرسال للمكاتب موقوف مؤقتاً لأن واتساب قيّد الرقم. يُستأنف تلقائياً بعد انتهاء المهلة.', 'Sending to offices is paused because WhatsApp restricted the line. It resumes when the pause ends.');
  if (raw.includes('outreach_nothing_to_send')) return L('لم يتم اختيار أي مكتب.', 'No office selected.');
  if (raw.includes('outreach_admin_only')) return L('هذه الإعدادات للمسؤول فقط.', 'Only an admin can change these settings.');
  if (raw.includes('outreach_unknown_line')) return L('رقم الواتساب المختار غير موجود.', 'The selected WhatsApp line does not exist.');
  if (raw.includes('request_not_found')) return L('لا يمكنك الوصول لهذا الطلب.', 'You cannot access this request.');
  if (raw.includes('outreach_schedule_overflow')) return L('عدد المكاتب أكبر من قدرة الجدولة — اختر عدداً أقل.', 'Too many offices to schedule at once — pick fewer.');
  return raw;
}

/** Why the database skipped an office. */
export function skipReasonText(reason: string, isAr: boolean): string {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  switch (reason) {
    case 'do_not_contact': return L('طلب عدم المراسلة', 'asked not to be messaged');
    case 'recently_contacted': return L('رُوسل مؤخراً', 'messaged recently');
    case 'already_in_request': return L('أُرسل له هذا الطلب', 'already has this request');
    case 'duplicate_phone': return L('رقم مكرر', 'duplicate number');
    case 'no_phone': return L('بلا رقم', 'no number');
    case 'bad_body': return L('نص غير صالح', 'invalid text');
    default: return reason;
  }
}
