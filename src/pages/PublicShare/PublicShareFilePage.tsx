import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, AlertTriangle, Download, ExternalLink, Loader2, Lock, Unlock } from 'lucide-react';
import { fetchSharedFile, fetchSharedFileDownload } from '@/lib/files/client';
import type { SharedFileResponse } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindIcon, kindLabel } from '@/lib/files/format';

/**
 * /share/:token — the external customer's view of a Wassel-shared file.
 *
 * Design language is lifted from app.wassel.re / index.html (the public
 * Wassel website): editorial dark hero with Najdi-arch silhouette, copper
 * crenellated edge, Amiri serif headlines + Tajawal body, Sadu ribbon
 * dividers, KSA pattern overlay, italic copper accents. The point is that
 * a customer who opens this link recognises it as the same Wassel they see
 * on the public website — same air, same craft.
 *
 * No AppLayout wrapper — the page paints its own full-bleed canvas.
 */
export default function PublicShareFilePage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');

  type Phase = 'loading' | 'password' | 'ready' | 'not-found';
  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<SharedFileResponse | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submittingPassword, setSubmittingPassword] = useState(false);

  // Force-fonts + RTL on <html> so the page is self-contained even outside AppLayout.
  useEffect(() => {
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
    document.documentElement.lang = isAr ? 'ar' : 'en';
  }, [isAr]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setPhase('loading');
    fetchSharedFile(token)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setPhase(res.requires_password ? 'password' : 'ready');
      })
      .catch(() => {
        if (!cancelled) setPhase('not-found');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submitPassword = async () => {
    if (!token) return;
    setSubmittingPassword(true);
    setPasswordError(null);
    try {
      const res = await fetchSharedFile(token, password);
      if (res.requires_password) {
        setPasswordError(t('files.share.password_wrong'));
      } else {
        setData(res);
        setPhase('ready');
      }
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingPassword(false);
    }
  };

  const onDownload = async () => {
    if (!token) return;
    try {
      const { url } = await fetchSharedFileDownload(token, data?.requires_password ? password : undefined);
      window.location.href = url;
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F0E3] text-[#3C2A20]" style={{ fontFamily: '"Tajawal", "Inter", sans-serif' }}>
      <ShareStyles />
      <BrandHeader />

      <main className="flex-1 relative overflow-hidden">
        <SubtleBackdrop />
        <div className="relative z-10 max-w-6xl w-full mx-auto px-6 py-10 lg:py-14 flex items-center justify-center">
          {phase === 'loading' && <LoadingState />}
          {phase === 'not-found' && <NotFoundState />}
          {phase === 'password' && (
            <PasswordGate
              password={password}
              error={passwordError}
              submitting={submittingPassword}
              onChange={setPassword}
              onSubmit={submitPassword}
            />
          )}
          {phase === 'ready' && data && data.url && (
            <ReadyState data={data} onDownload={onDownload} isAr={isAr} />
          )}
        </div>
      </main>

      <BrandFooter />
    </div>
  );
}

// ─── Shared CSS injection ─────────────────────────────────────────────
// Patterns + ribbons are direct ports of the public website (index.html).
// Inlined here so the share page is self-contained — no Tailwind config
// touch needed and no risk of bundle drift between the two surfaces.

function ShareStyles() {
  return (
    <style>{`
      .share-amiri { font-family: 'Amiri', 'Tajawal', serif; }
      .share-tajawal { font-family: 'Tajawal', 'Inter', sans-serif; }

      /* KSA pattern — subtle dot + diagonal weave behind the page body. */
      .share-ksa-pattern {
        background-image:
          radial-gradient(circle at 50% 50%, rgba(184, 117, 67, 0.10) 1px, transparent 1.6px),
          linear-gradient(45deg, transparent 48%, rgba(184, 117, 67, 0.05) 48%, rgba(184, 117, 67, 0.05) 52%, transparent 52%),
          linear-gradient(-45deg, transparent 48%, rgba(184, 117, 67, 0.05) 48%, rgba(184, 117, 67, 0.05) 52%, transparent 52%);
        background-size: 24px 24px, 48px 48px, 48px 48px;
      }

      /* Editorial dark hero band — matches the public website's hero gradient. */
      .share-hero-dark {
        background:
          radial-gradient(ellipse 120% 80% at 50% 100%, rgba(184, 117, 67, 0.42) 0%, transparent 55%),
          radial-gradient(ellipse 80% 60% at 20% 0%, rgba(139, 106, 72, 0.28) 0%, transparent 60%),
          linear-gradient(180deg, #1a0f08 0%, #2c1810 50%, #1a0f08 100%);
        position: relative;
      }
      .share-hero-dark::before {
        content: '';
        position: absolute; inset: 0;
        background-image:
          linear-gradient(45deg, transparent 49.5%, rgba(212, 165, 116, 0.07) 49.5%, rgba(212, 165, 116, 0.07) 50.5%, transparent 50.5%),
          linear-gradient(-45deg, transparent 49.5%, rgba(212, 165, 116, 0.07) 49.5%, rgba(212, 165, 116, 0.07) 50.5%, transparent 50.5%);
        background-size: 60px 60px;
        pointer-events: none;
        mask-image: radial-gradient(ellipse at center, black 0%, transparent 75%);
        -webkit-mask-image: radial-gradient(ellipse at center, black 0%, transparent 75%);
      }

      /* Sadu ribbon — Saudi weaving stripe used as a decorative divider. */
      .share-sadu {
        height: 6px;
        background-image:
          repeating-linear-gradient(90deg,
            #B87543 0, #B87543 6px,
            transparent 6px, transparent 10px,
            rgba(184, 117, 67, 0.4) 10px, rgba(184, 117, 67, 0.4) 14px,
            transparent 14px, transparent 18px,
            #B87543 18px, #B87543 22px,
            transparent 22px, transparent 30px);
        opacity: 0.7;
      }
      .share-sadu-thin {
        height: 2px;
        background-image:
          repeating-linear-gradient(90deg,
            #B87543 0, #B87543 4px,
            transparent 4px, transparent 8px);
        opacity: 0.5;
      }

      /* Editorial eyebrow tag — copper, uppercase, generous tracking. */
      .share-eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #B87543;
      }

      /* Saudi divider — flanking lines around centered content. */
      .share-divider {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        color: #B87543;
        opacity: 0.7;
      }
      .share-divider::before,
      .share-divider::after {
        content: '';
        width: 60px;
        height: 1px;
        background: currentColor;
      }

      /* Arch-frame: offset shadow border on featured cards. */
      .share-arch-frame { position: relative; }
      .share-arch-frame::before {
        content: '';
        position: absolute; inset: 0;
        border: 1px solid rgba(184, 117, 67, 0.32);
        border-radius: inherit;
        transform: translate(6px, 6px);
        pointer-events: none;
      }

      /* Display number — Amiri, editorial, oversized. */
      .share-display { font-family: 'Amiri', serif; font-weight: 700; line-height: 0.9; letter-spacing: -0.03em; }
      .share-display-num { font-family: 'Amiri', serif; font-weight: 700; line-height: 0.85; letter-spacing: -0.04em; font-feature-settings: "lnum" 1, "tnum" 1; }

      .share-fade-in { animation: share-fade-in 600ms cubic-bezier(0.22, 1, 0.36, 1) both; }
      @keyframes share-fade-in {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `}</style>
  );
}

// ─── Header / Footer / Backdrop ───────────────────────────────────────

function BrandHeader() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <header className="share-hero-dark relative overflow-hidden">
      {/* Crenellated castle-tooth top edge */}
      <svg
        className="absolute top-0 inset-x-0 h-3 w-full opacity-60 pointer-events-none"
        viewBox="0 0 1440 12"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M 0 12 L 0 6 L 30 6 L 30 0 L 60 0 L 60 6 L 90 6 L 90 0 L 120 0 L 120 6 L 150 6 L 150 0 L 180 0 L 180 6 L 210 6 L 210 0 L 240 0 L 240 6 L 270 6 L 270 0 L 300 0 L 300 6 L 1440 6 L 1440 12 Z" fill="#B87543"/>
        <path d="M 1440 12 L 1440 6 L 1410 6 L 1410 0 L 1380 0 L 1380 6 L 1350 6 L 1350 0 L 1320 0 L 1320 6 L 1290 6 L 1290 0 L 1260 0 L 1260 6 L 1230 6 L 1230 0 L 1200 0 L 1200 6 L 1170 6 L 1170 0 L 1140 0 L 1140 6 L 0 6 L 0 12 Z" fill="#B87543"/>
      </svg>

      {/* Najdi arch silhouette anchored to the bottom of the header */}
      <svg
        className="absolute inset-x-0 bottom-0 w-full h-[55%] pointer-events-none opacity-[0.10]"
        viewBox="0 0 1440 500"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="shareArchGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#d4a574" stopOpacity="0" />
            <stop offset="100%" stopColor="#d4a574" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <path d="M 0 500 L 0 380 L 180 380 L 180 280 L 320 280 L 320 200 L 480 200 L 540 120 L 600 200 L 760 200 L 760 280 L 900 280 L 900 200 L 1060 200 L 1120 120 L 1180 200 L 1340 200 L 1340 280 L 1440 280 L 1440 500 Z" fill="url(#shareArchGrad)" />
      </svg>

      {/* Top eyebrow rail — pulsing copper dot + location, just like the website */}
      <div className="relative z-10 max-w-6xl w-full mx-auto px-6 pt-10 flex items-center justify-between text-white/70 text-[11px] font-bold tracking-[0.15em]">
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#B87543] animate-pulse"></span>
          <span>{t('files.share.viewing')}</span>
        </span>
        <span className="hidden sm:inline">
          {isAr ? 'الرياض · المملكة العربية السعودية' : 'Riyadh · Saudi Arabia'}
        </span>
      </div>

      {/* Brand identity block */}
      <div className="relative z-10 max-w-6xl w-full mx-auto px-6 py-12 lg:py-16">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-2xl bg-white/95 shadow-lg shadow-black/40 p-2 flex items-center justify-center">
            <img src="/assets/logo-castle.png" alt="Wassel" className="w-full h-full object-contain" />
          </div>
          <span className="w-12 h-[1px] bg-[#B87543]"></span>
          <span className="share-eyebrow text-[#d4a574]">{t('files.share.shared_by')}</span>
        </div>
        <h1
          className="share-amiri text-white font-bold tracking-tight leading-[0.95] mb-3"
          style={{ fontSize: 'clamp(2.25rem, 5vw, 4.5rem)' }}
        >
          {isAr ? (
            <>
              <span className="block">وصل العقارية</span>
              <span className="block italic text-[#B87543] mt-2" style={{ fontSize: '0.45em' }}>
                نقود المشهد العقاري
              </span>
            </>
          ) : (
            <>
              <span className="block">Wassel Real Estate</span>
              <span className="block italic text-[#B87543] mt-2" style={{ fontSize: '0.45em' }}>
                Leading the Real-Estate Scene
              </span>
            </>
          )}
        </h1>
      </div>

      {/* Bottom rail — pillars + sadu accent */}
      <div className="relative z-10 max-w-6xl w-full mx-auto px-6 pb-8 flex items-end justify-between">
        <div className="hidden md:flex items-center gap-5 text-white/50 text-[11px] font-bold tracking-[0.15em]">
          <span>{isAr ? 'تسويق' : 'Marketing'}</span>
          <span className="w-1 h-1 rounded-full bg-[#B87543]"></span>
          <span>{isAr ? 'تقنية' : 'Technology'}</span>
          <span className="w-1 h-1 rounded-full bg-[#B87543]"></span>
          <span>{isAr ? 'استشارات' : 'Consulting'}</span>
        </div>
        <span className="text-white/40 text-[11px] font-bold tracking-[0.18em]">
          {isAr ? 'مشاركة آمنة' : 'Secure Share'}
        </span>
      </div>

      {/* Soft cream taper into the body */}
      <div
        className="absolute bottom-0 inset-x-0 h-16 z-[3] pointer-events-none"
        style={{ background: 'linear-gradient(180deg, transparent 0%, #F7F0E3 100%)' }}
      />
    </header>
  );
}

