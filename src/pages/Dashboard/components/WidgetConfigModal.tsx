import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { translateLabel } from '@/lib/translateLabel';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { BarChart3, PieChart, TrendingUp, Hash, Table2, Plus, Trash2, Filter } from 'lucide-react';
import { getDefaultSize } from '@/lib/widgetLayout';
import type { DashboardWidget, WidgetType, WidgetConfig, WidgetFilterCondition, WidgetFilterOperator, ModelField } from '@/types';

interface WidgetConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (widget: DashboardWidget) => void;
  existingWidget?: DashboardWidget;
}

const WIDGET_TYPES: { type: WidgetType; icon: typeof Hash; labelKey: string; descKey: string }[] = [
  { type: 'stat', icon: Hash, labelKey: 'dashboard.widget_stat', descKey: 'dashboard.widget_stat_desc' },
  { type: 'bar_chart', icon: BarChart3, labelKey: 'dashboard.widget_bar', descKey: 'dashboard.widget_bar_desc' },
  { type: 'pie_chart', icon: PieChart, labelKey: 'dashboard.widget_pie', descKey: 'dashboard.widget_pie_desc' },
  { type: 'line_chart', icon: TrendingUp, labelKey: 'dashboard.widget_line', descKey: 'dashboard.widget_line_desc' },
  { type: 'table', icon: Table2, labelKey: 'dashboard.widget_table', descKey: 'dashboard.widget_table_desc' },
];

