import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuid } from 'uuid';
import { MapPin, CheckCircle2, ArrowUpRight, Pencil, X, CalendarClock, User as UserIcon, FileText } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import Button from '@/components/ui/Button';
import type { AppRecord, NoteEntry } from '@/types';

interface RegisterVisitActionProps {
  /** The follow-up record this action runs from — stamped onto the visit as source_followup_id. */
  followupId: string;
  clientId: string | null;
  /** Client display name, used to prefill the visit's Name field. */
  clientName: string | null;
  /** First known phone for the client, prefilled into the visit's Phone field. */
  phone: string | null;
  /** The follow-up's sales-rep assignee value, passed through to the visit's Sales Representative. */
  salesRep: unknown;
  /** A pre-validated our_projects record id (the visit's Project lookup target), or null if none aligns. */
  projectCandidateId: string | null;
  readOnly: boolean;
}

/** Local calendar-day key (yyyy-m-d in the browser's timezone) for same-day duplicate detection. */
function localDayKey(iso: unknown): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * FOLLOWUP_4 — "Register Visit / تسجيل زيارة".
 *
 * A persistent, SECONDARY action available in every follow-up type. Registering
 * a visit is EVIDENCE the client reported during the call/WhatsApp — not a
 * follow-up outcome. Clicking it never touches the selected outcome or completes
 * the follow-up; it only creates a `visits` record (which fires the existing
 * "Visit → After-Visit" workflow normally) linked back via `source_followup_id`.
 *
 * Guards against duplicates: before opening the form it scans the client's
 * visits for one already on today's date and, if found, shows a warning that
 * prefers opening/editing the existing visit over creating a duplicate. If a
 * visit was already registered FROM this follow-up, the control flips to a
 * "Visit already registered" badge that opens that visit instead.
 */