function BrandFooter() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <footer className="share-hero-dark relative overflow-hidden mt-6">
      <div className="share-sadu absolute top-0 inset-x-0" />
      <div className="relative z-10 max-w-6xl w-full mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src="/assets/logo-castle.png" alt="" className="w-9 h-9 object-contain opacity-90" />
            <div className="text-right leading-tight">
              <div className="share-amiri text-white font-bold text-base">
                {isAr ? 'وصل العقارية' : 'Wassel Real Estate'}
              </div>
              <div className="text-[10px] text-white/50 tracking-wider">
                {isAr ? 'الرياض · المملكة العربية السعودية' : 'Riyadh · Saudi Arabia'}
              </div>
            </div>
          </div>
          <div className="share-divider">
            <span className="share-eyebrow text-[#d4a574]">{t('files.share.powered_by')}</span>
          </div>
          <a
            href="https://wassel.re"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-white/70 hover:text-white text-xs font-bold tracking-[0.15em] uppercase border-b border-white/20 hover:border-[#B87543] pb-1 transition"
          >
            <span>wassel.re</span>
            {isAr ? <ArrowLeft size={12} /> : <ArrowRight size={12} />}
          </a>
        </div>
      </div>
    </footer>
  );
}

function SubtleBackdrop() {
  return (
    <>
      <div className="absolute inset-0 share-ksa-pattern opacity-60 pointer-events-none" aria-hidden="true" />
      <img
        src="/assets/logo-castle.png"
        alt=""
        aria-hidden="true"
        className="absolute -bottom-16 -end-16 w-80 h-80 object-contain opacity-[0.04] pointer-events-none select-none"
      />
    </>
  );
}

