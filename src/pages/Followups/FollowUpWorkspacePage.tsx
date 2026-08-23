import { useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { SlidersHorizontal, ArrowLeft, FileText } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord, useCanViewRecord } from '@/hooks/usePermission';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import { applyOverridesToConfig, getFollowUpTypeConfig } from '@/lib/salesProcess';
import { completeFollowUp } from './lib/completeFollowup';
import { cancelSuggestionsForFollowup } from '@/lib/callSuggestions/client';
import type { AppRecord } from '@/types';
import { resolveFollowupContext } from './lib/followupContext';
import { useQualificationDraft } from './hooks/useQualificationDraft';
import MissionHeader from './components/MissionHeader';
import PrimaryAction from './components/PrimaryAction';
import ScriptModal from './components/ScriptModal';
import OptionsBrief from './components/OptionsBrief';
import InventoryMeter from './components/InventoryMeter';
import MissionStepper from './components/MissionStepper';
import { missionStages, type MissionStage } from './lib/missionStages';
import PreferenceSummary from './components/PreferenceSummary';
import { useOwnInventoryCount } from './hooks/useOwnInventoryCount';
import * as qualificationSession from '@/lib/salesProcess/qualificationSession';
import ClientContextCard from './components/ClientContextCard';
import QuickVisitModal from './components/QuickVisitModal';
import QuickAppointmentModal from './components/QuickAppointmentModal';
import ClientDetailModal from './components/ClientDetailModal';
import OutcomePanel from './components/OutcomePanel';
import SalesAssistantSidePanel from './components/SalesAssistantSidePanel';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ChatThreadModal from '@/pages/Chats/components/ChatThreadModal';
import { resolveClientSlugs, recordToPickedClient } from '@/pages/Chats/components/ClientPicker';
import { normalizePhoneDigits } from '@/lib/haberchat/normalize';

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
  const location = useLocation();
  const { models, records, language, saveRecord, addToast, currentUserId, salesProcessOverrides } = useAppStore();
  const isAr = language === 'ar';

  const model = models.find((m) => m.name === 'followups');
  const record = useMemo(
    () => (model ? (records[model.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [model, records, recordId],
  );

  const canView = useCanViewRecord(model, record ?? undefined);
  const canEdit = useCanEditRecord(model, record ?? undefined);

  // Editable draft of the follow-up's data. useRecordDraft re-seeds it when the
  // record first arrives — on a hard reload / direct URL load the records
  // slow-tail resolves AFTER first paint, so a once-only seed would leave the
  // workspace stuck in a degraded no-client state until a re-navigation.
  const { draft, patchDraft } = useRecordDraft(record);
  const [saving, setSaving] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const [showChatModal, setShowChatModal] = useState(false);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [showClientModal, setShowClientModal] = useState(false);

  // Form-mount version snapshot for optimistic concurrency (mirrors RecordFormPage).
  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  // Set when a save returned `conflict`. appStore's reload-on-conflict then
  // re-fetches the live row; we adopt its fresh version below so a retry in this
  // same mount sends the CURRENT version instead of re-conflicting forever.
  const conflictedRef = useRef(false);
  if (record && versionRef.current?.id !== record.id) {
    versionRef.current = { id: record.id, version: record.version ?? null };
    conflictedRef.current = false;
  } else if (
    record && conflictedRef.current &&
    (record.version ?? null) !== (versionRef.current?.version ?? null)
  ) {
    // Post-conflict: the re-fetch landed a newer version — adopt it so the retry
    // succeeds. Gated by conflictedRef so ordinary realtime version bumps don't
    // silently defeat optimistic concurrency (a real concurrent edit still
    // surfaces a conflict on the first save).
    versionRef.current = { id: record.id, version: record.version ?? null };
    conflictedRef.current = false;
  }

  const ctx = useMemo(() => resolveFollowupContext(draft, models, records), [draft, models, records]);
  const salesConfig = useMemo(() => applyOverridesToConfig(salesProcessOverrides), [salesProcessOverrides]);
  const typeConfig = getFollowUpTypeConfig(ctx.typeKey, salesConfig);
  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel && ctx.clientId
    ? (records[clientsModel.id] ?? []).find((r) => r.id === ctx.clientId) ?? null
    : null;
  const initialChatClient = clientRec ? recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr) : null;

  // An already-existing WhatsApp conversation for this client, if any. Preferred
  // by explicit client_link; else matched by phone digits (suffix-tolerant, the
  // same rule the webhook auto-link uses). When present, the WhatsApp button
  // opens that conversation thread in a popup instead of the "new chat"
  // composer. Chat records are persisted in `records`, so they're available
  // here even if the rep never opened the Chats page this session.
  const chatsModel = models.find((m) => m.name === 'chats');
  const existingChat = useMemo<AppRecord | null>(() => {
    if (!chatsModel) return null;
    const chatRecs = records[chatsModel.id] ?? [];
    if (ctx.clientId) {
      const linked = chatRecs.find((r) => (r.data as Record<string, unknown>).client_link === ctx.clientId);
      if (linked) return linked;
    }
    const targets = ctx.phones.map(normalizePhoneDigits).filter((d) => d.length >= 6);
    if (targets.length === 0) return null;
    return (
      chatRecs.find((r) => {
        const p = normalizePhoneDigits((r.data as Record<string, unknown>).phone as string | null | undefined);
        if (p.length < 6) return false;
        return targets.some((t) => p === t || p.endsWith(t) || t.endsWith(p));
      }) ?? null
    );
  }, [chatsModel, records, ctx.clientId, ctx.phones]);

  // WhatsApp button: jump straight into the existing conversation popup when one
  // exists; otherwise open the in-app composer to start a new chat (which, on
  // send, opens the same popup and stamps the follow-up).
  const openWhatsApp = () => {
    if (existingChat) setChatThreadId(existingChat.id);
    else setShowChatModal(true);
  };

  // Best-effort our_projects id to prefill the visit's Project lookup. The
  // Qualification working draft — the lifted client-preference buffer PLUS per-field
  // provenance (saved / ai_filled / ai_changed / rep_edited) and the AI exceptions
  // queue. Owned by the hook (seeds from the saved client, restores across the
  // Suggested-Projects round-trip). `prefDraft` is the value source of truth shared
  // with PreferenceSummary (editor), the InventoryMeter, and the Sales Assistant.
  // AI auto-apply lands here in Phase 4; today only the rep edits it.
  const qual = useQualificationDraft({ clientId: ctx.clientId, followupId: record?.id ?? null });
  const prefDraft = qual.draft;
  const setPrefField = qual.setPrefField;

  // Live count of OUR projects that fit the current (draft) preferences — reacts as
  // the rep qualifies. Deterministic (Project Finder mode:'count'); see the hook.
  const inventory = useOwnInventoryCount({ clientId: ctx.clientId, prefDraft });

  // Which stage of the guided mission the rep is on. The page is keyed by recordId
  // (App.tsx), so this resets when the rep opens a different follow-up.
  const [stage, setStage] = useState<MissionStage>('context');
  const [showScript, setShowScript] = useState(false);
  const [showVisit, setShowVisit] = useState(false);
  const [showClient360, setShowClient360] = useState(false);

  if (!model) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'النموذج غير موجود' : 'Model not found'}</div>;
  if (!record) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'المتابعة غير موجودة' : 'Follow-up not found'}</div>;
  if (!canView) return <div className="p-6 text-[#8E4E3A]">{isAr ? 'لا تملك صلاحية عرض هذا السجل' : 'You do not have permission to view this record'}</div>;

  const readOnly = !canEdit;

  const goAdvanced = () => navigate(`/model/followups/${record.id}?generic=1`);

  // Guided-mission stages for this follow-up type + Next/Back navigation.
  const stages = missionStages(ctx.typeKey, typeConfig?.primary_channel);
  const stageIdx = Math.max(0, stages.indexOf(stage));
  const goNextStage = () => { if (stageIdx < stages.length - 1) setStage(stages[stageIdx + 1]!); };
  const goPrevStage = () => { if (stageIdx > 0) setStage(stages[stageIdx - 1]!); };

  const handleComplete = async (outcomeKey: string) => {
    setSaving(true);
    // The stamping, validation, save and reverse evidence link all live in
    // completeFollowUp() — shared with the chat modals and the AI call-result
    // confirmation popup, so every surface writes `call_result` identically and
    // the outcome workflows can't see three slightly different shapes.
    const pcModel = models.find((m) => m.name === 'phone_calls');
    const result = await completeFollowUp({
      record,
      model,
      draft,
      outcomeKey,
      typeKey: ctx.typeKey,
      currentUserId,
      clientStage: (ctx.client?.client_stage as string) ?? null,
      clientStatus: (ctx.client?.client_status as string) ?? null,
      expectedVersion: versionRef.current?.version ?? null,
      saveRecord,
      phoneCallsRecords: pcModel ? records[pcModel.id] ?? [] : [],
    });
    setSaving(false);

    if (!result.ok) {
      if (result.reason === 'conflict') {
        conflictedRef.current = true; // adopt the re-fetched version next render so a retry succeeds
        addToast(isAr ? 'تم تعديل هذا السجل من مستخدم آخر — حدّث الصفحة قبل الحفظ.' : 'This record was just edited by someone else — reload before saving.', 'error');
      } else {
        addToast(isAr ? result.message_ar : result.message_en, 'error');
      }
      return;
    }
    addToast(
      result.queued
        ? (isAr ? 'تم الحفظ محلياً — سيُزامن لاحقاً.' : 'Saved locally — will sync later.')
        : (isAr ? 'تم إكمال المتابعة' : 'Follow-up completed'),
      result.queued ? 'info' : 'success',
    );

    // A pending AI suggestion for this task is now moot — the rep completed it
    // by hand. Retire it so the popup doesn't ask them to confirm an outcome
    // they already recorded themselves.
    void cancelSuggestionsForFollowup(record.id);

    // Clear the qualification session so the next follow-up can't inherit this
    // task's working draft / provenance / exceptions.
    qualificationSession.resetSession(record.id);

    // Return the rep to where they came from (e.g. the Sales Tasks queue, with
    // its view/filters preserved) if the entry point passed a ?returnTo=; else
    // the generic follow-ups list.
    navigate(new URLSearchParams(location.search).get('returnTo') ?? '/model/followups');
  };

  // FOLLOWUP_3: sending a WhatsApp is an ACTION, not a completion. Stamp the
  // follow-up into the waiting-for-response state (NOT 'completed') and bake the
  // escalation deadline into scheduled_datetime — attempt 1 → +24h; attempt ≥2 →
  // day 5 from the first message. The on_due "WhatsApp No-Response Escalation"
  // workflow fires at that deadline IF still waiting; recording a response
  // clears whatsapp_state first, so the escalation skips. Workflows do the
  // transitions; this only records the action's data on THIS record.
  const handleWhatsAppSent = async (chatId: string | null = null) => {
    if (ctx.typeKey !== 'whatsapp_follow_up' || readOnly) return;
    const now = new Date();
    const attempt = typeof draft.whatsapp_attempt_number === 'number' && draft.whatsapp_attempt_number > 0
      ? draft.whatsapp_attempt_number : 1;
    const firstSent = typeof draft.first_whatsapp_sent_at === 'string' && draft.first_whatsapp_sent_at
      ? draft.first_whatsapp_sent_at : now.toISOString();
    const day5 = new Date(new Date(firstSent).getTime() + 5 * 24 * 3600 * 1000);
    const deadline = attempt >= 2
      ? (day5.getTime() > now.getTime() + 60_000 ? day5 : new Date(now.getTime() + 60_000))
      : new Date(now.getTime() + 24 * 3600 * 1000);
    const patch: Record<string, unknown> = {
      whatsapp_state: 'message_sent_waiting_response',
      sent_at: now.toISOString(),
      first_whatsapp_sent_at: firstSent,
      whatsapp_attempt_number: attempt,
      completed_by_chat_id: chatId ?? (draft.completed_by_chat_id as string | null) ?? null,
      sent_by_user: currentUserId ?? draft.sent_by_user ?? null,
      followup_status: 'in_progress',
      scheduled_datetime: deadline.toISOString(),
      // Reset the on_due claim stamp: we just moved the deadline forward, so the
      // sweep must be allowed to fire at the NEW time. Without this, a task that
      // already came due once (fired_at set) before the rep sent would never be
      // re-claimed (the sweep filters fired_at IS NULL) and its escalation would
      // silently never run. (Bug fix.)
      fired_at: null,
      // Self-reference so the on_due "WhatsApp No-Response Escalation" workflow
      // can close THIS exact waiting record (it filters update_record by id =
      // trigger.source_followup_id; the sweeper can't otherwise self-target).
      source_followup_id: record.id,
    };
    patchDraft(patch);
    setSaving(true);
    const toSave: AppRecord = { ...record, data: { ...draft, ...patch }, updated_at: now.toISOString() };
    const res = await saveRecord(toSave, { expectedVersion: versionRef.current?.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') {
      conflictedRef.current = true; // adopt the re-fetched version on the next render so a retry succeeds
      addToast(isAr ? 'تم تعديل هذا السجل من مستخدم آخر — حدّث الصفحة.' : 'This record was just edited by someone else — reload.', 'error');
      return;
    }
    // Our own write bumped the version; track it so the later "record response"
    // save (handleComplete) uses the fresh version instead of self-conflicting.
    if (res.status !== 'queued' && versionRef.current) {
      versionRef.current = { id: versionRef.current.id, version: (versionRef.current.version ?? 0) + 1 };
    }
    addToast(isAr ? 'تم إرسال الرسالة — بانتظار رد العميل' : 'Message sent — awaiting the customer reply', 'success');
  };

  // "Waiting for reply" without opening the composer — for when the rep already
  // messaged from the chat. Parks the task in the same waiting state (arms the
  // 24h escalation), keeping any existing chat link as evidence.
  const handleMarkWaiting = () => handleWhatsAppSent(null);

  return (
    <div className="mx-auto max-w-[1500px] p-4 sm:p-6">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 space-y-5">
      <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1 text-sm font-semibold text-terracotta hover:underline">
        <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'رجوع' : 'Back'}
      </button>

      <MissionHeader
        typeConfig={typeConfig}
        typeKeyRaw={ctx.typeKey}
        client={ctx.client}
        draft={draft}
        attemptNumber={ctx.attemptNumber}
        onRecordVisit={() => setShowVisit(true)}
        onBookAppointment={() => setShowApptModal(true)}
        readOnly={readOnly}
      />

      <MissionStepper stages={stages} current={stage} onJump={setStage} isAr={isAr} />

      {/* ── the current stage ─────────────────────────────────────────────── */}
      <div className="space-y-5">
        {stage === 'context' ? (
          <>
            <OptionsBrief clientId={ctx.clientId} />
            <ClientContextCard
              clientId={ctx.clientId}
              client={ctx.client}
              currentFollowupId={record.id}
              phones={ctx.phones}
              onOpenWhatsApp={openWhatsApp}
            />
          </>
        ) : null}

        {stage === 'call' || stage === 'whatsapp' ? (
          <>
            <PrimaryAction
              channel={typeConfig?.primary_channel ?? 'call'}
              phones={ctx.phones}
              clientId={ctx.clientId}
              appointmentId={(draft.appointment_id as string) ?? null}
              onWhatsApp={openWhatsApp}
              onViewClient={() => setShowClient360(true)}
            />
            {(isAr ? typeConfig?.script?.ar : typeConfig?.script?.en)?.length ? (
              <button
                type="button"
                onClick={() => setShowScript(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-sand px-4 py-2.5 text-sm font-semibold text-copper transition hover:bg-cream"
              >
                <FileText size={16} /> {isAr ? 'سكربت المكالمة' : 'Call script'}
              </button>
            ) : null}
          </>
        ) : null}

        {stage === 'qualify' ? (
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <PreferenceSummary
                clientId={ctx.clientId}
                onEditFull={() => setShowClientModal(true)}
                draft={prefDraft}
                onFieldChange={setPrefField}
                meta={qual.meta}
              />
            </div>
            {/* Left rail: the Suggested Projects launcher (full "Present" stage
                returns later) with the live own-inventory count right beneath it. */}
            <div className="w-full space-y-5 xl:w-[340px] xl:shrink-0">
              <SalesAssistantSidePanel
                isAr={isAr}
                clientsModel={clientsModel ?? null}
                clientRec={clientRec}
                prefDraft={prefDraft}
                followupDraft={draft}
                followupId={record.id}
                projectName={(ctx.project?.project_name as string | undefined) ?? null}
              />
              <InventoryMeter state={inventory} />
            </div>
          </div>
        ) : null}

        {stage === 'confirm' ? (
          <OutcomePanel
            followupModel={model}
            typeKey={ctx.typeKey}
            draft={draft}
            patchDraft={patchDraft}
            readOnly={readOnly}
            clientId={ctx.clientId}
            phones={ctx.phones}
            onBookAppointment={() => setShowApptModal(true)}
            onSendWhatsApp={() => setShowChatModal(true)}
            onMarkWaiting={handleMarkWaiting}
            onComplete={handleComplete}
            saving={saving}
          />
        ) : null}
      </div>

      {/* ── stage navigation ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sand/60 pt-4">
        <button
          type="button"
          onClick={goPrevStage}
          disabled={stageIdx === 0}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-charcoal/70 hover:bg-cream disabled:opacity-40"
        >
          <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'السابق' : 'Back'}
        </button>
        <div className="flex items-center gap-2">
          {stage !== 'confirm' ? (
            <button
              type="button"
              onClick={() => setStage('confirm')}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-copper hover:bg-cream"
            >
              {isAr ? 'سجّل النتيجة' : 'Record outcome'}
            </button>
          ) : null}
          {stageIdx < stages.length - 1 ? (
            <button
              type="button"
              onClick={goNextStage}
              className="inline-flex items-center gap-1 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
            >
              {isAr ? 'التالي' : 'Next'} <ArrowLeft size={15} className={isAr ? '' : 'rotate-180'} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-sand/60 pt-4">
        <button type="button" onClick={goAdvanced} className="inline-flex items-center gap-1 text-sm font-semibold text-copper hover:underline">
          <SlidersHorizontal size={15} /> {isAr ? 'الحقول المتقدمة' : 'Advanced Fields'}
        </button>
      </div>
      </div>
      </div>

      {showApptModal && (
        <QuickAppointmentModal
          clientId={ctx.clientId}
          phone={ctx.phones[0] ?? null}
          salesRep={draft.sales_rep}
          followupId={record.id}
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
          onSent={(chatId) => { setShowChatModal(false); setChatThreadId(chatId); void handleWhatsAppSent(chatId); }}
        />
      )}

      {/* After sending, show the conversation in a popup — the rep stays on the
          follow-up record; closing it returns them here (no navigation). */}
      {chatThreadId && (
        <ChatThreadModal recordId={chatThreadId} onClose={() => setChatThreadId(null)} />
      )}

      {showScript && <ScriptModal typeConfig={typeConfig} onClose={() => setShowScript(false)} />}

      {showClient360 && ctx.clientId && (
        <ClientDetailModal clientId={ctx.clientId} onClose={() => setShowClient360(false)} />
      )}

      {showVisit && (
        <QuickVisitModal
          clientId={ctx.clientId}
          clientName={(ctx.client?.client_name as string | undefined) ?? null}
          phone={ctx.phones[0] ?? null}
          salesRep={draft.sales_rep}
          followupId={record.id}
          onClose={() => setShowVisit(false)}
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
          onSaved={() => {
            // The full editor just persisted the client — re-seed the lifted
            // preference draft from the fresh record so the panel reflects it.
            qual.resetSeed();
            setShowClientModal(false);
          }}
        />
      )}
    </div>
  );
}
