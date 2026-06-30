import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { SlidersHorizontal, ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord, useCanViewRecord } from '@/hooks/usePermission';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import { applyOverridesToConfig, buildFieldLabels, getFollowUpTypeConfig, validateFollowUpCompletion } from '@/lib/salesProcess';
import type { AppRecord } from '@/types';
import { resolveFollowupContext } from './lib/followupContext';
import { getFinderHandoff, clearFinderHandoff } from '@/lib/matching/finderHandoff';
import MissionHeader from './components/MissionHeader';
import PrimaryAction from './components/PrimaryAction';
import RegisterVisitAction from './components/RegisterVisitAction';
import ScriptPanel from './components/ScriptPanel';
import ContextPanel from './components/ContextPanel';
import PreferenceSummary from './components/PreferenceSummary';
import TimelinePanel from './components/TimelinePanel';
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
  const appointmentsModelId = models.find((m) => m.name === 'appointments')?.id;
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
  // follow-up's project context is keyed on all_projects, but a visit's Project
  // lookup targets our_projects — so only prefill when a candidate id is a real
  // our_projects record (otherwise leave it blank rather than show a broken ref).
  const ourProjectsModel = models.find((m) => m.name === 'our_projects');
  const visitProjectCandidate = useMemo<string | null>(() => {
    if (!ourProjectsModel) return null;
    const ourIds = new Set((records[ourProjectsModel.id] ?? []).map((r) => r.id));
    const candidates: unknown[] = [
      ctx.appointment?.project_id,
      draft.appointment_project,
      draft.visited_projects,
      ctx.client?.preferred_projects,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && ourIds.has(c)) return c;
      if (Array.isArray(c)) {
        const hit = c.find((v) => typeof v === 'string' && ourIds.has(v));
        if (typeof hit === 'string') return hit;
      }
    }
    return null;
  }, [ourProjectsModel, records, ctx.appointment, ctx.client, draft.appointment_project, draft.visited_projects]);

  // Lifted client-preference draft buffer. Seeded from the saved client (once
  // per client; survives realtime echoes — same rule PreferenceSummary used
  // internally), shared with BOTH PreferenceSummary (the editor) AND the Sales
  // Assistant side panel (the reader), so a quick action uses the rep's UNSAVED
  // edits. prefSeededRef is nulled after a full-modal save so the freshly-saved
  // prefs re-seed the buffer.
  const [prefDraft, setPrefDraft] = useState<Record<string, unknown>>({});
  const prefSeededRef = useRef<string | null>(null);
  useEffect(() => {
    if (clientRec && prefSeededRef.current !== ctx.clientId) {
      prefSeededRef.current = ctx.clientId;
      // Returning from the full-page Suggested Projects finder: restore the exact
      // (unsaved-included) draft the rep had when they opened it, then clear the
      // hand-off so a later legitimate re-seed reads the saved client data.
      const handoff = record ? getFinderHandoff(record.id) : null;
      setPrefDraft(handoff ? { ...handoff.prefDraft } : { ...clientRec.data });
      if (handoff) clearFinderHandoff();
    }
  }, [ctx.clientId, clientRec, record]);
  const setPrefField = (slug: string, value: unknown) => setPrefDraft((d) => ({ ...d, [slug]: value }));

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
      conflictedRef.current = true; // adopt the re-fetched version on the next render so a retry succeeds
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
  const handleWhatsAppSent = async (chatId: string) => {
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
      completed_by_chat_id: chatId,
      sent_by_user: currentUserId ?? draft.sent_by_user ?? null,
      followup_status: 'in_progress',
      scheduled_datetime: deadline.toISOString(),
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

  return (
    <div className="mx-auto max-w-[1500px] p-4 sm:p-6">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 space-y-5">
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
            onWhatsApp={openWhatsApp}
            onViewClient={() => setShowClientModal(true)}
          />
          {/* FOLLOWUP_4: register a client-reported visit as evidence — secondary,
              available for every follow-up type, never changes the outcome. */}
          <RegisterVisitAction
            followupId={record.id}
            clientId={ctx.clientId}
            clientName={(ctx.client?.client_name as string | undefined) ?? null}
            phone={ctx.phones[0] ?? null}
            salesRep={draft.sales_rep}
            projectCandidateId={visitProjectCandidate}
            readOnly={readOnly}
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
            onSendWhatsApp={() => setShowChatModal(true)}
            onComplete={handleComplete}
            saving={saving}
          />
        </div>
        <div className="space-y-5">
          <ContextPanel
            typeConfig={typeConfig}
            ctx={{ client: ctx.client, appointment: ctx.appointment, project: ctx.project, followup: draft, attemptNumber: ctx.attemptNumber, resolveUser, isAr }}
          />
          <PreferenceSummary
            clientId={ctx.clientId}
            onEditFull={() => setShowClientModal(true)}
            draft={prefDraft}
            onFieldChange={setPrefField}
          />
          <TimelinePanel clientId={ctx.clientId} currentFollowupId={record.id} phones={ctx.phones} />
        </div>
      </div>

      <div className="border-t border-sand/60 pt-4">
        <button type="button" onClick={goAdvanced} className="inline-flex items-center gap-1 text-sm font-semibold text-copper hover:underline">
          <SlidersHorizontal size={15} /> {isAr ? 'الحقول المتقدمة' : 'Advanced Fields'}
        </button>
      </div>
      </div>

      {/* Contextual Sales Assistant — the SAME assistant as the main page, scoped
          to this follow-up. Reads the rep's UNSAVED preference draft (prefDraft). */}
      <SalesAssistantSidePanel
        isAr={isAr}
        clientsModel={clientsModel ?? null}
        clientRec={clientRec}
        prefDraft={prefDraft}
        followupDraft={draft}
        followupId={record.id}
        projectName={(ctx.project?.project_name as string | undefined) ?? null}
      />
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
          onSent={(chatId) => { setShowChatModal(false); setChatThreadId(chatId); void handleWhatsAppSent(chatId); }}
        />
      )}

      {/* After sending, show the conversation in a popup — the rep stays on the
          follow-up record; closing it returns them here (no navigation). */}
      {chatThreadId && (
        <ChatThreadModal recordId={chatThreadId} onClose={() => setChatThreadId(null)} />
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
            prefSeededRef.current = null;
            setShowClientModal(false);
          }}
        />
      )}
    </div>
  );
}
