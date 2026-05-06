/**
 * Reset Password page — landing page after the user clicks the reset link from
 * their email. Supabase delivers them here with a temporary "recovery" session
 * active, which lets `updatePassword()` succeed without the old password.
 *
 * Flow:
 *   1. User clicks link in email → lands here with ?type=recovery in URL.
 *   2. Supabase auth listener fires with event="PASSWORD_RECOVERY".
 *   3. User types new password → we call updatePassword → done.
 *   4. They're now signed in with the new password; the App gate will route
 *      them into the app.
 *
 * If they land here without a recovery session (link expired, wrong URL,
 * direct navigation), we show an error and a "back to sign in" button.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { getSession, updatePassword, onAuthChange, MIN_PASSWORD_LENGTH } from '@/lib/auth';

export default function ResetPassword() {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Decide whether the user has a valid recovery session in hand.
  // Supabase surfaces the recovery session automatically on page load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await getSession();
      if (!cancelled) setHasRecoverySession(session !== null);
    })();
    // Also listen for the PASSWORD_RECOVERY event which fires async on page load.
    const unsub = onAuthChange((session) => {
      if (!cancelled) setHasRecoverySession(session !== null);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        isAr
          ? `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`
          : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (password !== confirm) {
      setError(isAr ? 'كلمتا المرور غير متطابقتين.' : 'Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const result = await updatePassword(password);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setDone(true);
    // Give the user a moment to read the success, then send them home.
    setTimeout(() => navigate('/', { replace: true }), 1500);
  };

  return (
    <div className="min-h-screen bg-cream-light flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <img
            src="/assets/logo-castle.png"
            alt="Wassel"
            className="w-16 h-16 mb-4 object-contain"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <h1 className="text-2xl font-bold text-chocolate mb-1">
            {isAr ? 'إعادة تعيين كلمة المرور' : 'Reset your password'}
          </h1>
          <p className="text-sm text-charcoal/60">
            {isAr ? 'اختر كلمة مرور جديدة' : 'Choose a new password'}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-sand/20 p-6">
          {hasRecoverySession === null && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-copper" />
            </div>
          )}

          {hasRecoverySession === false && (
            <div className="space-y-4">
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {isAr
                  ? 'رابط إعادة التعيين منتهي الصلاحية أو غير صحيح. يرجى طلب رابط جديد.'
                  : 'This reset link is expired or invalid. Please request a new one.'}
              </div>
              <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
                {isAr ? 'العودة لتسجيل الدخول' : 'Back to sign in'}
              </Button>
            </div>
          )}

          {hasRecoverySession === true && !done && (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <label className="block">
                <span className="block text-sm font-bold text-charcoal mb-1.5">
                  {isAr ? 'كلمة المرور الجديدة' : 'New password'}
                </span>
                <div className="relative">
                  <Lock
                    size={16}
                    className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40"
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full ps-10 pe-3 py-2.5 rounded-lg bg-cream-light border border-sand/30 text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30 focus:border-copper/40"
                    disabled={submitting}
                  />
                </div>
              </label>

              <label className="block">
                <span className="block text-sm font-bold text-charcoal mb-1.5">
                  {isAr ? 'تأكيد كلمة المرور' : 'Confirm password'}
                </span>
                <div className="relative">
                  <Lock
                    size={16}
                    className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40"
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full ps-10 pe-3 py-2.5 rounded-lg bg-cream-light border border-sand/30 text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30 focus:border-copper/40"
                    disabled={submitting}
                  />
                </div>
              </label>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {isAr ? 'تحديث كلمة المرور' : 'Update password'}
              </Button>
            </form>
          )}

          {done && (
            <div className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-center">
              {isAr
                ? 'تم تحديث كلمة المرور بنجاح. جاري التوجيه...'
                : 'Password updated. Redirecting...'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
