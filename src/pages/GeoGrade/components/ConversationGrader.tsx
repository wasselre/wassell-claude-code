import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { Loader2, Check, X, HelpCircle, ChevronRight, ChevronLeft, MapPin, PartyPopper, Phone, MessageCircle, Map as MapIcon } from 'lucide-react';
import GeoPrefMap from './GeoPrefMap';
import {
  authHeader, reading, Bold, Transcript,
  type Item, type Verdict, type ConversationView, type DistrictInfo, type Placement,
} from '../lib/shared';

/**
 * The CONVERSATION grader (`/geo-grade?batch=…&view=chat`): one screen per
 * conversation — the chat (or call transcript) on top, every place the AI
 * pulled out of it with its reading and a Right / Wrong / Not sure per
 * mention, then the MAP of what the AI actually selected (the proposal's
 * districts / zones, from the real boundary polygons) with its own verdict.
 * Verdicts save through the same endpoint as the one-card grader.
 */

interface Props { batchId: string }

function ChatBubbles({ text, mention }: { text: string; mention: string }) {
  // Chat transcripts come as lines prefixed 🧑 (customer) / 🏢 (us).
  const lines = text.split('\n').filter((l) => l.trim());
  return (
    <div className="flex flex-col gap-1.5">
      {lines.map((l, i) => {
        const mine = l.startsWith('🧑');
        const body = l.replace(/^(🧑|🏢)\s?/, '');
        return (
          <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-relaxed ${mine ? 'self-start bg-copper/15 text-charcoal' : 'self-end bg-sand/30 text-charcoal/80'}`}>
            <Transcript text={body} mention={mention} />
          </div>
        );
      })}
    </div>
  );
}

export default function ConversationGrader({ batchId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [items, setItems] = useState<Item[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [districts, setDistricts] = useState<Record<string, DistrictInfo>>({});
  const [idx, setIdx] = useState(0);
  const [focus, setFocus] = useState<string | null>(null); // evidence id whose span is highlighted
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
      const convs = (body.conversations ?? []) as ConversationView[];
      setConversations(convs);
      setDistricts((body.districts ?? {}) as Record<string, DistrictInfo>);
      const its = body.items as Item[];
      const firstOpen = convs.findIndex((c) => !isConversationDone(c, its));
      setIdx(firstOpen === -1 ? 0 : firstOpen);
    } catch (e) {
      addToast(isAr ? `تعذّر التحميل: ${String(e)}` : `Load failed: ${String(e)}`, 'error');
    } finally { setLoading(false); }
  }, [batchId, addToast, isAr]);

  useEffect(() => { void load(); }, [load]);

  const conv = conversations[idx];
  const mentions = useMemo(() => (conv ? items.filter((i) => i.conversation_id === conv.conversation_id) : []), [conv, items]);
  const transcript = conv ? (transcripts[conv.conversation_id] ?? transcripts[conv.client_id] ?? '') : '';
  const focused = mentions.find((m) => m.id === focus) ?? null;

  const gradeMention = useCallback(async (it: Item, verdict: Verdict) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/geo-preference/simple-grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ batch: batchId, evidence_id: it.id, verdict }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `(${res.status})`); }
      setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, my_verdict: verdict } : p)));
    } catch (e) {
      addToast(isAr ? `تعذّر الحفظ: ${String(e)}` : `Save failed: ${String(e)}`, 'error');
    } finally { setSaving(false); }
  }, [saving, batchId, addToast, isAr]);

  const gradeMap = useCallback(async (verdict: Verdict) => {
    if (!conv?.checkpoint_id || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/geo-preference/simple-grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ batch: batchId, checkpoint_id: conv.checkpoint_id, map_verdict: verdict }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error ?? `(${res.status})`); }
      setConversations((prev) => prev.map((c) => (c.conversation_id === conv.conversation_id ? { ...c, map_verdict: verdict } : c)));
    } catch (e) {
      addToast(isAr ? `تعذّر الحفظ: ${String(e)}` : `Save failed: ${String(e)}`, 'error');
    } finally { setSaving(false); }
  }, [conv, saving, batchId, addToast, isAr]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, conversations.length - 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversations.length]);

  const doneCount = conversations.filter((c) => isConversationDone(c, items)).length;

  if (loading) return <Center><Loader2 className="animate-spin text-copper" size={28} /></Center>;
  if (!batchId) return <Center><p className="text-charcoal/60">{isAr ? 'لا توجد دفعة. افتح الرابط الذي أرسلته لك.' : 'No batch. Open the link I sent you.'}</p></Center>;
  if (conversations.length === 0) return <Center><p className="text-charcoal/60">{isAr ? 'لا توجد محادثات في هذه الدفعة.' : 'No conversations in this batch.'}</p></Center>;

  const placementLine = (it: Item): { text: string; tone: 'ok' | 'none' | 'warn' } => {
    const p: Placement | undefined = conv?.proposal?.by_evidence[it.id];
    if (!p) {
      return it.role === 'none' || it.role === 'exploratory'
        ? { text: isAr ? 'ليس تفضيلًا — لا شيء على الخريطة' : 'not a preference — nothing on the map', tone: 'none' }
        : { text: isAr ? 'لم يُوضع على الخريطة' : 'not placed on the map', tone: 'warn' };
    }
    const names = p.element_ids.map((id) => {
      const d = districts[id];
      return d ? `${isAr ? d.name_ar : (d.name_en || d.name_ar)}${d.city ? ` (${d.city})` : ''}` : id;
    });
    if (!p.resolved) return { text: isAr ? `لم يُحدَّد حي حقيقي لـ «${names.join('، ')}» — يحتاج تأكيدًا` : `no real district picked for “${names.join(', ')}” — needs confirmation`, tone: 'warn' };
    const verb = p.polarity === 'exclude' ? (isAr ? 'استبعد' : 'excluded') : (isAr ? 'حدّد' : 'selected');
    // A zone (or any big district list) is summarised, not listed — 30+ names is noise.
    if (p.operation === 'zone_union' || (p.operation === 'district_union' && p.element_ids.length > 6)) {
      const n = p.element_ids.length;
      return { text: isAr ? `${verb}: ${p.label || 'منطقة'} — ${n} حيًا` : `${verb}: ${p.label || 'zone'} — ${n} districts`, tone: 'ok' };
    }
    if (p.operation === 'district_side_clip' && p.side) {
      const SIDE_AR: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب' };
      const roadId = p.element_ids[p.element_ids.length - 1]!;
      const road = districts[roadId];
      const roadName = road ? (isAr ? road.name_ar : (road.name_en || road.name_ar)) : roadId;
      const parts = (p.clip_parts ?? []).map((c) => c.kept
        ? `${c.name}${c.crossed && c.kept_km2 != null && c.total_km2 != null ? (isAr ? ` (${c.kept_km2} من ${c.total_km2} كم²)` : ` (${c.kept_km2} of ${c.total_km2} km²)`) : ''}`
        : `${c.name} ${isAr ? '(كله على الجهة الأخرى — أُسقط)' : '(entirely on the other side — dropped)'}`);
      const sideTxt = isAr ? `${SIDE_AR[p.side] ?? p.side} ${roadName}` : `${p.side} of ${roadName}`;
      return { text: `${verb}: ${parts.length ? parts.join(isAr ? '، ' : ', ') : names.join(', ')} — ${sideTxt}`, tone: 'ok' };
    }
    return { text: `${verb}: ${names.join(isAr ? '، ' : ', ')}`, tone: 'ok' };
  };

  return (
    <div className="mx-auto max-w-3xl p-4" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="mb-4 flex items-center gap-2">
        <MapPin className="text-copper" size={20} />
        <h1 className="text-lg font-bold text-charcoal">{isAr ? 'تقييم فهم الموقع — محادثة ثم خريطة' : 'Grade location understanding — chat, then map'}</h1>
      </div>
      <div className="mb-4">
        <div className="mb-1 flex justify-between text-xs font-semibold text-charcoal/50">
          <span>{isAr ? `${doneCount} من ${conversations.length} محادثة مكتملة` : `${doneCount} of ${conversations.length} conversations done`}</span>
          <span>{isAr ? `محادثة ${idx + 1}` : `Conversation ${idx + 1}`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sand/40">
          <div className="h-full rounded-full bg-copper transition-all" style={{ width: `${(doneCount / conversations.length) * 100}%` }} />
        </div>
      </div>

      {doneCount === conversations.length && idx >= conversations.length - 1 && conv && isConversationDone(conv, items) ? (
        <div className="card mb-4 flex flex-col items-center gap-2 p-5 text-center">
          <PartyPopper className="text-copper" size={28} />
          <p className="font-bold text-charcoal">{isAr ? 'خلصت كل المحادثات 🎉' : 'All conversations done 🎉'}</p>
          <Button variant="secondary" onClick={() => setIdx(0)}>{isAr ? 'مراجعة من البداية' : 'Review from the start'}</Button>
        </div>
      ) : null}

      {conv && (
        <div className="card p-5">
          {/* 1. The conversation */}
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-charcoal/40">
            {conv.channel === 'call' ? <Phone size={12} /> : <MessageCircle size={12} />}
            {conv.channel === 'call'
              ? (isAr ? `مكالمة هاتفية${conv.client ? `: ${conv.client}` : ''}` : `Phone call${conv.client ? `: ${conv.client}` : ''}`)
              : (isAr ? `محادثة واتساب${conv.client ? `: ${conv.client}` : ''}` : `WhatsApp chat${conv.client ? `: ${conv.client}` : ''}`)}
          </p>
          <p className="mb-1 text-xs text-charcoal/50">{isAr ? '١. المحادثة (اقرأها بنفسك):' : '1. The conversation (read it yourself):'}</p>
          <div className="mb-5 max-h-80 overflow-auto rounded-xl border border-sand/40 bg-cream/20 px-4 py-3" dir="rtl">
            {transcript.trim()
              ? (conv.channel === 'chat'
                ? <ChatBubbles text={transcript} mention={focused?.mention ?? ''} />
                : <div className="whitespace-pre-wrap text-sm leading-relaxed text-charcoal/80"><Transcript text={transcript} mention={focused?.mention ?? ''} /></div>)
              : <p className="text-center text-xs text-charcoal/40">{isAr ? 'لا يوجد نص محفوظ لهذه المحادثة.' : 'No saved text for this conversation.'}</p>}
          </div>

          {/* 2. What the AI understood, per mention */}
          <p className="mb-1 text-xs text-charcoal/50">{isAr ? '٢. ما فهمه الذكاء الاصطناعي (اضغط على العبارة لتمييزها في المحادثة):' : '2. What the AI understood (click a phrase to highlight it above):'}</p>
          <div className="mb-5 flex flex-col gap-2">
            {mentions.length === 0 && <p className="text-xs text-charcoal/40">{isAr ? 'لم يستخرج أي موقع من هذه المحادثة.' : 'No place was extracted from this conversation.'}</p>}
            {mentions.map((it) => {
              const pl = placementLine(it);
              return (
                <div key={it.id} className={`rounded-xl border px-3 py-2 ${focus === it.id ? 'border-copper bg-copper/5' : 'border-sand/40'}`}>
                  <button type="button" onClick={() => setFocus(focus === it.id ? null : it.id)} className="text-start text-base font-bold text-chocolate" dir="rtl">«{it.mention}»</button>
                  <p className="mt-0.5 text-sm text-charcoal"><Bold text={reading(it, isAr)} /></p>
                  <p className={`mt-0.5 text-xs ${pl.tone === 'ok' ? 'text-emerald-700' : pl.tone === 'warn' ? 'text-amber-700' : 'text-charcoal/40'}`}>
                    <MapIcon className="inline" size={11} /> {pl.text}
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <VerdictBtn active={it.my_verdict === 'right'} tone="ok" disabled={saving} onClick={() => void gradeMention(it, 'right')} icon={<Check size={14} />} label={isAr ? 'صحيح' : 'Right'} />
                    <VerdictBtn active={it.my_verdict === 'wrong'} tone="bad" disabled={saving} onClick={() => void gradeMention(it, 'wrong')} icon={<X size={14} />} label={isAr ? 'خطأ' : 'Wrong'} />
                    <VerdictBtn active={it.my_verdict === 'unsure'} tone="mid" disabled={saving} onClick={() => void gradeMention(it, 'unsure')} icon={<HelpCircle size={14} />} label={isAr ? 'غير واضح' : 'Not sure'} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 3. The map */}
          <p className="mb-1 text-xs text-charcoal/50">{isAr ? '٣. ما وضعه الذكاء الاصطناعي على الخريطة الفعلية:' : '3. What the AI selected on the actual map:'}</p>
          <GeoPrefMap items={conv.proposal?.items ?? []} isAr={isAr} />
          {conv.proposal && conv.proposal.items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {conv.proposal.items.map((li) => {
                const d = li.kind === 'district' && li.district_id ? districts[li.district_id] : undefined;
                const name = d ? `${isAr ? d.name_ar : (d.name_en || d.name_ar)}${d.city ? ` (${d.city})` : ''}` : (li.district_label || li.element_label || li.label || li.district_id || '');
                return <span key={li.id} className={`rounded-full px-2.5 py-0.5 text-xs ${li.polarity === 'exclude' ? 'bg-red-50 text-red-700' : 'bg-copper/15 text-chocolate'}`}>{li.polarity === 'exclude' ? '✕ ' : '✓ '}{name}</span>;
              })}
            </div>
          )}
          {conv.checkpoint_id ? (
            <>
              <p className="mb-1 mt-3 text-xs text-charcoal/50">{isAr ? 'هل الخريطة تطابق ما أراده العميل؟' : 'Does the map match what the customer wanted?'}</p>
              <div className="grid grid-cols-3 gap-2">
                <VerdictBtn big active={conv.map_verdict === 'right'} tone="ok" disabled={saving} onClick={() => void gradeMap('right')} icon={<Check size={20} />} label={isAr ? 'الخريطة صحيحة' : 'Map is right'} />
                <VerdictBtn big active={conv.map_verdict === 'wrong'} tone="bad" disabled={saving} onClick={() => void gradeMap('wrong')} icon={<X size={20} />} label={isAr ? 'الخريطة خطأ' : 'Map is wrong'} />
                <VerdictBtn big active={conv.map_verdict === 'unsure'} tone="mid" disabled={saving} onClick={() => void gradeMap('unsure')} icon={<HelpCircle size={20} />} label={isAr ? 'غير واضح' : 'Not sure'} />
              </div>
            </>
          ) : (
            <p className="mt-2 text-xs text-charcoal/40">{isAr ? 'لا توجد نقطة تقييم لهذه المحادثة (لم يُنتج اقتراح).' : 'No checkpoint for this conversation (no proposal was produced).'}</p>
          )}

          {/* Prev / Next */}
          <div className="mt-4 flex items-center justify-between">
            <button type="button" onClick={() => { setFocus(null); setIdx((i) => Math.max(i - 1, 0)); }} disabled={idx === 0}
              className="flex items-center gap-1 text-sm text-charcoal/50 disabled:opacity-30">
              {isAr ? <ChevronRight size={16} /> : <ChevronLeft size={16} />} {isAr ? 'السابقة' : 'Previous'}
            </button>
            {saving && <span className="flex items-center gap-1 text-xs text-charcoal/40"><Loader2 className="animate-spin" size={12} /> {isAr ? 'حفظ…' : 'saving…'}</span>}
            <button type="button" onClick={() => { setFocus(null); setIdx((i) => Math.min(i + 1, conversations.length - 1)); }} disabled={idx >= conversations.length - 1}
              className="flex items-center gap-1 text-sm text-charcoal/50 disabled:opacity-30">
              {isAr ? 'التالية' : 'Next'} {isAr ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function isConversationDone(c: ConversationView, items: Item[]): boolean {
  const mine = items.filter((i) => i.conversation_id === c.conversation_id);
  const mentionsDone = mine.every((i) => !!i.my_verdict);
  const mapDone = !c.checkpoint_id || !!c.map_verdict;
  return mentionsDone && mapDone;
}

function VerdictBtn({ active, tone, disabled, onClick, icon, label, big }: { active: boolean; tone: 'ok' | 'bad' | 'mid'; disabled: boolean; onClick: () => void; icon: React.ReactNode; label: string; big?: boolean }) {
  const on = tone === 'ok' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : tone === 'bad' ? 'border-red-500 bg-red-50 text-red-700' : 'border-amber-500 bg-amber-50 text-amber-700';
  const off = tone === 'ok' ? 'border-sand/50 text-charcoal/70 hover:border-emerald-400 hover:bg-emerald-50/50' : tone === 'bad' ? 'border-sand/50 text-charcoal/70 hover:border-red-400 hover:bg-red-50/50' : 'border-sand/50 text-charcoal/70 hover:border-amber-400 hover:bg-amber-50/50';
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={`flex items-center justify-center gap-1 rounded-xl border-2 font-bold transition ${big ? 'flex-col py-3 text-sm' : 'py-1.5 text-xs'} ${active ? on : off}`}>
      {icon} {label}
    </button>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[60vh] items-center justify-center p-6">{children}</div>;
}
