/**
 * /profile — self-service page where the signed-in user can update their
 * own bilingual name, change their password, and (for admin profiles)
 * manage their MFA factor. Read-only display of profile + roles since
 * those are admin-managed.
 *
 * Why not put this in /settings/* — settings is already gated on
 * `is_admin`. /profile is the *one* page every signed-in user needs and
 * goes through `RequireAuth` (the layout-level guard) instead.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from 'react-i18next';
import Button from '@/components/ui/Button';
import NotificationSettings from '@/components/NotificationSettings';
import { Loader2, ShieldCheck, KeyRound, UserCircle, ShieldAlert } from 'lucide-react';
import {
  updatePassword,
  listMfaFactors,
  unenrollMfaFactor,
  getCurrentAal,
  MIN_PASSWORD_LENGTH,
  isAuthAvailable,
  type MfaFactor,
} from '@/lib/auth';

export default function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language, addToast, currentUserId, users, profiles, roles, saveUser } = useAppStore();
  const isAr = language === 'ar';

  const me = users.find((u) => u.id === currentUserId) ?? null;
  const myProfile = me ? profiles.find((p) => p.id === me.profile_id) ?? null : null;

  const [nameAr, setNameAr] = useState(me?.name_ar ?? '');
  const [nameEn, setNameEn] = useState(me?.name_en ?? '');
  const [savingName, setSavingName] = useState(false);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [aal, setAal] = useState<'aal1' | 'aal2' | null>(null);
  const [mfaLoading, setMfaLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isAuthAvailable()) {
        if (!cancelled) {
          setMfaLoading(false);
        }
        return;
      }
      const [aalResult, factorsResult] = await Promise.all([
        getCurrentAal(),
        listMfaFactors(),
      ]);
      if (cancelled) return;
      setAal((aalResult.currentLevel as 'aal1' | 'aal2' | null) ?? null);
      setFactors(factorsResult.factors);
      setMfaLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me) {
    return (
      <div className="text-center py-20 text-charcoal/40">
        <p>{isAr ? 'لم يتم التعرف على المستخدم.' : 'User not recognized.'}</p>
      </div>
    );
  }

  const myRoles = roles.filter((r) =>
    me.role_assignments.some((ra) => ra.role_id === r.id),
  );

  const handleNameSave = (e: FormEvent) => {
    e.preventDefault();
    if (savingName) return;
    setSavingName(true);
    const result = saveUser({
      ...me,
      name_ar: nameAr.trim(),
      name_en: nameEn.trim(),
      updated_at: new Date().toISOString(),
    });
    setSavingName(false);
    if (result.ok) {
      addToast(t('toast.saved'), 'success');
    } else {
      addToast(t('toast.error'), 'error');
    }
  };

  const handlePasswordSave = async (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPwError(
        isAr
          ? `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`
          : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (password !== confirm) {
      setPwError(isAr ? 'كلمتا المرور غير متطابقتين.' : 'Passwords do not match.');
      return;
    }
    setSavingPw(true);
    const result = await updatePassword(password);
    setSavingPw(false);
    if (result.error) {
      setPwError(result.error);
      return;
    }
    setPassword('');
    setConfirm('');
    addToast(isAr ? 'تم تحديث كلمة المرور' : 'Password updated', 'success');
  };

  const handleUnenrollFactor = async (factorId: string) => {
    const confirmed = window.confirm(
      isAr
        ? 'حذف عامل المصادقة؟ ستحتاج إلى إعادة تسجيل عامل جديد للوصول إلى الإدارة.'
        : 'Remove this MFA factor? You\'ll need to enroll a new one to access admin areas.',
    );
    if (!confirmed) return;
    const { error } = await unenrollMfaFactor(factorId);
    if (error) {
      addToast(error, 'error');
      return;
    }
    addToast(isAr ? 'تم الحذف' : 'Removed', 'success');
    const refreshed = await listMfaFactors();
    setFactors(refreshed.factors);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <UserCircle size={22} className="text-copper" />
        <h1 className="text-xl font-bold text-chocolate">
          {isAr ? 'ملفي الشخصي' : 'My Profile'}
        </h1>
      </div>

      {/* Identity / read-only */}
      <div className="card p-4 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-charcoal/50 font-bold">
          {isAr ? 'الهوية' : 'Identity'}
        </div>
        <Row label={isAr ? 'البريد الإلكتروني' : 'Email'} value={me.email} />
        <Row
          label={isAr ? 'الملف' : 'Profile'}
          value={myProfile ? (isAr ? myProfile.label_ar : myProfile.label_en) : '—'}
          badge={myProfile?.is_admin ? (isAr ? 'مسؤول' : 'admin') : null}
        />
        <Row
          label={isAr ? 'الأدوار' : 'Roles'}
          value={
            myRoles.length === 0
              ? '—'
              : myRoles.map((r) => (isAr ? r.label_ar : r.label_en)).join('، ')
          }
        />
        <Row
          label={isAr ? 'الحالة' : 'Status'}
          value={me.is_active ? (isAr ? 'نشط' : 'Active') : (isAr ? 'معطّل' : 'Inactive')}
        />
      </div>

      {/* Push notifications — per device, so it lives with the user rather
          than in admin settings. */}
      <NotificationSettings />

      {/* Name (editable) */}
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-wider text-charcoal/50 font-bold mb-3">
          {isAr ? 'الاسم' : 'Name'}
        </div>
        <form onSubmit={handleNameSave} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-charcoal/60 mb-1 block">
                {isAr ? 'الاسم بالعربية' : 'Name (Arabic)'}
              </label>
              <input
                type="text"
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                className="form-input"
              />
            </div>
            <div>
              <label className="text-xs text-charcoal/60 mb-1 block">
                {isAr ? 'الاسم بالإنجليزية' : 'Name (English)'}
              </label>
              <input
                type="text"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                className="form-input"
              />
            </div>
          </div>
          <Button
            type="submit"
            disabled={savingName || (nameAr === me.name_ar && nameEn === me.name_en)}
          >
            {savingName && <Loader2 size={14} className="animate-spin" />}
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        </form>
      </div>

      {/* Password */}
      {isAuthAvailable() && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wider text-charcoal/50 font-bold mb-3 flex items-center gap-1.5">
            <KeyRound size={11} />
            {isAr ? 'كلمة المرور' : 'Password'}
          </div>
          <form onSubmit={(e) => void handlePasswordSave(e)} className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isAr ? 'كلمة المرور الجديدة' : 'New password'}
              className="form-input"
              autoComplete="new-password"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={isAr ? 'تأكيد كلمة المرور' : 'Confirm password'}
              className="form-input"
              autoComplete="new-password"
            />
            {pwError && <p className="text-sm text-red-600">{pwError}</p>}
            <Button type="submit" disabled={savingPw || !password}>
              {savingPw && <Loader2 size={14} className="animate-spin" />}
              {isAr ? 'تحديث كلمة المرور' : 'Update password'}
            </Button>
          </form>
        </div>
      )}

      {/* MFA — admins are forced to enroll; non-admins can opt in */}
      {isAuthAvailable() && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wider text-charcoal/50 font-bold mb-3 flex items-center gap-1.5">
            <ShieldCheck size={11} />
            {isAr ? 'التحقق بخطوتين' : 'Two-step verification'}
          </div>
          {mfaLoading ? (
            <div className="flex items-center gap-2 text-charcoal/60 text-sm">
              <Loader2 size={14} className="animate-spin" />
              <span>{isAr ? 'جاري التحميل…' : 'Loading…'}</span>
            </div>
          ) : factors.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-charcoal/70">
                {myProfile?.is_admin
                  ? isAr
                    ? 'مطلوب لحساب المسؤول. لم يتم تفعيله بعد.'
                    : 'Required for admin accounts. Not yet enrolled.'
                  : isAr
                    ? 'تفعيل اختياري لزيادة الأمان.'
                    : 'Optional, but strongly recommended.'}
              </p>
              <Button onClick={() => navigate('/auth/mfa-setup')}>
                {isAr ? 'تفعيل الآن' : 'Set up now'}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-sm text-charcoal/70 flex items-center gap-2">
                <ShieldCheck size={14} className="text-green-600" />
                {isAr
                  ? `مفعّل (${aal === 'aal2' ? 'تم التحقق في هذه الجلسة' : 'يحتاج تحقق'})`
                  : `Enabled (${aal === 'aal2' ? 'verified this session' : 'needs verification'})`}
              </div>
              {factors.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-sand/10 border border-sand/30"
                >
                  <span className="font-bold uppercase text-charcoal/60">{f.factor_type}</span>
                  <span className="flex-1">{f.friendly_name ?? '—'}</span>
                  <span className={f.status === 'verified' ? 'text-green-700' : 'text-amber-600'}>
                    {f.status}
                  </span>
                  <button
                    onClick={() => void handleUnenrollFactor(f.id)}
                    className="text-red-600 hover:underline"
                  >
                    {isAr ? 'حذف' : 'Remove'}
                  </button>
                </div>
              ))}
              {myProfile?.is_admin && aal === 'aal1' && (
                <div className="flex items-start gap-2 text-xs p-2 rounded bg-amber-50 border border-amber-200 text-amber-800">
                  <ShieldAlert size={14} className="shrink-0 mt-0.5" />
                  <span>
                    {isAr
                      ? 'الجلسة الحالية لم يتم التحقق منها بعد بـ MFA. سترى صفحة المصادقة عند زيارة أي قسم إداري.'
                      : 'This session is not yet MFA-verified. You\'ll be prompted when you visit an admin area.'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, badge }: { label: string; value: string; badge?: string | null }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-charcoal/50 w-24 shrink-0">{label}</span>
      <span className="text-charcoal flex-1">{value}</span>
      {badge && (
        <span className="text-[10px] uppercase font-bold text-copper bg-copper/10 border border-copper/20 px-1.5 py-0.5 rounded">
          {badge}
        </span>
      )}
    </div>
  );
}