export default function WidgetConfigModal({ open, onClose, onSave, existingWidget }: WidgetConfigModalProps) {
  const { t } = useTranslation();
  const { models, language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [step, setStep] = useState<1 | 2>(existingWidget ? 2 : 1);
  const [widgetType, setWidgetType] = useState<WidgetType>(existingWidget?.type ?? 'stat');
  const [titleAr, setTitleAr] = useState(existingWidget?.title_ar ?? '');
  const [titleEn, setTitleEn] = useState(existingWidget?.title_en ?? '');
  const [sourceModelId, setSourceModelId] = useState(existingWidget?.source_model_id ?? '');
  const [configState, setConfigState] = useState<Record<string, unknown>>(
    existingWidget?.config ? { ...(existingWidget.config as unknown as Record<string, unknown>) } : {},
  );

  // Sync state when existingWidget changes (edit vs new)
  useEffect(() => {
    if (existingWidget) {
      setStep(2);
      setWidgetType(existingWidget.type);
      setTitleAr(existingWidget.title_ar);
      setTitleEn(existingWidget.title_en);
      setSourceModelId(existingWidget.source_model_id);
      setConfigState({ ...(existingWidget.config as unknown as Record<string, unknown>) });
    } else {
      setStep(1);
      setWidgetType('stat');
      setTitleAr('');
      setTitleEn('');
      setSourceModelId('');
      setConfigState({});
    }
  }, [existingWidget, open]);

  const selectedModel = models.find((m) => m.id === sourceModelId);
  const allFields = selectedModel?.schema.sections.flatMap((s) => s.fields) ?? [];
  const dropdownFields = allFields.filter((f) => f.type === 'dropdown' || f.type === 'multiselect');
  const dateFields = allFields.filter((f) => f.type === 'date' || f.type === 'datetime');

  const handleSave = () => {
    if (!titleAr || !titleEn || !sourceModelId) return;
    const config = buildConfig();
    const widget: DashboardWidget = {
      id: existingWidget?.id ?? uuid(),
      type: widgetType,
      title_ar: titleAr,
      title_en: titleEn,
      source_model_id: sourceModelId,
      config,
      x: existingWidget?.x ?? 0,
      y: existingWidget?.y ?? 0,
      w: existingWidget?.w ?? getDefaultSize(widgetType).w,
      h: existingWidget?.h ?? getDefaultSize(widgetType).h,
    };
    onSave(widget);
    onClose();
    resetForm();
  };

  const buildConfig = (): WidgetConfig => {
    const conditions = ((configState.conditions as WidgetFilterCondition[]) ?? []).filter((c) => c.field_id);
    switch (widgetType) {
      case 'stat':
        return { color: (configState.color as string) ?? '#B8734F', conditions };
      case 'bar_chart':
      case 'pie_chart':
        return { group_by_field_id: (configState.group_by_field_id as string) ?? '', conditions };
      case 'line_chart':
        return { date_field_id: (configState.date_field_id as string) ?? '', period: (configState.period as 'day' | 'week' | 'month') ?? 'month', conditions };
      case 'table':
        return { field_ids: (configState.field_ids as string[]) ?? [], sort_field_id: (configState.sort_field_id as string) ?? null, sort_direction: (configState.sort_direction as 'asc' | 'desc') ?? 'asc', max_rows: (configState.max_rows as number) ?? 10, conditions };
      default:
        return { color: '#B8734F', conditions };
    }
  };

  const resetForm = () => {
    setStep(1);
    setWidgetType('stat');
    setTitleAr('');
    setTitleEn('');
    setSourceModelId('');
    setConfigState({});
  };

  return (
    <Modal
      open={open}
      onClose={() => { resetForm(); onClose(); }}
      title={t('dashboard.add_widget')}
      maxWidth="max-w-xl"
      footer={
        step === 2 ? (
          <>
            <Button variant="ghost" onClick={() => setStep(1)}>{t('common.back')}</Button>
            <Button onClick={handleSave} disabled={!titleAr || !titleEn || !sourceModelId}>{t('common.save')}</Button>
          </>
        ) : undefined
      }
    >
      {step === 1 ? (
        <div className="grid grid-cols-2 gap-3">
          {WIDGET_TYPES.map((wt) => {
            const Icon = wt.icon;
            return (
              <button
                key={wt.type}
                onClick={() => { setWidgetType(wt.type); setStep(2); }}
                className="p-4 rounded-xl border border-sand hover:border-copper hover:bg-copper/5 transition-colors text-start"
              >
                <Icon size={24} className="text-copper mb-2" />
                <div className="font-bold text-sm text-charcoal">{t(wt.labelKey)}</div>
                <div className="text-xs text-charcoal/50">{t(wt.descKey)}</div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <Input
            label={isAr ? 'عنوان العنصر' : 'Widget Title'}
            value={isAr ? titleAr : titleEn}
            onChange={(e) => {
              // Only update the typed side; the other gets filled on blur.
              if (isAr) setTitleAr(e.target.value);
              else setTitleEn(e.target.value);
            }}
            onBlur={async (e) => {
              const typed = e.target.value.trim();
              if (!typed) return;
              const otherSide = isAr ? titleEn : titleAr;
              if (otherSide && otherSide.trim()) return;
              try {
                const labels = await translateLabel(typed, 'dashboard');
                if (isAr) setTitleEn(labels.label_en);
                else setTitleAr(labels.label_ar);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                addToast(
                  isAr ? `تعذرت ترجمة عنوان العنصر: ${msg}` : `Widget title translation failed: ${msg}`,
                  'error',
                );
              }
            }}
            required
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'مثال: إجمالي المبيعات' : 'e.g. Total Sales'}
          />
          <div>
            <label className="block text-sm font-bold text-charcoal mb-1">{t('dashboard.source_model')}</label>
            <select value={sourceModelId} onChange={(e) => setSourceModelId(e.target.value)} className="form-input text-sm">
              <option value="">—</option>
              {models.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
            </select>
          </div>

          {/* Type-specific config */}
          {(widgetType === 'bar_chart' || widgetType === 'pie_chart') && sourceModelId && (
            <div>
              <label className="block text-sm font-bold text-charcoal mb-1">{t('dashboard.group_by')}</label>
              <select value={(configState.group_by_field_id as string) ?? ''} onChange={(e) => setConfigState({ ...configState, group_by_field_id: e.target.value })} className="form-input text-sm">
                <option value="">—</option>
                {dropdownFields.map((f) => <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>)}
              </select>
            </div>
          )}

          {widgetType === 'line_chart' && sourceModelId && (
            <>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t('dashboard.date_field')}</label>
                <select value={(configState.date_field_id as string) ?? ''} onChange={(e) => setConfigState({ ...configState, date_field_id: e.target.value })} className="form-input text-sm">
                  <option value="">—</option>
                  {dateFields.map((f) => <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t('dashboard.period')}</label>
                <div className="flex gap-2">
                  {(['day', 'week', 'month'] as const).map((p) => (
                    <button key={p} onClick={() => setConfigState({ ...configState, period: p })} className={`px-3 py-1.5 rounded-lg text-sm border font-bold ${(configState.period ?? 'month') === p ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>
                      {t(`dashboard.period_${p}`)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {widgetType === 'table' && sourceModelId && (
            <>
              <div>
                <label className="block text-sm font-bold text-charcoal mb-1">{t('dashboard.fields_to_show')}</label>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {allFields.map((f) => (
                    <label key={f.id} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input type="checkbox" checked={((configState.field_ids as string[]) ?? []).includes(f.id)} onChange={() => {
                        const ids = (configState.field_ids as string[]) ?? [];
                        setConfigState({ ...configState, field_ids: ids.includes(f.id) ? ids.filter((x) => x !== f.id) : [...ids, f.id] });
                      }} className="w-3.5 h-3.5 rounded border-sand text-copper" />
                      {isAr ? f.label_ar : f.label_en}
                    </label>
                  ))}
                </div>
              </div>
              <Input label={t('dashboard.max_rows')} type="number" value={String((configState.max_rows as number) ?? 10)} onChange={(e) => setConfigState({ ...configState, max_rows: Number(e.target.value) })} />
            </>
          )}

          {/* Filter Conditions — available for all widget types after model is selected */}
          {sourceModelId && (
            <WidgetConditionsEditor
              conditions={(configState.conditions as WidgetFilterCondition[]) ?? []}
              onChange={(conditions) => setConfigState({ ...configState, conditions })}
              allFields={allFields}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

/** Multi-condition filter editor for dashboard widgets */
function WidgetConditionsEditor({
  conditions,
  onChange,
  allFields,
}: {
  conditions: WidgetFilterCondition[];
  onChange: (conditions: WidgetFilterCondition[]) => void;
  allFields: ModelField[];
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const operators: { value: WidgetFilterOperator; ar: string; en: string }[] = [
    { value: 'equals', ar: 'يساوي', en: 'equals' },
    { value: 'not_equals', ar: 'لا يساوي', en: 'not equals' },
    { value: 'contains', ar: 'يحتوي على', en: 'contains' },
    { value: 'greater_than', ar: 'أكبر من', en: 'greater than' },
    { value: 'less_than', ar: 'أصغر من', en: 'less than' },
    { value: 'is_empty', ar: 'فارغ', en: 'is empty' },
    { value: 'is_not_empty', ar: 'غير فارغ', en: 'is not empty' },
  ];

  const needsValue = (op: WidgetFilterOperator) => op !== 'is_empty' && op !== 'is_not_empty';

  const addCondition = () => {
    onChange([...conditions, { id: uuid(), field_id: '', operator: 'equals', value: '' }]);
  };

  const updateCondition = (id: string, updates: Partial<WidgetFilterCondition>) => {
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  // When the picked field changes, seed field_path only for range fields and
  // clear it otherwise — keeps stored conditions clean across type switches.
  const pickField = (id: string, nextFieldId: string) => {
    const nextField = allFields.find((f) => f.id === nextFieldId);
    const field_path = nextField?.type === 'range' ? 'min' : undefined;
    updateCondition(id, { field_id: nextFieldId, field_path, value: '' });
  };

  const deleteCondition = (id: string) => {
    onChange(conditions.filter((c) => c.id !== id));
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Filter size={14} className="text-charcoal/40" />
        <label className="text-sm font-bold text-charcoal">
          {isAr ? 'شروط التصفية' : 'Filter Conditions'}
        </label>
        {conditions.length > 0 && (
          <span className="text-xs text-copper bg-copper/10 px-1.5 py-0.5 rounded-full font-bold">{conditions.length}</span>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="space-y-2 mb-3">
          {conditions.map((cond) => {
            const selectedField = allFields.find((f) => f.id === cond.field_id);
            return (
              <div key={cond.id} className="flex items-center gap-2 p-2 bg-cream-light rounded-lg flex-wrap">
                {/* Field */}
                <select
                  value={cond.field_id}
                  onChange={(e) => pickField(cond.id, e.target.value)}
                  className="form-input text-xs py-1 flex-1 bg-white min-w-[120px]"
                >
                  <option value="">— {isAr ? 'حقل' : 'Field'} —</option>
                  {allFields.map((f) => (
                    <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>

                {/* Range sub-path picker (min vs max). Hidden for empty-checks
                    since they evaluate against the whole range value. */}
                {selectedField?.type === 'range'
                  && cond.operator !== 'is_empty'
                  && cond.operator !== 'is_not_empty' && (
                  <select
                    value={cond.field_path ?? 'min'}
                    onChange={(e) => updateCondition(cond.id, { field_path: e.target.value })}
                    className="form-input text-xs py-1 w-20 bg-white"
                    aria-label={isAr ? 'الحد' : 'Bound'}
                  >
                    <option value="min">{isAr ? 'الحد الأدنى' : 'Min'}</option>
                    <option value="max">{isAr ? 'الحد الأعلى' : 'Max'}</option>
                  </select>
                )}

                {/* Operator */}
                <select
                  value={cond.operator}
                  onChange={(e) => updateCondition(cond.id, { operator: e.target.value as WidgetFilterOperator })}
                  className="form-input text-xs py-1 w-28 bg-white"
                >
                  {operators.map((op) => (
                    <option key={op.value} value={op.value}>{isAr ? op.ar : op.en}</option>
                  ))}
                </select>

                {/* Value — data-aware based on field type */}
                {needsValue(cond.operator) && selectedField && (
                  selectedField.type === 'dropdown' || selectedField.type === 'multiselect' ? (
                    <select
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    >
                      <option value="">—</option>
                      {(selectedField.options ?? []).map((opt) => (
                        <option key={opt.id} value={opt.value}>{isAr ? opt.label_ar : opt.label_en}</option>
                      ))}
                    </select>
                  ) : selectedField.type === 'checkbox' ? (
                    <select
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value === 'true' })}
                      className="form-input text-xs py-1 w-20 bg-white"
                    >
                      <option value="true">{isAr ? 'نعم' : 'Yes'}</option>
                      <option value="false">{isAr ? 'لا' : 'No'}</option>
                    </select>
                  ) : selectedField.type === 'number' || selectedField.type === 'currency' || selectedField.type === 'range' ? (
                    <input
                      type="number"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value ? Number(e.target.value) : '' })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    />
                  ) : selectedField.type === 'date' ? (
                    <input
                      type="date"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    />
                  ) : (
                    <input
                      type="text"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                      placeholder="..."
                    />
                  )
                )}
                {needsValue(cond.operator) && !selectedField && (
                  <input
                    type="text"
                    value={String(cond.value ?? '')}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                    className="form-input text-xs py-1 flex-1 bg-white"
                    placeholder="..."
                  />
                )}

                <button onClick={() => deleteCondition(cond.id)} className="p-1 rounded hover:bg-red-50 text-charcoal/20 hover:text-red-500 shrink-0">
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={addCondition} className="pill text-xs text-copper border-copper/30 hover:bg-copper/5">
        <Plus size={12} />
        {isAr ? 'إضافة شرط' : 'Add condition'}
      </button>
    </div>
  );
}
