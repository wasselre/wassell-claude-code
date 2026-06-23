import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, SlidersHorizontal, User, Phone, MessageCircle, X,
  CheckCircle2, AlertTriangle, AlertOctagon, Flame, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord, useCanViewRecord } from '@/hooks/usePermission';
import Button from '@/components/ui/Button';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import WhatsAppHistoryPanel from '@/pages/Records/components/WhatsAppHistoryPanel';
import type { AppModel, AppRecord } from '@/types';

const REVIEWS = 'sales_valuation_reviews';

/**
 * Custom manager review screen for one Sales Valuation Review. Replaces the
 * generic record form (still reachable via ?generic=1). Answers three questions
 * fast: who is the client, what happened, was the rep's handling correct.
 * Saving goes through `saveRecord` so the DB triggers (score / status /
 * correction task / daily summary) still fire.
 */
export default function ReviewDetailPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { models, records, language, saveRecord, addToast, currentUserId, users } = useAppStore();
  const isAr = language === 'ar';

  const reviewModel = models.find((m) => m.name === REVIEWS) ?? null;
  const review = useMemo(
    () => (reviewModel ? (records[reviewModel.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [reviewModel, records, recordId],
  );
  const followupsModel = models.find((m) => m.name === 'followups') ?? null;
  const clientsModel = models.find((m) => m.name === 'clients') ?? null;
  const categoriesModel = models.find((m) => m.name === 'sales_mistake_categories') ?? null;

  const followup = followupsModel && review?.data.follow_up
    ? (records[followupsModel.id] ?? []).find((r) => r.id === review.data.follow_up) ?? null
    : null;
  const client = clientsModel && review?.data.client
    ? (records[clientsModel.id] ?? []).find((r) => r.id === review.data.client) ?? null
    : null;
  const categories = useMemo(
    () => (categoriesModel ? (records[categoriesModel.id] ?? []).filter((c) => c.data.is_active !== false) : []),
    [categoriesModel, records],
  );

  const canView = useCanViewRecord(reviewModel ?? undefined, review ?? undefined);
  const canEdit = useCanEditRecord(reviewModel ?? undefined, review ?? undefined);

  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(review?.data ?? {}) }));
  const patch = (p: Record<string, unknown>) => setDraft((d) => ({ ...d, ...p }));
  // Seed the draft from the review ONCE it loads (cold direct loads finish
  // loading the store after mount; the useState initializer ran while review
  // was still null). Seeded once per review id so live edits + realtime echoes
  // never clobber the manager's in-progress decision.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (review && seededRef.current !== review.id) {
      seededRef.current = review.id;
      setDraft({ ...review.data });
    }
  }, [review]);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<null | 'client' | 'call' | 'whatsapp'>(null);
  const scoreTouched = useRef(false);

  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (review && versionRef.current?.id !== review.id) {
    versionRef.current = { id: review.id, version: review.version ?? null };
  }

  const resolveUser = (id: unknown): string => {
    if (typeof id !== 'string' || !id) return '—';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '—') : '—';
  };
  // Resolve a dropdown/multiselect value to its Arabic label via the model's
  // own field options — so no raw slug ever reaches the screen.
  const opt = (fieldName: string, value: unknown): { label: string; color?: string } => {
    const f = reviewModel?.schema.sections.flatMap((s) => s.fields).find((x) => x.name === fieldName);
    const o = (f?.options ?? []).find((x) => x.value === value);
    if (!o) return { label: typeof value === 'string' && value ? value : '—' };
    return { label: (isAr ? o.label_ar : o.label_en) || '—', color: o.color };
  };

  if (!reviewModel) return <Empty>{isAr ? 'النموذج غير موجود' : 'Model not found'}</Empty>;
  if (!review) return <Empty>{isAr ? 'التقييم غير موجود' : 'Review not found'}</Empty>;
  if (!canView) return <Empty>{isAr ? 'لا تملك صلاحية عرض هذا التقييم' : 'No permission to view this review'}</Empty>;

  const d = draft;
  const clientName = (d.client_name_snapshot as string) || (client?.data.client_name as string) || '—';
  const phone = (d.client_phone_snapshot as string) || (client?.data.phone_number as string) || '';
  const clientRecId = typeof review.data.client === 'string' ? review.data.client : '';
  const outcome = (d.review_outcome as string) || '';
  const flags = Array.isArray(d.review_flags) ? (d.review_flags as string[]) : [];
  const hasDispute = Boolean(d.rep_acknowledged) || Boolean(d.rep_response)
    || ((d.dispute_status as string) && d.dispute_status !== 'none')
    || d.review_status === 'disputed_by_rep';

  const fmt = (v: unknown): string => {
    if (typeof v !== 'string' || !v) return '—';
    const dt = new Date(v);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  };

  // Default score for the selected outcome (category deduction wins).
  const defaultScore = (oc: string, catId: unknown): number | '' => {
    const cat = categories.find((c) => c.id === catId);
    const ded = cat ? Number(cat.data.score_deduction) : NaN;
    if (!Number.isNaN(ded)) return Math.max(0, 100 - ded);
    if (oc === 'correct') return 100;
    if (oc === 'minor') return 85;
    if (oc === 'major') return 65;
    if (oc === 'critical') return 40;
    return '';
  };

  const pickOutcome = (oc: string) => {
    scoreTouched.current = false;
    patch({ review_outcome: oc, overall_score: defaultScore(oc, d.mistake_category) });
  };
  const pickCategory = (catId: string) => {
    const p: Record<string, unknown> = { mistake_category: catId };
    if (!scoreTouched.current) p.overall_score = defaultScore(outcome, catId);
    const cat = categories.find((c) => c.id === catId);
    if (cat && cat.data.requires_correction_by_default === true && d.requires_correction == null) {
      p.requires_correction = true;
    }
    patch(p);
  };

  async function save(extra: Record<string, unknown> = {}) {
    if (!review) return;
    setSaving(true);
    const finalData = {
      ...draft, ...extra,
      sales_manager: draft.sales_manager ?? currentUserId ?? null,
      review_date: draft.review_date ?? new Date().toISOString(),
    };
    const toSave: AppRecord = { ...review, data: finalData, updated_at: new Date().toISOString() };
    const res = await saveRecord(toSave, { expectedVersion: versionRef.current?.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تم تعديل هذا التقييم من مستخدم آخر — حدّث الصفحة.' : 'This review was edited elsewhere — reload.', 'error');
      return;
    }
    addToast(isAr ? 'تم حفظ التقييم' : 'Review saved', 'success');
    navigate('/model/sales_valuation_reviews');
  }

  const statusOpt = opt('review_status', d.review_status);
  const prioOpt = opt('review_priority', d.review_priority);

  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6 space-y-5">
      <button type="button" onClick={() => navigate('/model/sales_valuation_reviews')}
        className="inline-flex items-center gap-1 text-sm font-semibold text-terracotta hover:underline">
        <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'رجوع للقائمة' : 'Back to queue'}
      </button>

      {/* ── 1. Header summary card ─────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-xs font-medium text-charcoal/50 mb-1">{isAr ? 'العميل' : 'Client'}</p>
            <h1 className="text-2xl font-extrabold text-chocolate leading-tight">{clientName}</h1>
            {phone && <p className="text-sm text-charcoal/60 mt-1" dir="ltr">{phone}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={prioOpt.label} color={prioOpt.color} prefix={isAr ? 'الأولوية' : 'Priority'} />
            <Pill label={statusOpt.label} color={statusOpt.color} prefix={isAr ? 'الحالة' : 'Status'} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <Fact label={isAr ? 'مندوب المبيعات' : 'Sales Rep'} value={resolveUser(d.sales_rep)} />
          <Fact label={isAr ? 'نوع المتابعة' : 'Follow-up Type'} value={opt('followup_type', d.followup_type).label} />
          <Fact label={isAr ? 'نتيجة المتابعة' : 'Result'} value={opt('follow_up_result', d.follow_up_result).label} />
          <Fact label={isAr ? 'وقت المتابعة المجدول' : 'Scheduled'} value={fmt(followup?.data.scheduled_datetime ?? d.fu_scheduled)} />
          <Fact label={isAr ? 'وقت التنفيذ الفعلي' : 'Actually Completed'} value={fmt(followup?.data.actual_datetime ?? d.fu_completed)} />
          <Fact label={isAr ? 'مصدر المراجعة' : 'Source'} value={opt('review_source', d.review_source).label} />
        </div>
      </section>

      {/* ── 2. Evidence buttons (open modals, no navigation) ───────── */}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setModal('client')}>
          <User size={16} /> {isAr ? 'عرض ملف العميل' : 'Client Profile'}
        </Button>
        <Button variant="secondary" onClick={() => setModal('call')}>
          <Phone size={16} /> {isAr ? 'الاستماع للمكالمة' : 'Listen to Call'}
        </Button>
        <Button variant="secondary" onClick={() => setModal('whatsapp')}>
          <MessageCircle size={16} style={{ color: '#25D366' }} /> {isAr ? 'فتح محادثة واتساب' : 'WhatsApp Chat'}
        </Button>
      </div>

      {/* ── 3. Follow-up context (read-only cards) ─────────────────── */}
      <section className="card p-5 space-y-4">
        <h2 className="text-base font-bold text-charcoal flex items-center gap-2">
          {isAr ? 'سياق المتابعة' : 'Follow-up Context'}
        </h2>
        <ReadField label={isAr ? 'ملاحظات المتابعة' : 'Follow-up Notes'}
          value={(followup?.data.outcome_notes as string) || (d.fu_notes as string) || ''} long />
        <div className="grid sm:grid-cols-2 gap-4">
          <ReadField label={isAr ? 'الخطوة التالية' : 'Next Step'}
            value={nextStep(followup, isAr)} />
          <ReadField label={isAr ? 'الموعد / الزيارة / العرض المرتبط' : 'Linked Appointment / Visit / Offer'}
            value={linkedEvidence(followup, models, records, isAr)} />
        </div>
        <div>
          <p className="text-xs font-medium text-charcoal/50 mb-2">{isAr ? 'إشارات النظام' : 'System Flags'}</p>
          {flags.length === 0 ? (
            <p className="text-sm text-charcoal/50">{isAr ? 'لا توجد إشارات' : 'No flags'}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {flags.map((fl) => {
                const o = opt('review_flags', fl);
                return <Pill key={fl} label={o.label} color={o.color} />;
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── 4. Manager decision panel ──────────────────────────────── */}
      <section className="card p-5 space-y-4 border-2 border-copper/20">
        <h2 className="text-base font-bold text-charcoal">{isAr ? 'تقييم المدير' : 'Manager Decision'}</h2>
        <p className="text-sm text-charcoal/60">{isAr ? 'هل كان تعامل المندوب صحيحاً؟' : 'Was the rep’s handling correct?'}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <DecisionButton active={outcome === 'correct'} disabled={!canEdit} onClick={() => pickOutcome('correct')}
            icon={<CheckCircle2 size={20} />} label={isAr ? 'صحيح' : 'Correct'} tone="#10B981" />
          <DecisionButton active={outcome === 'minor'} disabled={!canEdit} onClick={() => pickOutcome('minor')}
            icon={<AlertTriangle size={20} />} label={isAr ? 'خطأ بسيط' : 'Minor'} tone="#C09B5F" />
          <DecisionButton active={outcome === 'major'} disabled={!canEdit} onClick={() => pickOutcome('major')}
            icon={<AlertOctagon size={20} />} label={isAr ? 'خطأ مؤثر' : 'Major'} tone="#F59E0B" />
          <DecisionButton active={outcome === 'critical'} disabled={!canEdit} onClick={() => pickOutcome('critical')}
            icon={<Flame size={20} />} label={isAr ? 'خطأ حرج' : 'Critical'} tone="#EF4444" />
        </div>

        {outcome === 'correct' && (
          <div className="space-y-3 pt-2">
            <Labeled label={isAr ? 'الدرجة' : 'Score'}>
              <input type="number" value={String(d.overall_score ?? 100)} disabled={!canEdit}
                onChange={(e) => { scoreTouched.current = true; patch({ overall_score: e.target.value === '' ? '' : Number(e.target.value) }); }}
                className="form-input w-32" />
            </Labeled>
            <Labeled label={isAr ? 'ملاحظة للمندوب (اختياري)' : 'Note (optional)'}>
              <textarea value={(d.coaching_note as string) ?? ''} disabled={!canEdit} rows={2}
                onChange={(e) => patch({ coaching_note: e.target.value })} className="form-input w-full" />
            </Labeled>
            <Button onClick={() => save()} disabled={!canEdit || saving}>
              {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'اعتماد التقييم' : 'Approve Review')}
            </Button>
          </div>
        )}

        {(outcome === 'minor' || outcome === 'major' || outcome === 'critical') && (
          <div className="space-y-3 pt-2">
            <Labeled label={isAr ? 'تصنيف الخطأ' : 'Mistake Category'}>
              <select value={(d.mistake_category as string) ?? ''} disabled={!canEdit}
                onChange={(e) => pickCategory(e.target.value)} className="form-input w-full">
                <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.data.category_name as string}</option>
                ))}
              </select>
            </Labeled>
            <Labeled label={isAr ? 'تفاصيل الخطأ' : 'Mistake Details'}>
              <textarea value={(d.mistake_details as string) ?? ''} disabled={!canEdit} rows={2}
                onChange={(e) => patch({ mistake_details: e.target.value })} className="form-input w-full" />
            </Labeled>
            <Labeled label={isAr ? 'التصرف الصحيح' : 'Correct Action'}>
              <textarea value={(d.correct_action as string) ?? ''} disabled={!canEdit} rows={2}
                onChange={(e) => patch({ correct_action: e.target.value })} className="form-input w-full" />
            </Labeled>
            <Labeled label={isAr ? 'ملاحظة تدريبية للمندوب' : 'Coaching Note'}>
              <textarea value={(d.coaching_note as string) ?? ''} disabled={!canEdit} rows={2}
                onChange={(e) => patch({ coaching_note: e.target.value })} className="form-input w-full" />
            </Labeled>
            <div className="grid sm:grid-cols-2 gap-4">
              <Labeled label={isAr ? 'الدرجة' : 'Score'}>
                <input type="number" value={String(d.overall_score ?? '')} disabled={!canEdit}
                  onChange={(e) => { scoreTouched.current = true; patch({ overall_score: e.target.value === '' ? '' : Number(e.target.value) }); }}
                  className="form-input w-32" />
              </Labeled>
              <Labeled label={isAr ? 'مهلة التصحيح' : 'Correction Deadline'}>
                <input type="datetime-local" value={toLocalInput(d.correction_deadline)} disabled={!canEdit}
                  onChange={(e) => patch({ correction_deadline: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                  className="form-input w-full" />
              </Labeled>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-charcoal">
              <input type="checkbox" checked={Boolean(d.requires_correction)} disabled={!canEdit}
                onChange={(e) => patch({ requires_correction: e.target.checked })} />
              {isAr ? 'يتطلب تصحيح' : 'Requires Correction'}
            </label>
            <Button onClick={() => save()} disabled={!canEdit || saving}>
              {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ التقييم' : 'Save Review')}
            </Button>
          </div>
        )}
      </section>

      {/* ── 5. Rep response / dispute (collapsed unless present) ────── */}
      <DisputePanel
        isAr={isAr} d={d} opt={opt} canEdit={canEdit} saving={saving}
        defaultOpen={hasDispute}
        onFinalDecision={(dec) => save({ final_manager_decision: dec })}
      />

      <div className="border-t border-sand/60 pt-3">
        <button type="button" onClick={() => navigate(`/model/sales_valuation_reviews/${review.id}?generic=1`)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
          <SlidersHorizontal size={14} /> {isAr ? 'الحقول المتقدمة (نموذج كامل)' : 'Advanced fields (full form)'}
        </button>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {modal === 'client' && clientsModel && clientRecId && (
        <RecordFormModal
          modelId={clientsModel.id}
          recordId={clientRecId}
          openInPageHref={`/model/clients/${clientRecId}`}
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
      {modal === 'call' && (
        <Modal title={isAr ? 'الاستماع للمكالمة' : 'Call Recording'} onClose={() => setModal(null)} isAr={isAr}>
          {phone
            ? <CallHistoryPanel phones={[phone]} chrome="naked" />
            : <p className="text-sm text-charcoal/60">{isAr ? 'لا يوجد تسجيل مكالمة مرتبط بهذه المتابعة' : 'No call recording linked to this follow-up'}</p>}
        </Modal>
      )}
      {modal === 'whatsapp' && (
        <Modal title={isAr ? 'محادثة واتساب' : 'WhatsApp Chat'} onClose={() => setModal(null)} isAr={isAr}>
          {clientRecId
            ? <WhatsAppHistoryPanel clientId={clientRecId} chrome="naked" />
            : <p className="text-sm text-charcoal/60">{isAr ? 'لا توجد محادثة واتساب مرتبطة بهذا العميل' : 'No WhatsApp conversation linked to this client'}</p>}
        </Modal>
      )}
    </div>
  );
}

// ── small building blocks ────────────────────────────────────────────

function Empty({ children }: { children: ReactNode }) {
  return <div className="p-6 text-[#8E4E3A]">{children}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-charcoal/50">{label}</p>
      <p className="text-sm font-semibold text-charcoal mt-0.5">{value}</p>
    </div>
  );
}

function Pill({ label, color, prefix }: { label: string; color?: string; prefix?: string }) {
  const c = color || '#6B7280';
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold"
      style={{ backgroundColor: `${c}1A`, color: c }}>
      {prefix && <span className="opacity-70 font-medium">{prefix}:</span>}{label}
    </span>
  );
}

function ReadField({ label, value, long }: { label: string; value: string; long?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-charcoal/50 mb-1">{label}</p>
      <div className={`rounded-xl bg-cream/60 border border-sand/30 px-4 py-3 text-sm text-charcoal whitespace-pre-wrap ${long ? 'min-h-[3rem]' : ''}`}>
        {value && value.trim() ? value : <span className="text-charcoal/40">—</span>}
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-charcoal/60 mb-1">{label}</label>
      {children}
    </div>
  );
}

function DecisionButton({ active, disabled, onClick, icon, label, tone }: {
  active: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; label: string; tone: string;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 py-4 px-2 font-bold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      style={active
        ? { borderColor: tone, backgroundColor: `${tone}15`, color: tone }
        : { borderColor: '#E5DCC9', backgroundColor: 'white', color: '#4A4E54' }}>
      <span style={{ color: tone }}>{icon}</span>
      {label}
    </button>
  );
}

function DisputePanel({ isAr, d, opt, canEdit, saving, defaultOpen, onFinalDecision }: {
  isAr: boolean; d: Record<string, unknown>; canEdit: boolean; saving: boolean; defaultOpen: boolean;
  opt: (f: string, v: unknown) => { label: string; color?: string };
  onFinalDecision: (dec: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const dispute = opt('dispute_status', d.dispute_status);
  return (
    <section className="card p-5">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-base font-bold text-charcoal">
        <span>{isAr ? 'رد المندوب والإغلاق' : 'Rep Response & Closure'}</span>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-4">
            <Fact label={isAr ? 'أقرّ المندوب' : 'Rep Acknowledged'} value={d.rep_acknowledged ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No')} />
            <div>
              <p className="text-xs font-medium text-charcoal/50">{isAr ? 'حالة الاعتراض' : 'Dispute Status'}</p>
              <div className="mt-1"><Pill label={dispute.label} color={dispute.color} /></div>
            </div>
          </div>
          <ReadField label={isAr ? 'رد المندوب' : 'Rep Response'} value={(d.rep_response as string) || ''} long />
          <div>
            <p className="text-xs font-medium text-charcoal/60 mb-2">{isAr ? 'قرار المدير النهائي' : 'Final Manager Decision'}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!canEdit || saving} onClick={() => onFinalDecision('confirmed')}>{isAr ? 'تأكيد الملاحظة' : 'Confirm'}</Button>
              <Button variant="secondary" disabled={!canEdit || saving} onClick={() => onFinalDecision('adjusted')}>{isAr ? 'تعديل' : 'Adjust'}</Button>
              <Button variant="secondary" disabled={!canEdit || saving} onClick={() => onFinalDecision('cancelled')}>{isAr ? 'إلغاء الملاحظة' : 'Cancel'}</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Modal({ title, onClose, isAr, children }: { title: string; onClose: () => void; isAr: boolean; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} dir={isAr ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-cream shadow-xl">
        <header className="sticky top-0 flex items-center justify-between border-b border-sand/40 bg-cream px-5 py-3">
          <h3 className="text-base font-bold text-charcoal">{title}</h3>
          <button type="button" onClick={onClose} className="text-charcoal/50 hover:text-charcoal"><X size={20} /></button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── pure helpers ─────────────────────────────────────────────────────

function toLocalInput(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  const dt = new Date(v);
  if (isNaN(dt.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function nextStep(followup: AppRecord | null, isAr: boolean): string {
  if (!followup) return '';
  const days = followup.data.next_followup_after_days;
  if (typeof days === 'number' && days > 0) return isAr ? `متابعة تالية بعد ${days} يوم` : `Next follow-up in ${days} days`;
  return '';
}

function linkedEvidence(followup: AppRecord | null, models: AppModel[], records: Record<string, AppRecord[]>, isAr: boolean): string {
  if (!followup) return '';
  const out: string[] = [];
  const apptId = followup.data.appointment_id;
  if (typeof apptId === 'string' && apptId) out.push(isAr ? 'موعد مرتبط' : 'Linked appointment');
  const visitId = followup.data.visit;
  if (typeof visitId === 'string' && visitId) out.push(isAr ? 'زيارة مرتبطة' : 'Linked visit');
  // offers/reservations linked to the same client
  const clientId = followup.data.client_id;
  for (const [name, label] of [['offer_prices', isAr ? 'عرض سعر' : 'Offer'], ['reservations', isAr ? 'حجز' : 'Reservation']] as const) {
    const m = models.find((x) => x.name === name);
    if (m && typeof clientId === 'string' && (records[m.id] ?? []).some((r) => r.data.client_id === clientId)) out.push(label);
  }
  return out.join(' · ');
}
