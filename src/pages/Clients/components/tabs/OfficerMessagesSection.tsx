/**
 * «رسائل المسؤولين» — under the client's portal registrations: every message we
 * sent a project's officer about this client (operator, 2026-10-08: "for every
 * customer, I could go to Portals and see what messages we have sent to the
 * officer regarding this client"). Interest notices, registration notices,
 * questions and visit checks (with their task status and the officer's answer),
 * reminders, and messages sent by hand from a chat (logged from 2026-10-08 on).
 *
 * Data: GET /api/officer-messages?client_id= (ai_actions kind officer_notice).
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronUp, Loader2, RefreshCw, AlertTriangle, CalendarCheck } from 'lucide-react';
import Button from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';

type Kind = 'interest' | 'registration' | 'visit_check' | 'question' | 'negotiation' | 'reminder' | 'manual';

interface OfficerMessage {
  id: string;
  kind: Kind;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  officer_name: string | null;
  officer_phone: string | null;
  project_name: string | null;
  body: string;
  delivery: string | null;
  question: {
    id: string; status: string; answer: string | null; answered_at: string | null; due_at: string | null; reminded_at: string | null;
    visit_day: string | null; visit_confirmed: boolean | null; booked_appointment_id: string | null;
  } | null;
}

const KIND_LABEL: Record<Kind, { ar: string; en: string }> = {
  interest: { ar: 'إشعار اهتمام', en: 'Interest notice' },
  registration: { ar: 'إشعار تسجيل في البوابة', en: 'Registration notice' },
  visit_check: { ar: 'تأكيد زيارة', en: 'Visit check' },
  question: { ar: 'سؤال', en: 'Question' },
  negotiation: { ar: 'سؤال سعر / خصم', en: 'Price / discount question' },
  reminder: { ar: 'تذكير', en: 'Reminder' },
  manual: { ar: 'رسالة يدوية', en: 'Sent by hand' },
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // en-GB digits in both languages: ar-SA would switch to the Hijri calendar.
  return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function deliveryLabel(m: OfficerMessage, isAr: boolean): { text: string; cls: string } {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  if (m.status === 'pending') return { text: L('بانتظار الموافقة', 'Awaiting approval'), cls: 'bg-amber-100 text-amber-800' };
  if (m.status === 'rejected') return { text: L('رُفضت ولم تُرسل', 'Rejected — not sent'), cls: 'bg-charcoal/10 text-charcoal/60' };
  if (m.status === 'expired') return { text: L('انتهت ولم تُرسل', 'Expired — not sent'), cls: 'bg-charcoal/10 text-charcoal/60' };
  if (m.status === 'failed') return { text: L('فشل الإرسال', 'Failed to send'), cls: 'bg-red-100 text-red-800' };
  if (m.status === 'sending') return { text: L('مجدولة للإرسال', 'Queued'), cls: 'bg-sky-100 text-sky-800' };
  if (m.delivery === 'read') return { text: L('قُرئت', 'Read'), cls: 'bg-green-100 text-green-800' };
  if (m.delivery === 'delivered') return { text: L('وصلت', 'Delivered'), cls: 'bg-green-50 text-green-700' };
  return { text: L('أُرسلت', 'Sent'), cls: 'bg-green-50 text-green-700' };
}

function taskLabel(q: NonNullable<OfficerMessage['question']>, isAr: boolean): { text: string; cls: string } {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  if (q.status === 'open') {
    const overdue = !!q.due_at && Date.parse(q.due_at) < Date.now();
    return overdue
      ? { text: L('بانتظار رد المسؤول — متأخر', 'Waiting for the officer — overdue'), cls: 'bg-red-100 text-red-800' }
      : { text: L('بانتظار رد المسؤول', 'Waiting for the officer'), cls: 'bg-amber-100 text-amber-800' };
  }
  if (q.status === 'dismissed') return { text: L('أُغلقت بدون جواب', 'Closed without an answer'), cls: 'bg-charcoal/10 text-charcoal/60' };
  if (q.visit_day && q.visit_confirmed === true) return { text: L('تأكدت الزيارة وانحجزت', 'Visit confirmed and booked'), cls: 'bg-green-100 text-green-800' };
  if (q.visit_day && q.visit_confirmed === false) return { text: L('الزيارة غير ممكنة', 'Visit not possible'), cls: 'bg-charcoal/10 text-charcoal/70' };
  return { text: L('أُجيب', 'Answered'), cls: 'bg-green-100 text-green-800' };
}

export default function OfficerMessagesSection({ clientId, isAr }: { clientId: string; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [messages, setMessages] = useState<OfficerMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const res = await fetch(`/api/officer-messages?client_id=${encodeURIComponent(clientId)}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const body = (await res.json().catch(() => ({}))) as { messages?: OfficerMessage[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setMessages(body.messages ?? []);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[OfficerMessagesSection] load failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Building2 size={18} className="text-copper" />
        <span className="text-base font-bold text-charcoal">
          {L(`رسائل المسؤولين (${messages.length})`, `Messages to officers (${messages.length})`)}
        </span>
        <span className="text-xs text-charcoal/50">{L('كل ما أرسلناه لمسؤولي المشاريع عن هذا العميل', "Everything we sent project officers about this client")}</span>
        <Button variant="secondary" className="ms-auto" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          {L('تحديث', 'Refresh')}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <div>{L('تعذّر تحميل رسائل المسؤولين.', 'Could not load the messages to officers.')}</div>
            <div className="mt-1 text-xs opacity-80">{error}</div>
          </div>
        </div>
      )}

      {!loading && !error && messages.length === 0 && (
        <div className="rounded-xl border border-dashed border-sand p-6 text-center text-sm text-charcoal/60">
          {L('لم نرسل أي رسالة لمسؤول مشروع عن هذا العميل بعد.', 'No message has been sent to a project officer about this client yet.')}
        </div>
      )}

      {messages.map((m) => {
        const d = deliveryLabel(m, isAr);
        const t = m.question ? taskLabel(m.question, isAr) : null;
        const isOpen = open.has(m.id);
        return (
          <div key={m.id} className="rounded-xl border border-sand/40 bg-white">
            <button type="button" onClick={() => toggle(m.id)} className="flex w-full flex-wrap items-start gap-x-4 gap-y-1.5 p-3 text-start">
              <div className="min-w-[180px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-copper/10 px-2 py-0.5 text-[11px] font-bold text-copper">
                    {isAr ? KIND_LABEL[m.kind].ar : KIND_LABEL[m.kind].en}
                  </span>
                  <span className="font-bold text-charcoal">{m.project_name ?? L('بدون مشروع', 'No project')}</span>
                </div>
                <div className="mt-0.5 text-xs text-charcoal/60">
                  {L('إلى', 'To')} {m.officer_name ?? L('المسؤول', 'the officer')}
                  {m.officer_phone && <span dir="ltr"> · {m.officer_phone}</span>}
                  {' · '}{fmt(m.sent_at ?? m.created_at)}
                </div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${d.cls}`}>{d.text}</span>
              {t && (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${t.cls}`}>
                  {m.question?.visit_day && <CalendarCheck size={11} />} {t.text}
                </span>
              )}
              {isOpen ? <ChevronUp size={16} className="text-charcoal/40" /> : <ChevronDown size={16} className="text-charcoal/40" />}
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-sand/30 p-3">
                <pre className="whitespace-pre-wrap rounded-lg bg-cream/50 p-2.5 font-[inherit] text-xs text-charcoal/80" dir="auto">{m.body || '—'}</pre>
                {m.error && <div className="text-xs text-red-700">{m.error}</div>}
                {m.question?.answer && (
                  <div className="rounded-lg bg-green-50 p-2.5 text-xs text-charcoal">
                    <div className="mb-0.5 text-[10px] font-bold text-green-800">
                      {L('جواب المسؤول', "Officer's answer")} · {fmt(m.question.answered_at)}
                    </div>
                    <div className="whitespace-pre-wrap" dir="auto">{m.question.answer}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
