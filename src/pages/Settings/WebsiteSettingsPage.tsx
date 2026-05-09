import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Bridge route that opens the public website's singleton config record
 * (model `site_settings`) directly in the standard record form. This
 * exists so the Settings page can offer a "Website Settings" card that
 * jumps straight to the editor — bypassing the model list view, which
 * is unhelpful for a one-record config model.
 *
 * The model is hidden from the main Sidebar by name (see Sidebar.tsx
 * `SETTINGS_ONLY_MODEL_NAMES`) so the only entry point is from here.
 *
 * Behavior:
 *  - If a record exists, redirect to /model/site_settings/<id>.
 *  - If no record yet, redirect to /model/site_settings/new — the form
 *    will create the singleton on first save.
 *  - While the store is hydrating, render a small loading state.
 */
export default function WebsiteSettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  useEffect(() => {
    const model = models.find((m) => m.name === 'site_settings');
    if (!model) return;
    const existing = (records[model.id] ?? [])[0];
    const target = existing
      ? `/model/site_settings/${existing.id}`
      : `/model/site_settings/new`;
    navigate(target, { replace: true });
  }, [models, records, navigate]);

  return (
    <div className="flex items-center justify-center py-20 text-charcoal/40">
      <Loader2 size={20} className="animate-spin" />
      <span className="ms-2 text-sm">
        {t('common.loading', { defaultValue: isAr ? 'جارٍ التحميل...' : 'Loading...' })}
      </span>
    </div>
  );
}
