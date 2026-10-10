import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MessageSquare, CalendarCheck, PhoneCall, AlertTriangle, Quote } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  fetchMyNextSteps, decideNextStep, announceNextStepChanged,
  NEXT_STEP_CHANGED_EVENT, FOLLOWUP_COMPLETED_EVENT,
  type NextPlan, type NextStepCard,
} from '@/lib/nextStep/client';
import NextStepEditor, { describePlan } from '@/components/nextStep/NextStepEditor';
import { RESULT_LABEL } from '@/components/nextStep/NextStepPromptHost';
import CompleteWhatsAppFollowupModal from '@/pages/Chats/components/CompleteWhatsAppFollowupModal';
import ChatThreadModal from '@/pages/Chats/components/ChatThreadModal';

/** My review cards: loaded on mount, on focus, every minute and after any decision. */
export function useNextStepCards(enabled = true) {
  const [cards, setCards] = useState<NextStepCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try { setCards(await fetchMyNextSteps()); setError(null); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [enabled]);
  useEffect(() => {
    void refresh();
    const again = () => void refresh();
    const later = () => window.setTimeout(again, 4_000);
    window.addEventListener(NEXT_STEP_CHANGED_EVENT, again);
    window.addEventListener(FOLLOWUP_COMPLETED_EVENT, later);
    window.addEventListener('focus', again);
    const t = window.setInterval(again, 60_000);
    return () => {
      window.removeEventListener(NEXT_STEP_CHANGED_EVENT, again);
      window.removeEventListener(FOLLOWUP_COMPLETED_EVENT, later);
      window.removeEventListener('focus', again);
      window.clearInterval(t);
    };
  }, [refresh]);
  return { cards, loading, error, refresh, drop: (id: string) => setCards((cs) => cs.filter((c) => c.id !== id)) };
}

/**
 * «المساعد يحتاجك» → «قراراتك»: the next steps the agent owns (2026-10-10).
 *   · after a result the agent recorded — agree with the planned next step or change it;
 *   · after a conversation the AI handled — agree with its result + next step,
 *     or set another result in the chat window (which then asks for the next step);
 *   · a visit booked from the AI's question — seen.
 * Cards applied automatically at 21:00 stay for a day-and-a-half, marked.
 */
