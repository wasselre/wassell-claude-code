import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import WidgetRenderer from './components/WidgetRenderer';
import type { Dashboard } from '@/types';

export default function PublicDashboardPage() {
  const { token } = useParams();
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  // Fetch the dashboard via the get_public_dashboard RPC. The function
  // verifies BOTH the token AND is_public server-side; anon does NOT have
  // direct SELECT on the dashboards table any more, so this RPC is the
  // only path to read public dashboard data without authenticating.
  const [dashboard, setDashboard] = useState<Dashboard | null | 'loading'>('loading');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token || !supabase) {
        if (!cancelled) setDashboard(null);
        return;
      }
      const { data, error } = await supabase.rpc('get_public_dashboard', { p_token: token });
      if (cancelled) return;
      if (error || !data) {
        setDashboard(null);
        return;
      }
      // The RPC returns the row directly (single-row return type). When
      // there's no match Supabase returns null (or an empty result set).
      setDashboard(data as Dashboard);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (dashboard === 'loading') {
    return (
      <div className="min-h-screen bg-cream-light flex items-center justify-center">
        <p className="text-charcoal/40">{t('common.loading')}</p>
      </div>
    );
  }

  if (!dashboard || !dashboard.is_public) {
    return (
      <div className="min-h-screen bg-cream-light flex items-center justify-center">
        <div className="text-center">
          <img src="/assets/logo-full.png" alt="Wassel" className="w-24 mx-auto mb-6" />
          <p className="text-lg font-bold text-charcoal/50">{t('dashboard.not_available')}</p>
          <p className="text-sm text-charcoal/30 mt-2">
            {isAr ? `Token: ${token ?? '—'}` : `Token: ${token ?? '—'}`}
          </p>
        </div>
      </div>
    );
  }

  const asOf = dashboard.widgets
    .map((w) => w.snapshot?.computed_at)
    .filter((x): x is string => !!x)
    .sort()
    .pop();

  return (
    <div className="min-h-screen bg-cream-light">
      {/* Header */}
      <div className="bg-white border-b border-sand/20 px-6 py-4 flex items-center gap-4">
        <img src="/assets/logo-castle.png" alt="Wassel" className="w-8 h-8 object-contain" />
        <h1 className="text-lg font-bold text-chocolate">
          {isAr ? dashboard.label_ar : dashboard.label_en}
        </h1>
        {asOf && (
          <span className="ms-auto text-xs text-charcoal/40">
            {isAr ? 'البيانات حتى' : 'Data as of'} {new Date(asOf).toLocaleString(isAr ? 'ar' : 'en')}
          </span>
        )}
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
