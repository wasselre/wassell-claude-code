/**
 * The client list's live columns — interest level, top project, what is
 * happening, the last action (by the AI or a person), last contact, visit —
 * from GET /api/client-pulse (SQL `client_pulse`, migration 2026-10-08_05).
 * Everything is derived from recorded facts; the wording below is fixed, built
 * from the codes the server returns (no model writes it).
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getFollowUpTypeConfig, getOutcome } from '@/lib/salesProcess';
import { formatRelative } from '@/pages/Clients/lib/lifecycleDisplay';

export type InterestLevel = 'hot' | 'warm' | 'quiet' | 'unknown' | 'closed';

export interface ClientPulse {
  client_id: string;
  interest: InterestLevel;
  /** Why it is hot / warm: visit_requested | appointment | visited | wants | ai | links | asked | messaged. */
  interest_reason: string | null;
  top_project_id: string | null;
  top_project_name: string | null;
  last_action: {
    by: 'ai' | 'person';
    kind: string;
    at: string;
    project?: string | null;
    result?: string | null;
    followup_type?: string | null;
  } | null;
  last_contact_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  situation: {
    code: 'visit_check' | 'officer_question' | 'rep_question' | 'appointment' | 'customer_waiting' | 'waiting_customer';
    waiting?: 'officer' | 'rep';
    day?: string;
    at?: string;
    since?: string;
    status?: string;
    project?: string | null;
    overdue?: boolean;
  } | null;
  visit: {
    kind: 'appointment' | 'requested' | 'visited';
    at?: string;
    day?: string;
    status?: string;
    project?: string | null;
  } | null;
}

export const INTEREST_ORDER: InterestLevel[] = ['hot', 'warm', 'quiet', 'unknown', 'closed'];

export const INTEREST_META: Record<InterestLevel, { ar: string; en: string; cls: string }> = {
  hot: { ar: 'ساخن', en: 'Hot', cls: 'bg-red-100 text-red-800' },
  warm: { ar: 'دافئ', en: 'Warm', cls: 'bg-amber-100 text-amber-800' },
  quiet: { ar: 'هادئ', en: 'Quiet', cls: 'bg-sky-50 text-sky-800' },
  unknown: { ar: 'غير معروف', en: 'Unknown', cls: 'bg-charcoal/5 text-charcoal/60' },
  closed: { ar: 'مغلق', en: 'Closed', cls: 'bg-charcoal/10 text-charcoal/50' },
};

const REASON: Record<string, { ar: string; en: string }> = {
  visit_requested: { ar: 'طلب زيارة', en: 'Asked to visit' },
  appointment: { ar: 'عنده موعد زيارة', en: 'Has a visit booked' },
  visited: { ar: 'زار مشروعاً مؤخراً', en: 'Visited recently' },
  wants: { ar: 'قال إنه يبي المشروع', en: 'Said they want the project' },
  ai: { ar: 'المساعد حكم عليه بالاهتمام', en: 'The AI judged them interested' },
  links: { ar: 'تفاعل مع روابط المشروع', en: 'Engaged with project links' },
  asked: { ar: 'سأل عن المشروع', en: 'Asked about the project' },
  messaged: { ar: 'راسلنا مؤخراً', en: 'Messaged us recently' },
};

export function reasonText(code: string | null, isAr: boolean): string | null {
  if (!code) return null;
  const r = REASON[code];
  return r ? (isAr ? r.ar : r.en) : null;
}

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** «الجمعة 09/10» from YYYY-MM-DD or a Riyadh wall-clock «YYYY-MM-DDTHH:mm» (time kept). */
export function dayLabel(value: string | null | undefined, isAr: boolean): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return null;
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  const day = `${isAr ? AR_DAYS[wd] : EN_DAYS[wd]} ${m[3]}/${m[2]}`;
  return m[4] !== undefined ? `${day} ${m[4]}:${m[5]}` : day;
}

