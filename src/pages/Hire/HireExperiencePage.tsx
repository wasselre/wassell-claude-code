import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayCircle, ChevronLeft, Lock, CheckCircle2, User, Phone, Loader2 } from 'lucide-react';
import { ProgressRail, JourneyStep, FlowConnector, Reveal } from './hireUi';
import OpeningSummary from './OpeningSummary';
import { resolveInvite, postExperience, type InviteInfo } from '@/lib/careers/experience';
import StepPreferences from './steps/StepPreferences';
import StepRecommendations from './steps/StepRecommendations';
import StepProjectDetail from './steps/StepProjectDetail';
import StepWhatsApp from './steps/StepWhatsApp';
import StepUnits from './steps/StepUnits';
import StepTask from './steps/StepTask';
import StepSummary from './steps/StepSummary';

// Seven steps in one continuous customer journey. `after` is the causal bridge
// shown between this step and the next (the last has none).
const STEPS: { title: string; blurb: string; Body: () => JSX.Element; after?: string }[] = [
  { title: 'استمع إلى العميل وسجّل احتياجاته', blurb: 'يكتب الموظف تفضيلات العميل مباشرة أثناء المكالمة — بلا حفظ في الذهن.', Body: StepPreferences, after: 'حُفظت التفضيلات — يبدأ وصل بالمطابقة' },
  { title: 'وصل يرشّح المشاريع المناسبة', blurb: 'يطابقها وصل مع كل المشاريع ويعرض الأنسب خلال ثوانٍ.', Body: StepRecommendations, after: 'اختار الموظف مشروع «واحة النرجس»' },
  { title: 'راجع المشروع أثناء المكالمة', blurb: 'كل تفاصيل المشروع وصوره جاهزة أمامه أثناء الحديث.', Body: StepProjectDetail, after: 'يرسل تفاصيل المشروع للعميل' },
  { title: 'أرسل معلومات المشروع مباشرة', blurb: 'رسالة المشروع وصوره تُرسل عبر واتساب بضغطة — مُدقّقة الأرقام.', Body: StepWhatsApp, after: 'العميل سأل عن الوحدات المتاحة' },
  { title: 'اختر الوحدة المناسبة', blurb: 'يختار الموظف الوحدة الأنسب ويرسل تفاصيلها ومخططها.', Body: StepUnits, after: 'انتهت المكالمة' },
  { title: 'أنهِ المكالمة وسجّل النتيجة', blurb: 'يسجّل النتيجة، فينشئ وصل مهمة المتابعة التالية تلقائيًا.', Body: StepTask, after: 'قبل الاتصال التالي' },
  { title: 'افتح مهامك وابدأ التواصل', blurb: 'قبل كل اتصال، يقرأ وصل السجل كاملًا ويعرض ملخصًا جاهزًا.', Body: StepSummary },
];

