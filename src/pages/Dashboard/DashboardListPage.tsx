import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Plus, Pencil, Trash2, LayoutDashboard, Copy, Globe, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import BackToSettings from '@/pages/Settings/components/BackToSettings';

export default function DashboardListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dashboards, language, saveDashboard, deleteDashboard, addToast } = useAppStore();
  const isAr = language === 'ar';

  const createDashboard = () => {
    const dashboard = {
      id: uuid(),
      label_ar: isAr ? 'لوحة جديدة' : 'New Dashboard',
      label_en: 'New Dashboard',
      widgets: [],
      is_public: false,
      public_token: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    saveDashboard(dashboard);
    navigate(`/dashboards/${dashboard.id}`);
  };

  const togglePublic = (dashboard: typeof dashboards[0]) => {
    saveDashboard({
      ...dashboard,
      is_public: !dashboard.is_public,
      public_token: !dashboard.is_public ? uuid() : dashboard.public_token,
    });
  };

  const copyLink = (token: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}/public/dashboard/${token}`);
    addToast(t('toast.link_copied'), 'success');
  };

  return (
    <div>
      <BackToSettings />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-charcoal">{t('dashboard.title')}</h1>
        <Button onClick={createDashboard}>
          <Plus size={16} />
          {t('dashboard.new')}
        </Button>
      </div>

      {dashboards.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <LayoutDashboard size={48} className="mb-4" />
          <p className="text-lg font-bold">{t('dashboard.no_dashboards')}</p>
          <p className="text-sm">{t('dashboard.create_first')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {dashboards.map((db) => (
            <div key={db.id} className="bg-white rounded-xl border border-sand/50 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-bold text-charcoal">{isAr ? db.label_ar : db.label_en}</h3>
                  <p className="text-xs text-charcoal/40 mt-1">
                    {db.widgets.length} {isAr ? 'عنصر' : 'widget(s)'}
                  </p>
                </div>
                {db.is_public ? (
                  <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                    <Globe size={10} />
                    {t('common.public')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs font-bold text-charcoal/40 bg-cream px-2 py-0.5 rounded-full">
                    <Lock size={10} />
                    {t('common.private')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate(`/dashboards/${db.id}`)} className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal">
                  <Pencil size={16} />
                </button>
                <button onClick={() => togglePublic(db)} className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal" title={db.is_public ? t('dashboard.make_private') : t('dashboard.make_public')}>
                  {db.is_public ? <Lock size={16} /> : <Globe size={16} />}
                </button>
                {db.is_public && db.public_token && (
                  <button onClick={() => copyLink(db.public_token!)} className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-copper">
                    <Copy size={16} />
                  </button>
                )}
                <button onClick={() => { deleteDashboard(db.id); addToast(t('toast.deleted'), 'success'); }} className="p-2 rounded-lg hover:bg-red-50 text-charcoal/40 hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
