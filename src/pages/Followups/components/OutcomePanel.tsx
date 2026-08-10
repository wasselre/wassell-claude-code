import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, CalendarPlus, Loader2, MessageCircle, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel } from '@/types';
import {
  buildFieldLabels,
  getFollowUpTypeConfig,
  getOutcome,
  getOutcomeConfig,
  revealedFieldSlugs,
  validateFollowUpCompletion,
} from '@/lib/salesProcess';
import CallEvidence from './CallEvidence';

interface OutcomePanelProps {
  followupModel: AppModel;
  typeKey: string | null;
  draft: Record<string, unknown>;
  patchDraft: (patch: Record<string, unknown>) => void;
  readOnly: boolean;
  clientId: string | null;
  phones: string[];
  onBookAppointment: () => void;
  /** Open the WhatsApp composer (used by the send→waiting→response flow). */
  onSendWhatsApp?: () => void;
  /** Park the task into the waiting state WITHOUT opening the composer — for
   *  "I already messaged from the chat, now waiting for the reply". */
  onMarkWaiting?: () => void;
  onComplete: (outcomeKey: string) => void;
  saving: boolean;
  /**
   * An AI-proposed outcome. When set it is PRE-SELECTED and promoted to the
   * primary button, so the rep confirms a decision instead of making one —
   * that is the entire point of the call-result assistant. Without it the
   * panel opened with nothing chosen and the first CONFIGURED outcome
   * («تم حجز موعد») sitting there as a big green button, which reads as a
   * recommendation the assistant never made.
   */
  suggestedOutcome?: string | null;
}

// datetime-local <-> ISO helpers (local wall-clock <-> UTC ISO).
function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const toneClasses: Record<string, string> = {
  positive: 'border-[#10B981] text-[#10B981] data-[on=true]:bg-[#10B981] data-[on=true]:text-white',
  neutral: 'border-[#C09B5F] text-[#8E4E3A] data-[on=true]:bg-[#C09B5F] data-[on=true]:text-white',
  negative: 'border-[#8E4E3A] text-[#8E4E3A] data-[on=true]:bg-[#8E4E3A] data-[on=true]:text-white',
};