export default function NextStepCardsSection({ cards, loading, error, isAr, showOwner, onChanged }: {
  cards: NextStepCard[];
  loading: boolean;
  error: string | null;
  isAr: boolean;
  showOwner: boolean;
  onChanged: (id: string) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  if (!cards.length && !loading && !error) return null;
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-bold text-chocolate">{L('قراراتك', 'Your decisions')}</h2>
      {error && <p className="mb-2 text-sm text-terracotta">{L('تعذّر التحميل: ', 'Could not load: ')}{error}</p>}
      {loading && !cards.length && <p className="text-sm text-charcoal/50"><Loader2 size={13} className="me-1 inline animate-spin" />{L('جارٍ التحميل…', 'Loading…')}</p>}
      <div className="space-y-2">
        {cards.map((c) => <CardRow key={c.id} card={c} isAr={isAr} showOwner={showOwner} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function CardRow({ card, isAr, showOwner, onChanged }: { card: NextStepCard; isAr: boolean; showOwner: boolean; onChanged: (id: string) => void }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<NextPlan | null>(card.kind === 'conversation' ? card.suggested_next : card.planned_next);
  const [saving, setSaving] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);

  const auto = card.status === 'auto_applied';
  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const followup: AppRecord | undefined = followupsModel && card.followup_id
    ? (records[followupsModel.id] ?? []).find((r) => r.id === card.followup_id) : undefined;
  const client: AppRecord | undefined = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === card.client_id) : undefined;
  const owner = showOwner && card.owner_user_id ? users.find((u) => u.id === card.owner_user_id) : undefined;

  const decide = async (input: Parameters<typeof decideNextStep>[1]) => {
    setSaving(true);
    try {
      await decideNextStep(card.id, input);
      addToast(L('تم الحفظ', 'Saved'), 'success');
      announceNextStepChanged();
      onChanged(card.id);
    } catch (err) {
      addToast(L(`تعذّر الحفظ: ${(err as Error).message}`, `Could not save: ${(err as Error).message}`), 'error');
    } finally {
      setSaving(false);
    }
  };

  const icon = card.kind === 'visit_booked' ? <CalendarCheck size={15} /> : card.kind === 'conversation' ? <MessageSquare size={15} /> : <PhoneCall size={15} />;
  const title = card.kind === 'visit_booked'
    ? L('حُجزت زيارة من سؤال المساعد', 'A visit was booked from the AI’s question')
    : card.kind === 'conversation'
      ? L('رد العميل وأكمل المساعد المحادثة', 'The client replied and the AI handled the chat')
      : L('الخطوة التالية بعد نتيجتك', 'The next step after your result');
  const res = (k: string | null) => (k && RESULT_LABEL[k] ? (isAr ? RESULT_LABEL[k].ar : RESULT_LABEL[k].en) : k ?? '—');

  return (
    <div className={`rounded-xl border bg-white p-3 shadow-sm ${auto ? 'border-sand/40 opacity-90' : 'border-sand/60'}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-copper">{icon}</span>
        <span className="font-bold text-charcoal">{card.client_name ?? L('عميل', 'Client')}</span>
        <span className="text-charcoal/55">— {title}</span>
        {owner && <span className="rounded-full bg-cream px-2 py-0.5 text-[11px] text-charcoal/60">{isAr ? owner.name_ar : owner.name_en}</span>}
        {auto && <span className="rounded-full bg-sand/40 px-2 py-0.5 text-[11px] font-bold text-charcoal/70">{L('طُبّق تلقائياً', 'Applied automatically')}</span>}
      </div>

      {card.kind === 'conversation' && (
        <div className="mt-2 space-y-1.5 text-sm">
          {card.summary && <p className="text-charcoal/80">{card.summary}</p>}
          {card.client_quote && (
            <p className="text-charcoal/60"><Quote size={12} className="me-1 inline text-copper" />«{card.client_quote}»</p>
          )}
          <p>
            <span className="text-charcoal/55">{L('النتيجة المقترحة: ', 'Suggested result: ')}</span>
            <span className="font-bold text-chocolate">{res(card.suggested_result)}</span>
            {card.suggested_confidence != null && <span className="text-xs text-charcoal/45"> ({card.suggested_confidence}%)</span>}
          </p>
        </div>
      )}
      {card.kind === 'after_call' && (
        <p className="mt-2 text-sm"><span className="text-charcoal/55">{L('نتيجتك: ', 'Your result: ')}</span><span className="font-bold">{res(card.call_result)}</span></p>
      )}
      {card.kind === 'visit_booked' && (
        <p className="mt-2 text-sm text-charcoal/80">{card.summary}</p>
      )}

      {card.kind !== 'visit_booked' && (
        editing ? (
          <div className="mt-3"><NextStepEditor initial={plan} isAr={isAr} onChange={setPlan} /></div>
        ) : (
          <p className="mt-1.5 text-sm">
            <span className="text-charcoal/55">{L('الخطوة التالية: ', 'Next step: ')}</span>
            <span className="font-bold text-chocolate">
              {describePlan(card.kind === 'conversation' ? card.suggested_next : card.planned_next, isAr)}
            </span>
          </p>
        )
      )}
      {card.apply_error && card.status === 'pending' && (
        <p className="mt-1.5 text-xs text-terracotta"><AlertTriangle size={12} className="me-1 inline" />{card.apply_error}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {card.kind === 'visit_booked' && card.status === 'pending' && (
          <Button onClick={() => void decide({ action: 'ack' })} disabled={saving}>{L('تم', 'OK')}</Button>
        )}
        {card.kind === 'visit_booked' && card.appointment_id && (
          <Link to={`/model/appointments/${card.appointment_id}`} className="inline-flex items-center rounded-xl border border-sand/30 bg-white px-4 py-2 text-sm font-bold text-charcoal hover:bg-cream">
            {L('افتح الموعد', 'Open the appointment')}
          </Link>
        )}

        {card.kind === 'after_call' && (editing ? (
          <>
            <Button onClick={() => plan && void decide({ action: 'change', next: plan })} disabled={saving || !plan}>{L('احفظ', 'Save')}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>{L('إلغاء', 'Cancel')}</Button>
          </>
        ) : (
          <>
            {!auto && <Button onClick={() => void decide({ action: 'agree' })} disabled={saving}>{L('موافق', 'Agree')}</Button>}
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={saving}>{L('غيّر', 'Change')}</Button>
          </>
        ))}

        {card.kind === 'conversation' && card.status === 'pending' && (editing ? (
          <>
            <Button onClick={() => void decide(plan ? { action: 'agree', next: plan } : { action: 'agree' })} disabled={saving}>{L('احفظ', 'Save')}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>{L('إلغاء', 'Cancel')}</Button>
          </>
        ) : (
          <>
            <Button onClick={() => void decide({ action: 'agree' })} disabled={saving}>{L('موافق', 'Agree')}</Button>
            {card.suggested_next && <Button variant="secondary" onClick={() => setEditing(true)} disabled={saving}>{L('غيّر الخطوة التالية', 'Change the next step')}</Button>}
            {followup && followupsModel && card.chat_record_id && (
              <Button variant="secondary" onClick={() => setResultOpen(true)} disabled={saving}>{L('نتيجة أخرى', 'Another result')}</Button>
            )}
          </>
        ))}
        {card.kind !== 'visit_booked' && card.chat_record_id && (
          <Button variant="ghost" onClick={() => setChatOpen(true)}>{L('افتح المحادثة', 'Open chat')}</Button>
        )}
        {saving && <Loader2 size={16} className="animate-spin self-center text-copper" />}
      </div>

      {resultOpen && followup && followupsModel && card.chat_record_id && (
        <CompleteWhatsAppFollowupModal
          followup={followup}
          followupModel={followupsModel}
          chatRecordId={card.chat_record_id}
          clientId={card.client_id}
          clientStage={(client?.data.client_stage as string | undefined) ?? null}
          clientStatus={(client?.data.client_status as string | undefined) ?? null}
          phone={(client?.data.phone_number as string | undefined) ?? null}
          onResolveChat={() => undefined}
          onOpenChat={() => { setResultOpen(false); setChatOpen(true); }}
          onClose={() => { setResultOpen(false); announceNextStepChanged(); }}
          resolveChatOnComplete={false}
        />
      )}
      {chatOpen && card.chat_record_id && <ChatThreadModal recordId={card.chat_record_id} onClose={() => setChatOpen(false)} />}
    </div>
  );
}
