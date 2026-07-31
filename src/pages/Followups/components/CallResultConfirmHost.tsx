// CallResultConfirmHost — the full-page "confirm what happened on that call"
// popup, mounted once for the whole authenticated app.
//
// THE FLOW IT SERVES
//   A rep works a call task, dials, hangs up, and moves straight on to the next
//   follow-up WITHOUT completing the one they just did. Seconds later the Fly
//   worker reads the transcript, DeepSeek proposes an outcome, and the
//   suggestion arrives here over Realtime. The popup's job is to make the rep
//   REMEMBER that client — name, phone, preferences, the property options
//   already on their file — then let them play the recording, read the AI's
//   summary, and confirm one pre-selected answer.
//
// WHY IT MINIMISES INSTEAD OF DISMISSING
//   The task is still open until someone records an outcome. Closing the popup
//   parks it as a badge (the same idea as the background-jobs circle) rather
//   than throwing it away — a rep who is mid-call must be able to get it off
//   their screen without losing it.
//
// WHEN IT REFUSES TO STEAL FOCUS
//   • the tab is hidden — nobody is looking, and grabbing focus on return is
//     jarring; it waits as a badge instead
//   • the rep is inside the Follow-up Workspace — they are working another task
//     right now, and interrupting that is exactly what this feature is meant to
//     avoid
//   • a best-effort live-call check (see isRepOnLiveCall — deliberately
//     fail-open, because the underlying Hatif signal is unreliable)
//
// Suggestions older than SUGGESTION_FRESHNESS_HOURS are never shown: the popup
// is a memory aid, and a call from yesterday has lost the thing that makes it
// useful.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bell, Loader2, Phone, Sparkles, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import OutcomePanel from './OutcomePanel';
import { completeFollowUp } from '../lib/completeFollowup';
import {
  confirmSuggestion,
  isRepOnLiveCall,
  listPendingSuggestions,
  subscribeToSuggestions,
  type CallResultSuggestion,
} from '@/lib/callSuggestions/client';
import type { AppRecord } from '@/types';

/** Property options shown to jog the rep's memory. */
interface OptionCard { id: string; name: string; status: string | null; isMain: boolean; score: number | null }

