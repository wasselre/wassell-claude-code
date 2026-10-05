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
 *
 * NO FREE TEXT (2026-10-05). The request IS the client's saved preferences —
 * unit type, requested districts, budget, … — which the office matching and the
 * office message read. So this form is the client's preference fields
 * (RequestPreferencesForm); the request opens only when the three a request
 * cannot work without are filled (requestReadiness.ts). Unsaved preference
 * edits are saved to the CLIENT first (the versioned saveClientPreferences
 * path), then the request is created — if that save fails, no request opens.
 */
import { useMemo, useRef, useState } from 'react';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import type { AppRecord } from '@/types';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import { requestPreferenceGaps } from '@/lib/clients/requestReadiness';
import { describeAsk } from '@/lib/officeOutreach/message';
import { clientRequestFacts } from '@/pages/Sales/requests/requestData';
import RequestPreferencesForm, { requestPrefFields } from '@/pages/Sales/requests/RequestPreferencesForm';

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

  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);

  const model = models.find((m) => m.name === REQUESTS_MODEL);
  const clientsModel = models.find((m) => m.name === 'clients');
  const client = useMemo(
    () => (clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null : null),
    [clientsModel, records, clientId],
  );

  // The client's preferences ARE the request: edited here, saved to the client.
  const { draft, patchDraft } = useRecordDraft(client);
  // Version pinned at load (same posture as PreferencesTab) so a concurrent edit
  // of this client surfaces as a conflict instead of being overwritten.
  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (client && versionRef.current?.id !== client.id) {
    versionRef.current = { id: client.id, version: client.version ?? null };
  }
  const slugs = useMemo(() => (clientsModel ? requestPrefFields(clientsModel).map((f) => f.name) : []), [clientsModel]);
  const dirty = client ? preferencesDirty(client.data, draft, slugs) : false;
  const gaps = requestPreferenceGaps(draft);
  const store = useMemo(() => ({ models, records }), [models, records]);
  const askLine = useMemo(() => describeAsk(clientRequestFacts(draft, store)), [draft, store]);

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

  const canSave = !!model && !!client && !existingOpen && gaps.length === 0 && !saving;

  const submit = async () => {
    if (!model || !client || !canSave) return;
    setSaving(true);
    try {
      // 1 — the preferences first: the request is read from the SAVED client.
      if (dirty) {
        const pref = await saveClientPreferences({
          client, draft, slugs, saveRecord, isAr,
          expectedVersion: versionRef.current?.version ?? null,
        });
        if (!pref.ok) {
          // Conflict / failure: nothing else is written, so no request opens on
          // preferences that did not save.
          addToast(pref.message, pref.tone);
          return;
        }
        if (versionRef.current) versionRef.current = { id: client.id, version: pref.nextVersion };
      }

      // 2 — the request: a pointer to the client, no text of its own.
      const id = uuid();
      const now = new Date().toISOString();
      const record: AppRecord = {
        id,
        model_id: model.id,
        data: {
          client_id: clientId,
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
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {L('إلغاء', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {dirty ? L('حفظ التفضيلات وفتح طلب بحث', 'Save preferences & open request') : L('فتح طلب بحث', 'Open search request')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {(!model || !clientsModel) && (
          <p className="rounded-xl bg-cream p-3 text-sm text-terracotta">
            {L('نموذج الطلبات غير المجابة غير متاح.', 'The unanswered-requests model is unavailable.')}
          </p>
        )}
        {model && clientsModel && !client && (
          <p className="rounded-xl bg-cream p-3 text-sm text-terracotta">
            {L('تعذّر تحميل ملف العميل — أعد تحميل الصفحة.', "Could not load the client's record — reload the page.")}
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
          {L('استخدم هذا عندما يكون العميل مهتماً لكن لا يوجد لدينا ما يناسب طلبه. الطلب هو تفضيلات العميل نفسها — نوع الوحدة والأحياء والميزانية — ومنها تُختار المكاتب وتُكتب رسالتها. تتوقف المتابعة المعتادة، وتُفتح مهمة بحث تتكرر كل ٧ أيام حتى نجد خياراً أو ينسحب العميل.',
             "Use this when the client is interested but we have nothing that fits. The request is the client's own preferences — unit type, districts, budget — which choose the offices and write their message. Ordinary follow-up pauses, and a search task recurs every 7 days until we find an option or the client drops out.")}
        </p>

        {client && clientsModel && (
          <RequestPreferencesForm
            client={client}
            clientsModel={clientsModel}
            draft={draft}
            patchDraft={patchDraft}
            isAr={isAr}
            disabled={!!existingOpen || saving}
          />
        )}

        {client && gaps.length === 0 && (
          <div className="rounded-xl border border-sand/60 bg-cream-light p-3 text-sm">
            <div className="mb-1 text-xs font-semibold text-charcoal/55">{L('الطلب كما سيصل للمكاتب', 'The request as offices will read it')}</div>
            <div className="font-semibold text-charcoal">{askLine}</div>
          </div>
        )}

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
