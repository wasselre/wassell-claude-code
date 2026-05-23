import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Download,
  Eye,
  Loader2,
  Lock,
  Unlock,
  Sparkles,
} from 'lucide-react';
import { fetchSharedFile, fetchSharedFileDownload } from '@/lib/files/client';
import type { SharedFileResponse } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindIcon, kindLabel } from '@/lib/files/format';

/**
 * /share/:token — the page external customers land on.
 *
 * Design intent: this is a "brag-worthy" surface. Wassel branding is
 * unmistakable, layout is generous, palette uses the brand cream/copper/
 * chocolate tokens, and the file is shown beautifully whatever its mime.
 *
 * No AppLayout wrapper — the page paints its own full-bleed canvas with
 * a Wassel watermark pattern, hero header, and brand footer.
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

  // Sync <html dir> to the user's language preference so the page is RTL-aware
  // even though it sits outside AppLayout.
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
        if (res.requires_password) {
          setPhase('password');
        } else {
          setPhase('ready');
        }
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
    <div
      className="min-h-screen relative overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse at top, #F5EDE0 0%, #EBDDC9 60%, #D4B896 100%)',
      }}
    >
      {/* Subtle watermark castle in the corner — gives every share page a Wassel signature. */}
      <WatermarkSignature />

      <div className="relative z-10 flex flex-col min-h-screen">
        <BrandHeader />

        <main className="flex-1 flex items-center justify-center px-4 py-6">
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
        </main>

        <BrandFooter />
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function BrandHeader() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <header className="px-6 lg:px-10 pt-8 pb-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white shadow-md shadow-chocolate/10 p-2 flex items-center justify-center">
            <img src="/assets/logo-castle.png" alt="Wassel" className="w-full h-full object-contain" />
          </div>
          <div>
            <div className="text-xl font-bold text-chocolate" style={{ fontFamily: '"Amiri", serif' }}>
              {isAr ? 'وصل العقارية' : 'Wassel Real Estate'}
            </div>
            <div className="text-xs text-chocolate/60 tracking-wider uppercase font-bold mt-0.5">
              {t('files.share.shared_by')}
            </div>
          </div>
        </div>
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-sand/40 text-xs font-bold text-chocolate/70">
          <Sparkles size={12} className="text-copper" />
          {t('files.share.viewing')}
        </div>
      </div>
    </header>
  );
}

function BrandFooter() {
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <footer className="px-6 lg:px-10 pb-6 pt-4">
      <div className="max-w-6xl mx-auto flex items-center justify-center">
        <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-white/40 backdrop-blur-sm border border-sand/30 text-xs text-chocolate/60">
          <img src="/assets/logo-castle.png" alt="" className="w-5 h-5 object-contain opacity-80" />
          <span className="font-bold tracking-wide" style={{ fontFamily: '"Amiri", serif' }}>
            {isAr ? 'مدعوم من وصل العقارية' : 'Powered by Wassel Real Estate'}
          </span>
        </div>
      </div>
    </footer>
  );
}

function WatermarkSignature() {
  return (
    <>
      <img
        src="/assets/logo-castle.png"
        alt=""
        aria-hidden="true"
        className="absolute -bottom-12 -end-12 w-80 h-80 object-contain opacity-[0.04] pointer-events-none select-none"
      />
      <img
        src="/assets/logo-castle.png"
        alt=""
        aria-hidden="true"
        className="absolute -top-20 -start-20 w-72 h-72 object-contain opacity-[0.03] pointer-events-none select-none"
      />
    </>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-3 animate-pulse">
      <Loader2 size={32} className="animate-spin text-copper" />
      <div className="text-chocolate/50 text-sm">…</div>
    </div>
  );
}

