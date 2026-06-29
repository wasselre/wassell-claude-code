import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Loader2, ListChecks, Lock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import DynamicField from '@/pages/Records/components/DynamicField';
import type { AppModel, AppRecord } from '@/types';
import { fieldBySlug, isOverdue, hasNoNextAction, isClosedWon, isLostOrUnqualified, type ClientView, type ClientViewCtx } from '../../lib/clientView';
import { formatDateTime, lifecycleHealthDisplay, lifecycleHealthExplanation } from '../../lib/lifecycleDisplay';
import { HealthBadge, VisitRatingStars, Dash } from '../clientChips';

interface SalesNotesTabProps {
  view: ClientView;
  client: AppRecord;
  clientsModel: AppModel;
  ctx: ClientViewCtx;
  isAr: boolean;
  canEdit: boolean;
  now?: number;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h3 className="mb-3 text-sm font-bold text-chocolate">{title}</h3>
      {children}
    </section>
  );
}

function optionLabel(model: AppModel, slug: string, value: string | null, isAr: boolean): string | null {
  if (!value) return null;
  const f = fieldBySlug(model, slug);
  const opt = f?.options?.find((o) => o.value === value);
  return opt ? (isAr ? opt.label_ar : opt.label_en) || value : value;
}

/** Lifecycle explanation (read-only derived facts) + an editable sales-notes box. */
export default function SalesNotesTab({ view, client, clientsModel, ctx, isAr, canEdit, now = Date.now() }: SalesNotesTabProps) {
  const navigate = useNavigate();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const health = lifecycleHealthDisplay(view.lifecycleHealth);

  // Resolve the source follow-up for "next action".
  const followupsModel = ctx.models.find((m) => m.name === 'followups');
  const nextFollowup = view.nextFollowupId && followupsModel
    ? (ctx.records[followupsModel.id] ?? []).find((r) => r.id === view.nextFollowupId) ?? null
    : null;

  // "Why" bullets — derived, read-only.
  const reasons: string[] = [];
  if (isOverdue(view, now)) {
    reasons.push(isAr ? `الإجراء التالي تجاوز موعده (${formatDateTime(view.nextActionDueAt, isAr) ?? '—'}).` : `Next action is past due (${formatDateTime(view.nextActionDueAt, isAr) ?? '—'}).`);
  }
  if (hasNoNextAction(view)) {
    reasons.push(isAr ? 'لا توجد متابعة مفتوحة.' : 'No open follow-up exists.');
  }
  if (isClosedWon(view)) reasons.push(isAr ? 'العميل في مرحلة "مغلق ناجح".' : 'Client is in the "Closed won" stage.');
  if (isLostOrUnqualified(view)) reasons.push(isAr ? `العميل في مرحلة "${view.stage}".` : `Client is in the "${view.stage}" stage.`);

  // Editable general notes (NOT a derived field). Reuses the versioned save path.
  const notesField = fieldBySlug(clientsModel, 'notes');
  const { draft, patchDraft } = useRecordDraft(client);
  const [saving, setSaving] = useState(false);
  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (versionRef.current?.id !== client.id) versionRef.current = { id: client.id, version: client.version ?? null };
  const notesDirty = notesField ? JSON.stringify(draft[notesField.name] ?? null) !== JSON.stringify(client.data[notesField.name] ?? null) : false;

  const saveNotes = async () => {
    if (!notesField) return;
    setSaving(true);
    const next: AppRecord = { ...client, data: { ...client.data, [notesField.name]: draft[notesField.name] }, updated_at: new Date().toISOString() };
    const res = await saveRecord(next, { expectedVersion: versionRef.current?.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تم تعديل العميل في مكان آخر — أعد التحميل.' : 'Client was edited elsewhere — reload before saving.', 'error');
      return;
    }
    addToast(isAr ? 'تم حفظ الملاحظات' : 'Notes saved', res.status === 'queued' ? 'info' : 'success');
    if (res.status !== 'queued' && versionRef.current) versionRef.current = { id: client.id, version: (versionRef.current.version ?? 0) + 1 };
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Lifecycle explanation */}
      <Card title={isAr ? 'دورة الحياة' : 'Lifecycle'}>
        <div className="mb-2">
          <HealthBadge value={view.lifecycleHealth} isAr={isAr} />
        </div>
        <p className="text-sm leading-relaxed text-charcoal/70">{lifecycleHealthExplanation(view.lifecycleHealth, isAr)}</p>
        {reasons.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-charcoal/70">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: health.color }}>
          {isAr ? 'الحالة:' : 'State:'} {isAr ? health.label_ar : health.label_en}
        </div>
      </Card>

      {/* Next follow-up source */}
      <Card title={isAr ? 'مصدر المتابعة التالية' : 'Next follow-up source'}>
        {nextFollowup ? (
          <button
            type="button"
            onClick={() => navigate(`/model/followups/${nextFollowup.id}?returnTo=${encodeURIComponent(`/model/clients/${client.id}`)}`)}
            className="flex w-full items-center justify-between gap-2 rounded-lg bg-copper/8 p-3 text-start transition hover:bg-copper/15"
          >
            <span className="inline-flex items-center gap-2 text-sm font-bold text-copper">
              <ListChecks size={15} /> {isAr ? 'افتح المتابعة المفتوحة' : 'Open the active follow-up'}
            </span>
            <span className="text-xs text-charcoal/50">{formatDateTime(view.nextActionDueAt, isAr) ?? ''}</span>
          </button>
        ) : (
          <p className="text-sm text-charcoal/50">{isAr ? 'لا توجد متابعة مفتوحة مرتبطة.' : 'No active follow-up linked.'}</p>
        )}
      </Card>

      {/* Lost reason / date (derived, read-only) */}
      <Card title={isAr ? 'الخسارة' : 'Loss details'}>
        <div className="flex items-center justify-between py-1.5 text-sm">
          <span className="text-charcoal/50">{isAr ? 'سبب الخسارة' : 'Lost reason'}</span>
          <span className="font-semibold text-charcoal/85">{optionLabel(clientsModel, 'lost_reason', view.lostReason, isAr) ?? <Dash />}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 text-sm">
          <span className="text-charcoal/50">{isAr ? 'تاريخ الخسارة' : 'Lost at'}</span>
          <span className="font-semibold text-charcoal/85">{formatDateTime(view.lostAt, isAr) ?? <Dash />}</span>
        </div>
        <p className="mt-1 text-[11px] text-charcoal/40">{isAr ? 'تُحسب تلقائيًا — غير قابلة للتعديل.' : 'Computed automatically — not editable.'}</p>
      </Card>

      {/* Latest visit rating (derived, read-only) */}
      <Card title={isAr ? 'تقييم الزيارة الأخيرة' : 'Latest visit rating'}>
        {typeof view.latestVisitRating === 'number' && view.latestVisitRating > 0 ? (
          <div className="flex items-center gap-3">
            <VisitRatingStars rating={view.latestVisitRating} size={18} />
            <span className="text-sm font-bold text-chocolate">{view.latestVisitRating}/5</span>
            <span className="text-xs text-charcoal/50">{formatDateTime(view.latestVisitRatedAt, isAr) ?? ''}</span>
          </div>
        ) : (
          <p className="text-sm text-charcoal/50">{isAr ? 'لا يوجد تقييم زيارة بعد.' : 'No visit rating yet.'}</p>
        )}
        <p className="mt-2 text-[11px] text-charcoal/40">{isAr ? 'تُحسب من سجل الزيارة — غير قابلة للتعديل.' : 'Mirrored from the visit record — not editable.'}</p>
      </Card>

      {/* Editable general notes */}
      {notesField && (
        <section className="card p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-chocolate">{isAr ? notesField.label_ar : notesField.label_en}</h3>
            {!canEdit && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-charcoal/50">
                <Lock size={13} /> {isAr ? 'عرض فقط' : 'Read-only'}
              </span>
            )}
          </div>
          {canEdit ? (
            <>
              <DynamicField
                field={notesField}
                value={draft[notesField.name]}
                onChange={(v) => patchDraft({ [notesField.name]: v })}
                recordData={draft}
                modelId={clientsModel.id}
                recordId={client.id}
              />
              {notesDirty && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void saveNotes()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
                  >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    {isAr ? 'حفظ الملاحظات' : 'Save notes'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-charcoal/70">{typeof client.data[notesField.name] === 'string' ? (client.data[notesField.name] as string) : '—'}</p>
          )}
        </section>
      )}
    </div>
  );
}
