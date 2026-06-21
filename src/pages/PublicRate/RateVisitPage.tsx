import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Star, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

/**
 * /rate/:token — the public, no-login page a client opens from the visit-rating
 * WhatsApp link. It reads ONLY a minimal, PII-free context (project name + visit
 * date) via the anon `get_visit_for_rating` RPC and writes the 1–5 score back to
 * the visit via `submit_visit_rating`. No AppLayout — paints its own Wassel-brand
 * canvas, RTL-aware like the other public pages (PublicShareFilePage).
 */

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'not-found' | 'error';
interface VisitContext {
  project_name: string | null;
  visit_date: string | null;
}

// Bilingual UI strings via the sanctioned isAr ? ar : en pattern (no raw,
// untranslated literals in JSX; public page sits outside the i18n-keyed surface).
const STR = {
  title: { ar: 'كيف كانت تجربة زيارتك؟', en: 'How was your visit experience?' },
  subtitle: { ar: 'يسعدنا تقييمك من ١ إلى ٥', en: 'Please rate it from 1 to 5' },
  visitTo: { ar: 'زيارة مشروع', en: 'Visit to' },
  on: { ar: 'بتاريخ', en: 'on' },
  submit: { ar: 'إرسال التقييم', en: 'Submit rating' },
  thanks: { ar: 'شكرًا لك! تم استلام تقييمك.', en: 'Thank you! Your rating has been received.' },
  notfound: { ar: 'هذا الرابط غير صالح أو منتهي الصلاحية.', en: 'This link is invalid or has expired.' },
  error: { ar: 'تعذّر إرسال التقييم، يرجى المحاولة مرة أخرى.', en: 'Could not submit your rating — please try again.' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
} as const;

export default function RateVisitPage() {
  const { token } = useParams<{ token: string }>();
  const isAr = useAppStore((s) => s.language === 'ar');
  const tr = (k: keyof typeof STR) => (isAr ? STR[k].ar : STR[k].en);

  const [phase, setPhase] = useState<Phase>('loading');
  const [ctx, setCtx] = useState<VisitContext | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);

  // RTL-aware even though we're outside AppLayout.
  useEffect(() => {
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
    document.documentElement.lang = isAr ? 'ar' : 'en';
  }, [isAr]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token || !supabase) {
        if (!cancelled) setPhase('not-found');
        return;
      }
      const { data, error } = await supabase.rpc('get_visit_for_rating', { p_token: token });
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) {
        setPhase('not-found');
        return;
      }
      setCtx(row as VisitContext);
      setPhase('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    if (!token || !supabase || rating < 1 || rating > 5) return;
    setPhase('submitting');
    const { data, error } = await supabase.rpc('submit_visit_rating', { p_token: token, p_rating: rating });
    if (error || !(data as { ok?: boolean } | null)?.ok) {
      setPhase('error');
      return;
    }
    setPhase('done');
  };

  const visitDate = (() => {
    if (!ctx?.visit_date) return null;
    const d = new Date(ctx.visit_date);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'long' });
  })();

  return (
    <div
      className="min-h-screen relative overflow-hidden flex flex-col"
      style={{ background: 'radial-gradient(ellipse at top, #F5EDE0 0%, #EBDDC9 60%, #D4B896 100%)' }}
    >
      <header className="relative z-10 px-6 py-6 flex items-center justify-center">
        <img src="/assets/logo-full.png" alt="Wassel" className="h-12" />
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-4 pb-12">
        <div
          className="w-full max-w-md rounded-2xl bg-white/80 backdrop-blur shadow-xl border p-8 text-center"
          style={{ borderColor: 'rgba(212,184,150,0.5)' }}
        >
          {phase === 'loading' && (
            <div className="flex flex-col items-center gap-3 py-8 text-charcoal/50">
              <Loader2 className="w-7 h-7 animate-spin" />
              <p>{tr('loading')}</p>
            </div>
          )}

          {phase === 'not-found' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <AlertTriangle className="w-10 h-10" style={{ color: '#8E4E3A' }} />
              <p className="text-lg font-bold" style={{ color: '#4A4E54' }}>{tr('notfound')}</p>
            </div>
          )}

          {phase === 'done' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <CheckCircle2 className="w-12 h-12" style={{ color: '#10B981' }} />
              <p className="text-xl font-bold" style={{ color: '#4A4E54' }}>{tr('thanks')}</p>
            </div>
          )}

          {(phase === 'ready' || phase === 'submitting' || phase === 'error') && (
            <>
              <h1 className="text-2xl font-bold mb-2" style={{ color: '#4A2C2A' }}>{tr('title')}</h1>
              <p className="mb-1" style={{ color: '#4A4E54' }}>{tr('subtitle')}</p>
              {(ctx?.project_name || visitDate) && (
                <p className="text-sm mb-6" style={{ color: '#B8734F' }}>
                  {ctx?.project_name ? `${tr('visitTo')} ${ctx.project_name}` : ''}
                  {ctx?.project_name && visitDate ? ' — ' : ''}
                  {visitDate ? `${tr('on')} ${visitDate}` : ''}
                </p>
              )}

              <div className="flex items-center justify-center gap-2 my-6" dir="ltr">
                {[1, 2, 3, 4, 5].map((n) => {
                  const active = n <= (hover || rating);
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-label={`${n}`}
                      onMouseEnter={() => setHover(n)}
                      onMouseLeave={() => setHover(0)}
                      onClick={() => setRating(n)}
                      className="transition-transform hover:scale-110 focus:outline-none"
                    >
                      <Star
                        className="w-10 h-10"
                        style={{ color: active ? '#C09B5F' : '#D4B896' }}
                        fill={active ? '#C09B5F' : 'none'}
                      />
                    </button>
                  );
                })}
              </div>

              {phase === 'error' && (
                <p className="text-sm mb-4" style={{ color: '#8E4E3A' }}>{tr('error')}</p>
              )}

              <button
                type="button"
                disabled={rating < 1 || phase === 'submitting'}
                onClick={submit}
                className="w-full py-3 rounded-lg font-bold text-white transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
                style={{ background: '#B8734F' }}
              >
                {phase === 'submitting' && <Loader2 className="w-4 h-4 animate-spin" />}
                {tr('submit')}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
