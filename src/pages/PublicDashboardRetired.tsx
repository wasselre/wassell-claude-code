import { useTranslation } from 'react-i18next';

/**
 * The Dashboards module was deleted (architecture cleanup D44, 2026-09-27),
 * which took the public share route with it. Anyone still holding an old
 * `/public/dashboard/:token` link lands here instead of on a blank page.
 */
export default function PublicDashboardRetired() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5EDE0] px-4">
      <p className="text-[#4A4E54] text-lg text-center">{t('dashboard.not_available')}</p>
    </div>
  );
}