export default function HireExperiencePage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const [phase, setPhase] = useState<'loading' | 'confirm' | 'ready'>('loading');
  const [invite, setInvite] = useState<InviteInfo | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir;
    const prevLang = html.lang;
    html.dir = 'rtl';
    html.lang = 'ar';
    window.scrollTo({ top: 0 });
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  // Resolve the per-candidate token → name/phone for the confirm gate. Unknown /
  // preview tokens resolve to null → a labelled demo confirm (never a dead page).
  useEffect(() => {
    let alive = true;
    void resolveInvite(token ?? '').then((info) => {
      if (!alive) return;
      setInvite(info);
      setPhase('confirm');
    });
    return () => { alive = false; };
  }, [token]);

  const goToVideo = () => navigate(`/careers/experience/${token ?? 'preview'}/video`);

  if (phase !== 'ready') {
    return (
      <ConfirmGate
        invite={invite}
        loading={phase === 'loading'}
        onConfirm={() => { void postExperience(token ?? '', 'confirm'); setPhase('ready'); }}
      />
    );
  }

  return (
    <div
      className="min-h-screen font-amiri"
      style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 60%, #E4D2B4 100%)', color: '#4A4E54' }}
    >
      <style>{`
        @keyframes hire-bar { from { width: 0 } to { width: 100% } }
        @keyframes hire-up { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes hire-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes hire-pop { 0% { opacity: 0; transform: scale(.94) } 60% { transform: scale(1.02) } 100% { opacity: 1; transform: scale(1) } }
        .hire-reveal { animation: hire-up .6s cubic-bezier(.22,.61,.36,1) both; }
        .hire-fade { animation: hire-fade .5s ease both; }
        .hire-pop { animation: hire-pop .5s cubic-bezier(.22,.61,.36,1) both; }
      `}</style>

      <ProgressRail active={0} />

      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
        {/* Header */}
        <header className="mb-8 flex flex-col items-center text-center">
          <img src="/assets/wassel-logo.png" alt="وصل العقارية" className="h-16 sm:h-20" />
          <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-copper/30 bg-white/70 px-3 py-1 text-xs font-bold text-copper">
            <Lock size={12} /> تجربة خاصة بالمرشّحين
          </span>
        </header>

        {/* Opening value summary — the "why" before any product screen */}
        <OpeningSummary />

        {/* The seven steps as one connected journey (the evidence) */}
        <div id="hire-workflow" className="mt-14 scroll-mt-20">
          <Reveal>
            <p className="mb-2 text-center text-sm font-bold uppercase tracking-wider text-copper">رحلة عميل واحدة داخل وصل</p>
          </Reveal>
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <Reveal>
                <JourneyStep n={i + 1} title={s.title} blurb={s.blurb} last={i === STEPS.length - 1}>
                  <s.Body />
                </JourneyStep>
              </Reveal>
              {s.after && (
                <Reveal>
                  <FlowConnector>{s.after}</FlowConnector>
                </Reveal>
              )}
            </div>
          ))}
        </div>

        {/* Closing statement */}
        <Reveal>
          <div className="mt-12 rounded-3xl border bg-chocolate p-8 text-center shadow-xl sm:p-10" style={{ borderColor: 'rgba(212,184,150,0.4)' }}>
            <p className="mx-auto max-w-2xl text-lg leading-loose text-cream sm:text-2xl">
              عملك هو التواصل مع العملاء وبناء الثقة ومساعدتهم على القرار.
              وصل يجهّز لك المعلومات والترشيحات وسجلّ العميل ومهام المتابعة.
            </p>
          </div>
        </Reveal>

        {/* Dominant transition to the video stage */}
        <Reveal>
          <div className="mt-10 overflow-hidden rounded-3xl border bg-white shadow-2xl" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
            {/* video thumbnail */}
            <button
              type="button"
              onClick={goToVideo}
              aria-label="شاهد طريقة العمل"
              className="group relative block h-56 w-full sm:h-72"
              style={{ background: 'linear-gradient(135deg,#4A2C2A 0%,#8E4E3A 60%,#B8734F 100%)' }}
            >
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/90 shadow-2xl transition-transform group-hover:scale-110 sm:h-24 sm:w-24">
                  <PlayCircle size={52} className="text-copper" />
                </span>
              </span>
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/40 to-transparent p-5 text-center">
                <span className="text-lg font-bold text-white sm:text-xl">شاهد العملية كاملة داخل وصل</span>
              </span>
            </button>

            <div className="p-7 text-center sm:p-9">
              <p className="mx-auto max-w-2xl text-base leading-loose text-charcoal sm:text-lg">
                في الفيديو التالي ستشاهد هذه الخطوات كاملة من بداية المكالمة حتى المتابعة.
                وبعده ستنفّذ تجربة قصيرة مشابهة بنفسك.
              </p>
              <button
                type="button"
                onClick={goToVideo}
                className="mx-auto mt-6 inline-flex items-center gap-3 rounded-2xl px-9 py-5 text-xl font-bold text-white shadow-xl transition-transform hover:scale-[1.03]"
                style={{ background: '#B8734F' }}
              >
                <PlayCircle size={26} /> شاهد طريقة العمل
                <ChevronLeft size={22} />
              </button>
            </div>
          </div>
        </Reveal>

        <footer className="mt-12 text-center text-xs" style={{ color: '#A79B86' }}>
          وصل العقارية · الرياض
        </footer>
      </div>
    </div>
  );
}

