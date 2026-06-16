import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { translateLabel } from '@/lib/translateLabel';
import { ArrowRight, Save, Plus, Pencil, Trash2, Globe, Copy, LayoutGrid, SlidersHorizontal, RefreshCw, Sigma } from 'lucide-react';
import Button from '@/components/ui/Button';
import WidgetRenderer from './components/WidgetRenderer';
import WidgetBuilder from './components/builder/WidgetBuilder';
import DashboardFilterBar from './components/DashboardFilterBar';
import DashboardFiltersConfigModal from './components/DashboardFiltersConfigModal';
import MetricsManagerModal from './components/MetricsManagerModal';
import type { GlobalFilterState } from './lib/globalFilters';
import { refreshDashboardSnapshots } from './lib/snapshots';
import { autoLayoutWidgets, findPositionForNew } from '@/lib/widgetLayout';
import type { Dashboard, DashboardWidget } from '@/types';

export default function DashboardEditorPage() {
  const { dashboardId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { dashboards, models, saveDashboard, addToast, language } = useAppStore();
  const isAr = language === 'ar';

  const dashboard = dashboards.find((d) => d.id === dashboardId);
  const [showWidgetConfig, setShowWidgetConfig] = useState(false);
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | undefined>();
  const [showFiltersConfig, setShowFiltersConfig] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [filterState, setFilterState] = useState<GlobalFilterState>({});
  const [refreshing, setRefreshing] = useState(false);

  if (!dashboard) {
    return <div className="text-center py-20 text-charcoal/40">Dashboard not found</div>;
  }

  const handleSave = () => {
    saveDashboard({ ...dashboard, updated_at: new Date().toISOString() });
    addToast(t('toast.saved'), 'success');
  };


  const addWidget = (widget: DashboardWidget) => {
    const existing = dashboard.widgets.findIndex((w) => w.id === widget.id);
    if (existing >= 0) {
      // Editing existing widget -- keep its position
      const widgets = dashboard.widgets.map((w) => (w.id === widget.id ? widget : w));
      saveDashboard({ ...dashboard, widgets });
    } else {
      // New widget -- find a non-overlapping position
      const pos = findPositionForNew(dashboard.widgets, widget.w, widget.h);
      const widgets = [...dashboard.widgets, { ...widget, x: pos.x, y: pos.y }];
      saveDashboard({ ...dashboard, widgets });
    }
  };

  const fixLayout = () => {
    const fixed = autoLayoutWidgets(dashboard.widgets);
    saveDashboard({ ...dashboard, widgets: fixed });
    addToast(isAr ? 'تم إعادة ترتيب العناصر' : 'Widgets rearranged', 'success');
  };

  const deleteWidget = (widgetId: string) => {
    saveDashboard({ ...dashboard, widgets: dashboard.widgets.filter((w) => w.id !== widgetId) });
  };

  const refreshShared = async (dash: Dashboard) => {
    setRefreshing(true);
    try {
      const { widgets, refreshed, failed } = await refreshDashboardSnapshots(dash);
      saveDashboard({ ...dash, widgets, updated_at: new Date().toISOString() });
      addToast(
        isAr
          ? `تم تحديث ${refreshed} عنصر${failed ? ` (فشل ${failed})` : ''}`
          : `Refreshed ${refreshed} widget(s)${failed ? `, ${failed} failed` : ''}`,
        failed ? 'error' : 'success',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast(isAr ? `تعذّر تحديث البيانات: ${msg}` : `Refresh failed: ${msg}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const togglePublic = () => {
    const makingPublic = !dashboard.is_public;
    const next = {
      ...dashboard,
      is_public: makingPublic,
      public_token: makingPublic ? dashboard.public_token || uuid() : dashboard.public_token,
    };
    saveDashboard(next);
    if (makingPublic) void refreshShared(next);
  };

  const copyLink = () => {
    if (dashboard.public_token) {
      void navigator.clipboard.writeText(`${window.location.origin}/public/dashboard/${dashboard.public_token}`);
      addToast(t('toast.link_copied'), 'success');
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/dashboards')} className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal">
            <ArrowRight size={20} className="rtl:rotate-0 ltr:rotate-180" />
          </button>
          <input
            value={isAr ? dashboard.label_ar : dashboard.label_en}
            onChange={(e) => {
              // Update only the typed side; opposite side gets filled on blur
              // via the live translator.
              saveDashboard({
                ...dashboard,
                label_ar: isAr ? e.target.value : dashboard.label_ar,
                label_en: isAr ? dashboard.label_en : e.target.value,
              });
            }}
            onBlur={async (e) => {
              const typed = e.target.value.trim();
              if (!typed) return;
              const otherSide = isAr ? dashboard.label_en : dashboard.label_ar;
              if (otherSide && otherSide.trim()) return;
              try {
                const labels = await translateLabel(typed, 'dashboard');
                saveDashboard({
                  ...dashboard,
                  label_ar: isAr ? dashboard.label_ar : labels.label_ar,
                  label_en: isAr ? labels.label_en : dashboard.label_en,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                addToast(
                  isAr ? `تعذرت ترجمة اسم اللوحة: ${msg}` : `Dashboard name translation failed: ${msg}`,
                  'error',
                );
              }
            }}
            className="form-input py-1.5 text-sm w-56"
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'اسم اللوحة' : 'Dashboard name'}
          />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={togglePublic} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border font-bold ${dashboard.is_public ? 'border-green-300 bg-green-50 text-green-700' : 'border-sand text-charcoal'}`}>
            <Globe size={14} />
            {dashboard.is_public ? t('dashboard.make_private') : t('dashboard.make_public')}
          </button>
          {dashboard.is_public && (
            <button onClick={copyLink} className="p-2 rounded-lg border border-sand hover:bg-cream text-charcoal/40 hover:text-copper">
              <Copy size={14} />
            </button>
          )}
          {dashboard.is_public && (
            <Button variant="ghost" onClick={() => refreshShared(dashboard)} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              {isAr ? 'تحديث البيانات' : 'Refresh data'}
            </Button>
          )}
          {dashboard.widgets.length > 0 && (
            <Button variant="ghost" onClick={fixLayout}>
              <LayoutGrid size={16} />
              {isAr ? 'إعادة ترتيب' : 'Fix Layout'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setShowFiltersConfig(true)}>
            <SlidersHorizontal size={16} />
            {isAr ? 'التصفية' : 'Filters'}
          </Button>
          <Button variant="ghost" onClick={() => setShowMetrics(true)}>
            <Sigma size={16} />
            {isAr ? 'المقاييس' : 'Metrics'}
          </Button>
          <Button onClick={() => setShowWidgetConfig(true)}>
            <Plus size={16} />
            {t('dashboard.add_widget')}
          </Button>
          <Button onClick={handleSave}>
            <Save size={16} />
            {t('common.save')}
          </Button>
        </div>
      </div>

      <DashboardFilterBar filters={dashboard.filters} state={filterState} onChange={setFilterState} models={models} />

      {/* Widget Grid */}
      {dashboard.widgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30 border-2 border-dashed border-sand rounded-xl">
          <p className="font-bold">{isAr ? 'لا توجد عناصر بعد' : 'No widgets yet'}</p>
          <p className="text-sm mt-1">{isAr ? 'أضف عنصراً للبدء' : 'Add a widget to get started'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4 auto-rows-[80px]">
          {dashboard.widgets.map((widget) => (
            <div
              key={widget.id}
              className="bg-white rounded-xl border border-sand/50 overflow-hidden relative group"
              style={{
                gridColumn: `${widget.x + 1} / span ${widget.w}`,
                gridRow: `${widget.y + 1} / span ${widget.h}`,
              }}
            >
              {/* Widget header */}
              <div className="absolute top-0 inset-x-0 flex items-center justify-between px-3 py-1.5 bg-white/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <span className="text-xs font-bold text-charcoal/50 truncate">
                  {isAr ? widget.title_ar : widget.title_en}
                </span>
                <div className="flex gap-1">
                  <button onClick={() => { setEditingWidget(widget); setShowWidgetConfig(true); }} className="p-1 rounded hover:bg-cream text-charcoal/30 hover:text-charcoal">
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => deleteWidget(widget.id)} className="p-1 rounded hover:bg-red-50 text-charcoal/30 hover:text-red-500">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {/* Widget content */}
              <div className="p-3 h-full">
                <WidgetRenderer widget={widget} dashboardFilters={dashboard.filters} filterState={filterState} />
              </div>
            </div>
          ))}
        </div>
      )}

      <WidgetBuilder
        open={showWidgetConfig}
        onClose={() => { setShowWidgetConfig(false); setEditingWidget(undefined); }}
        onSave={addWidget}
        existingWidget={editingWidget}
      />

      <DashboardFiltersConfigModal
        open={showFiltersConfig}
        onClose={() => setShowFiltersConfig(false)}
        initial={dashboard.filters ?? []}
        onSave={(filters) => saveDashboard({ ...dashboard, filters, updated_at: new Date().toISOString() })}
      />

      <MetricsManagerModal open={showMetrics} onClose={() => setShowMetrics(false)} />
    </div>
  );
}
