import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MessageCircle, Wallet, Home, BedDouble, MapPin, Loader2, CheckCircle2,
  Send, FileText, Phone, CalendarClock, Sparkles, ChevronLeft, Lock,
  AlertTriangle, Check, PlayCircle,
} from 'lucide-react';
import { ProgressRail } from './hireUi';
import {
  TASK_CLIENT, TASK_ENQUIRED, TASK_PREF_CHIPS, TASK_RECS, TASK_FOLLOWUP,
  TASK_SUMMARY, type TaskRec,
} from './hireTask';

type Phase = 'brief' | 'capture' | 'recommend' | 'send' | 'done';
const CHIP_ICON: Record<string, ReactNode> = {
  city: <MapPin size={14} />, type: <Home size={14} />,
  bedrooms: <BedDouble size={14} />, budget: <Wallet size={14} />,
};

/**
 * Stage 3 — the guided practical task (التجربة). A 3-step preset simulation:
 * record the customer's needs → choose an in-budget alternative → send it.
 * Phone-first, RTL, no real calls/messages/records.
 */
export default function HireTaskPage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const base = `/careers/experience/${token ?? 'preview'}`;

  const [phase, setPhase] = useState<Phase>('brief');
  const [recorded, setRecorded] = useState<string[]>([]);
  const [recId, setRecId] = useState<string | null>(null);
  const [recommending, setRecommending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir; const prevLang = html.lang;
    html.dir = 'rtl'; html.lang = 'ar';
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [phase]);

  // Entering "recommend" runs a brief preset match (not a live finder call).
  useEffect(() => {
    if (phase !== 'recommend') return;
    setRecommending(true);
    const t = setTimeout(() => setRecommending(false), 2000);
    return () => clearTimeout(t);
  }, [phase]);

  const chosen = TASK_RECS.find((r) => r.id === recId) ?? null;

  return (
    <div className="min-h-screen font-amiri" style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 60%, #E4D2B4 100%)', color: '#4A4E54' }}>
      <ProgressRail active={2} />
      <div className="mx-auto w-full max-w-md px-4 py-5">
        {/* persistent simulation label */}
        <div className="mb-4 flex items-center justify-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-copper/30 bg-white/70 px-3 py-1 text-xs font-bold text-copper">
            <Lock size={12} /> محاكاة تجريبية · لا يُرسَل شيء فعليًا
          </span>
        </div>

        {phase === 'brief' && <Brief onStart={() => setPhase('capture')} />}
        {phase === 'capture' && (
          <Capture
            recorded={recorded}
            toggle={(k) => setRecorded((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))}
            onNext={() => setPhase('recommend')}
          />
        )}
        {phase === 'recommend' && (
          <Recommend
            loading={recommending}
            recId={recId}
            onPick={setRecId}
            onNext={() => setPhase('send')}
          />
        )}
        {phase === 'send' && chosen && (
          <SendStep rec={chosen} sent={sent} onSend={() => setSent(true)} onNext={() => setPhase('done')} />
        )}
        {phase === 'done' && chosen && <Done onOffer={() => navigate(`${base}/offer`)} />}
      </div>
    </div>
  );
}

// ── Step dots (3 steps) ───────────────────────────────────────────────────────
function StepDots({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="mb-4 flex items-center justify-center gap-2">
      <span className="text-xs font-bold text-charcoal/50">الخطوة {toAr(step)} من ٣</span>
      <span className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span key={n} className="h-1.5 w-6 rounded-full" style={{ background: n <= step ? '#B8734F' : '#E4D2B4' }} />
        ))}
      </span>
    </div>
  );
}
const toAr = (n: number) => ['٠', '١', '٢', '٣'][n] ?? String(n);

