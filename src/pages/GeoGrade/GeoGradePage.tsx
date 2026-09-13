import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { Loader2, Check, X, HelpCircle, ChevronRight, ChevronLeft, MapPin, PartyPopper, Phone, MessageCircle } from 'lucide-react';
import ConversationGrader from './components/ConversationGrader';
import { authHeader, reading, Bold, Transcript, type Item, type Verdict } from './lib/shared';

/**
 * The DEAD-SIMPLE geography grader. One mention at a time: the customer's exact
 * words + the AI's read in plain Arabic, and three buttons — Right / Wrong / Not
 * sure. Backed by /api/geo-preference/simple-grade. No jargon, no 113-card dump.
 *
 * `?view=chat` switches to the CONVERSATION grader: the whole chat, every
 * mention with its reading, then the map of what the AI selected — one verdict
 * per mention plus one for the map (components/ConversationGrader.tsx).
 */

export default function GeoGradePage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [params] = useSearchParams();
  const batchId = params.get('batch') ?? '';
  const view = params.get('view') ?? '';

  const [items, setItems] = useState<Item[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!batchId) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/geo-preference/simple-grade?batch=${encodeURIComponent(batchId)}`, { headers: await authHeader() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `(${res.status})`);
      setItems(body.items as Item[]);
      setTranscripts((body.transcripts ?? {}) as Record<string, string>);
      const firstUngraded = (body.items as Item[]).findIndex((i) => !i.my_verdict);
      setIdx(firstUngraded === -1 ? 0 : firstUngraded);
    } catch (e) {
      addToast(isAr ? `تعذّر التحميل: ${String(e)}` : `Load failed: ${String(e)}`, 'error');
    } finally { setLoading(false); }
  }, [batchId, addToast, isAr]);

  useEffect(() => { void load(); }, [load]);

  const grade = useCallback(async (verdict: Verdict) => {
    const it = items[idx];
    if (!it || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/geo-preference/simple-grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ batch: batchId, evidence_id: it.id, verdict }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `(${res.status})`); }
      setItems((prev) => prev.map((p, i) => (i === idx ? { ...p, my_verdict: verdict } : p)));
      setIdx((i) => Math.min(i + 1, items.length)); // advance (past-end = done screen)
    } catch (e) {
      addToast(isAr ? `تعذّر الحفظ: ${String(e)}` : `Save failed: ${String(e)}`, 'error');
    } finally { setSaving(false); }
  }, [items, idx, saving, batchId, addToast, isAr]);

  // 1 = right, 2 = wrong, 3 = not sure
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') void grade('right');
      else if (e.key === '2') void grade('wrong');
      else if (e.key === '3') void grade('unsure');
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [grade, items.length]);

  const gradedCount = items.filter((i) => i.my_verdict).length;
  const it = items[idx];

  if (view === 'chat') return <ConversationGrader batchId={batchId} />;
  if (loading) return <Center><Loader2 className="animate-spin text-copper" size={28} /></Center>;
  if (!batchId) return <Center><p className="text-charcoal/60">{isAr ? 'لا توجد دفعة. افتح الرابط الذي أرسلته لك.' : 'No batch. Open the link I sent you.'}</p></Center>;
  if (items.length === 0) return <Center><p className="text-charcoal/60">{isAr ? 'لا توجد عناصر في هذه الدفعة.' : 'No items in this batch.'}</p></Center>;

  return (
    <div className="mx-auto max-w-xl p-4" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Header + progress */}
      <div className="mb-4 flex items-center gap-2">
        <MapPin className="text-copper" size={20} />
        <h1 className="text-lg font-bold text-charcoal">{isAr ? 'تقييم فهم الموقع' : 'Grade location understanding'}</h1>
      </div>
      <div className="mb-4">
        <div className="mb-1 flex justify-between text-xs font-semibold text-charcoal/50">
          <span>{isAr ? `${gradedCount} من ${items.length} تم تقييمها` : `${gradedCount} of ${items.length} graded`}</span>
          <span>{isAr ? `عنصر ${Math.min(idx + 1, items.length)}` : `Item ${Math.min(idx + 1, items.length)}`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sand/40">
          <div className="h-full rounded-full bg-copper transition-all" style={{ width: `${(gradedCount / items.length) * 100}%` }} />
        </div>
      </div>

      {idx >= items.length ? (
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <PartyPopper className="text-copper" size={36} />
          <p className="text-lg font-bold text-charcoal">{isAr ? 'خلصت كل العناصر 🎉' : 'All done 🎉'}</p>
          <p className="text-sm text-charcoal/60">{isAr ? 'شكرًا! قيّمت كل العناصر في هذه الدفعة.' : 'Thank you — every item in this batch is graded.'}</p>
          <Button variant="secondary" onClick={() => setIdx(0)}>{isAr ? 'مراجعة من البداية' : 'Review from the start'}</Button>
        </div>
      ) : it && (
        <div className="card p-5">
          {/* Channel-aware header: a call and a chat are graded separately. */}
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-charcoal/40">
            {it.source_channel === 'call' ? <Phone size={12} /> : <MessageCircle size={12} />}
            {it.source_channel === 'call'
              ? (isAr ? `مكالمة هاتفية${it.client ? `: ${it.client}` : ''}` : `Phone call${it.client ? `: ${it.client}` : ''}`)
              : (isAr ? `محادثة واتساب${it.client ? `: ${it.client}` : ''}` : `WhatsApp chat${it.client ? `: ${it.client}` : ''}`)}
          </p>

          {/* The ONE conversation the AI read (by its real id; legacy batches fall back to the client) — highlighted where the mention is */}
          {(transcripts[it.conversation_id] ?? transcripts[it.client_id])?.trim() ? (
            <>
              <p className="mb-1 text-xs text-charcoal/50">{it.source_channel === 'call' ? (isAr ? 'نص المكالمة (اقرأه بنفسك):' : 'The call transcript (read it yourself):') : (isAr ? 'المحادثة (اقرأها بنفسك):' : 'The chat (read it yourself):')}</p>
              <div className="mb-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-sand/40 bg-cream/20 px-4 py-3 text-sm leading-relaxed text-charcoal/80" dir="rtl">
                <Transcript text={(transcripts[it.conversation_id] ?? transcripts[it.client_id])!} mention={it.mention} />
              </div>
            </>
          ) : (
            <p className="mb-4 rounded-xl border border-dashed border-sand/40 bg-cream/10 px-4 py-3 text-center text-xs text-charcoal/40">
              {isAr ? 'لا يوجد نص محادثة محفوظ لهذا العميل.' : 'No saved conversation text for this customer.'}
            </p>
          )}

          {/* The exact words */}
          <p className="mb-1 text-xs text-charcoal/50">{isAr ? 'العبارة محل التقييم:' : 'The phrase being graded:'}</p>
          <div className="mb-4 rounded-xl bg-cream/50 px-4 py-3 text-center text-2xl font-bold text-chocolate" dir="rtl">«{it.mention}»</div>

          {/* The AI's read, plain */}
          <p className="mb-1 text-xs text-charcoal/50">{isAr ? 'الذكاء الاصطناعي فهم أنّ:' : 'The AI understood that:'}</p>
          <p className="mb-5 text-base leading-relaxed text-charcoal"><Bold text={reading(it, isAr)} /></p>

          {/* Verdict buttons */}
          <div className="grid grid-cols-3 gap-2">
            <button type="button" disabled={saving} onClick={() => void grade('right')}
              className={`flex flex-col items-center gap-1 rounded-xl border-2 py-3 text-sm font-bold transition ${it.my_verdict === 'right' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-sand/50 text-charcoal/70 hover:border-emerald-400 hover:bg-emerald-50/50'}`}>
              <Check size={22} /> {isAr ? 'صحيح' : 'Right'} <span className="text-[10px] font-normal opacity-50">1</span>
            </button>
            <button type="button" disabled={saving} onClick={() => void grade('wrong')}
              className={`flex flex-col items-center gap-1 rounded-xl border-2 py-3 text-sm font-bold transition ${it.my_verdict === 'wrong' ? 'border-red-500 bg-red-50 text-red-700' : 'border-sand/50 text-charcoal/70 hover:border-red-400 hover:bg-red-50/50'}`}>
              <X size={22} /> {isAr ? 'خطأ' : 'Wrong'} <span className="text-[10px] font-normal opacity-50">2</span>
            </button>
            <button type="button" disabled={saving} onClick={() => void grade('unsure')}
              className={`flex flex-col items-center gap-1 rounded-xl border-2 py-3 text-sm font-bold transition ${it.my_verdict === 'unsure' ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-sand/50 text-charcoal/70 hover:border-amber-400 hover:bg-amber-50/50'}`}>
              <HelpCircle size={22} /> {isAr ? 'غير واضح' : 'Not sure'} <span className="text-[10px] font-normal opacity-50">3</span>
            </button>
          </div>

          {/* Prev / Next */}
          <div className="mt-4 flex items-center justify-between">
            <button type="button" onClick={() => setIdx((i) => Math.max(i - 1, 0))} disabled={idx === 0}
              className="flex items-center gap-1 text-sm text-charcoal/50 disabled:opacity-30">
              {isAr ? <ChevronRight size={16} /> : <ChevronLeft size={16} />} {isAr ? 'السابق' : 'Previous'}
            </button>
            {saving && <span className="flex items-center gap-1 text-xs text-charcoal/40"><Loader2 className="animate-spin" size={12} /> {isAr ? 'حفظ…' : 'saving…'}</span>}
            <button type="button" onClick={() => setIdx((i) => Math.min(i + 1, items.length - 1))} disabled={idx >= items.length - 1}
              className="flex items-center gap-1 text-sm text-charcoal/50 disabled:opacity-30">
              {isAr ? 'التالي' : 'Next'} {isAr ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
          <p className="mt-3 text-center text-[11px] text-charcoal/40">{isAr ? 'أو استخدم لوحة المفاتيح: ١=صحيح ٢=خطأ ٣=غير واضح' : 'Tip: keyboard 1 = Right, 2 = Wrong, 3 = Not sure'}</p>
        </div>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[60vh] items-center justify-center p-6">{children}</div>;
}
