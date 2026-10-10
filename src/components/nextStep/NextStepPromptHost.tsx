import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  FOLLOWUP_COMPLETED_EVENT, fetchCardForFollowup, decideNextStep, announceNextStepChanged,
  type NextPlan, type NextStepCard,
} from '@/lib/nextStep/client';
import NextStepEditor, { describePlan } from './NextStepEditor';

export const RESULT_LABEL: Record<string, { ar: string; en: string }> = {
  interested: { ar: 'مهتم', en: 'Interested' },
  no_answer: { ar: 'لم يرد', en: 'No answer' },
  wrong_time: { ar: 'الوقت غير مناسب', en: 'Wrong time' },
  recontact_later: { ar: 'إعادة التواصل لاحقاً', en: 'Call back later' },
  not_interested: { ar: 'غير مهتم', en: 'Not interested' },
  request_offer: { ar: 'طلب عرض سعر', en: 'Requested an offer' },
  unanswered_request: { ar: 'طلب غير مجاب', en: 'Unanswered request' },
  appointment_booked: { ar: 'تم حجز موعد', en: 'Visit booked' },
};

const POLL_MS = 2_000;
const GIVE_UP_MS = 25_000;

/**
 * Right after a PERSON records a result that leads to another contact, ask them
 * to confirm the next step the process planned (operator, 2026-10-10). Mounted
 * once in AppLayout; every completion path announces itself
 * (announceFollowupCompleted). The planned task is made by a server workflow a
 * few seconds after the save, so the card is polled until it shows. «Later»
 * closes the popup — the card waits in «المساعد يحتاجك», and at 21:00 the plan
 * stands as is.
 */
export default function NextStepPromptHost() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [card, setCard] = useState<NextStepCard | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<NextPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const pollRef = useRef<{ id: string; stop: boolean } | null>(null);

  useEffect(() => {
    const onDone = (e: Event) => {
      const id = (e as CustomEvent<{ followupId?: string }>).detail?.followupId;
      if (!id) return;
      if (pollRef.current) pollRef.current.stop = true;
      const run = { id, stop: false };
      pollRef.current = run;
      const started = Date.now();
      const tick = async () => {
        if (run.stop) return;
        try {
          const c = await fetchCardForFollowup(id);
          if (run.stop) return;
          // No card = this result opens none (or the feature is off): stay quiet.
          if (!c) { if (Date.now() - started < 6_000) { window.setTimeout(tick, POLL_MS); } else { setWaiting(false); } return; }
          if (c.status !== 'pending') { setWaiting(false); return; }
          setCard(c); setPlan(c.planned_next); setEditing(false);
          // Wait for the planned task, but never block the agent on it.
          if (!c.planned_next && Date.now() - started < GIVE_UP_MS) { setWaiting(true); window.setTimeout(tick, POLL_MS); return; }
          setWaiting(false);
        } catch (err) {
          console.error('[nextStep] popup lookup failed:', err);
          setWaiting(false);
        }
      };
      window.setTimeout(tick, 1_200);
    };
    window.addEventListener(FOLLOWUP_COMPLETED_EVENT, onDone);
    return () => window.removeEventListener(FOLLOWUP_COMPLETED_EVENT, onDone);
  }, []);

  const close = () => { if (pollRef.current) pollRef.current.stop = true; setCard(null); setEditing(false); setWaiting(false); };

  const decide = async (action: 'agree' | 'change') => {
    if (!card) return;
    if (action === 'change' && !plan) return;
    setSaving(true);
    try {
      await decideNextStep(card.id, action === 'agree' ? { action: 'agree' } : { action: 'change', next: plan! });
      addToast(L('تم حفظ الخطوة التالية', 'Next step saved'), 'success');
      announceNextStepChanged();
      close();
    } catch (err) {
      addToast(L(`تعذّر الحفظ: ${(err as Error).message}`, `Could not save: ${(err as Error).message}`), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!card) return null;
  const result = card.call_result ? RESULT_LABEL[card.call_result] : null;
  return (
    <Modal
      open
      onClose={close}
      title={L('الخطوة التالية', 'Next step')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={saving}>{L('لاحقاً', 'Later')}</Button>
          {editing ? (
            <Button onClick={() => void decide('change')} disabled={saving || !plan}>
              {saving && <Loader2 size={14} className="animate-spin" />}{L('احفظ', 'Save')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)} disabled={saving}>{L('غيّر', 'Change')}</Button>
              <Button onClick={() => void decide('agree')} disabled={saving || waiting}>
                {saving && <Loader2 size={14} className="animate-spin" />}{L('موافق', 'Agree')}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-3 text-sm text-charcoal">
        <div>
          <span className="font-bold">{card.client_name ?? L('العميل', 'The client')}</span>
          {result && <span className="text-charcoal/60"> — {L('النتيجة', 'Result')}: {isAr ? result.ar : result.en}</span>}
        </div>
        {editing ? (
          <NextStepEditor initial={plan} isAr={isAr} onChange={setPlan} />
        ) : (
          <div className="rounded-xl border border-sand/50 bg-cream/40 p-3">
            <div className="text-xs font-bold text-charcoal/55">{L('إذا لم يرد العميل، الخطوة التالية:', "If the client doesn't reply, the next step is:")}</div>
            <div className="mt-1 font-bold text-chocolate">
              {waiting ? <span className="inline-flex items-center gap-1.5 text-charcoal/50"><Loader2 size={13} className="animate-spin" />{L('جارٍ تجهيز الخطوة…', 'Preparing the next step…')}</span>
                : describePlan(card.planned_next, isAr)}
            </div>
            <div className="mt-2 text-xs text-charcoal/55">
              {L('إذا رد العميل قبل ذلك، يكمل المساعد المحادثة ثم يعرض عليك ما حدث لتقرر.', 'If the client replies first, the AI carries on the chat and then shows you what happened to decide.')}
            </div>
          </div>
        )}
        <div className="text-xs text-charcoal/45">{L('إن لم تقرر اليوم، تُطبَّق هذه الخطوة كما هي الساعة ٩ مساءً.', "If you don't decide today, this step stands as is at 9 pm.")}</div>
      </div>
    </Modal>
  );
}
