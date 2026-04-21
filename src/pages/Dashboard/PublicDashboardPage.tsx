import { useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import WidgetRenderer from './components/WidgetRenderer';

export default function PublicDashboardPage() {
  const { token } = useParams();
  const { t } = useTranslation();
  const { dashboards, initialized, initialize, language } = useAppStore();
  const isAr = language === 'ar';

  useEffect(() => {
    if (!initialized) void initialize();
  }, [initialized, initialize]);

  // Wait until store is initialized before checking
  if (!initialized) {
    return (
      <div className="min-h-screen bg-cream-light flex items-center justify-center">
        <p className="text-charcoal/40">{t('common.loading')}</p>
      </div>
    );
  }

  // Find dashboard by public_token - match on token only, is_public checked separately
  const dashboard = dashboards.find((d) => d.public_token === token);

  if (!dashboard || !dashboard.is_public) {
    return (
      <div className="min-h-screen bg-cream-light flex items-center justify-center">
        <div className="text-center">
          <img src="/assets/logo-full.png" alt="Wassel" className="w-24 mx-auto mb-6" />
          <p className="text-lg font-bold text-charcoal/50">{t('dashboard.not_available')}</p>
          <p className="text-sm text-charcoal/30 mt-2">
            {isAr ? `Token: ${token ?? '—'}` : `Token: ${token ?? '—'}`}
          </p>
          <p className="text-xs text-charcoal/20 mt-1">
            {isAr ? `عدد اللوحات: ${dashboards.length}` : `Total dashboards: ${dashboards.length}`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream-light">
      {/* Header */}
      <div className="bg-white border-b border-sand/20 px-6 py-4 flex items-center gap-4">
        <img src="/assets/logo-icon.png" alt="Wassel" className="w-8 h-8 object-contain" />
        <h1 className="text-lg font-bold text-chocolate">
          {isAr ? dashboard.label_ar : dashboard.label_en}
        </h1>
      </div>

      {/* Widgets */}
      <div className="p-6">
        {dashboard.widgets.length === 0 ? (
          <div className="text-center py-20 text-charcoal/30">
            <p className="font-bold">{isAr ? 'لا توجد عناصر في هذه اللوحة' : 'No widgets in this dashboard'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4 auto-rows-[80px]">
            {dashboard.widgets.map((widget) => (
              <div
                key={widget.id}
                className="bg-white rounded-xl border border-sand/20 overflow-hidden shadow-sm"
                style={{
                  gridColumn: `${widget.x + 1} / span ${widget.w}`,
                  gridRow: `${widget.y + 1} / span ${widget.h}`,
                }}
              >
                <div className="px-4 py-2.5 border-b border-sand/15">
                  <span className="text-sm font-bold text-charcoal/60">
                    {isAr ? widget.title_ar : widget.title_en}
                  </span>
                </div>
                <div className="p-3 h-[calc(100%-36px)]">
                  <WidgetRenderer widget={widget} isPublic />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