// ─── States ──────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-20">
      <Loader2 size={28} className="animate-spin text-[#B87543]" />
    </div>
  );
}

function NotFoundState() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <div className="share-fade-in share-arch-frame bg-white rounded-3xl shadow-2xl shadow-[#3C2A20]/15 max-w-md w-full mx-auto p-10 text-center border border-[#DECEB4]">
      <div className="w-16 h-16 rounded-2xl bg-amber-50 mx-auto mb-5 flex items-center justify-center ring-1 ring-amber-200">
        <AlertTriangle size={28} className="text-amber-700" />
      </div>
      <div className="share-eyebrow mb-3">{isAr ? 'تعذر فتح الرابط' : 'Unable to open'}</div>
      <h2 className="share-amiri text-2xl font-bold text-[#3C2A20] mb-2">
        {t('files.share.not_found')}
      </h2>
      <p className="text-[#3C2A20]/60 text-sm leading-relaxed">
        {t('files.share.not_found_subtitle')}
      </p>
      <div className="share-sadu-thin mt-6" />
    </div>
  );
}

interface PWProps {
  password: string;
  error: string | null;
  submitting: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}
function PasswordGate({ password, error, submitting, onChange, onSubmit }: PWProps) {
  const { t } = useTranslation();
  return (
    <div className="share-fade-in share-arch-frame bg-white rounded-3xl shadow-2xl shadow-[#3C2A20]/15 max-w-md w-full mx-auto p-10 text-center border border-[#DECEB4]">
      <div className="w-20 h-20 rounded-3xl mx-auto mb-5 flex items-center justify-center bg-gradient-to-br from-[#B87543]/15 to-[#8E4E3A]/10 ring-1 ring-[#B87543]/30 shadow-inner">
        <Lock size={34} className="text-[#B87543]" />
      </div>
      <div className="share-eyebrow mb-3">{t('files.share.password_required')}</div>
      <h2 className="share-amiri text-2xl font-bold text-[#3C2A20] mb-2">
        {t('files.share.unlock')}
      </h2>
      <p className="text-[#3C2A20]/60 text-sm mb-6 leading-relaxed">
        {t('files.share.password_locked')}
      </p>
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && password.length > 0) onSubmit();
        }}
        placeholder="•••••••••"
        className="w-full text-center tracking-[0.4em] px-4 py-3 rounded-2xl border-2 border-[#DECEB4] bg-[#F7F0E3]/40 focus:outline-none focus:ring-4 focus:ring-[#B87543]/20 focus:border-[#B87543]/60 text-[#3C2A20] text-lg mb-4 share-tajawal"
      />
      {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
      <button
        onClick={onSubmit}
        disabled={submitting || password.length === 0}
        className="inline-flex items-center justify-center gap-2 w-full px-5 py-3 rounded-full bg-[#B87543] text-white hover:bg-[#8E4E3A] disabled:opacity-50 font-bold transition-all shadow-[0_10px_28px_-10px_rgba(184,117,67,0.7)] hover:shadow-[0_14px_36px_-12px_rgba(184,117,67,0.8)]"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Unlock size={16} />}
        {t('files.share.unlock')}
      </button>
      <div className="share-sadu-thin mt-7" />
    </div>
  );
}

