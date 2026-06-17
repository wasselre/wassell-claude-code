import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SlidersHorizontal, ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord, useCanViewRecord } from '@/hooks/usePermission';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import { applyOverridesToConfig, buildFieldLabels, getFollowUpTypeConfig, validateFollowUpCompletion } from '@/lib/salesProcess';
import type { AppRecord } from '@/types';
import { resolveFollowupContext } from './lib/followupContext';
import MissionHeader from './components/MissionHeader';
import PrimaryAction from './components/PrimaryAction';
import ScriptPanel from './components/ScriptPanel';
import ContextPanel from './components/ContextPanel';
import PreferenceSummary from './components/PreferenceSummary';
import TimelinePanel from './components/TimelinePanel';
import OutcomePanel from './components/OutcomePanel';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import { resolveClientSlugs, recordToPickedClient } from '@/pages/Chats/components/ClientPicker';

/**
 * The guided Follow-up Workspace — replaces the generic form for `followups`.
 * The rep sees the mission + only-relevant context, acts (call/WhatsApp), records
 * an outcome, and saves. The save writes the follow-up (call_result +
 * actual_datetime + followup_status='completed' + snapshots); the EXISTING
 * workflow engine then moves the client and creates the next task. The generic
 * form remains reachable via "Advanced Fields" (?generic=1).
 */