export default function CallResultConfirmHost() {
  const { models, records, language, saveRecord, addToast, currentUserId } = useAppStore();
  const isAr = language === 'ar';
  const location = useLocation();

  const [pending, setPending] = useState<CallResultSuggestion[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const seededFor = useRef<string | null>(null);

  // Oldest first — the rep confirms them one at a time, in the order the calls
  // actually happened, so the narrative matches their memory.
  const active = pending[0] ?? null;

  const reload = useCallback(() => {
    void listPendingSuggestions()
      .then(setPending)
      .catch(() => { /* already logged + surfaced in the client module */ });
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    reload();
    return subscribeToSuggestions(reload);
  }, [currentUserId, reload]);

  // Never interrupt focused work. Re-checked whenever a new suggestion becomes
  // active or the rep navigates.
  const inWorkspace = /^\/model\/followups\/[^/]+/.test(location.pathname);
  useEffect(() => {
    if (!active) { setMinimized(false); return; }
    if (document.hidden || inWorkspace) { setMinimized(true); return; }
    let cancelled = false;
    void isRepOnLiveCall(currentUserId).then((onCall) => {
      if (!cancelled && onCall) setMinimized(true);
    });
    return () => { cancelled = true; };
  }, [active?.id, inWorkspace, currentUserId, active]);

  // ── the records behind the popup ──────────────────────────────────────────

  const followupModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const callsModel = models.find((m) => m.name === 'phone_calls');
  const optionsModel = models.find((m) => m.name === 'client_property_options');

  const followupRec = useMemo<AppRecord | null>(() => {
    if (!followupModel || !active?.followup_id) return null;
    return (records[followupModel.id] ?? []).find((r) => r.id === active.followup_id) ?? null;
  }, [followupModel, records, active?.followup_id]);

  const clientRec = useMemo<AppRecord | null>(() => {
    if (!clientsModel || !active?.client_id) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === active.client_id) ?? null;
  }, [clientsModel, records, active?.client_id]);

  const callRec = useMemo<AppRecord | null>(() => {
    if (!callsModel || !active?.call_record_id) return null;
    return (records[callsModel.id] ?? []).find((r) => r.id === active.call_record_id) ?? null;
  }, [callsModel, records, active?.call_record_id]);

  /**
   * The main option if one is flagged, else the top three by match_score.
   *
   * Measured 2026-07-30: only 42 of 3,362 options carry `is_main`, and
   * `priority_rank` is populated on ZERO of them despite the name — so
   * match_score is the only real ranking signal, and the top-three path is the
   * normal case rather than the fallback.
   */
  const optionCards = useMemo<OptionCard[]>(() => {
    if (!optionsModel || !active?.client_id) return [];
    const mine = (records[optionsModel.id] ?? []).filter(
      (r) => r.data.client_id === active.client_id && r.data.status !== 'eliminated',
    );
    const toCard = (r: AppRecord): OptionCard => ({
      id: r.id,
      name: String(r.data.source_name ?? '—'),
      status: (r.data.status as string) ?? null,
      isMain: r.data.is_main === true || r.data.status === 'main_focus',
      score: typeof r.data.match_score === 'number' ? r.data.match_score : Number(r.data.match_score) || null,
    });
    const main = mine.filter((r) => r.data.is_main === true || r.data.status === 'main_focus');
    if (main.length > 0) return main.slice(0, 3).map(toCard);
    return mine
      .map(toCard)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, 3);
  }, [optionsModel, records, active?.client_id]);

  // Seed the editable draft from the follow-up + whatever the AI prefilled.
  // Re-seeded per suggestion so moving to the next one never inherits edits.
  useEffect(() => {
    if (!active) { seededFor.current = null; setDraft({}); return; }
    if (seededFor.current === active.id) return;
    seededFor.current = active.id;
    setDraft({
      ...(followupRec?.data ?? {}),
      ...active.suggested_fields,
      completed_by_call_id: active.call_record_id,
      actual_datetime:
        (callRec?.data.call_time as string) ??
        (followupRec?.data.actual_datetime as string) ??
        new Date().toISOString(),
    });
  }, [active, followupRec, callRec]);

  const patchDraft = useCallback((patch: Record<string, unknown>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const dropActive = useCallback(() => {
    setPending((p) => p.slice(1));
    setMinimized(false);
  }, []);

  // ── confirm ───────────────────────────────────────────────────────────────

  const handleConfirm = async (outcomeKey: string) => {
    if (!active || !followupModel) return;
    if (!followupRec) {
      // log_interaction, or the follow-up hasn't reached the store yet. Creating
      // + completing a task from here is deliberately NOT done silently — the
      // rep is sent to the client so they choose the task themselves.
      addToast(
        isAr ? 'لا توجد متابعة مرتبطة — سجّل النتيجة من صفحة العميل.' : 'No linked follow-up — record this from the client page.',
        'info',
      );
      return;
    }
    setSaving(true);
    const result = await completeFollowUp({
      record: followupRec,
      model: followupModel,
      draft,
      outcomeKey,
      typeKey: active.followup_type,
      currentUserId,
      clientStage: (clientRec?.data.client_stage as string) ?? null,
      clientStatus: (clientRec?.data.client_status as string) ?? null,
      expectedVersion: followupRec.version ?? null,
      saveRecord,
      phoneCallsRecords: callsModel ? records[callsModel.id] ?? [] : [],
    });
    if (!result.ok) {
      setSaving(false);
      addToast(
        result.reason === 'conflict'
          ? (isAr ? 'تم تعديل هذه المتابعة من مكان آخر — حدّث الصفحة.' : 'This follow-up was just edited elsewhere — reload.')
          : (isAr ? result.message_ar : result.message_en),
        'error',
      );
      return;
    }
    // Record the decision for the accuracy ledger. Best-effort: the follow-up is
    // already completed, so a failure here must not look like the save failed.
    try {
      await confirmSuggestion(active.id, outcomeKey, draft as Record<string, unknown>);
    } catch {
      console.error('[callSuggestions] follow-up saved but the suggestion was not marked confirmed');
    }
    setSaving(false);
    addToast(isAr ? 'تم تأكيد نتيجة المكالمة' : 'Call result confirmed', 'success');
    dropActive();
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (!active || !currentUserId) return null;

  const clientName = String(
    clientRec?.data.client_name ?? followupRec?.data.client_name ?? (isAr ? 'عميل' : 'Client'),
  );
  const clientPhone = String(clientRec?.data.phone_number ?? followupRec?.data.client_phone ?? '');
  const recordingUrl = (callRec?.data.recording_url as string) ?? null;
  const durationSecs = callRec?.data.duration_seconds as number | undefined;

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-24 end-4 z-[54] flex items-center gap-2 rounded-full bg-copper px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-terracotta"
        title={isAr ? 'تأكيد نتيجة مكالمة' : 'Confirm a call result'}
      >
        <Bell size={16} />
        {isAr ? 'نتيجة مكالمة بانتظارك' : 'Call result awaiting you'}
        {pending.length > 1 ? (
          <span className="rounded-full bg-white/25 px-2 py-0.5 text-xs">{pending.length}</span>
        ) : null}
      </button>
    );
  }

  return (
    <Modal
      open
      onClose={() => setMinimized(true)}
      title={isAr ? 'تأكيد نتيجة المكالمة' : 'Confirm the call result'}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-4">
        {/* Who was this? — the memory jog. */}
        <div className="rounded-xl border border-sand bg-cream/50 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-lg font-bold text-charcoal">{clientName}</span>
            {clientPhone ? (
              <span className="inline-flex items-center gap-1 text-sm text-terracotta" dir="ltr">
                <Phone size={13} /> {clientPhone}
              </span>
            ) : null}
          </div>

          {optionCards.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold text-terracotta">
                {optionCards.some((o) => o.isMain)
                  ? (isAr ? 'الخيار الرئيسي' : 'Main option')
                  : (isAr ? 'أبرز الخيارات المضافة' : 'Top options on file')}
              </p>
              <ul className="flex flex-wrap gap-2">
                {optionCards.map((o) => (
                  <li
                    key={o.id}
                    className={`rounded-lg border px-2.5 py-1 text-sm ${o.isMain ? 'border-[#10B981] bg-[#10B981]/10 text-charcoal' : 'border-sand bg-white text-charcoal'}`}
                  >
                    {o.name}
                    {o.score != null ? <span className="text-charcoal/50"> · {Math.round(o.score)}%</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* The call itself. */}
        <div className="rounded-xl border border-sand p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-charcoal">
              {isAr ? 'تسجيل المكالمة' : 'Call recording'}
              {typeof durationSecs === 'number' ? (
                <span className="font-normal text-charcoal/60"> · {durationSecs}{isAr ? 'ث' : 's'}</span>
              ) : null}
            </span>
          </div>
          {recordingUrl ? (
            <audio controls src={recordingUrl} className="w-full" preload="none" />
          ) : (
            <p className="text-xs text-charcoal/60">{isAr ? 'لا يوجد تسجيل لهذه المكالمة' : 'No recording for this call'}</p>
          )}

          {active.summary ? (
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-charcoal">{active.summary}</p>
          ) : null}
        </div>

        {/* What the AI thinks, and why. */}
        <div className="rounded-xl border border-copper/40 bg-copper/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-copper">
            <Sparkles size={15} />
            {isAr ? 'اقتراح المساعد' : 'Assistant suggestion'}
            {typeof active.confidence === 'number' ? (
              <span className="font-normal text-charcoal/60">· {active.confidence}%</span>
            ) : null}
            {active.source === 'deterministic' ? (
              <span className="font-normal text-charcoal/60">· {isAr ? 'بدون تحليل' : 'no analysis needed'}</span>
            ) : null}
          </div>
          {active.reasoning ? <p className="text-sm text-charcoal">{active.reasoning}</p> : null}
          {active.quoted_phrase ? (
            <p className="mt-1 text-xs text-charcoal/70">
              {isAr ? 'استُخرج الموعد من: ' : 'Date taken from: '}«{active.quoted_phrase}»
            </p>
          ) : null}
          <p className="mt-2 text-xs text-charcoal/60">
            {isAr
              ? 'راجع النتيجة وعدّلها إن لزم — لا يُحفظ شيء قبل تأكيدك.'
              : 'Review and change it if needed — nothing is saved until you confirm.'}
          </p>
        </div>

        {/* The real outcome picker — same component, rules and validation the
            Workspace uses, so an override re-reveals the right required fields. */}
        {followupModel && followupRec ? (
          <OutcomePanel
            followupModel={followupModel}
            typeKey={active.followup_type}
            draft={draft}
            patchDraft={patchDraft}
            readOnly={false}
            clientId={active.client_id}
            phones={clientPhone ? [clientPhone] : []}
            onBookAppointment={() => {
              addToast(isAr ? 'افتح المتابعة لحجز موعد.' : 'Open the follow-up to book an appointment.', 'info');
            }}
            onComplete={handleConfirm}
            saving={saving}
          />
        ) : (
          <div className="rounded-xl border border-sand bg-cream/40 p-4 text-sm text-charcoal">
            {isAr
              ? 'هذه المكالمة ليست مرتبطة بمتابعة مفتوحة. افتح صفحة العميل لتسجيل النتيجة.'
              : 'This call is not linked to an open follow-up. Open the client to record the result.'}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-charcoal/60">
            {pending.length > 1
              ? (isAr ? `${pending.length} مكالمات بانتظار التأكيد` : `${pending.length} calls awaiting confirmation`)
              : ''}
          </span>
          <Button variant="ghost" onClick={() => setMinimized(true)} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            {isAr ? 'لاحقًا' : 'Later'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
