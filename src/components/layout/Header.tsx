import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { isAuthAvailable } from '@/lib/auth';
import { Languages, Menu, User, LogOut, Loader2 } from 'lucide-react';

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
    currentUserId,
    setCurrentUser,
    authEmail,
    signOutAndClear,
  } = useAppStore();
  const location = useLocation();
  const params = useParams();
  const isAr = language === 'ar';
  const [signingOut, setSigningOut] = useState(false);

  const authOn = isAuthAvailable();
  const currentUser = users.find((u) => u.id === currentUserId) ?? null;
  const displayName = currentUser
    ? (isAr ? currentUser.name_ar : currentUser.name_en)
    : (authEmail ?? (isAr ? 'بدون صلاحية' : 'No access'));

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
    <header className="sticky top-0 z-30 bg-cream-light/80 backdrop-blur-md">
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
          {/* ── Current user ──────────────────────────────────────── */}
          {authOn ? (
            /* Production: read-only pill showing the signed-in user. */
            authEmail && (
              <div className="flex items-center gap-2 pill" title={authEmail}>
                <User size={14} className="text-charcoal/40" />
                <span className="text-sm font-bold text-charcoal">{displayName}</span>
              </div>
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
    </header>
  );
}