interface ReadyProps {
  data: SharedFileResponse;
  onDownload: () => void;
  isAr: boolean;
}
function ReadyState({ data, onDownload, isAr }: ReadyProps) {
  const { t } = useTranslation();
  const Icon = useMemo(() => kindIcon[data.kind ?? 'other'], [data.kind]);
  const sizeText = data.size_bytes !== undefined ? formatBytes(data.size_bytes, isAr) : '';
  const kindText = data.kind ? kindLabel(data.kind, isAr) : '';

  return (
    <div className="share-fade-in w-full max-w-5xl">
      {/* Editorial file header */}
      <div className="text-center mb-8">
        <div className="share-eyebrow mb-3">
          {isAr ? 'ملف مشارك' : 'Shared File'}
        </div>
        <h2
          className="share-amiri font-bold text-[#3C2A20] mb-4 leading-[1.1] px-4"
          style={{ fontSize: 'clamp(1.5rem, 3.4vw, 2.5rem)', wordBreak: 'break-word' }}
        >
          {data.original_name}
        </h2>
        <div className="share-divider mb-5">
          <span className="inline-flex items-center gap-2 text-[#3C2A20]/60 text-xs font-bold tracking-wider">
            <Icon size={14} className="text-[#B87543]" />
            <span>{kindText}</span>
            <span className="w-1 h-1 rounded-full bg-[#B87543]"></span>
            <span dir="ltr">{sizeText}</span>
          </span>
        </div>
        {data.allow_download && (
          <button
            onClick={onDownload}
            className="inline-flex items-center gap-3 bg-[#B87543] text-white px-7 py-3.5 rounded-full font-bold text-sm hover:bg-[#8E4E3A] transition-all hover:gap-4 shadow-[0_10px_28px_-10px_rgba(184,117,67,0.7)] hover:shadow-[0_14px_36px_-12px_rgba(184,117,67,0.8)]"
          >
            <Download size={16} />
            <span>{t('files.actions.download')}</span>
            {isAr ? (
              <ArrowLeft size={16} className="transition-transform group-hover:-translate-x-1" />
            ) : (
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
            )}
          </button>
        )}
      </div>

      {/* Preview area inside an arch-framed canvas */}
      <div className="share-arch-frame bg-white rounded-3xl border border-[#DECEB4] overflow-hidden shadow-xl shadow-[#3C2A20]/10">
        <SharePreviewBody data={data} />
      </div>

      {/* Sadu ribbon divider */}
      <div className="share-sadu-thin mt-10" />
    </div>
  );
}