export default function RegisterVisitAction({
  followupId,
  clientId,
  clientName,
  phone,
  salesRep,
  projectCandidateId,
  readOnly,
}: RegisterVisitActionProps) {
  const { models, records, language, addToast, currentUserId, users } = useAppStore();
  const isAr = language === 'ar';

  const visitsModel = models.find((m) => m.name === 'visits');
  const ourProjectsModel = models.find((m) => m.name === 'our_projects');

  // Visits already recorded for this client (for duplicate + already-linked detection).
  const clientVisits = useMemo<AppRecord[]>(() => {
    if (!visitsModel || !clientId) return [];
    return (records[visitsModel.id] ?? []).filter((r) => r.data.client_id === clientId);
  }, [visitsModel, records, clientId]);

  // A visit explicitly registered FROM this follow-up → show "already registered".
  const linkedVisit = useMemo(
    () => clientVisits.find((r) => r.data.source_followup_id === followupId) ?? null,
    [clientVisits, followupId],
  );

  // 'idle' | a same-day duplicate to confirm | the visit form (new or editing existing).
  const [duplicate, setDuplicate] = useState<AppRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editVisitId, setEditVisitId] = useState<string | null>(null);

  // Prefill for a NEW visit (ignored when editing an existing one). Hoisted
  // ABOVE the `!visitsModel` early return below: on a fresh deep-link load the
  // store's `models` is empty on first paint, so visitsModel flips
  // undefined→defined across renders — a hook below the return would change the
  // hook count between renders and crash with React error #310.
  const prefill = useMemo<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = {
      // RecordFormModal does not resolve `default_dynamic`, so seed the date + rep explicitly.
      scheduled_datetime: new Date().toISOString(),
      sales_representative: salesRep ?? currentUserId ?? undefined,
      source_followup_id: followupId,
      // `visit_notes` is a `notes` field — seed a proper NoteEntry so it renders.
      visit_notes: [
        {
          id: uuid(),
          text: isAr
            ? 'سُجّلت الزيارة من المتابعة بعد إفادة العميل بأنه زار المشروع.'
            : 'Visit was registered from follow-up after client reported they visited.',
          author_id: currentUserId ?? null,
          created_at: new Date().toISOString(),
        } as NoteEntry,
      ],
    };
    if (clientId) p.client_id = clientId;
    if (clientName) p.name = clientName;
    if (phone) p.phone = phone;
    if (projectCandidateId) p.project_id = projectCandidateId;
    return p;
  }, [clientId, clientName, phone, salesRep, currentUserId, followupId, projectCandidateId, isAr]);

  if (!visitsModel) return null;

  const resolveUserName = (val: unknown): string | null => {
    const id = Array.isArray(val) ? (typeof val[0] === 'string' ? val[0] : null) : typeof val === 'string' ? val : null;
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u ? (isAr ? u.name_ar : u.name_en) || u.email || null : null;
  };

  const fmtDateTime = (iso: unknown): string => {
    if (typeof iso !== 'string' || !iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  };

  const projectName = (val: unknown): string | null => {
    if (typeof val !== 'string' || !val || !ourProjectsModel) return null;
    const rec = (records[ourProjectsModel.id] ?? []).find((r) => r.id === val);
    const name = rec?.data.project_name;
    return typeof name === 'string' && name.trim() ? name : null;
  };

  const latestNote = (val: unknown): string | null => {
    if (!Array.isArray(val) || val.length === 0) return null;
    const entries = val.filter((e): e is NoteEntry => !!e && typeof e === 'object' && typeof (e as NoteEntry).text === 'string');
    if (entries.length === 0) return null;
    return [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!.text;
  };

  const openNewForm = () => {
    setDuplicate(null);
    setEditVisitId(null);
    setFormOpen(true);
  };

  const openExisting = (id: string) => {
    setDuplicate(null);
    setEditVisitId(id);
    setFormOpen(true);
  };

  const handleClick = () => {
    if (readOnly) return;
    // Already registered from this follow-up → open/edit that visit, never duplicate.
    if (linkedVisit) {
      openExisting(linkedVisit.id);
      return;
    }
    // Duplicate pre-check: a visit for this client already exists on today's date.
    const today = localDayKey(new Date().toISOString());
    const sameDay = clientVisits.find((r) => localDayKey(r.data.scheduled_datetime) === today);
    if (sameDay) {
      setDuplicate(sameDay);
      return;
    }
    openNewForm();
  };

  const alreadyRegistered = !!linkedVisit;

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-chocolate">{isAr ? 'دليل إضافي' : 'Additional evidence'}</h2>
          <p className="mt-0.5 text-xs text-charcoal/55">
            {alreadyRegistered
              ? isAr
                ? 'تم تسجيل زيارة من هذه المتابعة.'
                : 'A visit was registered from this follow-up.'
              : isAr
                ? 'إذا أفاد العميل بأنه زار المشروع، سجّل الزيارة دون تغيير نتيجة المتابعة.'
                : 'If the client reports they visited, register the visit without changing the follow-up outcome.'}
          </p>
        </div>
        {alreadyRegistered ? (
          <button
            type="button"
            onClick={handleClick}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
            title={isAr ? 'فتح الزيارة المسجلة' : 'Open the registered visit'}
          >
            <CheckCircle2 size={18} /> {isAr ? 'الزيارة مسجلة' : 'Visit already registered'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleClick}
            disabled={readOnly}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-sand px-4 py-2.5 text-sm font-semibold text-charcoal transition hover:bg-cream disabled:opacity-40"
          >
            <MapPin size={18} /> {isAr ? 'تسجيل زيارة' : 'Register Visit'}
          </button>
        )}
      </div>

      {/* Duplicate warning — same client already has a visit today. Prefer
          opening/editing the existing visit over silently creating a duplicate. */}
      {duplicate &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDuplicate(null);
            }}
          >
            <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
              <div className="flex items-center gap-3 border-b border-sand/20 px-5 py-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-copper/10 text-copper">
                  <MapPin size={16} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-chocolate">
                    {isAr ? 'زيارة موجودة بنفس التاريخ' : 'A visit already exists on this date'}
                  </h2>
                  <p className="text-xs text-charcoal/55">
                    {isAr
                      ? 'يوجد بالفعل زيارة لهذا العميل بنفس اليوم.'
                      : 'A visit for this client already exists on this date.'}
                  </p>
                </div>
              </div>

              {/* Existing visit summary */}
              <div className="space-y-3 px-5 py-4">
                <div className="space-y-1.5 rounded-xl border border-sand/25 bg-cream/40 px-3.5 py-3 text-xs text-charcoal/70">
                  <div className="flex items-center gap-2">
                    <CalendarClock size={13} className="text-charcoal/40" />
                    <span dir="ltr">{fmtDateTime(duplicate.data.scheduled_datetime)}</span>
                  </div>
                  {projectName(duplicate.data.project_id) && (
                    <div className="flex items-center gap-2">
                      <MapPin size={13} className="text-charcoal/40" />
                      <span>{projectName(duplicate.data.project_id)}</span>
                    </div>
                  )}
                  {resolveUserName(duplicate.data.sales_representative) && (
                    <div className="flex items-center gap-2">
                      <UserIcon size={13} className="text-charcoal/40" />
                      <span>{resolveUserName(duplicate.data.sales_representative)}</span>
                    </div>
                  )}
                  {latestNote(duplicate.data.visit_notes) && (
                    <div className="flex items-start gap-2">
                      <FileText size={13} className="mt-0.5 shrink-0 text-charcoal/40" />
                      <span className="line-clamp-2">{latestNote(duplicate.data.visit_notes)}</span>
                    </div>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-charcoal/55">
                  {isAr
                    ? 'يُفضّل فتح الزيارة الموجودة وتعديلها بدلاً من إنشاء زيارة مكررة.'
                    : 'Prefer opening and editing the existing visit instead of creating a duplicate.'}
                </p>
              </div>

              <div className="flex flex-wrap justify-end gap-2 border-t border-sand/20 px-5 py-4">
                <Button variant="ghost" onClick={() => setDuplicate(null)}>
                  <X size={14} /> {isAr ? 'إلغاء' : 'Cancel'}
                </Button>
                <Button variant="secondary" onClick={() => openNewForm()}>
                  <Pencil size={14} /> {isAr ? 'إنشاء زيارة جديدة' : 'Create new anyway'}
                </Button>
                <Button variant="primary" onClick={() => openExisting(duplicate.id)}>
                  <ArrowUpRight size={14} /> {isAr ? 'فتح الزيارة الموجودة' : 'Open existing visit'}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Visit form — new (prefilled) or editing the existing/linked visit. The
          create path fires the "Visit → After-Visit" workflow via saveRecord. */}
      {formOpen && (
        <RecordFormModal
          modelId={visitsModel.id}
          recordId={editVisitId}
          prefill={editVisitId ? undefined : prefill}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            addToast(
              editVisitId
                ? isAr
                  ? 'تم تحديث الزيارة'
                  : 'Visit updated'
                : isAr
                  ? 'تم تسجيل الزيارة'
                  : 'Visit registered',
              'success',
            );
          }}
        />
      )}
    </section>
  );
}