// ── A · brief ─────────────────────────────────────────────────────────────────
function Brief({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-3xl border bg-white/85 p-7 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-copper/10 text-copper"><MessageCircle size={26} /></span>
      <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>دورك الآن</h1>
      <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
        عميل جديد تواصل معك على واتساب. جرّب كيف يساعدك وصل، وأنت تركّز على العميل.
      </p>
      <p className="mt-3 text-sm text-charcoal/55">٣ خطوات بسيطة، بدون كتابة تقريبًا.</p>
      <div className="mt-5 flex items-center justify-center gap-3 rounded-2xl bg-cream/50 p-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#25D366]/15 text-[#128C7E]"><MessageCircle size={18} /></span>
        <div className="text-start">
          <div className="text-sm font-bold text-charcoal">{TASK_CLIENT.name}</div>
          <div className="text-xs text-charcoal/50">عميل جديد</div>
        </div>
      </div>
      <button type="button" onClick={onStart} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-lg font-bold text-white shadow-lg" style={{ minHeight: 52 }}>
        ابدأ
      </button>
    </div>
  );
}

// ── B · capture (step 1) — customer message pinned + record needs ─────────────
function Capture({ recorded, toggle, onNext }: { recorded: string[]; toggle: (k: string) => void; onNext: () => void }) {
  const all = TASK_PREF_CHIPS.every((c) => recorded.includes(c.key));
  return (
    <div>
      <StepDots step={1} />
      {/* pinned customer request — stays visible while recording */}
      <div className="sticky top-14 z-10 mb-3 rounded-2xl border border-sand/40 bg-[#EDE0CC] p-3 shadow-sm">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-bold text-charcoal/60">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#25D366]/20 text-[#128C7E]"><MessageCircle size={13} /></span>
          {TASK_CLIENT.name} · واتساب
        </div>
        <div className="rounded-xl rounded-tr-sm bg-white px-3 py-2 text-sm leading-relaxed text-charcoal">{TASK_CLIENT.message}</div>
      </div>

      {/* enquired project — over budget */}
      <div className="mb-4 overflow-hidden rounded-2xl border border-sand/40 bg-white shadow-sm">
        <div className="relative h-28 w-full">
          <img src={TASK_ENQUIRED.url} alt={TASK_ENQUIRED.name} className="h-full w-full object-cover" />
          <span className="absolute bottom-2 start-2 inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white">
            <AlertTriangle size={11} /> {TASK_ENQUIRED.overBudgetNote}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 p-3">
          <div>
            <div className="text-base font-bold text-charcoal">{TASK_ENQUIRED.name}</div>
            <div className="text-xs text-charcoal/55">{TASK_ENQUIRED.type} · {TASK_ENQUIRED.bedrooms}</div>
          </div>
          <div className="text-sm font-semibold text-red-600">{TASK_ENQUIRED.price}</div>
        </div>
      </div>

      <h2 className="mb-1 text-lg font-bold text-chocolate">سجّل ما يريده العميل</h2>
      <p className="mb-3 text-sm text-charcoal/60">اضغط على ما ذكره في رسالته ليُحفظ في ملفه.</p>

      <div className="flex flex-wrap gap-2">
        {TASK_PREF_CHIPS.map((c) => {
          const on = recorded.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border-2 px-3.5 text-sm font-semibold transition-colors ${on ? 'border-copper bg-copper/10 text-copper' : 'border-sand/60 bg-white text-charcoal/75'}`}
              style={{ minHeight: 44 }}
            >
              {on ? <CheckCircle2 size={15} /> : <span className="text-copper">{CHIP_ICON[c.key]}</span>}
              {c.value}
            </button>
          );
        })}
      </div>

      {/* client file */}
      <div className="mt-4 rounded-2xl border border-sand/40 bg-white p-3.5 shadow-sm">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-copper">ملف العميل</div>
        {recorded.length === 0 ? (
          <div className="text-sm text-charcoal/40">لم تُسجَّل تفضيلات بعد.</div>
        ) : (
          <div className="space-y-1.5">
            {TASK_PREF_CHIPS.filter((c) => recorded.includes(c.key)).map((c) => (
              <div key={c.key} className="flex items-center justify-between border-b border-sand/30 py-1 text-sm last:border-0">
                <span className="text-charcoal/50">{c.label}</span>
                <span className="font-semibold text-charcoal">{c.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!all}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-base font-bold text-white shadow-lg disabled:opacity-40"
        style={{ minHeight: 52 }}
      >
        حفظ ومتابعة <ChevronLeft size={18} />
      </button>
      {!all && <p className="mt-2 text-center text-xs text-charcoal/50">سجّل كل ما ذكره العميل للمتابعة.</p>}
    </div>
  );
}

// ── C · recommend (step 2) ────────────────────────────────────────────────────
function Recommend({ loading, recId, onPick, onNext }: { loading: boolean; recId: string | null; onPick: (id: string) => void; onNext: () => void }) {
  return (
    <div>
      <StepDots step={2} />
      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border bg-white/85 py-16 text-center shadow-xl" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <Loader2 size={32} className="animate-spin text-copper" />
          <div className="text-base font-bold text-chocolate">وصل يطابق تفضيلات العميل…</div>
          <div className="text-sm text-charcoal/55">فيلا · ٤–٥ غرف · حتى 2.2 مليون · شمال الرياض</div>
        </div>
      ) : (
        <>
          <div className="mb-3 rounded-2xl border border-green-200 bg-green-50 p-3 text-sm leading-relaxed text-green-800">
            فلل رِفان تجاوز ميزانية العميل — لكن وصل وجد لك بديلين مناسبين ضمن الميزانية 👇
          </div>
          <h2 className="mb-3 text-lg font-bold text-chocolate">اختر المشروع الأنسب لعميلك</h2>
          <div className="space-y-3">
            {TASK_RECS.map((r) => <RecCard key={r.id} r={r} on={recId === r.id} onPick={() => onPick(r.id)} />)}
          </div>
          <button
            type="button"
            onClick={onNext}
            disabled={!recId}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-base font-bold text-white shadow-lg disabled:opacity-40"
            style={{ minHeight: 52 }}
          >
            متابعة <ChevronLeft size={18} />
          </button>
          {!recId && <p className="mt-2 text-center text-xs text-charcoal/50">اختر أحد المشروعين للمتابعة.</p>}
        </>
      )}
    </div>
  );
}

function RecCard({ r, on, onPick }: { r: TaskRec; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full overflow-hidden rounded-2xl border-2 bg-white text-start shadow-sm transition-colors ${on ? 'border-copper ring-2 ring-copper/30' : 'border-sand/40'}`}
    >
      <div className="relative h-32 w-full">
        <img src={r.url} alt={r.name} className="h-full w-full object-cover" />
        <span className="absolute top-2 end-2 rounded-full bg-green-600 px-2.5 py-0.5 text-[11px] font-bold text-white">ضمن الميزانية</span>
        {on && <span className="absolute bottom-2 start-2 inline-flex items-center gap-1 rounded-full bg-copper px-2.5 py-0.5 text-[11px] font-bold text-white"><CheckCircle2 size={12} /> مختار</span>}
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-base font-bold text-charcoal">{r.name}</span>
          <span className="text-sm font-semibold text-copper">{r.price}</span>
        </div>
        <div className="mt-0.5 text-xs text-charcoal/55">{r.type} · {r.bedrooms}</div>
        <p className="mt-1.5 text-sm leading-relaxed text-charcoal/70">{r.reason}</p>
      </div>
    </button>
  );
}

// ── D · send (step 3) ─────────────────────────────────────────────────────────
function SendStep({ rec, sent, onSend, onNext }: { rec: TaskRec; sent: boolean; onSend: () => void; onNext: () => void }) {
  return (
    <div>
      <StepDots step={3} />
      <h2 className="mb-1 text-lg font-bold text-chocolate">أرسل العرض للعميل</h2>
      <p className="mb-3 text-sm text-charcoal/60">الرسالة جاهزة ومُدقّقة — ما عليك إلا الإرسال.</p>

      <div className="rounded-2xl p-3" style={{ background: '#EDE0CC' }}>
        <div className="flex justify-end">
          <div className="max-w-[90%] overflow-hidden rounded-2xl rounded-br-md bg-[#D9FDD3] shadow-sm">
            <div className="flex items-center gap-1.5 border-b border-black/5 bg-white/50 px-3 py-1.5 text-[11px] font-semibold text-green-700">
              <Sparkles size={12} className="text-copper" /> رسالة مشروع جاهزة
            </div>
            <img src={rec.url} alt={rec.name} className="h-28 w-full object-cover" />
            <div className="px-3 py-2">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-charcoal">{rec.message}</p>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-charcoal/80">
                <FileText size={13} className="text-copper" /> بروشور المشروع (PDF)
              </span>
            </div>
            {sent && <div className="flex items-center justify-end gap-1 px-3 pb-1.5 text-[10px] text-charcoal/50">تم الإرسال <Check size={12} className="text-[#25D366]" /></div>}
          </div>
        </div>
      </div>

      {sent ? (
        <>
          <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-green-50 px-3 py-3 text-sm font-bold text-green-700">
            <CheckCircle2 size={18} /> تم إرسال العرض إلى {TASK_CLIENT.name}
          </div>
          <button type="button" onClick={onNext} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-base font-bold text-white shadow-lg" style={{ minHeight: 52 }}>
            التالي <ChevronLeft size={18} />
          </button>
        </>
      ) : (
        <button type="button" onClick={onSend} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-6 text-base font-bold text-white shadow-lg" style={{ minHeight: 52 }}>
          <Send size={18} /> إرسال عبر واتساب
        </button>
      )}
    </div>
  );
}

// ── E · done ──────────────────────────────────────────────────────────────────
function Done({ onOffer }: { onOffer: () => void }) {
  return (
    <div>
      <div className="rounded-3xl border bg-white/90 p-6 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#10B98118' }}><CheckCircle2 size={38} style={{ color: '#10B981' }} /></span>
        <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>أحسنت</h1>
        <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
          المشروع الأول تجاوز ميزانية العميل، لكنك قدّمت له خيارًا مناسبًا فورًا — دون أن تحفظ باقي المشاريع.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {['سجّلت الاحتياج', 'رشّح وصل بديلًا مناسبًا', 'أرسلت العرض'].map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2.5 py-1 text-xs font-semibold text-copper"><CheckCircle2 size={12} /> {t}</span>
          ))}
        </div>
      </div>

      {/* passive payoff — the system already organized the next step */}
      <p className="mt-5 text-center text-sm font-semibold text-charcoal/60">وجهّز لك وصل الخطوة التالية تلقائيًا</p>
      <div className="mt-2 overflow-hidden rounded-2xl border border-sand/40 bg-white p-4 shadow-sm" style={{ borderInlineStartWidth: 5, borderInlineStartColor: '#25D366' }}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-base font-bold text-chocolate">{TASK_CLIENT.name}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2.5 py-1 text-[11px] font-bold text-[#0f7a52]"><CalendarClock size={12} /> مجدولة تلقائيًا</span>
        </div>
        <div className="mt-1.5 text-sm font-bold text-copper">{TASK_FOLLOWUP.type}</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-charcoal/60">الموعد: {TASK_FOLLOWUP.scheduled}</span>
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-copper px-4 text-sm font-bold text-white" style={{ minHeight: 40 }}><Phone size={14} /> اتصال</span>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-sand/40 bg-cream/40 p-4">
        <div className="mb-2 flex items-center gap-2"><Sparkles size={15} className="text-copper" /><span className="text-sm font-bold text-chocolate">ملخّص العميل</span></div>
        <ul className="list-disc space-y-1 ps-5 text-sm leading-relaxed text-charcoal/85 marker:text-copper">
          {TASK_SUMMARY.map((s) => <li key={s}>{s}</li>)}
        </ul>
      </div>

      <button type="button" onClick={onOffer} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 text-lg font-bold text-white shadow-xl" style={{ background: '#B8734F', minHeight: 56 }}>
        <PlayCircle size={20} /> التالي: العرض <ChevronLeft size={20} />
      </button>
    </div>
  );
}