export default function OutcomePanel(props: OutcomePanelProps) {
  const { followupModel, typeKey, draft, patchDraft, readOnly, clientId, phones, onBookAppointment, onSendWhatsApp, onMarkWaiting, onComplete, saving, suggestedOutcome } = props;
  const isAr = useAppStore((s) => s.language === 'ar');
  const [outcomeKey, setOutcomeKey] = useState<string | null>(
    typeof draft.call_result === 'string' && draft.followup_status === 'completed'
      ? draft.call_result
      : suggestedOutcome ?? null,
  );
  // FOLLOWUP_3 correction: in the open phase the rep chooses between SENDING a
  // WhatsApp (→ waiting state) or RECORDING a reply the client already sent.
  // recordMode = chose "Record customer response" → show the outcome buttons
  // immediately (no send required); completion runs the normal flow and never
  // schedules escalation (whatsapp_state stays unset).
  const [recordMode, setRecordMode] = useState(false);

  // Hoisted ABOVE the early `!typeConfig` return below: hooks must run on every
  // render. On a direct deep-link load the follow-up's draft (and thus typeKey)
  // seeds AFTER first paint, so typeConfig flips falsy→truthy across renders —
  // if this useMemo lived below the early return, the second render would call
  // one more hook than the first and crash the page with React error #310.
  const fieldLabels = useMemo(
    () => buildFieldLabels(followupModel.schema.sections.flatMap((s) => s.fields)),
    [followupModel],
  );

  const typeConfig = getFollowUpTypeConfig(typeKey);
  if (!typeConfig) {
    return (
      <section className="card p-5">
        <p className="text-sm text-terracotta">
          {isAr ? 'لا تتوفر نتائج موجهة لهذا النوع — استخدم الحقول المتقدمة.' : 'No guided outcomes for this type — use Advanced Fields.'}
        </p>
      </section>
    );
  }

  const lostReasonOptions =
    followupModel.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'lost_reason')?.options ?? [];

  const selectOutcome = (value: string) => {
    if (readOnly) return;
    setOutcomeKey(value);
    const patch: Record<string, unknown> = { call_result: value };
    if (!draft.actual_datetime) patch.actual_datetime = new Date().toISOString();
    patchDraft(patch);
  };

  const revealed = outcomeKey ? revealedFieldSlugs(typeKey ?? '', outcomeKey) : [];
  const outcomeCfg = outcomeKey ? getOutcomeConfig(typeKey, outcomeKey) : undefined;
  const validation = outcomeKey
    ? validateFollowUpCompletion({ followupType: typeKey ?? '', selectedOutcome: outcomeKey, draft, fieldLabels })
    : null;

  // FOLLOWUP_3: WhatsApp is a two-phase flow — SEND (an action) then RECORD the
  // reply (the outcome). Sending puts the follow-up into a waiting state; show
  // the Send button until then, and the response-outcome buttons only once a
  // reply is awaited. Non-WhatsApp types are unaffected.
  const isWhatsapp = typeConfig.primary_channel === 'whatsapp';
  const isCompleted = draft.followup_status === 'completed';
  const waState = typeof draft.whatsapp_state === 'string' ? draft.whatsapp_state : undefined;
  // Three WhatsApp phases (the task is a reply-checkpoint — the first project was
  // already sent on the call, NOT from here):
  //   sendPhase    — no state yet: check the reply; if silent, send a CHECK-IN.
  //   repliedPhase — the client replied (set by the inbound webhook reconciler):
  //                  continue the conversation, then record the outcome.
  //   waitingPhase — the rep sent a check-in and is now awaiting a reply.
  const sendPhase = isWhatsapp && !isCompleted && !waState;
  const repliedPhase = isWhatsapp && !isCompleted && waState === 'replied';
  const waitingPhase = isWhatsapp && !isCompleted && waState === 'message_sent_waiting_response';
  const sentAtLabel = typeof draft.sent_at === 'string' && draft.sent_at
    ? new Date(draft.sent_at).toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })
    : null;
  // Early-message indicator: the client messaged us while the task was still
  // fresh (webhook stamp). Shown only in the send phase — it means "check the
  // conversation before sending a check-in"; it is NOT the replied state.
  const clientMessagedLabel = typeof draft.client_messaged_at === 'string' && draft.client_messaged_at
    ? new Date(draft.client_messaged_at).toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })
    : null;

  const dt = (slug: string, label: string) => (
    <label className="block text-sm">
      <span className="mb-1 block text-[#8E4E3A]">{label}</span>
      <input
        type="datetime-local"
        disabled={readOnly}
        value={toLocalInput(draft[slug])}
        onChange={(e) => patchDraft({ [slug]: fromLocalInput(e.target.value) })}
        className="form-input"
      />
    </label>
  );

  return (
    <section className="card p-5" style={{ border: '1.5px solid rgba(184, 115, 79, 0.45)' }}>
      <h2 className="mb-3 text-base font-bold text-chocolate">{isAr ? 'النتيجة' : 'Outcome'}</h2>

      {sendPhase && !recordMode && outcomeKey !== 'no_message_sent' ? (
        <div className="space-y-3">
          {clientMessagedLabel && (
            <div className="flex items-center gap-2 rounded-xl border border-[#10B981]/40 bg-[#10B981]/10 px-3 py-2.5 text-sm text-[#0f7a52]">
              <MessageCircle size={16} className="shrink-0" />
              <span className="flex-1 font-semibold">
                {isAr ? 'العميل أرسل رسالة — تحقق من المحادثة قبل التواصل' : 'The client sent a message — check the conversation first'}
                <span className="font-normal text-charcoal/50"> · {clientMessagedLabel}</span>
              </span>
              <button type="button" onClick={() => setRecordMode(true)} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                {isAr ? 'سجّل النتيجة' : 'Record outcome'}
              </button>
            </div>
          )}
          <p className="text-sm font-bold text-chocolate">{isAr ? 'المشروع أُرسل بعد المكالمة — هل ردّ العميل؟' : 'The project was sent after the call — did the client reply?'}</p>
          {/* Primary: send a check-in (opens the composer → waiting state) */}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onSendWhatsApp?.()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-base font-bold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            <MessageCircle size={18} /> {isAr ? 'إرسال رسالة تفقّد' : 'Send a check-in message'}
          </button>
          <div className="grid gap-2 sm:grid-cols-3">
            {/* I already sent a message (e.g. from the chat) — just park as waiting */}
            <button
              type="button"
              disabled={readOnly}
              onClick={() => onMarkWaiting?.()}
              className="flex flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-[#C09B5F] px-3 py-2.5 text-sm font-bold text-[#8E4E3A] transition hover:bg-[#C09B5F]/10 disabled:opacity-40"
            >
              <Clock size={16} /> {isAr ? 'بانتظار رد العميل' : 'Waiting for reply'}
              <span className="text-[10px] font-normal text-charcoal/50">{isAr ? 'أرسلت الرسالة مسبقاً' : 'already sent'}</span>
            </button>
            {/* Deliberately not messaging now — requires a reason + next date */}
            <button
              type="button"
              disabled={readOnly}
              onClick={() => selectOutcome('no_message_sent')}
              className="flex flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-charcoal/25 px-3 py-2.5 text-sm font-bold text-charcoal/70 transition hover:bg-charcoal/5 disabled:opacity-40"
            >
              <AlertCircle size={16} /> {isAr ? 'لم تُرسل رسالة' : 'No message sent'}
              <span className="text-[10px] font-normal text-charcoal/50">{isAr ? 'سبب + تاريخ' : 'reason + date'}</span>
            </button>
            {/* The client already replied — record the response outcome */}
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setRecordMode(true)}
              className="flex flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-copper px-3 py-2.5 text-sm font-bold text-copper transition hover:bg-copper/5 disabled:opacity-40"
            >
              <CheckCircle2 size={16} /> {isAr ? 'العميل ردّ' : 'Client replied'}
              <span className="text-[10px] font-normal text-charcoal/50">{isAr ? 'سجّل النتيجة' : 'record outcome'}</span>
            </button>
          </div>
          <p className="text-xs text-charcoal/55">
            {isAr
              ? 'أرسل رسالة تفقّد إن لم يردّ العميل. إن قررت عدم الإرسال، اختر «لم تُرسل رسالة» واكتب السبب. سجّل النتيجة فقط بعد أن يردّ العميل.'
              : "Send a check-in if the client hasn't replied. If you chose not to message, pick “No message sent” and write why. Record an outcome only after the client has replied."}
          </p>
        </div>
      ) : (
        <>
          {repliedPhase && (
            <div className="mb-3">
              <div className="flex items-center gap-2 rounded-xl border border-[#10B981]/40 bg-[#10B981]/10 px-3 py-2.5 text-sm text-[#0f7a52]">
                <MessageCircle size={16} className="shrink-0" />
                <span className="flex-1 font-semibold">{isAr ? 'ردّ العميل — أكمل المحادثة ثم سجّل النتيجة' : 'Client replied — continue the conversation, then record the outcome'}</span>
                <button type="button" onClick={() => onSendWhatsApp?.()} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                  {isAr ? 'فتح المحادثة' : 'Open chat'}
                </button>
              </div>
              {/* Escape hatch: the marked "reply" wasn't (or is no longer) the
                  answer the rep is waiting on — e.g. the rep sent a fresh
                  message and the client went silent again. Re-parks the task
                  in the waiting state and re-arms the no-response escalation
                  (same handler as the send flow's "Waiting for reply"). */}
              {onMarkWaiting && !readOnly && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => onMarkWaiting()}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-[#C09B5F] px-3 py-2 text-sm font-bold text-[#8E4E3A] transition hover:bg-[#C09B5F]/10 disabled:opacity-40"
                >
                  <Clock size={15} /> {isAr ? 'ما زلت بانتظار رد العميل' : 'Still waiting for a reply'}
                  <span className="text-[10px] font-normal text-charcoal/50">{isAr ? 'أرسلت رسالة جديدة — أعد التذكير التلقائي' : 'sent a new message — re-arm auto-reminder'}</span>
                </button>
              )}
            </div>
          )}
          {waitingPhase && (
            <div className="mb-3">
              <div className="flex items-center gap-2 rounded-xl border border-[#C09B5F]/40 bg-[#C09B5F]/10 px-3 py-2.5 text-sm text-[#8E4E3A]">
                <Clock size={16} className="shrink-0" />
                <span className="flex-1">
                  {isAr ? 'تم إرسال الرسالة — بانتظار رد العميل' : 'Message sent — awaiting the customer reply'}
                  {sentAtLabel && <span className="text-charcoal/50"> · {sentAtLabel}</span>}
                </span>
                <button type="button" onClick={() => onSendWhatsApp?.()} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                  {isAr ? 'إرسال رسالة أخرى' : 'Send another'}
                </button>
              </div>
              <p className="mt-3 text-sm font-semibold text-chocolate">{isAr ? 'سجّل رد العميل:' : "Record the customer's reply:"}</p>
            </div>
          )}
          {sendPhase && recordMode && (
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-chocolate">{isAr ? 'سجّل رد العميل (ردّ مسبق):' : "Record the customer's reply (already received):"}</p>
              <button type="button" onClick={() => onSendWhatsApp?.()} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                {isAr ? 'إرسال رسالة بدلاً من ذلك' : 'Send a message instead'}
              </button>
            </div>
          )}
          {outcomeKey === 'no_message_sent' ? (
            <div className="mb-1 flex items-center justify-between gap-2 rounded-xl border border-charcoal/20 bg-charcoal/5 px-3 py-2.5">
              <span className="text-sm font-bold text-charcoal">{isAr ? 'لم تُرسل رسالة — اكتب السبب وحدّد موعد المتابعة القادم' : 'No message sent — write the reason and set the next follow-up date'}</span>
              <button type="button" onClick={() => { setOutcomeKey(null); patchDraft({ call_result: null }); }} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                {isAr ? 'رجوع' : 'Back'}
              </button>
            </div>
          ) : (() => {
        // The first config outcome is the primary success path (e.g. حجز موعد for
        // a booking call) — render it as a prominent filled button; the rest as pills.
        // no_message_sent is a PRE-reply action (offered on the choice screen), never a response button.
        const selectable = typeConfig.allowed_outcomes.filter((o) => o.value !== 'no_message_sent');
        // With a suggestion in play the AI's answer takes the primary slot; the
        // configured success path is still offered, just as a pill like the rest.
        const ordered = suggestedOutcome && selectable.some((o) => o.value === suggestedOutcome)
          ? [
              ...selectable.filter((o) => o.value === suggestedOutcome),
              ...selectable.filter((o) => o.value !== suggestedOutcome),
            ]
          : selectable;
        const [primary, ...secondary] = ordered;
        const fill: Record<string, string> = { positive: '#10B981', neutral: '#C09B5F', negative: '#8E4E3A' };
        return (
          <div className="space-y-2">
            {primary && (() => {
              const meta = getOutcome(primary.value);
              const on = outcomeKey === primary.value;
              const c = fill[meta?.tone ?? 'positive'];
              return (
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => selectOutcome(primary.value)}
                  className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
                  style={{ backgroundColor: c, outline: on ? `3px solid ${c}66` : 'none', outlineOffset: 2 }}
                >
                  {on && <CheckCircle2 size={18} />}
                  {isAr ? meta?.label_ar ?? primary.value : meta?.label_en ?? primary.value}
                </button>
              );
            })()}
            {secondary.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {secondary.map((o) => {
                  const meta = getOutcome(o.value);
                  const on = outcomeKey === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      data-on={on}
                      disabled={readOnly}
                      onClick={() => selectOutcome(o.value)}
                      className={`rounded-full border-[1.5px] px-4 py-1.5 text-sm font-semibold transition ${toneClasses[meta?.tone ?? 'neutral']}`}
                    >
                      {isAr ? meta?.label_ar ?? o.value : meta?.label_en ?? o.value}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {outcomeKey && (
        <div className="mt-4 space-y-3">
          {revealed.includes('appointment_id') && outcomeCfg?.requires?.appointment_created && (
            <div className="rounded-xl border border-sand p-3">
              {draft.appointment_id ? (
                <span className="inline-flex items-center gap-1 text-sm text-[#10B981]"><CheckCircle2 size={15} /> {isAr ? 'تم إنشاء الموعد وربطه' : 'Appointment created & linked'}</span>
              ) : (
                <button type="button" onClick={onBookAppointment} disabled={readOnly}
                  className="inline-flex items-center gap-2 rounded-xl bg-copper px-3 py-2 text-sm font-semibold text-white transition hover:bg-terracotta">
                  <CalendarPlus size={16} /> {isAr ? 'حجز موعد' : 'Book Appointment'}
                </button>
              )}
            </div>
          )}
          {revealed.includes('appointment_id') && !outcomeCfg?.requires?.appointment_created && (
            <p className="text-sm text-[#8E4E3A]">
              {draft.appointment_id ? (isAr ? 'الموعد مرتبط ✓' : 'Appointment linked ✓') : (isAr ? 'لا يوجد موعد مرتبط' : 'No appointment linked')}
            </p>
          )}
          {revealed.includes('reschedule_contact_date') && dt('reschedule_contact_date', isAr ? 'موعد إعادة التواصل' : 'Recontact date')}
          {revealed.includes('new_appointment_datetime') && dt('new_appointment_datetime', isAr ? 'موعد الزيارة الجديد' : 'New appointment time')}
          {revealed.includes('lost_reason') && (
            <label className="block text-sm">
              <span className="mb-1 block text-[#8E4E3A]">{isAr ? 'سبب الخسارة' : 'Lost reason'}</span>
              <select
                disabled={readOnly}
                value={(draft.lost_reason as string) ?? ''}
                onChange={(e) => patchDraft({ lost_reason: e.target.value })}
                className="form-input"
              >
                <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                {lostReasonOptions.map((o) => (
                  <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                ))}
              </select>
            </label>
          )}
          {dt('actual_datetime', isAr ? 'وقت الإكمال' : 'Completed at')}
          {revealed.includes('outcome_notes') && (
            <label className="block text-sm">
              <span className="mb-1 block text-[#8E4E3A]">{isAr ? 'ملاحظات' : 'Notes'}</span>
              <textarea
                disabled={readOnly}
                value={(draft.outcome_notes as string) ?? ''}
                onChange={(e) => patchDraft({ outcome_notes: e.target.value })}
                rows={2}
                className="form-input"
              />
            </label>
          )}
          {revealed.includes('completed_by_call_id') && (
            <CallEvidence
              clientId={clientId}
              phones={phones}
              value={(draft.completed_by_call_id as string) ?? null}
              anchor={(draft.actual_datetime as string) ?? null}
              onAttach={(id) => patchDraft({ completed_by_call_id: id })}
            />
          )}

          {/* What will happen (preview — the workflow executes it) */}
          {(outcomeCfg?.client_update_preview || outcomeCfg?.next_action_preview) && (
            <div className="rounded-xl bg-cream p-3 text-xs text-charcoal">
              <span className="font-semibold">{isAr ? 'سيقوم النظام بـ: ' : 'The system will: '}</span>
              {outcomeCfg?.client_update_preview?.stage && (
                <span>{isAr ? `نقل العميل إلى مرحلة «${outcomeCfg.client_update_preview.stage}». ` : `move the client to "${outcomeCfg.client_update_preview.stage}". `}</span>
              )}
              {outcomeCfg?.client_update_preview?.status && (
                <span>{isAr ? `تحديث الحالة إلى «${outcomeCfg.client_update_preview.status}». ` : `set status "${outcomeCfg.client_update_preview.status}". `}</span>
              )}
              {outcomeCfg?.next_action_preview && outcomeCfg.next_action_preview.kind !== 'none' && (
                <span>{isAr ? (outcomeCfg.next_action_preview.note_ar ?? 'إنشاء الإجراء التالي.') : (outcomeCfg.next_action_preview.note_en ?? 'create the next action.')}</span>
              )}
            </div>
          )}

          {validation?.hardErrors.map((e, i) => (
            <p key={`h${i}`} className="flex items-center gap-1 text-sm text-terracotta"><AlertCircle size={14} /> {isAr ? e.message_ar : e.message_en}</p>
          ))}
          {validation?.warnings.map((w, i) => (
            <p key={`w${i}`} className="flex items-center gap-1 text-sm text-gold"><AlertTriangle size={14} /> {isAr ? w.message_ar : w.message_en}</p>
          ))}

          {!readOnly && (
            <button
              type="button"
              disabled={!outcomeKey || !(validation?.ok ?? false) || saving}
              onClick={() => onComplete(outcomeKey)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-copper px-5 py-3 text-base font-bold text-white transition hover:bg-terracotta disabled:opacity-40"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
              {isAr ? 'إكمال وحفظ' : 'Complete & Save'}
            </button>
          )}
        </div>
      )}
        </>
      )}
    </section>
  );
}