function NotFoundState() {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-chocolate/10 p-10 max-w-md w-full mx-auto text-center border border-sand/30">
      <div className="w-16 h-16 rounded-2xl bg-amber-50 mx-auto mb-5 flex items-center justify-center">
        <AlertTriangle size={32} className="text-amber-600" />
      </div>
      <h1 className="text-xl font-bold text-chocolate mb-2" style={{ fontFamily: '"Amiri", serif' }}>
        {t('files.share.not_found')}
      </h1>
      <p className="text-charcoal/60 text-sm">{t('files.share.not_found_subtitle')}</p>
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
    <div className="bg-white rounded-3xl shadow-2xl shadow-chocolate/10 p-10 max-w-md w-full mx-auto text-center border border-sand/30">
      <div className="w-20 h-20 rounded-3xl mx-auto mb-5 flex items-center justify-center bg-gradient-to-br from-copper/15 to-terracotta/10 ring-1 ring-copper/20">
        <Lock size={36} className="text-copper" />
      </div>
      <h1 className="text-xl font-bold text-chocolate mb-2" style={{ fontFamily: '"Amiri", serif' }}>
        {t('files.share.password_required')}
      </h1>
      <p className="text-charcoal/60 text-sm mb-6">{t('files.share.password_locked')}</p>
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && password.length > 0) onSubmit();
        }}
        placeholder="•••••••••"
        className="w-full text-center tracking-[0.4em] px-4 py-3 rounded-2xl border-2 border-sand/40 bg-cream/40 focus:outline-none focus:ring-4 focus:ring-copper/20 focus:border-copper/50 text-charcoal text-lg mb-4"
      />
      {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
      <button
        onClick={onSubmit}
        disabled={submitting || password.length === 0}
        className="inline-flex items-center justify-center gap-2 w-full px-5 py-3 rounded-2xl bg-copper text-white hover:bg-terracotta disabled:opacity-50 font-bold transition-colors shadow-lg shadow-copper/20"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Unlock size={16} />}
        {t('files.share.unlock')}
      </button>
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
    <div className="w-full max-w-5xl">
      {/* File header card */}
      <div className="bg-white rounded-3xl shadow-2xl shadow-chocolate/10 border border-sand/30 overflow-hidden">
        {/* Metadata strip */}
        <div className="flex items-center justify-between gap-4 px-6 py-5 border-b border-sand/30 bg-gradient-to-r from-cream/40 to-transparent">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-copper/10 flex items-center justify-center shrink-0">
              <Icon size={24} className="text-copper" />
            </div>
            <div className="min-w-0">
              <h2
                className="text-lg font-bold text-chocolate truncate"
                style={{ fontFamily: '"Amiri", serif' }}
              >
                {data.original_name}
              </h2>
              <div className="flex items-center gap-2 text-xs text-charcoal/50 mt-1">
                <span className="px-2 py-0.5 rounded-md bg-charcoal/5 font-bold">{kindText}</span>
                <span>•</span>
                <span>{sizeText}</span>
              </div>
            </div>
          </div>
          {data.allow_download && (
            <button
              onClick={onDownload}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm transition-colors shadow-md shadow-copper/20 shrink-0"
            >
              <Download size={16} />
              {t('files.actions.download')}
            </button>
          )}
        </div>

        {/* Preview area */}
        <div className="bg-cream/30">
          <SharePreviewBody data={data} />
        </div>
      </div>

      {/* Trust badge below the card */}
      <div className="mt-5 flex items-center justify-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/50 backdrop-blur-sm border border-sand/30 text-xs text-chocolate/60">
          <Eye size={12} className="text-copper" />
          <span className="font-bold">
            {isAr ? 'مشاركة آمنة' : 'Secure share'}
          </span>
        </div>
      </div>
    </div>
  );
}

function SharePreviewBody({ data }: { data: SharedFileResponse }) {
  const { t } = useTranslation();
  if (!data.url) return null;
  const mime = (data.mime_type ?? '').toLowerCase();
  const kind = data.kind ?? 'other';

  if (kind === 'image' || mime.startsWith('image/')) {
    return (
      <div className="flex items-center justify-center p-6 lg:p-8">
        <img
          src={data.url}
          alt={data.original_name ?? ''}
          className="max-w-full max-h-[70vh] object-contain rounded-2xl shadow-xl shadow-chocolate/10"
        />
      </div>
    );
  }
  if (kind === 'pdf' || mime === 'application/pdf') {
    return (
      <div className="p-3 lg:p-4">
        <iframe
          src={data.url}
          title={data.original_name ?? 'PDF'}
          className="w-full h-[75vh] rounded-2xl border border-sand/40 bg-white"
        />
      </div>
    );
  }
  if (kind === 'video' || mime.startsWith('video/')) {
    return (
      <div className="flex items-center justify-center p-6 lg:p-8">
        <video
          src={data.url}
          controls
          autoPlay
          className="max-w-full max-h-[70vh] rounded-2xl shadow-xl shadow-chocolate/10 bg-black"
        />
      </div>
    );
  }
  if (kind === 'audio' || mime.startsWith('audio/')) {
    const Icon = kindIcon.audio;
    return (
      <div className="flex flex-col items-center justify-center p-10 gap-5">
        <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-purple-500/15 to-copper/10 ring-1 ring-purple-500/20 flex items-center justify-center">
          <Icon size={56} className="text-purple-600" />
        </div>
        <audio src={data.url} controls autoPlay className="w-full max-w-md" />
      </div>
    );
  }
  // document / archive / other → big card
  const Icon = kindIcon[kind];
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center gap-4">
      <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-copper/15 to-terracotta/10 ring-1 ring-copper/20 flex items-center justify-center">
        <Icon size={56} className="text-copper" />
      </div>
      <p className="text-charcoal/70 text-sm max-w-sm">
        {data.allow_download
          ? t('files.actions.download')
          : t('files.actions.preview')}
      </p>
    </div>
  );
}
