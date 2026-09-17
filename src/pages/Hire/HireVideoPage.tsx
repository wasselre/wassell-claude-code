import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { ProgressRail } from './hireUi';

/**
 * Stage 2 of the recruitment experience — the walkthrough video.
 *
 * Plays the intro recording (hosted in Supabase Storage, public `hire-assets`
 * bucket — kept out of the git repo so it doesn't bloat it), then hands off to
 * the (not-yet-built) practical-task stage. Fully Arabic/RTL, no auth.
 */
const VIDEO_URL = 'https://zhqqsxwealdwqzrbpwyv.supabase.co/storage/v1/object/public/hire-assets/system-intro.mp4';
export default function HireVideoPage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const base = `/careers/experience/${token ?? 'preview'}`;

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir;
    const prevLang = html.lang;
    html.dir = 'rtl';
    html.lang = 'ar';
    window.scrollTo({ top: 0 });
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  return (
    <div
      className="min-h-screen font-amiri"
      style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 60%, #E4D2B4 100%)', color: '#4A4E54' }}
    >
      <ProgressRail active={1} />

      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:py-12">
        <header className="mb-8 flex flex-col items-center text-center">
          <img src="/assets/wassel-logo.png" alt="وصل العقارية" className="h-14 sm:h-16" />
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-copper/30 bg-white/70 px-3 py-1 text-xs font-bold text-copper">
            <Lock size={12} /> تجربة خاصة بالمرشّحين
          </span>
        </header>

        <div className="text-center">
          <h1 className="text-3xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>شاهد طريقة العمل داخل وصل</h1>
          <p className="mx-auto mt-3 max-w-2xl text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
            في هذا الفيديو ستشاهد رحلة عميل كاملة داخل وصل — من أول مكالمة وحتى المتابعة التالية.
          </p>
        </div>

        {/* video */}
        <div className="mt-7 overflow-hidden rounded-3xl border bg-black shadow-2xl" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <video
            className="h-auto w-full"
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload"
          >
            <source src={VIDEO_URL} type="video/mp4" />
            متصفحك لا يدعم تشغيل الفيديو.
          </video>
        </div>

        <p className="mx-auto mt-6 max-w-2xl text-center text-base leading-loose" style={{ color: '#4A4E54' }}>
          بعد الفيديو، ستنفّذ تجربة قصيرة مشابهة بنفسك.
        </p>

        {/* nav */}
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => navigate(base)}
            className="inline-flex items-center gap-2 rounded-2xl border bg-white px-6 py-3.5 text-sm font-bold shadow-sm"
            style={{ borderColor: 'rgba(212,184,150,0.6)', color: '#4A4E54' }}
          >
            <ChevronRight size={18} /> العودة إلى الشرح
          </button>
          <button
            type="button"
            onClick={() => navigate(`${base}/task`)}
            className="inline-flex items-center gap-2.5 rounded-2xl px-8 py-4 text-lg font-bold text-white shadow-xl transition-transform hover:scale-[1.02]"
            style={{ background: '#B8734F' }}
          >
            ابدأ التجربة العملية <ChevronLeft size={20} />
          </button>
        </div>

        <footer className="mt-12 text-center text-xs" style={{ color: '#A79B86' }}>
          وصل العقارية · الرياض
        </footer>
      </div>
    </div>
  );
}
