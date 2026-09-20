import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { CalendarCheck, CheckCircle2, Loader2, Send, Wallet, Percent, HelpCircle, ChevronRight } from 'lucide-react';
import { ProgressRail } from './hireUi';
import { postExperience } from '@/lib/careers/experience';

/**
 * Stage 5 — the decision (القرار).
 *   /book     → interested; records `offer_accepted` + "we'll be in touch".
 *   /decline  → a 2-step questionnaire: why? (salary / commission / other) then a
 *               follow-up (desired salary, desired commission, or free text) →
 *               `offer_rejected` + category + reason.
 * Best-effort writes: in preview / no-token the flow still completes.
 */
export default function HireDecisionPage() {
  const { token } = useParams();
  const declined = useLocation().pathname.endsWith('/decline');

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir; const prevLang = html.lang;
    html.dir = 'rtl'; html.lang = 'ar';
    window.scrollTo({ top: 0 });
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  return (
    <div className="min-h-screen font-amiri" style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 55%, #E4D2B4 100%)', color: '#4A4E54' }}>
      <ProgressRail active={4} />
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-8">
        {declined ? <Decline token={token} /> : <Interested token={token} />}
      </div>
    </div>
  );
}

function Interested({ token }: { token?: string }) {
  useEffect(() => { void postExperience(token ?? '', 'interested'); }, [token]);
  return (
    <div className="w-full rounded-3xl border bg-white/90 p-8 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#10B98118' }}>
        <CalendarCheck size={38} style={{ color: '#10B981' }} />
      </span>
      <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>شكرًا لاهتمامك!</h1>
      <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
        سجّلنا رغبتك في المقابلة. سنتواصل معك قريبًا لتحديد موعد زيارتك لمكتبنا في الرياض — حي النزهة.
      </p>
      <p className="mt-4 text-sm text-charcoal/50">يمكنك إغلاق هذه الصفحة الآن.</p>
    </div>
  );
}

type Category = 'salary' | 'commission' | 'other';

function Decline({ token }: { token?: string }) {
  const [step, setStep] = useState<'q1' | 'q2' | 'sending' | 'done'>('q1');
  const [category, setCategory] = useState<Category | null>(null);
  const [answer, setAnswer] = useState('');

  const pick = (c: Category) => { setCategory(c); setAnswer(''); setStep('q2'); };

  const submit = async () => {
    setStep('sending');
    await postExperience(token ?? '', 'declined', { reason: answer.trim() || undefined, category: category ?? undefined });
    setStep('done');
  };

  if (step === 'done') {
    return (
      <div className="w-full rounded-3xl border bg-white/90 p-8 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#B8734F18' }}>
          <CheckCircle2 size={38} className="text-copper" />
        </span>
        <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>شكرًا لوقتك</h1>
        <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
          شكرًا لاطّلاعك على العرض ومشاركتنا رأيك. نقدّر وقتك ونتمنى لك التوفيق.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-3xl border bg-white/90 p-7 shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      {step === 'q1' ? (
        <>
          <h1 className="text-center text-2xl font-bold" style={{ color: '#4A2C2A' }}>العرض غير مناسب لي</h1>
          <p className="mx-auto mt-2 max-w-sm text-center text-base leading-relaxed" style={{ color: '#4A4E54' }}>
            نودّ أن نتحسّن — ما سبب عدم اهتمامك؟
          </p>
          <div className="mt-5 space-y-2.5">
            <OptionBtn icon={<Wallet size={18} />} label="الراتب" onClick={() => pick('salary')} />
            <OptionBtn icon={<Percent size={18} />} label="العمولة" onClick={() => pick('commission')} />
            <OptionBtn icon={<HelpCircle size={18} />} label="سبب آخر" onClick={() => pick('other')} />
          </div>
        </>
      ) : (
        <>
          <button type="button" onClick={() => setStep('q1')} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-charcoal/55 hover:text-copper">
            <ChevronRight size={16} /> رجوع
          </button>
          <h1 className="text-center text-xl font-bold sm:text-2xl" style={{ color: '#4A2C2A' }}>
            {category === 'salary' && 'ما الراتب الشهري الذي تراه مناسبًا لك؟'}
            {category === 'commission' && 'ما نسبة العمولة المناسبة لك؟'}
            {category === 'other' && 'إذا لم يكن بسبب الوظيفة، فما سبب اعتذارك؟'}
          </h1>

          {category === 'salary' && (
            <div className="relative mt-4">
              <input
                value={answer} onChange={(e) => setAnswer(e.target.value)}
                inputMode="numeric" dir="ltr" placeholder="مثال: 8000"
                className="form-input w-full text-center text-lg"
                style={{ paddingInlineEnd: '3.5rem' }}
              />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-charcoal/50">ريال</span>
            </div>
          )}
          {category === 'commission' && (
            <input
              value={answer} onChange={(e) => setAnswer(e.target.value)}
              dir="ltr" placeholder="مثال: 20%"
              className="form-input mt-4 w-full text-center text-lg"
            />
          )}
          {category === 'other' && (
            <textarea
              value={answer} onChange={(e) => setAnswer(e.target.value)}
              rows={4} placeholder="أخبرنا بالسبب…"
              className="form-input mt-4 w-full resize-none text-base"
            />
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={step === 'sending'}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-base font-bold text-white shadow-lg disabled:opacity-50"
            style={{ minHeight: 52 }}
          >
            {step === 'sending' ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />} إرسال
          </button>
        </>
      )}
    </div>
  );
}

function OptionBtn({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border-2 border-sand/60 bg-white px-4 text-start font-bold text-charcoal transition-colors hover:border-copper hover:bg-copper/5"
      style={{ minHeight: 56 }}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-copper/10 text-copper">{icon}</span>
      <span className="flex-1">{label}</span>
      <ChevronRight size={18} className="rotate-180 text-charcoal/30" />
    </button>
  );
}