/** Phone-or-narrow detector — drives PDF preview fallback because mobile
 *  browsers don't render multi-page PDFs in <iframe> (they show only the
 *  first page, no scroll/zoom). Tracks resize so a desktop browser the
 *  user narrows still gets the friendly card.
 */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

function SharePreviewBody({ data }: { data: SharedFileResponse }) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const isNarrow = useIsNarrow();
  if (!data.url) return null;
  const mime = (data.mime_type ?? '').toLowerCase();
  const kind = data.kind ?? 'other';

  if (kind === 'image' || mime.startsWith('image/')) {
    return (
      <div className="flex items-center justify-center p-4 lg:p-6 bg-[#F7F0E3]/40">
        <img
          src={data.url}
          alt={data.original_name ?? ''}
          className="max-w-full max-h-[72vh] object-contain rounded-2xl"
        />
      </div>
    );
  }
  if (kind === 'pdf' || mime === 'application/pdf') {
    if (isNarrow) {
      const Icon = kindIcon.pdf;
      return (
        <div className="flex flex-col items-center justify-center px-6 py-12 text-center gap-5 bg-gradient-to-br from-[#F7F0E3]/40 to-[#EFE3D0]/40">
          <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-[#B87543]/20 to-[#8E4E3A]/15 ring-1 ring-[#B87543]/30 flex items-center justify-center shadow-inner">
            <Icon size={48} className="text-[#B87543]" />
          </div>
          <p className="text-[#3C2A20]/70 text-sm max-w-sm leading-relaxed share-tajawal">
            {isAr
              ? 'افتح ملف PDF في عارض الجهاز للحصول على كامل الصفحات والتكبير.'
              : 'Open the PDF in your device viewer for full pages and zoom.'}
          </p>
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 bg-[#B87543] text-white px-7 py-3.5 rounded-full font-bold text-sm hover:bg-[#8E4E3A] transition-all shadow-[0_10px_28px_-10px_rgba(184,117,67,0.7)]"
          >
            <ExternalLink size={16} />
            <span>{isAr ? 'فتح ملف PDF' : 'Open PDF'}</span>
          </a>
        </div>
      );
    }
    return (
      <div className="p-3 lg:p-4 bg-[#F7F0E3]/40">
        <iframe
          src={data.url}
          title={data.original_name ?? 'PDF'}
          className="w-full h-[78vh] rounded-2xl bg-white border border-[#DECEB4]"
        />
      </div>
    );
  }
  if (kind === 'video' || mime.startsWith('video/')) {
    return (
      <div className="flex items-center justify-center p-4 lg:p-6 bg-black">
        <video
          src={data.url}
          controls
          autoPlay
          className="max-w-full max-h-[72vh] rounded-2xl"
        />
      </div>
    );
  }
  if (kind === 'audio' || mime.startsWith('audio/')) {
    const Icon = kindIcon.audio;
    return (
      <div className="flex flex-col items-center justify-center p-12 gap-5 bg-gradient-to-br from-[#F7F0E3]/40 to-[#EFE3D0]/40">
        <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-[#B87543]/20 to-[#8E4E3A]/15 ring-1 ring-[#B87543]/30 flex items-center justify-center shadow-inner">
          <Icon size={56} className="text-[#B87543]" />
        </div>
        <audio src={data.url} controls autoPlay className="w-full max-w-md" />
      </div>
    );
  }
  // document / archive / other → editorial download card
  const Icon = kindIcon[kind];
  return (
    <div className="flex flex-col items-center justify-center p-14 text-center gap-5 bg-gradient-to-br from-[#F7F0E3]/40 to-[#EFE3D0]/40">
      <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-[#B87543]/20 to-[#8E4E3A]/15 ring-1 ring-[#B87543]/30 flex items-center justify-center shadow-inner">
        <Icon size={56} className="text-[#B87543]" />
      </div>
      <p className="text-[#3C2A20]/70 text-sm max-w-sm leading-relaxed">
        {data.allow_download
          ? t('files.actions.download')
          : t('files.actions.preview')}
      </p>
    </div>
  );
}
