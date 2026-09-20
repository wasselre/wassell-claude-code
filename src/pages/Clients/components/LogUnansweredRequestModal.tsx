/**
 * "We don't have what this client wants" — opens a SEARCH REQUEST from the
 * Client Options tab.
 *
 * ONE CONVERGENCE POINT. This modal creates ONLY the `unanswered_requests`
 * record. It deliberately does NOT move the client's stage/status and does NOT
 * create the search task — a workflow on the request's CREATE does both, so
 * this button and the follow-up outcome «طلب غير مجاب» produce byte-identical
 * state. Moving the client here would be a second automation path, which is
 * exactly the class of bug this codebase keeps paying for.
 *
 * `unanswered_requests` is enrolled in `workflow_capture_models`, so the store
 * skips the client-side engine and the Fly worker runs the workflow server-side
 * off the DB capture trigger.
 */
import { useMemo, useState } from 'react';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

const REQUESTS_MODEL = 'unanswered_requests';

/** Request statuses that mean the search is over. Mirrors the two closing
 *  options added to `request_status` and the SQL partial unique index. */
const CLOSED_STATUSES = new Set(['fulfilled', 'client_dropped']);

interface Props {
  clientId: string;
  isAr: boolean;
  onClose: () => void;
  /** Fired after a request is created, so the host can refresh/navigate. */
  onCreated?: (requestId: string) => void;
}

export default function LogUnansweredRequestModal({ clientId, isAr, onClose, onCreated }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const [notes, setNotes] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);

  const model = models.find((m) => m.name === REQUESTS_MODEL);

  // One OPEN request per client. The DB partial unique index is the real
  // guarantee (it also covers races and the follow-up entry point); this check
  // exists so the rep gets a sentence instead of a failed write.
  const existingOpen = useMemo(() => {
    if (!model) return undefined;
    return (records[model.id] ?? []).find((r) => {
      const d = r.data as Record<string, unknown>;
      if (d.client_id !== clientId) return false;
      const status = typeof d.request_status === 'string' && d.request_status ? d.request_status : 'received';
      return !CLOSED_STATUSES.has(status);
    });
  }, [model, records, clientId]);

  const canSave = !!model && !existingOpen && notes.trim().length > 0 && !saving;

  const submit = async () => {
    if (!model || !canSave) return;
    setSaving(true);
    try {
      const id = uuid();
      const now = new Date().toISOString();
      const record: AppRecord = {
        id,
        model_id: model.id,
        data: {
          client_id: clientId,
          request_notes: notes.trim(),
          request_status: 'received',
          ...(targetDate ? { target_date: new Date(targetDate).toISOString() } : {}),
        },
        created_by_user_id: null,
        created_at: now,
        updated_at: now,
      };
      const res = await saveRecord(record);
      if (res.status === 'conflict') {
        addToast(L('تعذّر الحفظ — أعد تحميل الصفحة وحاول مجدداً.', 'Could not save — reload and try again.'), 'error');
        return;
      }
      addToast(
        res.status === 'queued'
          ? L('سيُحفظ الطلب عند عودة الاتصال.', 'The request will be saved when the connection returns.')
          : L('تم فتح طلب بحث — سيتحوّل العميل إلى «يتم البحث» وتُفتح مهمة متابعة للبحث.',
               'Search request opened — the client moves to “Searching” and a search task is created.'),
        'success',
      );
      onCreated?.(id);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={L('تسجيل طلب غير مجاب', 'Log an unanswered request')}
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {L('إلغاء', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {L('فتح طلب بحث', 'Open search request')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!model && (
          <p className="rounded-xl bg-cream p-3 text-sm text-terracotta">
            {L('نموذج الطلبات غير المجابة غير متاح.', 'The unanswered-requests model is unavailable.')}
          </p>
        )}

        {existingOpen && (
          <div className="flex items-start gap-2 rounded-xl border border-[#C09B5F]/40 bg-[#C09B5F]/10 px-3 py-2.5 text-sm text-[#8E4E3A]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>
              {L('يوجد طلب بحث مفتوح لهذا العميل بالفعل — حدّثه بدلاً من فتح طلب جديد.',
                 'This client already has an open search request — update that one instead of opening another.')}
            </span>
          </div>
        )}

        <p className="text-sm text-charcoal/70">
          {L('استخدم هذا عندما يكون العميل مهتماً لكن لا يوجد لدينا ما يناسب طلبه. تتوقف المتابعة المعتادة، وتُفتح مهمة بحث تتكرر كل ٧ أيام حتى نجد خياراً أو ينسحب العميل.',
             "Use this when the client is interested but we have nothing that fits. Ordinary follow-up pauses, and a search task recurs every 7 days until we find an option or the client drops out.")}
        </p>

        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-chocolate">
            {L('ما الذي يطلبه العميل بالضبط؟', 'What exactly is the client asking for?')}
            <span className="text-terracotta"> *</span>
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            disabled={!!existingOpen}
            placeholder={L('مثال: فيلا في حي الملقا، ٤٠٠–٥٠٠ م²، حتى ٣ مليون، تسليم فوري.',
                           'e.g. Villa in Al Malqa, 400–500 m², up to 3M, ready to move in.')}
            className="form-input w-full"
          />
          <span className="mt-1 block text-xs text-charcoal/55">
            {L('هذا النص هو محتوى ملف البحث — اكتبه بدقة كي يعرف فريق المصادر ما يبحث عنه.',
               'This text becomes the search file — be specific so whoever sources it knows what to look for.')}
          </span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-chocolate">
            {L('تاريخ مستهدف (اختياري)', 'Target date (optional)')}
          </span>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            disabled={!!existingOpen}
            className="form-input"
          />
        </label>
      </div>
    </Modal>
  );
}
