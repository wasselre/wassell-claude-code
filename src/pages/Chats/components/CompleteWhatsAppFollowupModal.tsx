import { useMemo, useState } from 'react';
import { X, Loader2, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';
import { buildFieldLabels, getFollowUpTypeConfig, validateFollowUpCompletion } from '@/lib/salesProcess';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import OutcomePanel from '@/pages/Followups/components/OutcomePanel';

/**
 * "Complete WhatsApp Follow-Up" — shown when the rep clicks Done/Resolve on a
 * client-linked chat that still has an active WhatsApp follow-up task.
 *
 * It does NOT create a separate chat-result object. It completes the EXISTING
 * follow-up through the normal completion path (`saveRecord` on the follow-up),
 * so the existing "WhatsApp Response Completed" workflow runs and moves the
 * client lifecycle. Only after the follow-up is completed do we resolve the
 * chat. Lifecycle movement stays owned by the workflow engine.
 */
export default function CompleteWhatsAppFollowupModal({
  followup,
  followupModel,
  chatRecordId,
  clientId,
  clientStage,
  clientStatus,
  phone,
  onResolveChat,
  onOpenChat,
  onClose,
}: {
  followup: AppRecord;
  followupModel: AppModel;
  chatRecordId: string;
  clientId: string | null;
  clientStage: string | null;
  clientStatus: string | null;
  phone: string | null;
  /** Resolve the chat (status='resolved') after the follow-up is completed. */
  onResolveChat: () => Promise<void> | void;
  /** Close the modal to reveal the chat composer behind it ("Open chat"). */
  onOpenChat: () => void;
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const currentUserId = useAppStore((s) => s.currentUserId);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const [saving, setSaving] = useState(false);

  const typeKey = readFollowupType(followup.data);
  const typeConfig = getFollowUpTypeConfig(typeKey);
  const fieldLabels = useMemo(
    () => buildFieldLabels(followupModel.schema.sections.flatMap((s) => s.fields)),
    [followupModel],
  );

  // Local editable draft, seeded from the follow-up's real state. The panel then
  // shows the honest choice ("did the client reply?"): send a check-in, mark as
  // waiting, record no-message-sent, or record the reply outcome.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...followup.data }));
  const patchDraft = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }));

  // "Waiting for reply" from the chat Done popup: park the task in the waiting
  // state (arms the 24h escalation) and DO NOT resolve the chat — the rep is
  // still waiting, so the conversation stays open. Mirrors the Workspace's
  // handleWhatsAppSent(null).
  const doMarkWaiting = async () => {
    const now = new Date();
    const attempt = typeof draft.whatsapp_attempt_number === 'number' && draft.whatsapp_attempt_number > 0 ? draft.whatsapp_attempt_number : 1;
    const firstSent = typeof draft.first_whatsapp_sent_at === 'string' && draft.first_whatsapp_sent_at ? draft.first_whatsapp_sent_at : now.toISOString();
    const day5 = new Date(new Date(firstSent).getTime() + 5 * 24 * 3600 * 1000);
    const deadline = attempt >= 2 ? (day5.getTime() > now.getTime() + 60_000 ? day5 : new Date(now.getTime() + 60_000)) : new Date(now.getTime() + 24 * 3600 * 1000);
    const finalData: Record<string, unknown> = {
      ...draft,
      whatsapp_state: 'message_sent_waiting_response',
      sent_at: now.toISOString(),
      first_whatsapp_sent_at: firstSent,
      whatsapp_attempt_number: attempt,
      completed_by_chat_id: chatRecordId,
      sent_by_user: currentUserId ?? (draft.sent_by_user as string) ?? null,
      followup_status: 'in_progress',
      scheduled_datetime: deadline.toISOString(),
      fired_at: null,
      source_followup_id: followup.id,
    };
    setSaving(true);
    const res = await saveRecord({ ...followup, data: finalData, updated_at: now.toISOString() }, { expectedVersion: followup.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تم تعديل المتابعة من مكان آخر — افتح المهمة.' : 'This follow-up was edited elsewhere — open the task.', 'error');
      return;
    }
    addToast(isAr ? 'بانتظار رد العميل' : 'Marked as waiting for reply', 'success');
    onClose(); // deliberately NOT resolving the chat
  };

  const doComplete = async (outcomeKey: string) => {
    const now = new Date().toISOString();
    const finalData: Record<string, unknown> = {
      ...draft,
      call_result: outcomeKey,
      actual_datetime: (draft.actual_datetime as string) || now,
      followup_status: 'completed',
      completed_by_user: currentUserId ?? (draft.completed_by_user as string) ?? null,
      // Evidence: this conversation completed the task.
      completed_by_chat_id: chatRecordId,
      // A completed row must never keep a waiting/replied flag (see the same
      // clear in the Follow-up Workspace's handleComplete).
      whatsapp_state: null,
      source_stage_snapshot: (draft.source_stage_snapshot as string) ?? clientStage ?? null,
      source_status_snapshot: (draft.source_status_snapshot as string) ?? clientStatus ?? null,
    };

    // Reuse the exact workspace validation so the chat path can't produce an
    // under-specified completion (e.g. not_interested without a lost_reason).
    const result = validateFollowUpCompletion({
      followupType: typeKey ?? '',
      selectedOutcome: outcomeKey,
      draft: finalData,
      fieldLabels,
    });
    if (!result.ok) {
      addToast(isAr ? (result.hardErrors[0]?.message_ar ?? 'حقول مطلوبة ناقصة') : (result.hardErrors[0]?.message_en ?? 'Required fields missing'), 'error');
      return;
    }

    setSaving(true);
    const saveResult = await saveRecord(
      { ...followup, data: finalData, updated_at: now },
      { expectedVersion: followup.version ?? null },
    );
    if (saveResult.status === 'conflict') {
      setSaving(false);
      addToast(isAr ? 'تم تعديل المتابعة من مكان آخر — افتح المهمة وأكملها.' : 'This follow-up was edited elsewhere — open the task to complete it.', 'error');
      return;
    }

    // Follow-up completed (workflow fired). Now resolve the chat.
    try {
      await onResolveChat();
    } catch {
      // The chat-resolve store path toasts + reverts on its own; the follow-up
      // is already completed, which is the important half.
    }
    setSaving(false);
    addToast(isAr ? 'تم إنهاء متابعة واتساب' : 'WhatsApp follow-up completed', 'success');
    onClose();
  };

  const clientName = (followup.data as Record<string, unknown>).client_name as string | undefined;
  const scheduledISO = (followup.data as Record<string, unknown>).scheduled_datetime as string | undefined;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-6" onClick={onClose}>
      <div className="mt-6 w-full max-w-lg rounded-2xl bg-cream shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-sand/60 p-4">
          <div>
            <h2 className="text-lg font-bold text-chocolate">{isAr ? 'إنهاء متابعة واتساب' : 'Complete WhatsApp Follow-Up'}</h2>
            <p className="mt-0.5 text-sm text-charcoal/70">
              {isAr ? 'ما نتيجة هذه المحادثة؟' : 'What was the outcome of this conversation?'}
            </p>
            <p className="mt-1 text-xs text-charcoal/55">
              {(clientName ? `${clientName} · ` : '')}
              {typeConfig ? (isAr ? typeConfig.label_ar : typeConfig.label_en) : (typeKey ?? '')}
              {scheduledISO ? ` · ${new Date(scheduledISO).toLocaleDateString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium' })}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 text-charcoal/50 hover:bg-sand/40 hover:text-charcoal">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          {typeConfig ? (
            <OutcomePanel
              followupModel={followupModel}
              typeKey={typeKey}
              draft={draft}
              patchDraft={patchDraft}
              readOnly={false}
              clientId={clientId}
              phones={phone ? [phone] : []}
              // Booking an appointment needs the full task workspace — hand off.
              onBookAppointment={onOpenChat}
              // "Open chat" (replied banner) just reveals the composer behind.
              onSendWhatsApp={onOpenChat}
              onMarkWaiting={doMarkWaiting}
              onComplete={doComplete}
              saving={saving}
            />
          ) : (
            <p className="text-sm text-terracotta">{isAr ? 'نوع المتابعة غير معروف.' : 'Unknown follow-up type.'}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-sand/60 p-4">
          {/* "Still waiting" — the client hasn't replied yet, so there is no
              outcome to record. This closes/resolves the chat (it leaves the
              inbox) and deliberately leaves the follow-up untouched in its
              waiting state, so the auto-reminder keeps tracking it. */}
          <button
            type="button"
            disabled={saving}
            onClick={async () => { setSaving(true); try { await onResolveChat(); } finally { setSaving(false); onClose(); } }}
            className="inline-flex items-center gap-2 rounded-xl border-[1.5px] border-[#C09B5F] bg-[#C09B5F]/10 px-4 py-2.5 text-sm font-bold text-[#8E4E3A] transition hover:bg-[#C09B5F]/20 disabled:opacity-40"
            title={isAr ? 'إغلاق المحادثة وترك المتابعة في حالة انتظار الرد' : 'Close the chat and leave the follow-up waiting for a reply'}
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Clock size={15} />}
            {isAr ? 'ما زلت بانتظار رد العميل' : 'Still waiting'}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-sand px-3 py-1.5 text-sm font-semibold text-charcoal/70 hover:bg-sand/30">
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
