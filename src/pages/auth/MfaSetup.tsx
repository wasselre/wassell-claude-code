/**
 * MFA Setup / Challenge page.
 *
 * Used in two cases:
 *   1. **First-time enrollment** — admin user signs in fresh, has no
 *      factor yet. We call `enrollTotpFactor()`, show the QR code,
 *      ask them to scan it in their authenticator (Google Authenticator,
 *      Authy, 1Password, …) and submit the first 6-digit code.
 *   2. **Routine challenge** — admin user signs in, already has a
 *      verified factor, but the session is at aal1. We list their
 *      factors, ask them to enter the current code, and verify against
 *      it to upgrade the session to aal2.
 *
 * The page picks the right mode automatically based on
 * `listMfaFactors()`. Once aal2 is reached, navigates to the originally-
 * requested route (or `/` as a fallback).
 *
 * MFA is required only for `is_admin` profiles. The `RequireAdmin` route
 * guard sends users here when their session is aal1.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  enrollTotpFactor,
  listMfaFactors,
  verifyMfaEnrollment,
  challengeAndVerifyMfa,
  unenrollMfaFactor,
  getCurrentAal,
  type MfaFactor,
} from '@/lib/auth';

type Mode = 'loading' | 'enroll' | 'challenge' | 'done';

export default function MfaSetup() {
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<Mode>('loading');
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [enrollState, setEnrollState] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Decide between enroll and challenge mode on first render.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const aal = await getCurrentAal();
      if (cancelled) return;
      // Already aal2 — nothing to do, send them home.
      if (aal.currentLevel === 'aal2') {
        navigate(returnTo, { replace: true });
        return;
      }
      const { factors: existing } = await listMfaFactors();
      if (cancelled) return;
      setFactors(existing);
      const verified = existing.find((f) => f.status === 'verified');
      if (verified) {
        setMode('challenge');
      } else {
        // No verified factor yet — kick off enrollment.
        const { factorId, qrCode, secret, error: enrollErr } = await enrollTotpFactor();
        if (cancelled) return;
        if (enrollErr || !factorId || !qrCode || !secret) {
          // If a previous enroll attempt left an unverified factor on the
          // account, Supabase rejects a fresh enroll. Clean it up and retry.
          const stale = existing.find((f) => f.status === 'unverified');
          if (stale) {
            await unenrollMfaFactor(stale.id);
            const retry = await enrollTotpFactor();
            if (cancelled) return;
            if (retry.error || !retry.factorId || !retry.qrCode || !retry.secret) {
              setError(retry.error ?? 'Failed to start enrollment.');
              setMode('enroll');
              return;
            }
            setEnrollState({ factorId: retry.factorId, qr: retry.qrCode, secret: retry.secret });
          } else {
            setError(enrollErr ?? 'Failed to start enrollment.');
            setMode('enroll');
            return;
          }
        } else {
          setEnrollState({ factorId, qr: qrCode, secret });
        }
        setMode('enroll');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'enroll' && enrollState) {
        const { error: verifyErr } = await verifyMfaEnrollment(enrollState.factorId, code);
        if (verifyErr) {
          setError(verifyErr);
          return;
        }
      } else if (mode === 'challenge') {
        const verified = factors.find((f) => f.status === 'verified');
        if (!verified) {
          setError(isAr ? 'لا يوجد عامل متحقق منه.' : 'No verified factor on this account.');
          return;
        }
        const { error: verifyErr } = await challengeAndVerifyMfa(verified.id, code);
        if (verifyErr) {
          setError(verifyErr);
          return;
        }
      }
      addToast(isAr ? 'تم تأكيد التحقق' : 'Verified', 'success');
      setMode('done');
      // Brief beat so the user sees the success state before redirect.
      window.setTimeout(() => navigate(returnTo, { replace: true }), 600);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-cream">
      <div className="card max-w-md w-full p-6">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={20} className="text-copper" />
          <h1 className="text-lg font-bold text-charcoal">
            {mode === 'enroll'
              ? isAr ? 'تفعيل التحقق بخطوتين' : 'Set up two-step verification'
              : mode === 'challenge'
              ? isAr ? 'أدخل رمز التحقق' : 'Enter your verification code'
              : isAr ? 'تم' : 'Done'}
          </h1>
        </div>

        {mode === 'loading' && (
          <div className="flex items-center gap-2 text-charcoal/60">
            <Loader2 size={16} className="animate-spin" />
            <span>{isAr ? 'جاري التحميل…' : 'Loading…'}</span>
          </div>
        )}

        {mode === 'enroll' && enrollState && (
          <>
            <p className="text-sm text-charcoal/70 mb-4">
              {isAr
                ? 'امسح الرمز التالي بتطبيق المصادقة (Google Authenticator أو Authy أو 1Password) ثم أدخل الرمز المكوّن من 6 أرقام لإكمال التفعيل.'
                : 'Scan the QR code below with your authenticator app (Google Authenticator, Authy, 1Password, …) then enter the 6-digit code it shows.'}
            </p>
            <div className="flex flex-col items-center gap-3 mb-4">
              <img
                src={enrollState.qr}
                alt="MFA QR code"
                className="w-48 h-48 border border-sand/40 rounded-lg p-2 bg-white"
              />
              <details className="text-xs text-charcoal/50">
                <summary className="cursor-pointer">
                  {isAr ? 'لا يمكنك مسح الرمز؟' : 'Can\'t scan the QR?'}
                </summary>
                <code className="block mt-1 break-all bg-sand/10 px-2 py-1 rounded">
                  {enrollState.secret}
                </code>
              </details>
            </div>
          </>
        )}

        {mode === 'challenge' && (
          <p className="text-sm text-charcoal/70 mb-4">
            {isAr
              ? 'افتح تطبيق المصادقة وأدخل الرمز الحالي.'
              : 'Open your authenticator app and enter the current code.'}
          </p>
        )}

        {mode === 'done' && (
          <p className="text-sm text-green-700">
            {isAr ? 'جاري إعادة التوجيه…' : 'Redirecting…'}
          </p>
        )}

        {(mode === 'enroll' || mode === 'challenge') && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="form-input text-2xl tracking-[0.4em] text-center font-mono"
              dir="ltr"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={code.length !== 6 || submitting}>
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {isAr ? 'تأكيد' : 'Verify'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
