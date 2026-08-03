import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { isAuthAvailable } from '@/lib/auth';
import { Languages, Menu, User, LogOut, Loader2, Eye, X } from 'lucide-react';

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps = {}) {
  const { t } = useTranslation();
  const {
    language,
    setLanguage,
    models,
    users,
    profiles,
    currentUserId,
    setCurrentUser,
    previewProfileId,
    setPreviewProfile,
    authEmail,
    signOutAndClear,
  } = useAppStore();
  const location = useLocation();
  const params = useParams();
  const navigate = useNavigate();
  const isAr = language === 'ar';
  const [signingOut, setSigningOut] = useState(false);

  const authOn = isAuthAvailable();
  const currentUser = users.find((u) => u.id === currentUserId) ?? null;
  const displayName = currentUser
    ? (isAr ? currentUser.name_ar : currentUser.name_en)
    : (authEmail ?? (isAr ? 'بدون صلاحية' : 'No access'));

  // ── Profile preview ("view app as") ─────────────────────────────────
  // Gated on the REAL user's explicit grant — never on the previewed
  // profile — so the switcher and exit control stay reachable while a
  // restricted profile is being previewed.
  const canPreview = currentUser?.can_preview_profiles === true;
  const realProfile = currentUser ? profiles.find((p) => p.id === currentUser.profile_id) ?? null : null;
  const previewProfile =
    canPreview && previewProfileId ? profiles.find((p) => p.id === previewProfileId) ?? null : null;
  // Non-admin grantees can't preview an admin profile — the server would
  // reject everything anyway (RLS runs as the real user); hiding the
  // option avoids a broken half-admin UI.
  const previewOptions = profiles.filter(
    (p) => p.id !== currentUser?.profile_id && (realProfile?.is_admin === true || !p.is_admin),
  );

  const toggleLanguage = (): void => {
    const newLang = language === 'ar' ? 'en' : 'ar';
    setLanguage(newLang);
    void import('@/lib/i18n').then((mod) => {
      void mod.default.changeLanguage(newLang);
    });
  };

  const handleSignOut = async (): Promise<void> => {
    setSigningOut(true);
    await signOutAndClear();
    // The RequireAuth gate will redirect to /login as soon as authEmail
    // becomes null, so no explicit navigate() is required here.
    setSigningOut(false);
  };

  const getPageTitle = (): string => {
    const path = location.pathname;

    if (path === '/') return t('nav.home');
    if (path.startsWith('/builder')) return t('builder.title');
    if (path.startsWith('/workflow')) return t('workflow.title');
    if (path.startsWith('/dashboards')) return t('dashboard.title');
    if (path === '/settings') return isAr ? 'الإعدادات' : 'Settings';
    if (path.startsWith('/settings/translations')) return isAr ? 'إعدادات الترجمة' : 'Translation Settings';
    if (path.startsWith('/settings/profiles')) return isAr ? 'الصلاحيات' : 'Profiles';
    if (path.startsWith('/settings/roles')) return isAr ? 'الأدوار' : 'Roles';
    if (path.startsWith('/settings/users')) return isAr ? 'المستخدمون' : 'Users';

    if (path.startsWith('/model/')) {
      const modelName = params.modelName ?? path.split('/')[2];
      const model = models.find((m) => m.name === modelName);
      if (model) {
        const recordId = params.recordId;
        if (recordId) return `${t('records.edit_record')} — ${isAr ? model.label_ar : model.label_en}`;
        if (path.endsWith('/new')) return `${t('records.new_record')} — ${isAr ? model.label_ar : model.label_en}`;
        return isAr ? model.label_ar : model.label_en;
      }
    }

    return t('nav.home');
  };

  return (
    // `safe-top` keeps the header's contents clear of the notch when the app
    // runs standalone from the Home Screen; the translucent background still
    // extends up behind the status bar. Inert in a normal browser tab.
    <header className="safe-top sticky top-0 z-30 bg-cream-light/80 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 px-4 md:px-8 py-4">
        <div className="flex items-center gap-3 min-w-0">
          {onMenuClick && (
            <button
              onClick={onMenuClick}
              className="md:hidden p-2 -ms-1 rounded-lg hover:bg-white/60 text-charcoal/70 transition-colors"
              aria-label={isAr ? 'فتح القائمة' : 'Open menu'}
            >
              <Menu size={20} />
            </button>
          )}
          <h1 className="text-lg md:text-xl font-bold text-chocolate truncate">
            {getPageTitle()}
          </h1>
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {/* The Sales ⇄ Marketing switch lives at the top of the sidebar now
              (WorkspaceSwitcher) — a real segmented switch, not a header pill. */}

          {/* ── Profile preview switcher (explicit per-user grant only) ── */}
          {canPreview && previewOptions.length > 0 && (
            <div
              className={`flex items-center gap-1.5 pill ${previewProfile ? 'bg-gold/20 ring-1 ring-gold/50' : ''}`}
              title={isAr ? 'معاينة التطبيق بصلاحيات ملف شخصي آخر' : 'Preview the app as another profile'}
            >
              <Eye size={14} className={previewProfile ? 'text-terracotta' : 'text-charcoal/40'} />
              <select
                value={previewProfileId ?? ''}
                onChange={(e) => setPreviewProfile(e.target.value || null)}
                className="bg-transparent border-0 text-sm font-bold text-charcoal focus:ring-0 focus:outline-none cursor-pointer pe-5 appearance-none max-w-[9.5rem] truncate"
                style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%234A4E54' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: isAr ? '4px center' : 'calc(100% - 4px) center' }}
                aria-label={isAr ? 'معاينة كملف شخصي' : 'Preview as profile'}
              >
                <option value="">{isAr ? 'صلاحياتي' : 'My profile'}</option>
                {previewOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {isAr ? p.label_ar : p.label_en}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ── Current user ──────────────────────────────────────── */}
          {authOn ? (
            /* Production: clickable pill that takes the user to /profile. */
            authEmail && (
              <button
                onClick={() => navigate('/profile')}
                className="flex items-center gap-2 pill hover:bg-white/80 transition-colors"
                title={authEmail}
              >
                <User size={14} className="text-charcoal/40" />
                <span className="text-sm font-bold text-charcoal">{displayName}</span>
              </button>
            )
          ) : (
            /* Dev / local mode: keep the user-switcher dropdown for testing. */
            users.length > 0 && (
              <div className="flex items-center gap-2 pill">
                <User size={14} className="text-charcoal/40" />
                <select
                  value={currentUserId ?? users[0]?.id ?? ''}
                  onChange={(e) => {
                    if (e.target.value) setCurrentUser(e.target.value);
                  }}
                  className="bg-transparent border-0 text-sm font-bold text-charcoal focus:ring-0 focus:outline-none cursor-pointer pe-5 appearance-none"
                  style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%234A4E54' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: isAr ? '4px center' : 'calc(100% - 4px) center' }}
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {isAr ? u.name_ar : u.name_en}
                    </option>
                  ))}
                </select>
              </div>
            )
          )}

          {/* ── Sign out (only when auth is available and signed in) ─ */}
          {authOn && authEmail && (
            <button
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="pill hover:bg-white/60 transition-colors disabled:opacity-40"
              title={isAr ? 'تسجيل الخروج' : 'Sign out'}
              aria-label={isAr ? 'تسجيل الخروج' : 'Sign out'}
            >
              {signingOut ? <Loader2 size={15} className="animate-spin" /> : <LogOut size={15} />}
            </button>
          )}

          {/* ── Language toggle ───────────────────────────────────── */}
          <button onClick={toggleLanguage} className="pill">
            <Languages size={15} />
            {language === 'ar' ? 'EN' : 'AR'}
          </button>
        </div>
      </div>

      {/* ── Profile-preview banner — always visible while previewing, so
             the user can never get "stuck" inside a restricted profile
             (the exit button doesn't depend on any previewed permission). */}
      {previewProfile && (
        <div className="flex items-center justify-between gap-3 px-4 md:px-8 py-2 bg-gold/25 border-y border-gold/40">
          <span className="flex items-center gap-2 text-sm text-chocolate min-w-0">
            <Eye size={15} className="text-terracotta shrink-0" />
            <span className="truncate">
              {isAr ? (
                <>وضع المعاينة: أنت ترى التطبيق بصلاحيات «<b>{previewProfile.label_ar}</b>» — العرض فقط، وتبقى صلاحيات البيانات الفعلية كما هي.</>
              ) : (
                <>Preview mode: you are viewing the app as “<b>{previewProfile.label_en}</b>” — UI only; your real data access is unchanged.</>
              )}
            </span>
          </span>
          <button
            onClick={() => setPreviewProfile(null)}
            className="flex items-center gap-1 text-sm font-bold text-terracotta hover:text-chocolate shrink-0"
          >
            <X size={14} />
            {isAr ? 'إنهاء المعاينة' : 'Exit preview'}
          </button>
        </div>
      )}
    </header>
  );
}
