import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, PhoneIncoming, PhoneOutgoing, MessageCircle, Building2, NotebookPen } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  getFollowUpTypeConfig, getOutcome, requiredFieldSlugs, validateFollowUpCompletion, buildFieldLabels,
} from '@/lib/salesProcess';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';

type Direction = 'outbound_call' | 'inbound_call' | 'whatsapp' | 'in_person';
type TaskAction = 'complete' | 'keep' | 'cancel';

/**
 * "Log an interaction" (2026-07-21 — sales-process improvement plan,
 * Workstream E, generalized per user decision). Calls happen with no task —
 * the rep calls the client, the client calls in, a walk-in — and the result
 * must still drive the pipeline. This modal:
 *
 *  - records direction + outcome + notes,
 *  - DEFAULTS to completing the client's current open task with that outcome
 *    (override: keep it open, or cancel it),
 *  - when there is no task (or it's kept/cancelled), creates a follow-up and
 *    completes it — create-then-update via saveRecord, so the existing
 *    outcome workflows fire and move the client exactly like the Workspace.
 *
 * Outcomes requiring record LINKAGE (an existing appointment/visit) are not
 * offered here — those flows need the full Follow-up Workspace.
 */
export default function LogInteractionModal({
  clientId,
  clientName,
  chatRecordId,
  onClose,
}: {
  clientId: string;
  clientName: string;
  /** When opened from a chat — stamped as completion evidence. */
  chatRecordId: string | null;
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');

  const [direction, setDirection] = useState<Direction>('outbound_call');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [taskAction, setTaskAction] = useState<TaskAction>('complete');
  const [saving, setSaving] = useState(false);

  // The client's current open task (earliest scheduled first).
  const openTask: AppRecord | null = useMemo(() => {
    if (!followupsModel) return null;
    const rows = (records[followupsModel.id] ?? []).filter((r) => {
      const d = r.data as Record<string, unknown>;
      const cid = Array.isArray(d.client_id) ? d.client_id[0] : d.client_id;
      if (cid !== clientId) return false;
      const st = typeof d.followup_status === 'string' && d.followup_status ? d.followup_status : 'open';
      return st === 'open' || st === 'in_progress';
    });
    if (rows.length === 0) return null;
    return rows.slice().sort((a, b) => {
      const av = typeof a.data.scheduled_datetime === 'string' ? Date.parse(a.data.scheduled_datetime) : Infinity;
      const bv = typeof b.data.scheduled_datetime === 'string' ? Date.parse(b.data.scheduled_datetime) : Infinity;
      return av - bv;
    })[0] ?? null;
  }, [followupsModel, records, clientId]);

  // Which follow-up TYPE the outcome vocabulary comes from: the open task's
  // type when completing it; else inferred from the interaction channel.
  const effectiveType = useMemo(() => {
    if (openTask && taskAction === 'complete') return readFollowupType(openTask.data) ?? 'appointment_booking_call';
    return direction === 'whatsapp' ? 'whatsapp_follow_up' : 'appointment_booking_call';
  }, [openTask, taskAction, direction]);

  const typeConfig = getFollowUpTypeConfig(effectiveType);
  // Outcomes needing an existing appointment/visit record are Workspace-only.
  const outcomes = useMemo(
    () => (typeConfig?.allowed_outcomes ?? []).filter((o) => {
      const r = o.requires ?? {};
      return !r.appointment_id && !r.appointment_created && !r.visit;
    }),
    [typeConfig],
  );
  const selected = outcomes.find((o) => o.value === outcome);
  const requiredExtras = useMemo(
    () => (selected ? requiredFieldSlugs(selected).filter((s) => !['actual_datetime', 'outcome_notes'].includes(s)) : []),
    [selected],
  );

  const fieldLabels = useMemo(
    () => (followupsModel ? buildFieldLabels(followupsModel.schema.sections.flatMap((s) => s.fields)) : {}),
    [followupsModel],
  );

  const extraLabel = (slug: string): string => {
    const lbl = fieldLabels[slug];
    return lbl ? (isAr ? lbl.label_ar : lbl.label_en) || slug : slug;
  };

  const save = async () => {
    if (!followupsModel) return;
    if (!outcome) {
      addToast(isAr ? 'اختر نتيجة التواصل' : 'Pick an outcome', 'error');
      return;
    }
    const nowISO = new Date().toISOString();
    const clientData = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId)?.data as Record<string, unknown> | undefined : undefined;

    const completion: Record<string, unknown> = {
      call_result: outcome,
      outcome_notes: notes.trim() || null,
      actual_datetime: nowISO,
      followup_status: 'completed',
      completed_by_user: currentUserId,
      interaction_direction: direction,
      whatsapp_state: null,
      ...(chatRecordId && direction === 'whatsapp' ? { completed_by_chat_id: chatRecordId } : {}),
      ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v.trim())),
      source_stage_snapshot: (clientData?.client_stage as string | undefined) ?? null,
      source_status_snapshot: (clientData?.client_status as string | undefined) ?? null,
    };

    // Same guard as the Workspace: a required field can't be skipped.
    const check = validateFollowUpCompletion({
      followupType: effectiveType,
      selectedOutcome: outcome,
      draft: { ...(openTask && taskAction === 'complete' ? openTask.data : {}), ...completion },
      fieldLabels,
    });
    if (!check.ok) {
      addToast(isAr ? (check.hardErrors[0]?.message_ar ?? 'حقول مطلوبة ناقصة') : (check.hardErrors[0]?.message_en ?? 'Required fields missing'), 'error');
      return;
    }

    setSaving(true);
    try {
      if (openTask && taskAction === 'complete') {
        // Complete the CURRENT task with this interaction's result.
        const res = await saveRecord(
          { ...openTask, data: { ...openTask.data, ...completion }, updated_at: nowISO },
          { expectedVersion: openTask.version ?? null },
        );
        if (res.status === 'conflict') {
          addToast(isAr ? 'تم تعديل المهمة من مكان آخر — أعد المحاولة' : 'The task was edited elsewhere — try again', 'error');
          return;
        }
      } else {
        if (openTask && taskAction === 'cancel') {
          await saveRecord(
            {
              ...openTask,
              data: {
                ...openTask.data,
                followup_status: 'cancelled',
                cancel_reason: 'superseded_by_logged_interaction',
                cancelled_at: nowISO,
              },
              updated_at: nowISO,
            },
            { expectedVersion: openTask.version ?? null },
          );
        }
        // No (surviving) task → create one, then complete it in a second save
        // so the update-triggered outcome workflows fire.
        const id = uuid();
        const base: Record<string, unknown> = {
          client_id: clientId,
          sales_rep: currentUserId,
          followup_type: [effectiveType],
          followup_status: 'open',
          followup_number: 1,
          scheduled_datetime: nowISO,
          creation_source: 'logged_interaction',
        };
        await saveRecord({ id, model_id: followupsModel.id, data: base, created_at: nowISO, updated_at: nowISO });
        const created = (useAppStore.getState().records[followupsModel.id] ?? []).find((r) => r.id === id);
        await saveRecord(
          { id, model_id: followupsModel.id, data: { ...base, ...completion }, created_at: nowISO, updated_at: nowISO },
          { expectedVersion: created?.version ?? null },
        );
      }
      addToast(isAr ? 'تم تسجيل التواصل وتحريك العميل' : 'Interaction logged — client moved', 'success');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const DIRECTIONS: { id: Direction; label: { ar: string; en: string }; icon: React.ReactNode }[] = [
    { id: 'outbound_call', label: { ar: 'اتصلنا به', en: 'We called' }, icon: <PhoneOutgoing size={14} /> },
    { id: 'inbound_call', label: { ar: 'اتصل بنا', en: 'They called' }, icon: <PhoneIncoming size={14} /> },
    { id: 'whatsapp', label: { ar: 'واتساب', en: 'WhatsApp' }, icon: <MessageCircle size={14} /> },
    { id: 'in_person', label: { ar: 'زيارة مكتب', en: 'Walk-in' }, icon: <Building2 size={14} /> },
  ];

  const openTaskType = openTask ? getFollowUpTypeConfig(readFollowupType(openTask.data)) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-chocolate">
            <NotebookPen size={18} className="text-copper" />
            {isAr ? `تسجيل تواصل — ${clientName}` : `Log interaction — ${clientName}`}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal">
            <X size={18} />
          </button>
        </div>

        {/* Direction */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-bold text-charcoal/70">{isAr ? 'نوع التواصل' : 'Channel'}</span>
          <div className="flex flex-wrap gap-2">
            {DIRECTIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDirection(d.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
                  direction === d.id ? 'bg-copper text-white' : 'bg-cream text-charcoal/70 hover:bg-sand/40'
                }`}
              >
                {d.icon} {isAr ? d.label.ar : d.label.en}
              </button>
            ))}
          </div>
        </div>

        {/* Current open task */}
        {openTask && (
          <div className="mb-4 rounded-xl border border-sand bg-cream/40 p-3">
            <span className="mb-1.5 block text-xs font-bold text-charcoal/70">
              {isAr ? 'المهمة المفتوحة الحالية: ' : 'Current open task: '}
              <span className="text-copper">{openTaskType ? (isAr ? openTaskType.label_ar : openTaskType.label_en) : ''}</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {([
                { id: 'complete', ar: 'أكملها بهذه النتيجة (مستحسن)', en: 'Complete it with this result (recommended)' },
                { id: 'keep', ar: 'أبقها مفتوحة', en: 'Keep it open' },
                { id: 'cancel', ar: 'ألغِها', en: 'Cancel it' },
              ] as { id: TaskAction; ar: string; en: string }[]).map((o) => (
                <label key={o.id} className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-charcoal/80">
                  <input
                    type="radio"
                    name="taskAction"
                    checked={taskAction === o.id}
                    onChange={() => setTaskAction(o.id)}
                    className="accent-copper"
                  />
                  {isAr ? o.ar : o.en}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Outcome */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-bold text-charcoal/70">{isAr ? 'النتيجة' : 'Outcome'}</span>
          <div className="flex flex-wrap gap-2">
            {outcomes.map((o) => {
              const label = getOutcome(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setOutcome(o.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-bold transition ${
                    outcome === o.value ? 'bg-chocolate text-white' : 'bg-cream text-charcoal/70 hover:bg-sand/40'
                  }`}
                >
                  {label ? (isAr ? label.label_ar : label.label_en) : o.value}
                </button>
              );
            })}
          </div>
          {outcomes.length === 0 && (
            <p className="text-xs text-charcoal/50">{isAr ? 'لا توجد نتائج متاحة لهذا النوع.' : 'No outcomes available for this type.'}</p>
          )}
        </div>

        {/* Outcome-required extras (e.g. new appointment time, lost reason) */}
        {requiredExtras.map((slug) => (
          <label key={slug} className="mb-3 block">
            <span className="mb-1 block text-xs font-bold text-charcoal/70">{extraLabel(slug)} *</span>
            {slug.endsWith('_datetime') || slug.endsWith('_date') ? (
              <input
                type="datetime-local"
                value={extra[slug] ?? ''}
                onChange={(e) => setExtra((x) => ({ ...x, [slug]: e.target.value }))}
                className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
              />
            ) : (
              <input
                value={extra[slug] ?? ''}
                onChange={(e) => setExtra((x) => ({ ...x, [slug]: e.target.value }))}
                className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
              />
            )}
          </label>
        ))}

        {/* Notes */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'ملاحظات' : 'Notes'}</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
            placeholder={isAr ? 'ماذا قال العميل؟ (١٥ حرفًا على الأقل يحفظ الجودة)' : 'What did the client say?'}
          />
        </label>

        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta disabled:opacity-60"
        >
          {saving && <Loader2 size={15} className="animate-spin" />}
          {isAr ? 'تسجيل وتحريك العميل' : 'Log & move the client'}
        </button>
      </div>
    </div>
  );
}
