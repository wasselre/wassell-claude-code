/**
 * Login page — email + password → Supabase Auth → app.
 *
 * Sits OUTSIDE the AppLayout. When a session exists, the App-level auth gate
 * redirects away from here. On successful sign-in we do nothing special — the
 * gate watches `onAuthStateChange` and will render the app itself.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Loader2, Mail, Lock, Languages } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { signIn, sendPasswordResetEmail } from '@/lib/auth';

type Mode = 'sign-in' | 'forgot';

export default function Login() {
  const { language, setLanguage } = useAppStore();
  const isAr = language === 'ar';
  const { i18n } = useTranslation();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleLanguage = (): void => {
    const next = isAr ? 'en' : 'ar';
    setLanguage(next);
    void i18n.changeLanguage(next);
  };

  const handleSignIn = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!email.trim() || !password) {
      setError(isAr ? 'يرجى إدخال البريد وكلمة المرور' : 'Please enter email and password.');
      return;
    }
    setSubmitting(true);
    const result = await signIn(email.trim(), password);
    setSubmitting(false);
    if (result.error) {
      setError(translateAuthError(result.error, isAr));
      return;
    }
    // Success — the auth gate in App.tsx listens for onAuthStateChange and
    // will render the app. Navigate home as a safety net in case the listener
    // hasn't fired yet by the time we redirect.
    navigate('/', { replace: true });
  };

  const handleForgot = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError(isAr ? 'يرجى إدخال البريد' : 'Please enter your email.');
      return;
    }
    setSubmitting(true);
    const result = await sendPasswordResetEmail(email.trim());
    setSubmitting(false);
    if (result.error) {
      setError(translateAuthError(result.error, isAr));
      return;
    }
    setInfo(
      isAr
        ? 'أرسلنا رابط إعادة تعيين كلمة المرور إلى بريدك.'
        : 'We sent a password-reset link to your email.',
    );
  };

  return (
    <div className="min-h-screen bg-cream-light flex items-center justify-center px-4">
      {/* Language toggle — absolute top-left/right */}
      <button
        onClick={toggleLanguage}
        className="absolute top-4 end-4 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/80 border border-sand/30 text-sm font-bold text-charcoal hover:bg-white transition-colors"
        aria-label={isAr ? 'English' : 'العربية'}
        type="button"
      >
        <Languages size={15} />
        {isAr ? 'EN' : 'AR'}
      </button>

      <div className="w-full max-w-md">
        {/* Logo + title */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="/assets/logo-icon.png"
            alt="Wassel"
            className="w-16 h-16 mb-4 object-contain"
            onError={(e) => {
              // Graceful fallback when the logo asset is missing
              e.currentTarget.style.display = 'none';
            }}
          />
          <h1 className="text-2xl font-bold text-chocolate mb-1">
            {isAr ? 'وصل العقارية' : 'Wassel Real Estate'}
          </h1>
          <p className="text-sm text-charcoal/60">
            {mode === 'sign-in'
              ? isAr ? 'تسجيل الدخول إلى النظام' : 'Sign in to your CRM'
              : isAr ? 'إعادة تعيين كلمة المرور' : 'Reset your password'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-sand/20 p-6">
          <form
            onSubmit={mode === 'sign-in' ? handleSignIn : handleForgot}
            className="space-y-4"
            noValidate
          >
            {/* Email */}
            <label className="block">
              <span className="block text-sm font-bold text-charcoal mb-1.5">
                {isAr ? 'البريد الإلكتروني' : 'Email'}
              </span>
              <div className="relative">
                <Mail
                  size={16}
                  className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40"
                />
                <input
                  type="email"
                  autoComplete="email"
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full ps-10 pe-3 py-2.5 rounded-lg bg-cream-light border border-sand/30 text-charcoal placeholder:text-charcoal/30 focus:outline-none focus:ring-2 focus:ring-copper/30 focus:border-copper/40"
                  placeholder="you@wassel.re"
                  disabled={submitting}
                />
              </div>
            </label>

            {/* Password — only on sign-in */}
            {mode === 'sign-in' && (
              <label className="block">
                <span className="block text-sm font-bold text-charcoal mb-1.5">
                  {isAr ? 'كلمة المرور' : 'Password'}
                </span>
                <div className="relative">
                  <Lock
                    size={16}
                    className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40"
                  />
                  <input
                    type="password"
                    autoComplete="current-password"
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full ps-10 pe-3 py-2.5 rounded-lg bg-cream-light border border-sand/30 text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30 focus:border-copper/40"
                    disabled={submitting}
                  />
                </div>
              </label>
            )}

            {/* Error / info */}
            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {info && (
              <div className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                {info}
              </div>
            )}

            {/* Submit */}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {mode === 'sign-in'
                ? isAr ? 'تسجيل الدخول' : 'Sign in'
                : isAr ? 'إرسال الرابط' : 'Send reset link'}
            </Button>

            {/* Mode toggle */}
            <div className="text-center text-sm text-charcoal/60 pt-2">
              {mode === 'sign-in' ? (
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot');
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-copper hover:text-terracotta font-bold"
                >
                  {isAr ? 'نسيت كلمة المرور؟' : 'Forgot password?'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMode('sign-in');
                    setError(null);
                    setInfo(null);
                  }}
                  className="text-copper hover:text-terracotta font-bold"
                >
                  {isAr ? '← العودة لتسجيل الدخول' : '← Back to sign in'}
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Footer note */}
        <p className="text-center text-xs text-charcoal/40 mt-6">
          {isAr
            ? 'للوصول إلى حسابك تواصل مع مسؤول النظام.'
            : 'Need an account? Contact your administrator.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Translate the English-formatted auth errors from `lib/auth.ts` into Arabic
 * when the UI is in Arabic. The wrapper already normalized Supabase's raw
 * messages — here we just pick an Arabic equivalent by substring match.
 */
function translateAuthError(msg: string, isAr: boolean): string {
  if (!isAr) return msg;
  const m = msg.toLowerCase();
  if (m.includes('invalid')) return 'البريد أو كلمة المرور غير صحيحة.';
  if (m.includes('confirm')) return 'يرجى تأكيد بريدك قبل تسجيل الدخول.';
  if (m.includes('too many') || m.includes('rate')) return 'محاولات كثيرة، يرجى الانتظار دقيقة.';
  if (m.includes('not found') || m.includes('no account')) return 'لا يوجد حساب بهذا البريد.';
  if (m.includes('short')) return 'كلمة المرور قصيرة جدًا (٦ أحرف على الأقل).';
  if (m.includes('not configured') || m.includes('unavailable'))
    return 'خدمة تسجيل الدخول غير متاحة. يرجى التواصل مع مسؤول النظام.';
  return msg;
}
