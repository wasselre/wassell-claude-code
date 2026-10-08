import { useState, type ReactNode } from 'react';
import { CalendarCheck, ChevronDown, ChevronUp, HelpCircle, Loader2, MessageSquareReply, Send, Building2, Clock, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import type { AgentQuestion } from '@/types';

/**
 * One question the AI sales agent could not answer (wa_agent_questions), with
 * the rep's three explicit ways out:
 *   • type the answer → the agent passes it on to the customer in its own voice
 *     (optionally kept as a fact of the project for next time);
 *   • «أجبته مباشرة» → the rep answered the customer themselves;
 *   • «ليس سؤالاً» → dismiss, nothing is sent.
 * Shared by the chat (above the composer) and the Work Queue's
 * «أسئلة المساعد» tab, so both resolve a question the same way.
 *
 * A question to the PROJECT'S OFFICER, or a visit check (2026-10-08 —
 * api/_lib/salesAgent/officerQuestions.ts), is the rep's tracked task: it shows
 * who was asked and when, the deadline, the exact message sent and the
 * officer's replies; the rep records the officer's answer (and, for a visit,
 * whether it is confirmed — that is what books it).
 */

async function authHeaders(): Promise<Record<string, string>> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // en-GB digits in both languages: ar-SA would switch to the Hijri calendar.
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${time}`;
}

interface ThreadLine { id: string; at: string; from_officer: boolean; text: string; ack: string | null }

export default function AgentQuestionItem({ question: q, isAr, context, onResolved, onStale }: {
  question: AgentQuestion;
  isAr: boolean;
  /** Extra lines under the question (client, project, open-chat link) — the Work Queue uses it. */
  context?: ReactNode;
  /** The question is closed — drop it from the list. */
  onResolved: (id: string) => void;
  /** Someone else closed it first — reload the list. */
  onStale: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState('');
  const [asFact, setAsFact] = useState(false);
  const [busy, setBusy] = useState(false);
  const isVisit = !!q.visit_day;
  const isProjectTask = q.asked_to === 'officer' || isVisit;
  const [visitTime, setVisitTime] = useState(q.visit_time ?? '');
  const [toldDirectly, setToldDirectly] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [thread, setThread] = useState<ThreadLine[] | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);

  const act = async (action: 'answer' | 'direct' | 'dismiss', visitOutcome?: 'confirmed' | 'not_available') => {
    let answer = draft.trim();
    // «Confirmed» with nothing typed: the confirmation itself is the answer.
    if (visitOutcome === 'confirmed' && !answer) answer = L('أكّد المسؤول أن فيه أحد يستقبل العميل', 'The officer confirmed someone will receive the customer');
    if (action === 'answer' && !answer) return;
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/agent-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          question_id: q.id, action, answer, save_as_fact: asFact,
          ...(visitOutcome ? { visit_outcome: visitOutcome } : {}),
          ...(visitOutcome === 'confirmed' && visitTime ? { visit_time: visitTime } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; relaying?: boolean; reason?: string };
      if (!res.ok) {
        const msg = body.error === 'ai_paused'
          ? L('المساعد موقوف في هذه المحادثة — ردّ على العميل مباشرة أو شغّل المساعد أولاً', 'The AI is stopped in this chat — answer the customer directly or resume the AI first')
          : body.error === 'already_resolved'
            ? L('هذا السؤال أُجيب عليه بالفعل', 'This question was already resolved')
            : body.error === 'ai_disabled'
              ? L('المساعد الآلي مطفأ — ردّ على العميل مباشرة', 'The AI is switched off — answer the customer directly')
              : body.error?.startsWith('visit_not_booked')
                ? L(`تعذّر حجز الزيارة: ${body.error.replace(/^visit_not_booked:\s*/, '')}`, `Could not book the visit: ${body.error.replace(/^visit_not_booked:\s*/, '')}`)
                : L(`تعذّر الحفظ: ${body.error ?? res.status}`, `Could not save: ${body.error ?? res.status}`);
        addToast(msg, 'error');
        if (body.error === 'already_resolved') onStale();
        return;
      }
      const booked = visitOutcome === 'confirmed';
      addToast(
        action === 'dismiss'
          ? (isProjectTask ? L('أُغلقت المهمة — المساعد يبلّغ العميل أنه ما تأكد', 'Task closed — the AI tells the customer it could not be confirmed') : L('تم تجاهل السؤال', 'Question dismissed'))
          : body.relaying === false
            ? L(`حُفظ الجواب${booked ? ' وانحجزت الزيارة' : ''} — المساعد موقوف، بلّغ العميل بنفسك`, `Saved${booked ? ' and the visit is booked' : ''} — the AI is stopped, tell the customer yourself`)
            : action === 'direct'
              ? L(`أُغلقت${booked ? ' وانحجزت الزيارة' : ''}`, `Closed${booked ? ' and the visit is booked' : ''}`)
              : booked
                ? L('تأكدت الزيارة وانحجز الموعد — المساعد يبلّغ العميل الآن', 'Visit confirmed and booked — the AI is telling the customer now')
                : L('وصل الجواب للمساعد — يبلّغ العميل الآن', 'Answer saved — the AI is telling the customer now'),
        'success',
      );
      onResolved(q.id);
    } catch (err) {
      console.error('[AgentQuestionItem] action failed:', err);
      addToast(L(`خطأ: ${String(err)}`, `Error: ${String(err)}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadThread = async () => {
    setThreadOpen((o) => !o);
    if (thread || threadLoading) return;
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/officer-messages?question_id=${encodeURIComponent(q.id)}`, { headers: await authHeaders() });
      const body = (await res.json().catch(() => ({}))) as { thread?: ThreadLine[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setThread(body.thread ?? []);
    } catch (err) {
      console.error('[AgentQuestionItem] officer thread load failed:', err);
      addToast(L(`تعذّر تحميل ردود المسؤول: ${String(err)}`, `Could not load the officer's replies: ${String(err)}`), 'error');
      setThreadOpen(false);
    } finally {
      setThreadLoading(false);
    }
  };

  // ── A question to the REP (unchanged) ──────────────────────────────────────
  if (!isProjectTask) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3">
        <div className="flex items-start gap-2">
          <HelpCircle size={16} className="mt-0.5 shrink-0 text-amber-700" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold text-amber-800">{L('المساعد يسألك — العميل ينتظر الجواب', 'The AI is asking you — the customer is waiting')}</div>
            <div className="mt-0.5 text-sm font-semibold text-charcoal" dir="auto">{q.question}</div>
            {q.note && <div className="mt-0.5 text-xs text-charcoal/60" dir="auto">{q.note}</div>}
            {context}
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          dir="auto"
          placeholder={L('اكتب الجواب هنا والمساعد يبلّغه للعميل بأسلوبه…', 'Type the answer; the AI passes it on in its own voice…')}
          className="form-input mt-2 w-full resize-none text-sm"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void act('answer')}
            className="inline-flex items-center gap-1 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {L('أرسل الجواب عبر المساعد', 'Send via the AI')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('direct')}
            className="rounded-lg border border-charcoal/20 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal/80 transition hover:bg-cream disabled:opacity-50"
            title={L('رددت على العميل بنفسك — يُغلق السؤال ولا يرسل المساعد شيئاً', 'You answered the customer yourself — closes the question, the AI sends nothing')}
          >
            {L('أجبته مباشرة', 'I answered directly')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('dismiss')}
            className="rounded-lg px-2 py-1.5 text-xs font-semibold text-charcoal/50 transition hover:bg-charcoal/5 disabled:opacity-50"
          >
            {L('ليس سؤالاً', 'Not a question')}
          </button>
          {q.project_id && (
            <label className="ms-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-charcoal/70">
              <input type="checkbox" checked={asFact} onChange={(e) => setAsFact(e.target.checked)} />
              {L('احفظ الجواب كمعلومة عن المشروع', 'Keep as a fact of this project')}
            </label>
          )}
        </div>
      </div>
    );
  }

  // ── A question to the OFFICER / a visit check ──────────────────────────────
  const now = Date.now();
  const overdue = !!q.due_at && Date.parse(q.due_at) < now;
  const toOfficer = q.asked_to === 'officer';
  const statusLine = q.escalated_at
    ? { cls: 'bg-red-100 text-red-800', text: toOfficer ? L('ما رد بعد التذكير — كلّم المسؤول', 'No reply after the reminder — call the officer') : L('متأخرة — أكّدها الآن', 'Overdue — confirm it now') }
    : q.reminded_at
      ? { cls: 'bg-amber-100 text-amber-800', text: L(`ذكّرنا المسؤول ${fmtTime(q.reminded_at)}`, `Officer reminded ${fmtTime(q.reminded_at)}`) }
      : overdue
        ? { cls: 'bg-red-100 text-red-800', text: L('تجاوز موعد الرد', 'Past the answer deadline') }
        : q.due_at
          ? { cls: 'bg-sky-100 text-sky-800', text: L(`الرد متوقع قبل ${fmtTime(q.due_at)}`, `Answer expected by ${fmtTime(q.due_at)}`) }
          : null;

  return (
    <div className="rounded-2xl border border-sky-300 bg-sky-50 p-3">
      <div className="flex items-start gap-2">
        {isVisit ? <CalendarCheck size={16} className="mt-0.5 shrink-0 text-sky-700" /> : <Building2 size={16} className="mt-0.5 shrink-0 text-sky-700" />}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold text-sky-800">
            {isVisit
              ? (toOfficer ? L('تأكيد زيارة مع المشروع — العميل ينتظر', 'Visit check with the project — the customer is waiting') : L('تأكيد زيارة مطلوب منك — العميل ينتظر', 'Visit check for you — the customer is waiting'))
              : L('سؤال للمسؤول — العميل ينتظر', "Question to the project's officer — the customer is waiting")}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-charcoal" dir="auto">{q.question}</div>
          {q.note && <div className="mt-0.5 text-xs text-charcoal/60" dir="auto">{q.note}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-charcoal/70">
            {toOfficer && (
              <span className="inline-flex items-center gap-1">
                <Building2 size={12} /> {L('المسؤول:', 'Officer:')} <span className="font-semibold text-chocolate">{q.officer_name ?? '—'}</span>
              </span>
            )}
            {toOfficer && q.sent_at && (
              <span className="inline-flex items-center gap-1"><Clock size={12} /> {L(`أُرسل ${fmtTime(q.sent_at)}`, `Sent ${fmtTime(q.sent_at)}`)}</span>
            )}
            {statusLine && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusLine.cls}`}>
                {(overdue || q.escalated_at) && <AlertTriangle size={11} />} {statusLine.text}
              </span>
            )}
          </div>
          {context}
          {toOfficer && (
            <div className="mt-2 flex flex-wrap gap-2">
              {q.officer_message && (
                <button type="button" onClick={() => setShowMessage((v) => !v)} className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-charcoal/70 hover:bg-cream">
                  {showMessage ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {L('الرسالة المرسلة للمسؤول', 'Message sent to the officer')}
                </button>
              )}
              <button type="button" onClick={() => void loadThread()} className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-charcoal/70 hover:bg-cream">
                {threadLoading ? <Loader2 size={12} className="animate-spin" /> : <MessageSquareReply size={12} />} {L('ردود المسؤول', "Officer's replies")}
              </button>
            </div>
          )}
          {showMessage && q.officer_message && (
            <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-white p-2.5 font-[inherit] text-xs text-charcoal/80" dir="auto">{q.officer_message}</pre>
          )}
          {threadOpen && thread && (
            <div className="mt-2 space-y-1.5 rounded-xl bg-white p-2.5">
              {thread.length === 0 ? (
                <p className="text-xs text-charcoal/50">{L('لا توجد رسائل في محادثة المسؤول بعد.', "No messages in the officer's chat yet.")}</p>
              ) : thread.map((m) => (
                <div key={m.id} className={`rounded-lg px-2 py-1.5 text-xs ${m.from_officer ? 'bg-green-50 text-charcoal' : 'bg-cream/60 text-charcoal/60'}`}>
                  <div className="mb-0.5 text-[10px] font-bold text-charcoal/50">
                    {m.from_officer ? L('المسؤول', 'Officer') : L('نحن', 'Us')} · {fmtTime(m.at)}{!m.from_officer && m.ack ? ` · ${m.ack}` : ''}
                  </div>
                  <div className="whitespace-pre-wrap" dir="auto">{m.text}</div>
                </div>
              ))}
              <p className="text-[10px] text-charcoal/40">{L('محادثة المسؤول فيها عملاء آخرون — تأكد أن الرد يخص هذا العميل.', "The officer's chat has other clients too — check the reply is about this one.")}</p>
            </div>
          )}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        dir="auto"
        placeholder={toOfficer
          ? L('اكتب جواب المسؤول هنا — المساعد يبلّغه للعميل…', "Type the officer's answer — the AI passes it on…")
          : L('اكتب جواب المشروع هنا — المساعد يبلّغه للعميل…', "Type the project's answer — the AI passes it on…")}
        className="form-input mt-2 w-full resize-none text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isVisit ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(toldDirectly ? 'direct' : 'answer', 'confirmed')}
              className="inline-flex items-center gap-1 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <CalendarCheck size={12} />}
              {L('تأكدت — احجز الزيارة', 'Confirmed — book the visit')}
            </button>
            <label className="inline-flex items-center gap-1 text-[11px] text-charcoal/70">
              {L('الساعة', 'Time')}
              <input type="time" value={visitTime} onChange={(e) => setVisitTime(e.target.value)} className="form-input h-7 w-24 py-0 text-xs" />
            </label>
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void act(toldDirectly ? 'direct' : 'answer', 'not_available')}
              title={L('اكتب السبب أو اليوم البديل أولاً', 'Type the reason or another day first')}
              className="rounded-lg border border-charcoal/20 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal/80 transition hover:bg-cream disabled:opacity-50"
            >
              {L('الزيارة غير ممكنة', 'Visit not possible')}
            </button>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-charcoal/70" title={L('لن يرسل المساعد شيئاً للعميل', 'The AI will send the customer nothing')}>
              <input type="checkbox" checked={toldDirectly} onChange={(e) => setToldDirectly(e.target.checked)} />
              {L('بلّغت العميل بنفسي', 'I told the customer myself')}
            </label>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void act('answer')}
              className="inline-flex items-center gap-1 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {L('سجّل الجواب — المساعد يبلّغه', 'Record the answer — the AI passes it on')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('direct')}
              className="rounded-lg border border-charcoal/20 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal/80 transition hover:bg-cream disabled:opacity-50"
              title={L('بلّغت العميل بنفسك — تُغلق المهمة ولا يرسل المساعد شيئاً', 'You told the customer yourself — closes the task, the AI sends nothing')}
            >
              {L('بلّغت العميل بنفسي', 'I told the customer myself')}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('dismiss')}
          className="rounded-lg px-2 py-1.5 text-xs font-semibold text-charcoal/50 transition hover:bg-charcoal/5 disabled:opacity-50"
          title={L('المساعد يبلّغ العميل أنه ما تأكد', 'The AI tells the customer it could not be confirmed')}
        >
          {toOfficer ? L('المسؤول ما رد — أغلق', 'Officer never answered — close') : L('أغلق بدون تأكيد', 'Close without confirming')}
        </button>
        {q.project_id && (
          <label className="ms-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-charcoal/70">
            <input type="checkbox" checked={asFact} onChange={(e) => setAsFact(e.target.checked)} />
            {L('احفظ الجواب كمعلومة عن المشروع', 'Keep as a fact of this project')}
          </label>
        )}
      </div>
    </div>
  );
}