// ── Confirm gate — the candidate verifies their name/phone before starting ────
function ConfirmGate({ invite, loading, onConfirm }: { invite: InviteInfo | null; loading: boolean; onConfirm: () => void }) {
  const [badData, setBadData] = useState(false);
  const demo = !invite;
  return (
    <div className="min-h-screen font-amiri" style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 60%, #E4D2B4 100%)', color: '#4A4E54' }}>
      <ProgressRail active={0} />
      <div className="mx-auto flex min-h-[80vh] w-full max-w-md items-center px-4 py-8">
        <div className="w-full">
          <div className="mb-6 flex flex-col items-center text-center">
            <img src="/assets/wassel-logo.png" alt="وصل العقارية" className="h-14 sm:h-16" />
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-copper/30 bg-white/70 px-3 py-1 text-xs font-bold text-copper">
              <Lock size={12} /> تجربة خاصة بالمرشّحين
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-3xl border bg-white/85 p-10 text-charcoal/60 shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
              <Loader2 size={20} className="animate-spin text-copper" /> جارٍ فتح تجربتك…
            </div>
          ) : (
            <div className="rounded-3xl border bg-white/85 p-7 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-copper/10 text-copper"><User size={26} /></span>
              <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>أهلًا {invite?.name || 'وسهلًا'} 👋</h1>

              {demo ? (
                <>
                  <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
                    هذه معاينة داخلية للتجربة. في الرابط الحقيقي سيظهر اسم المرشّح ورقم جواله للتأكيد.
                  </p>
                  <span className="mt-3 inline-block rounded-full bg-sand/40 px-3 py-1 text-xs font-bold text-charcoal/60">وضع المعاينة</span>
                </>
              ) : (
                <>
                  <p className="mx-auto mt-3 max-w-sm text-base leading-relaxed" style={{ color: '#4A4E54' }}>
                    قبل أن نبدأ، أكّد لنا بياناتك:
                  </p>
                  <div className="mt-4 space-y-2 rounded-2xl bg-cream/50 p-4 text-start">
                    <div className="flex items-center justify-between gap-3 border-b border-sand/30 py-1.5">
                      <span className="inline-flex items-center gap-1.5 text-sm text-charcoal/55"><User size={14} className="text-copper" /> الاسم</span>
                      <span className="font-bold text-charcoal">{invite?.name}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-1.5">
                      <span className="inline-flex items-center gap-1.5 text-sm text-charcoal/55"><Phone size={14} className="text-copper" /> رقم الجوال</span>
                      <span className="font-bold text-charcoal" dir="ltr">{invite?.phone}</span>
                    </div>
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={onConfirm}
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-lg font-bold text-white shadow-lg transition-transform hover:scale-[1.01]"
                style={{ minHeight: 54 }}
              >
                <CheckCircle2 size={20} /> {demo ? 'ابدأ المعاينة' : 'نعم، هذه بياناتي — ابدأ'}
              </button>

              {!demo && (
                <>
                  <button type="button" onClick={() => setBadData(true)} className="mt-3 text-sm font-semibold text-charcoal/55 underline-offset-2 hover:underline">
                    بياناتي غير صحيحة
                  </button>
                  {badData && (
                    <p className="mt-2 text-sm leading-relaxed text-terracotta">
                      لا مشكلة — تواصل معنا على نفس الرقم الذي وصلك منه الرابط وسنصحّح بياناتك.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
