import { useState } from 'react';
import { CalendarPlus, Check, X, ClipboardCheck, AlertTriangle, Users, Phone } from 'lucide-react';
import { FOLLOWUP_TYPE_LABELS, type TaskProposalPayload } from '@/lib/matching/cards';

export type TaskProposalStatus = 'proposed' | 'created' | 'cancelled';

/**
 * Confirmation-gated task creation card (propose_task). The assistant NEVER
 * writes — this card shows the proposed follow-up; the salesperson reviews,
 * optionally edits the due time, and only then presses Confirm to create the
 * follow-up record. The card refuses to create a task unless the server resolved
 * the client to EXACTLY ONE real lead:
 *   - unresolved (not found) → disabled, "client not found".
 *   - ambiguous (duplicate name) → disabled, lists candidates to disambiguate.
 *   - resolved → shows the client's name + phone so the rep knows exactly who.
 * onConfirm returns whether the write actually saved, so a failed save shows an
 * inline error and stays retryable (never a false "created").
 */
export default function TaskProposalCard({
  payload,
  isAr,
  status,
  onConfirm,
  onCancel,
}: {
  payload: TaskProposalPayload;
  isAr: boolean;
  status: TaskProposalStatus;
  onConfirm: (dueAtIso: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [due, setDue] = useState(() => isoToLocalInput(payload.due_at));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const typeLabel = FOLLOWUP_TYPE_LABELS[payload.followup_type];

  const ambiguous = payload.ambiguous === true && (payload.candidates?.length ?? 0) > 0;
  // The server couldn't tie this to exactly one real client — never allow create.
  const blocked = payload.unresolved === true || !payload.client_id || ambiguous;
  const locked = status !== 'proposed';

  async function confirm() {
    if (locked || busy || blocked) return;
    setBusy(true);
    setFailed(false);
    const ok = await onConfirm(localInputToIso(due));
    if (!ok) {
      setFailed(true);
      setBusy(false);
    }
    // On success the parent flips status → 'created' (this card re-renders locked).
  }

  return (
    <div className="mt-2 w-full max-w-[80%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <CalendarPlus size={16} className="text-copper shrink-0" />
        <div className="text-sm font-bold text-charcoal">{L('مهمة متابعة مقترحة', 'Proposed follow-up task')}</div>
      </div>

      <div className="p-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Field label={L('العميل', 'Customer')}>
            <div>{payload.client_name || (payload.client_id ? payload.client_id.slice(0, 8) : '—')}</div>
            {payload.client_phone && (
              <div className="flex items-center gap-1 text-charcoal/50 text-[11px] mt-0.5" dir="ltr">
                <Phone size={10} /> {payload.client_phone}
              </div>
            )}
          </Field>
          <Field label={L('النوع', 'Type')}>{isAr ? typeLabel.ar : typeLabel.en}</Field>
        </div>

        <div>
          <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wider mb-0.5">{L('موعد الاستحقاق', 'Due')}</div>
          <input
            type="datetime-local"
            value={due}
            disabled={locked || blocked}
            onChange={(e) => setDue(e.target.value)}
            className="w-full rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none px-2.5 py-1.5 text-sm bg-white disabled:bg-cream disabled:text-charcoal/50"
          />
        </div>

        {payload.notes && <Field label={L('السبب / المطلوب', 'Reason / what to do')}>{payload.notes}</Field>}
        {payload.suggested_message && (
          <div className="rounded-lg bg-cream/30 border border-sand/40 p-2 text-xs text-charcoal/80 whitespace-pre-wrap">
            <span className="font-bold">{L('رسالة مقترحة: ', 'Suggested message: ')}</span>{payload.suggested_message}
          </div>
        )}

        {/* Resolution states */}
        {ambiguous && status === 'proposed' ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
            <div className="flex items-center gap-1.5 font-bold mb-1">
              <Users size={13} /> {L('أكثر من عميل بنفس الاسم — حدّد العميل أولاً', 'More than one client with this name — pick the client first')}
            </div>
            <ul className="space-y-0.5">
              {payload.candidates!.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span>{c.name || '—'}</span>
                  <span dir="ltr" className="text-amber-700/80">{c.phone || ''}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 text-amber-700/80">{L('أعد الطلب باسم العميل الكامل أو رقم جواله.', "Re-ask with the client's full name or phone number.")}</div>
          </div>
        ) : payload.unresolved === true && status === 'proposed' ? (
          <div className="flex items-start gap-1.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{L('لم يتم العثور على هذا العميل في النظام — لا يمكن إنشاء المهمة. تأكّد من اسم/رقم العميل.', "This client wasn't found in the CRM — the task can't be created. Confirm the client's name/phone.")}</span>
          </div>
        ) : status === 'created' ? (
          <div className="flex items-center gap-1.5 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
            <ClipboardCheck size={14} /> {L('تم إنشاء المهمة وإضافتها لقائمة المتابعات.', 'Task created and added to the follow-up queue.')}
          </div>
        ) : status === 'cancelled' ? (
          <div className="text-sm text-charcoal/50 italic">{L('تم تجاهل الاقتراح.', 'Proposal dismissed.')}</div>
        ) : (
          <>
            {failed && (
              <div className="flex items-center gap-1.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">
                <AlertTriangle size={14} className="shrink-0" /> {L('تعذّر إنشاء المهمة. حاول مرة أخرى.', 'Could not create the task. Try again.')}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => !busy && onCancel()}
                className="px-3 py-1.5 rounded-lg border border-sand/50 text-charcoal/70 text-sm hover:bg-cream transition-colors"
              >
                <span className="inline-flex items-center gap-1"><X size={14} />{L('تجاهل', 'Dismiss')}</span>
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="px-4 py-1.5 rounded-lg bg-copper text-white text-sm font-medium hover:bg-terracotta disabled:opacity-50 transition-colors"
              >
                <span className="inline-flex items-center gap-1"><Check size={15} />{failed ? L('إعادة المحاولة', 'Retry') : L('تأكيد وإنشاء', 'Confirm & create')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-sm text-charcoal">{children}</div>
    </div>
  );
}

/** ISO → value for <input type="datetime-local"> (local time, no seconds). */
function isoToLocalInput(iso: string): string {
  const ms = iso ? Date.parse(iso) : NaN;
  const d = Number.isFinite(ms) ? new Date(ms) : new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(v: string): string {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}
