import { useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Loader2, MessageCircle, Send, Sparkles, Star, User, UserCheck, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AiAction, AppRecord } from '@/types';
import { decideAiAction } from '@/lib/aiActions/client';
import { resolveChatSuggestion, type ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';
import { CLIENT_OPTIONS_MODEL, saveClientOption, setMainOption } from '@/lib/matching/clientOptions';
import { outcomeLabel } from '@/pages/Chats/lib/useChatOutcomeSuggestion';
import CompleteWhatsAppFollowupModal from '@/pages/Chats/components/CompleteWhatsAppFollowupModal';
import ChatThreadModal from '@/pages/Chats/components/ChatThreadModal';

/**
 * Sales → Work Queue → AI tab, «بانتظار موافقتك»: everything the AI prepared
 * that waits for the operator (2026-10-04 — only portal registration runs on
 * its own for now):
 *   · (messages to clients are NOT here since 2026-10-07 — the AI sends them
 *     itself; the Sales overview shows how many went out);
 *   · messages to project officers — about a highly interested client;
 *   · follow-up results — the outcome the AI read from the chat, plus the
 *     client's main project it chose.
 * A message is edited in place and sent with «اعتمد وأرسل»; a result is
 * recorded through the normal completion window (so the same workflows run as
 * when a rep records it in the chat).
 */

const BTN = '!px-3 !py-1.5 !text-xs !rounded-lg !gap-1';

const DECISION_ERRORS: Record<string, { ar: string; en: string }> = {
  already_decided: { ar: 'تم التعامل معها من قبل', en: 'Already handled' },
  followup_moved: { ar: 'المتابعة لم تعد مفتوحة — لم تُرسل', en: 'The follow-up is no longer open — not sent' },
  client_closed: { ar: 'العميل في مرحلة مغلقة — لم تُرسل', en: 'The client is in a closed stage — not sent' },
  ai_paused: { ar: 'المساعد موقوف في هذه المحادثة — شغّله أو أرسل بنفسك', en: 'The assistant is paused in this chat — resume it or send it yourself' },
  no_operations_line: { ar: 'لا يوجد رقم عمليات مفعّل', en: 'No operations line is configured' },
};

function ctxStr(a: AiAction, key: string): string | null {
  const v = a.context[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

function ctxList(a: AiAction, key: string): string[] {
  const v = a.context[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** The client's last messages, saved on the draft as {at, text}. */
function ctxSaid(a: AiAction): { at: string | null; text: string }[] {
  const v = a.context.client_said;
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x && typeof x === 'object' ? x as { at?: unknown; text?: unknown } : null))
    .filter((x): x is { at?: unknown; text?: unknown } => !!x && typeof x.text === 'string' && x.text.trim() !== '')
    .map((x) => ({ at: typeof x.at === 'string' ? x.at : null, text: String(x.text) }));
}

function fmtAt(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function MessageCard({ action, isAr, clientName, onDone, onRestore, onSettled }: {
  action: AiAction;
  isAr: boolean;
  clientName: string | null;
  onDone: (id: string) => void;
  onRestore: (id: string) => void;
  onSettled: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [text, setText] = useState(action.body);
  const [busy, setBusy] = useState<'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const isOfficer = action.kind === 'officer_notice';
  const warnings = ctxList(action, 'warnings');
  const brief = ctxList(action, 'brief');
  const chatRecordId = ctxStr(action, 'chat_record_id');
  const said = ctxSaid(action);
  const reason = ctxStr(action, 'reason');
  const reading = ctxStr(action, 'reading');
  const failed = action.status === 'failed';
  const sending = action.status === 'sending';

  // Errors that close the card for good — anything else puts it back.
  const isFinal = (e: string) => e === 'already_decided' || e === 'followup_moved' || e === 'client_closed';
  const failToast = (e: string) => {
    const known = DECISION_ERRORS[e];
    addToast(known ? L(known.ar, known.en) : L(`تعذّر: ${e}`, `Failed: ${e}`), 'error');
  };

  // Approve: the card leaves the list at once (operator, 2026-10-05) — the
  // send happens in the background and only a failure brings it back.
  const approve = async () => {
    const edited = text.trim() !== action.body ? text.trim() : undefined;
    onDone(action.id);
    const r = await decideAiAction(action.id, 'approve', edited);
    if (!r.ok) {
      failToast(r.error);
      if (!isFinal(r.error)) onRestore(action.id);
    }
    onSettled();
  };

  // Reject: needs a note saying what was wrong with the draft.
  const reject = async () => {
    if (!note.trim()) return;
    setBusy('reject');
    const r = await decideAiAction(action.id, 'reject', undefined, note.trim());
    setBusy(null);
    if (!r.ok) {
      failToast(r.error);
      if (isFinal(r.error)) { onDone(action.id); onSettled(); }
      return;
    }
    onDone(action.id);
    onSettled();
  };

  return (
    <div className={`rounded-2xl border p-3 ${failed ? 'border-terracotta/50 bg-terracotta/5' : 'border-sand bg-white'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-charcoal/70">
        <span className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2 py-0.5 font-bold text-copper">
          {isOfficer ? <UserCheck size={12} /> : <MessageCircle size={12} />}
          {isOfficer ? L('رسالة للمسؤول', 'To the officer') : L('متابعة للعميل', 'Follow-up to client')}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-chocolate">
          <User size={12} /> {clientName ?? ctxStr(action, 'client_name') ?? '—'}
        </span>
        {isOfficer && ctxStr(action, 'officer_name') && (
          <span>{L('إلى: ', 'To: ')}{ctxStr(action, 'officer_name')}</span>
        )}
        {isOfficer && ctxStr(action, 'project_name') && (
          <span className="inline-flex items-center gap-1"><Building2 size={12} /> {ctxStr(action, 'project_name')}</span>
        )}
        {chatRecordId && (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="ms-auto inline-flex items-center gap-1 rounded-lg bg-[#25D366] px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90"
          >
            <MessageCircle size={12} /> {L('فتح المحادثة', 'Open chat')}
          </button>
        )}
      </div>

      {brief.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-charcoal/60" dir="ltr">
          {brief.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}

      {/* Why this message: the client's own last words, the AI's reading of
          the chat, and the writer's reason. */}
      {!isOfficer && (said.length > 0 || reading || reason) && (
        <div className="mt-2 space-y-1.5 rounded-xl bg-cream/60 p-2.5 text-xs text-charcoal/80">
          {said.length > 0 && (
            <div>
              <div className="mb-0.5 font-bold text-chocolate">{L('آخر ما قاله العميل', 'What the client said last')}</div>
              {said.map((m, i) => (
                <div key={`${m.at ?? ''}-${i}`} className="flex gap-1.5" dir="auto">
                  {m.at && <span className="shrink-0 text-[10px] text-charcoal/50">{fmtAt(m.at, isAr)}</span>}
                  <span className="whitespace-pre-wrap break-words">«{m.text}»</span>
                </div>
              ))}
            </div>
          )}
          {reading && (
            <div>
              <span className="font-bold text-chocolate">{L('قراءة المساعد للمحادثة: ', "The AI's reading of the chat: ")}</span>
              <span dir="auto">{reading}</span>
            </div>
          )}
          {reason && (
            <div>
              <span className="font-bold text-chocolate">{L('لماذا هذه الرسالة: ', 'Why this message: ')}</span>
              <span dir="auto">{reason}</span>
            </div>
          )}
        </div>
      )}
      {chatOpen && chatRecordId && <ChatThreadModal recordId={chatRecordId} onClose={() => setChatOpen(false)} />}

      {failed ? (
        <p className="mt-2 text-sm text-terracotta">
          <AlertTriangle size={13} className="me-1 inline" />
          {L('لم تُرسل: ', 'Not sent: ')}{action.error ?? '—'}
        </p>
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={isOfficer ? 6 : 3}
          dir="auto"
          disabled={sending}
          className="form-input mt-2 w-full resize-y text-sm"
        />
      )}

      {warnings.length > 0 && !failed && (
        <div className="mt-1 rounded-lg bg-gold/15 p-2 text-[11px] text-[#8a6a2f]" dir="ltr">
          {warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}

      {!failed && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {sending ? (
            <span className="inline-flex items-center gap-1 text-xs text-charcoal/60">
              <Loader2 size={12} className="animate-spin" /> {L('جارٍ الإرسال…', 'Sending…')}
            </span>
          ) : (
            <>
              <Button className={BTN} disabled={busy !== null || rejecting || !text.trim()} onClick={() => void approve()}>
                <Send size={12} />
                {L('اعتمد وأرسل', 'Approve & send')}
              </Button>
              {!rejecting && (
                <Button className={BTN} variant="secondary" disabled={busy !== null} onClick={() => setRejecting(true)}>
                  <X size={12} />
                  {L('رفض', 'Reject')}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {rejecting && !failed && (
        <div className="mt-2 space-y-2 rounded-xl border border-terracotta/30 bg-terracotta/5 p-2.5">
          <label className="block text-xs font-bold text-chocolate" htmlFor={`reject-note-${action.id}`}>
            {L('سبب الرفض (مطلوب) — ما الخطأ في الرسالة؟', 'Reason for rejecting (required) — what is wrong with the message?')}
          </label>
          <textarea
            id={`reject-note-${action.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            dir="auto"
            maxLength={1000}
            autoFocus
            className="form-input w-full resize-y text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button className={BTN} variant="danger" disabled={busy !== null || !note.trim()} onClick={() => void reject()}>
              {busy === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              {L('تأكيد الرفض', 'Confirm reject')}
            </Button>
            <Button className={BTN} variant="ghost" disabled={busy !== null} onClick={() => { setRejecting(false); setNote(''); }}>
              {L('إلغاء', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ suggestion: s, isAr, onDone }: {
  suggestion: ChatOutcomeSuggestion;
  isAr: boolean;
  onDone: (id: string) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [chatOpen, setChatOpen] = useState(false);
  const models = useAppStore((st) => st.models);
  const records = useAppStore((st) => st.records);
  const addToast = useAppStore((st) => st.addToast);
  const [open, setOpen] = useState(false);
  const [busyMain, setBusyMain] = useState(false);
  const [busyDismiss, setBusyDismiss] = useState(false);

  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const optionsModel = models.find((m) => m.name === CLIENT_OPTIONS_MODEL);
  const followup: AppRecord | undefined = followupsModel && s.followup_id
    ? (records[followupsModel.id] ?? []).find((r) => r.id === s.followup_id) : undefined;
  const client: AppRecord | undefined = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === s.client_id) : undefined;
  const mainOption = optionsModel && s.suggested_main_project_id
    ? (records[optionsModel.id] ?? []).find((r) => r.data.client_id === s.client_id && r.data.source_type === 'project' && r.data.source_id === s.suggested_main_project_id)
    : undefined;
  const mainAlreadySet = mainOption?.data.is_main === true;

  const approveMain = async () => {
    if (!s.suggested_main_project_id) return;
    setBusyMain(true);
    try {
      let optionId = mainOption?.id ?? null;
      if (!optionId) {
        const created = await saveClientOption({
          clientId: s.client_id, sourceType: 'project', sourceId: s.suggested_main_project_id,
          sourceName: s.suggested_main_project_name, addedFrom: 'follow_up',
        });
        if (!created.ok || !created.optionId) throw new Error(created.reason ?? created.outcome);
        if (created.outcome === 'eliminated_exists') throw new Error(L('هذا المشروع مستبعد عند العميل', 'This project is eliminated for the client'));
        optionId = created.optionId;
      }
      const r = await setMainOption(s.client_id, optionId);
      if (!r.ok) throw new Error(r.reason ?? 'save failed');
      addToast(L('حُدّد المشروع الرئيسي', 'Main project set'), 'success');
    } catch (err) {
      console.error('[AiApprovals] main project approve failed:', err);
      addToast(L(`تعذّر: ${String(err instanceof Error ? err.message : err)}`, `Failed: ${String(err instanceof Error ? err.message : err)}`), 'error');
    } finally {
      setBusyMain(false);
    }
  };

  const dismiss = async () => {
    setBusyDismiss(true);
    try {
      await resolveChatSuggestion(s.id, 'dismissed');
      onDone(s.id);
    } catch (err) {
      addToast(L(`تعذّر: ${String(err)}`, `Failed: ${String(err)}`), 'error');
    } finally {
      setBusyDismiss(false);
    }
  };

  return (
    <div className="rounded-2xl border border-sand bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-charcoal/70">
        <span className="inline-flex items-center gap-1 rounded-full bg-gold/20 px-2 py-0.5 font-bold text-[#8a6a2f]">
          <Sparkles size={12} /> {L('نتيجة متابعة', 'Follow-up result')}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-chocolate">
          <User size={12} /> {(client?.data.client_name as string | undefined) ?? '—'}
        </span>
        {s.chat_record_id && (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="ms-auto inline-flex items-center gap-1 rounded-lg bg-[#25D366] px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90"
          >
            <MessageCircle size={12} /> {L('فتح المحادثة', 'Open chat')}
          </button>
        )}
      </div>
      <div className="mt-2 text-sm">
        <span className="font-bold text-chocolate">{outcomeLabel(s, isAr)}</span>
        {s.confidence != null && <span className="ms-2 text-xs text-charcoal/50">{s.confidence}%</span>}
      </div>
      {s.summary && <p className="mt-1 text-xs text-charcoal/70" dir="auto">{s.summary}</p>}

      {s.suggested_main_project_name && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-cream p-2 text-xs">
          <Star size={12} className="text-copper" />
          <span>{L('المشروع الرئيسي: ', 'Main project: ')}<b>{s.suggested_main_project_name}</b></span>
          {mainAlreadySet ? (
            <span className="inline-flex items-center gap-1 text-[#0f7a52]"><CheckCircle2 size={12} /> {L('محدّد', 'Set')}</span>
          ) : (
            <Button className={BTN} variant="secondary" disabled={busyMain} onClick={() => void approveMain()}>
              {busyMain ? <Loader2 size={12} className="animate-spin" /> : <Star size={12} />}
              {L('اعتمد كمشروع رئيسي', 'Approve as main project')}
            </Button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button className={BTN} disabled={!followup || !followupsModel} onClick={() => setOpen(true)}>
          <CheckCircle2 size={12} /> {L('اعتمد النتيجة', 'Approve result')}
        </Button>
        <Button className={BTN} variant="secondary" disabled={busyDismiss} onClick={() => void dismiss()}>
          {busyDismiss ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          {L('رفض', 'Reject')}
        </Button>
        {!followup && <span className="text-[11px] text-charcoal/50">{L('المتابعة غير محمّلة', 'Follow-up not loaded')}</span>}
      </div>

      {open && followup && followupsModel && (
        <CompleteWhatsAppFollowupModal
          followup={followup}
          followupModel={followupsModel}
          chatRecordId={s.chat_record_id ?? ''}
          clientId={s.client_id}
          clientStage={(client?.data.client_stage as string | undefined) ?? null}
          clientStatus={(client?.data.client_status as string | undefined) ?? null}
          phone={(client?.data.phone_number as string | undefined) ?? null}
          onResolveChat={() => undefined}
          onOpenChat={() => { setOpen(false); if (s.chat_record_id) setChatOpen(true); }}
          onClose={() => { setOpen(false); onDone(s.id); }}
          suggestion={s}
          preselect
          resolveChatOnComplete={false}
        />
      )}
      {chatOpen && s.chat_record_id && <ChatThreadModal recordId={s.chat_record_id} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

export default function AiApprovalsSection({ actions, results, loading, error, isAr, onActionDone, onActionRestore, onActionSettled, onResultDone }: {
  actions: AiAction[];
  results: ChatOutcomeSuggestion[];
  loading: boolean;
  error: string | null;
  isAr: boolean;
  onActionDone: (id: string) => void;
  onActionRestore: (id: string) => void;
  onActionSettled: () => void;
  onResultDone: (id: string) => void;
}) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const clientsModel = models.find((m) => m.name === 'clients');
  const followupsModel = models.find((m) => m.name === 'followups');
  const clientNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of clientsModel ? records[clientsModel.id] ?? [] : []) {
      const n = r.data.client_name;
      if (typeof n === 'string' && n.trim()) m.set(r.id, n);
    }
    return m;
  }, [clientsModel, records]);

  // A result for a task that has since been completed or cancelled is stale —
  // nothing left to approve.
  const liveResults = useMemo(() => {
    const open = new Set((followupsModel ? records[followupsModel.id] ?? [] : [])
      .filter((r) => { const st = String(r.data.followup_status ?? '') || 'open'; return st === 'open' || st === 'in_progress'; })
      .map((r) => r.id));
    return results.filter((s) => s.suggested_outcome && s.followup_id && open.has(s.followup_id));
  }, [results, followupsModel, records]);

  const officerMsgs = actions.filter((a) => a.kind === 'officer_notice');
  // Follow-up messages to clients are no longer approved here — the AI sends
  // them itself (operator, 2026-10-07); the overview counts what went out.
  const total = officerMsgs.length + liveResults.length;

  const group = (title: string, children: React.ReactNode, n: number) => n > 0 && (
    <section className="space-y-2">
      <h3 className="text-sm font-bold text-chocolate">{title} <span className="text-charcoal/50">({n})</span></h3>
      {children}
    </section>
  );

  return (
    <div className="mb-6 space-y-4">
      <p className="text-xs text-charcoal/60">
        {L(
          'ما بقي من عمل المساعد بانتظار قرارك. رسائل المتابعة للعملاء يرسلها المساعد بنفسه.',
          'What the AI left for you to decide. Follow-up messages to clients are sent by the AI itself.',
        )}
      </p>
      {error && <p className="rounded-xl bg-terracotta/10 p-3 text-sm text-terracotta">{L(`تعذّر التحميل: ${error}`, `Could not load: ${error}`)}</p>}
      {loading && total === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{L('جارٍ التحميل…', 'Loading…')}</p>
      ) : total === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{L('لا يوجد شيء بانتظار موافقتك.', 'Nothing is waiting for your approval.')}</p>
      ) : (
        <>
          {group(L('رسائل للمسؤولين', 'Messages to officers'), officerMsgs.map((a) => (
            <MessageCard key={a.id} action={a} isAr={isAr} clientName={clientNames.get(a.client_id) ?? null} onDone={onActionDone} onRestore={onActionRestore} onSettled={onActionSettled} />
          )), officerMsgs.length)}
          {group(L('نتائج المتابعات', 'Follow-up results'), liveResults.map((s) => (
            <ResultCard key={s.id} suggestion={s} isAr={isAr} onDone={onResultDone} />
          )), liveResults.length)}
        </>
      )}
    </div>
  );
}
