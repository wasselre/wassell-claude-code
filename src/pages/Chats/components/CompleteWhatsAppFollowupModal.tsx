import { useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
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

  // Local editable draft, seeded from the follow-up. If the task carried no
  // WhatsApp state yet (an open checkpoint the rep is now wrapping up from the
  // chat), display it in the "replied — record the outcome" phase so the rep
  // lands directly on the outcome buttons. Completion nulls whatsapp_state.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({
    ...followup.data,
    whatsapp_state: (followup.data as Record<string, unknown>).whatsapp_state ?? 'replied',
  }));
  const patchDraft = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }));

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
              onComplete={doComplete}
              saving={saving}
            />
          ) : (
            <p className="text-sm text-terracotta">{isAr ? 'نوع المتابعة غير معروف.' : 'Unknown follow-up type.'}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-sand/60 p-4">
          <button
            type="button"
            disabled={saving}
            onClick={async () => { setSaving(true); try { await onResolveChat(); } finally { setSaving(false); onClose(); } }}
            className="text-xs font-semibold text-charcoal/60 hover:text-terracotta hover:underline disabled:opacity-40"
            title={isAr ? 'إغلاق المحادثة دون تسجيل نتيجة على المتابعة' : 'Resolve the chat without recording an outcome on the follow-up'}
          >
            {saving ? <Loader2 size={13} className="inline animate-spin" /> : null} {isAr ? 'إغلاق دون تسجيل نتيجة' : 'Resolve without recording'}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-sand px-3 py-1.5 text-sm font-semibold text-charcoal/70 hover:bg-sand/30">
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