export default function FollowUpWorkspacePage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { models, records, language, saveRecord, addToast, currentUserId, users, salesProcessOverrides } = useAppStore();
  const isAr = language === 'ar';
  const resolveUser = (id: unknown): string | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || undefined) : undefined;
  };

  const model = models.find((m) => m.name === 'followups');
  const record = useMemo(
    () => (model ? (records[model.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [model, records, recordId],
  );

  const canView = useCanViewRecord(model, record ?? undefined);
  const canEdit = useCanEditRecord(model, record ?? undefined);

  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}) }));
  const patchDraft = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }));
  const [saving, setSaving] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const [showChatModal, setShowChatModal] = useState(false);
  const [showClientModal, setShowClientModal] = useState(false);

  // Form-mount version snapshot for optimistic concurrency (mirrors RecordFormPage).
  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (record && versionRef.current?.id !== record.id) {
    versionRef.current = { id: record.id, version: record.version ?? null };
  }

  const ctx = useMemo(() => resolveFollowupContext(draft, models, records), [draft, models, records]);
  const salesConfig = useMemo(() => applyOverridesToConfig(salesProcessOverrides), [salesProcessOverrides]);
  const typeConfig = getFollowUpTypeConfig(ctx.typeKey, salesConfig);
  const appointmentsModelId = models.find((m) => m.name === 'appointments')?.id;
  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel && ctx.clientId
    ? (records[clientsModel.id] ?? []).find((r) => r.id === ctx.clientId) ?? null
    : null;
  const initialChatClient = clientRec ? recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr) : null;

  if (!model) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'النموذج غير موجود' : 'Model not found'}</div>;
  if (!record) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'المتابعة غير موجودة' : 'Follow-up not found'}</div>;
  if (!canView) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'لا تملك صلاحية عرض هذا السجل' : 'You do not have permission to view this record'}</div>;

  const readOnly = !canEdit;

  const goAdvanced = () => navigate(`/model/followups/${record.id}?generic=1`);

  const handleComplete = async (outcomeKey: string) => {
    const finalData: Record<string, unknown> = {
      ...draft,
      call_result: outcomeKey,
      actual_datetime: draft.actual_datetime ?? new Date().toISOString(),
      followup_status: 'completed',
      completed_by_user: currentUserId ?? draft.completed_by_user ?? null,
      source_stage_snapshot: draft.source_stage_snapshot ?? (ctx.client?.client_stage as string) ?? null,
      source_status_snapshot: draft.source_status_snapshot ?? (ctx.client?.client_status as string) ?? null,
    };

    const result = validateFollowUpCompletion({
      followupType: ctx.typeKey ?? '',
      selectedOutcome: outcomeKey,
      draft: finalData,
      fieldLabels: buildFieldLabels(model.schema.sections.flatMap((s) => s.fields)),
    });
    if (!result.ok) {
      addToast(isAr ? result.hardErrors[0]?.message_ar ?? 'حقول مطلوبة ناقصة' : result.hardErrors[0]?.message_en ?? 'Required fields missing', 'error');
      return;
    }

    setSaving(true);
    const toSave: AppRecord = { ...record, data: finalData, updated_at: new Date().toISOString() };
    const saveResult = await saveRecord(toSave, { expectedVersion: versionRef.current?.version ?? null });
    setSaving(false);

    if (saveResult.status === 'conflict') {
      addToast(isAr ? 'تم تعديل هذا السجل من مستخدم آخر — حدّث الصفحة قبل الحفظ.' : 'This record was just edited by someone else — reload before saving.', 'error');
      return;
    }
    if (saveResult.status === 'queued') {
      addToast(isAr ? 'تم الحفظ محلياً — سيُزامن لاحقاً.' : 'Saved locally — will sync later.', 'info');
    } else {
      addToast(isAr ? 'تم إكمال المتابعة' : 'Follow-up completed', 'success');
    }

    // Bidirectional evidence: stamp the phone_call with this follow-up id.
    const callId = finalData.completed_by_call_id;
    if (typeof callId === 'string' && callId) {
      const pcModel = models.find((m) => m.name === 'phone_calls');
      const callRec = pcModel ? (records[pcModel.id] ?? []).find((r) => r.id === callId) : null;
      if (callRec && callRec.data.linked_followup_id !== record.id) {
        // Own version + opts; a conflict here doesn't undo the completion (the
        // pending-sync queue retries a queued write).
        void saveRecord(
          { ...callRec, data: { ...callRec.data, linked_followup_id: record.id }, updated_at: new Date().toISOString() },
          { expectedVersion: callRec.version ?? null },
        );
      }
    }

    navigate('/model/followups');
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1 text-sm font-semibold text-terracotta hover:underline">
        <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'رجوع' : 'Back'}
      </button>

      <MissionHeader typeConfig={typeConfig} typeKeyRaw={ctx.typeKey} client={ctx.client} draft={draft} attemptNumber={ctx.attemptNumber} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <PrimaryAction
            channel={typeConfig?.primary_channel ?? 'call'}
            phones={ctx.phones}
            clientId={ctx.clientId}
            appointmentId={(draft.appointment_id as string) ?? null}
            onWhatsApp={() => setShowChatModal(true)}
            onViewClient={() => setShowClientModal(true)}
          />
          <ScriptPanel typeConfig={typeConfig} />
          <OutcomePanel
            followupModel={model}
            typeKey={ctx.typeKey}
            draft={draft}
            patchDraft={patchDraft}
            readOnly={readOnly}
            clientId={ctx.clientId}
            phones={ctx.phones}
            onBookAppointment={() => setShowApptModal(true)}
            onComplete={handleComplete}
            saving={saving}
          />
        </div>
        <div className="space-y-5">
          <ContextPanel
            typeConfig={typeConfig}
            ctx={{ client: ctx.client, appointment: ctx.appointment, project: ctx.project, followup: draft, attemptNumber: ctx.attemptNumber, resolveUser, isAr }}
          />
          <PreferenceSummary clientId={ctx.clientId} onEditFull={() => setShowClientModal(true)} />
          <TimelinePanel clientId={ctx.clientId} currentFollowupId={record.id} phones={ctx.phones} />
        </div>
      </div>

      <div className="border-t border-sand/60 pt-4">
        <button type="button" onClick={goAdvanced} className="inline-flex items-center gap-1 text-sm font-semibold text-copper hover:underline">
          <SlidersHorizontal size={15} /> {isAr ? 'الحقول المتقدمة' : 'Advanced Fields'}
        </button>
      </div>

      {showApptModal && appointmentsModelId && (
        <RecordFormModal
          modelId={appointmentsModelId}
          recordId={null}
          prefill={{
            client_id: ctx.clientId,
            phone_number: ctx.phones[0] ?? '',
            sales_rep: draft.sales_rep,
            source_followup_id: record.id,
          }}
          onClose={() => setShowApptModal(false)}
          onSaved={(apptId) => {
            patchDraft({ appointment_id: apptId });
            setShowApptModal(false);
            addToast(isAr ? 'تم إنشاء الموعد' : 'Appointment created', 'success');
          }}
        />
      )}

      {/* WhatsApp → in-app composer, pre-connected to this client. */}
      {showChatModal && (
        <StartChatModal
          onClose={() => setShowChatModal(false)}
          initialClient={initialChatClient}
          initialPhone={ctx.phones[0]}
        />
      )}

      {/* View Client / Edit Full Preferences → client form in a modal, with an
          "Open full page" button to hand off to the full record page. */}
      {showClientModal && clientsModel && ctx.clientId && (
        <RecordFormModal
          modelId={clientsModel.id}
          recordId={ctx.clientId}
          openInPageHref={`/model/clients/${ctx.clientId}`}
          onClose={() => setShowClientModal(false)}
          onSaved={() => setShowClientModal(false)}
        />
      )}
    </div>
  );
}