/** One line: what is happening with the client right now. */
export function situationText(p: ClientPulse, isAr: boolean, now: number): { text: string; urgent: boolean } | null {
  const s = p.situation;
  if (!s) return null;
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const proj = s.project ? ` ${s.project}` : '';
  switch (s.code) {
    case 'visit_check':
      return {
        text: s.waiting === 'officer'
          ? L(`بانتظار تأكيد المسؤول لزيارة${proj} ${dayLabel(s.day, true) ?? ''}`, `Waiting for the officer to confirm the${proj} visit ${dayLabel(s.day, false) ?? ''}`)
          : L(`زيارة${proj} ${dayLabel(s.day, true) ?? ''} بانتظار تأكيدك`, `${proj} visit ${dayLabel(s.day, false) ?? ''} waiting for you to confirm`),
        urgent: !!s.overdue,
      };
    case 'officer_question':
      return { text: L(`سؤال للمسؤول${proj} بانتظار الرد`, `Question to the${proj} officer, waiting`), urgent: !!s.overdue };
    case 'rep_question':
      return { text: L('سؤال من المساعد بانتظار جوابك', 'The AI is waiting for your answer'), urgent: true };
    case 'appointment':
      return {
        text: L(`موعد زيارة${proj} ${dayLabel(s.at, true) ?? ''}${s.status === 'confirmed' ? ' (مؤكد)' : ''}`,
          `Visit${proj} ${dayLabel(s.at, false) ?? ''}${s.status === 'confirmed' ? ' (confirmed)' : ''}`),
        urgent: false,
      };
    case 'customer_waiting': {
      const ago = formatRelative(s.since, isAr, now) ?? '';
      const late = s.since ? now - Date.parse(s.since) > 30 * 60_000 : false;
      return { text: L(`العميل ينتظر ردنا (${ago})`, `Customer waiting for our reply (${ago})`), urgent: late };
    }
    case 'waiting_customer': {
      const ago = formatRelative(s.since, isAr, now) ?? '';
      return { text: L(`بانتظار رد العميل (${ago})`, `Waiting for the customer (${ago})`), urgent: false };
    }
    default:
      return null;
  }
}

/** The last action, as «المساعد: أرسل يمام 16». */
export function actionText(p: ClientPulse, isAr: boolean): string | null {
  const a = p.last_action;
  if (!a) return null;
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const proj = a.project ? ` ${a.project}` : '';
  switch (a.kind) {
    case 'visit_requested': return L(`طلب تأكيد زيارة${proj}`, `Asked the project to confirm a${proj} visit`);
    case 'visit_booked': return L(`حجز زيارة${proj}`, `Booked a${proj} visit`);
    case 'sent_project': return L(`أرسل${proj}`, `Sent${proj}`);
    case 'sent_units': return L(`أرسل وحدات${proj}`, `Sent units of${proj}`);
    case 'handoff': return L('حوّل العميل لزميل', 'Handed the customer to a colleague');
    case 'asked': return L('سأل زميلاً عن معلومة', 'Asked a colleague a question');
    case 'replied': return L('رد على العميل', 'Replied to the customer');
    case 'whatsapp': return L('أرسل رسالة واتساب', 'Sent a WhatsApp');
    case 'call': return L('مكالمة', 'Call');
    case 'result': {
      const o = getOutcome(a.result ?? null);
      const t = getFollowUpTypeConfig(a.followup_type ?? null);
      const res = o ? (isAr ? o.label_ar : o.label_en) : (a.result ?? '');
      const typ = t ? (isAr ? t.label_ar : t.label_en) : '';
      return typ ? `${typ}: ${res}` : res;
    }
    default: return a.kind;
  }
}

export function visitText(p: ClientPulse, isAr: boolean): string | null {
  const v = p.visit;
  if (!v) return null;
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const proj = v.project ? ` ${v.project}` : '';
  if (v.kind === 'appointment') return L(`موعد${proj} ${dayLabel(v.at, true) ?? ''}`, `Booked${proj} ${dayLabel(v.at, false) ?? ''}`);
  if (v.kind === 'requested') return L(`يبي يزور${proj} ${dayLabel(v.day, true) ?? ''}`, `Wants to visit${proj} ${dayLabel(v.day, false) ?? ''}`);
  return L(`زار${proj}`, `Visited${proj}`);
}

/** «Waiting on us»: the customer wrote last, or a question / visit check is open with us. */
export function waitingOnUs(p: ClientPulse): boolean {
  const c = p.situation?.code;
  return c === 'customer_waiting' || c === 'rep_question' || c === 'visit_check' || c === 'officer_question';
}

/** The pulse for every client the caller can see; refreshed every 2 minutes and on focus. */
export function useClientPulse(): { byId: Map<string, ClientPulse>; loading: boolean; error: string | null; refresh: () => void } {
  const [byId, setById] = useState<Map<string, ClientPulse>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const res = await fetch('/api/client-pulse', {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const body = (await res.json().catch(() => ({}))) as { clients?: ClientPulse[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setById(new Map((body.clients ?? []).map((c) => [c.client_id, c])));
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[useClientPulse] load failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 120_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  return { byId, loading, error, refresh: () => void refresh() };
}
