import { useState, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { flattenFields, canAggregateFieldType } from '@/lib/analytics';
import ConditionsEditor from './builder/ConditionsEditor';
import type { AggregationConfig, AggregationType, AnalyticsQuery, FilterCondition, FilterGroup } from '@/lib/analytics/types';
import type { MetricDefinition, WidgetFilterCondition } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

const AGG_TYPES: { value: AggregationType; ar: string; en: string }[] = [
  { value: 'count', ar: 'عدد', en: 'Count' },
  { value: 'count_distinct', ar: 'عدد مميز', en: 'Distinct' },
  { value: 'sum', ar: 'مجموع', en: 'Sum' },
  { value: 'avg', ar: 'متوسط', en: 'Average' },
  { value: 'min', ar: 'أدنى', en: 'Min' },
  { value: 'max', ar: 'أعلى', en: 'Max' },
  { value: 'percentage', ar: 'نسبة %', en: 'Percentage' },
];

interface Draft {
  id: string;
  label: string;
  source_model_id: string;
  aggType: AggregationType;
  aggFieldId: string;
  conditions: WidgetFilterCondition[];
  partConditions: WidgetFilterCondition[];
  created_at?: string;
}

function condsToGroup(conds: WidgetFilterCondition[]): FilterGroup | undefined {
  const valid = conds.filter((c) => c.field_id);
  if (valid.length === 0) return undefined;
  const conditions: FilterCondition[] = valid.map((c) => ({
    id: c.id,
    field: { kind: 'field', field_id: c.field_id, field_path: c.field_path === 'min' || c.field_path === 'max' ? c.field_path : undefined },
    operator: c.operator,
    value: c.value,
  }));
  return { mode: 'all', conditions };
}

export default function MetricsManagerModal({ open, onClose }: Props) {
  const { metricDefinitions, models, language, saveMetricDefinition, deleteMetricDefinition } = useAppStore();
  const isAr = language === 'ar';
  const [editing, setEditing] = useState<Draft | null>(null);

  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  const model = models.find((m) => m.id === editing?.source_model_id);
  const allFields = model ? flattenFields(model) : [];
  const needsField = editing && ['sum', 'avg', 'min', 'max', 'count_distinct'].includes(editing.aggType);
  const aggFields = allFields.filter((f) => editing && canAggregateFieldType(editing.aggType, f.type));

  const startNew = () =>
    setEditing({ id: uuid(), label: '', source_model_id: '', aggType: 'count', aggFieldId: '', conditions: [], partConditions: [] });

  const startEdit = (m: MetricDefinition) => {
    const agg = m.query.aggregation;
    setEditing({
      id: m.id,
      label: isAr ? m.label_ar : m.label_en,
      source_model_id: m.query.source_model_id,
      aggType: agg.type === 'ratio' ? 'count' : agg.type,
      aggFieldId: agg.field?.kind === 'field' ? agg.field.field_id : '',
      conditions: filterGroupToConds(m.query.filters),
      partConditions: agg.numerator ? filterGroupToConds(agg.numerator.filters) : [],
      created_at: m.created_at,
    });
  };

  const save = () => {
    if (!editing || !editing.label.trim() || !editing.source_model_id) return;
    if (needsField && !editing.aggFieldId) return;
    let aggregation: AggregationConfig;
    if (editing.aggType === 'percentage') {
      aggregation = { type: 'percentage', numerator: { source_model_id: editing.source_model_id, filters: condsToGroup(editing.partConditions), aggregation: { type: 'count' } } };
    } else if (editing.aggType === 'count') {
      aggregation = { type: 'count' };
    } else {
      aggregation = { type: editing.aggType, field: { kind: 'field', field_id: editing.aggFieldId } };
    }
    const query: AnalyticsQuery = { source_model_id: editing.source_model_id, filters: condsToGroup(editing.conditions), aggregation };
    const aggField = allFields.find((f) => f.id === editing.aggFieldId);
    const format = editing.aggType === 'percentage' ? { percent: true } : aggField?.type === 'currency' ? { currency: 'SAR' } : undefined;
    const now = new Date().toISOString();
    const label = editing.label.trim();
    saveMetricDefinition({
      id: editing.id,
      label_ar: label,
      label_en: label,
      query,
      format,
      is_system: false,
      created_at: editing.created_at ?? now,
      updated_at: now,
    });
    setEditing(null);
  };

  const patch = (p: Partial<Draft>) => setEditing((e) => (e ? { ...e, ...p } : e));

  return (
    <Modal open={open} onClose={onClose} title={isAr ? 'المقاييس' : 'Metrics'} maxWidth="max-w-2xl">
      {!editing ? (
        <div className="space-y-2">
          <p className="text-xs text-charcoal/50">{isAr ? 'مقاييس معرّفة لإعادة الاستخدام في عناصر اللوحة (مثل: الإيراد، نسبة الرد).' : 'Named, reusable measures for dashboard widgets (e.g. Revenue, Response Rate).'}</p>
          {metricDefinitions.length === 0 && <p className="text-sm text-charcoal/40">{isAr ? 'لا توجد مقاييس بعد' : 'No metrics yet'}</p>}
          {metricDefinitions.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-lg border border-sand/60 px-3 py-2">
              <span className="text-sm font-bold text-charcoal">{isAr ? m.label_ar : m.label_en}</span>
              <div className="flex gap-1">
                <button onClick={() => startEdit(m)} className="rounded p-1 text-charcoal/40 hover:bg-cream hover:text-charcoal"><Pencil size={14} /></button>
                <button onClick={() => deleteMetricDefinition(m.id)} className="rounded p-1 text-charcoal/30 hover:bg-red-50 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <button onClick={startNew} className="pill border-copper/30 text-xs text-copper hover:bg-copper/5"><Plus size={12} /> {isAr ? 'مقياس جديد' : 'New metric'}</button>
            <Button variant="ghost" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'اسم المقياس' : 'Metric name'}</label>
            <input value={editing.label} onChange={(e) => patch({ label: e.target.value })} className="form-input w-full text-sm" placeholder={isAr ? 'مثال: الإيراد' : 'e.g. Revenue'} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'النموذج المصدر' : 'Source model'}</label>
            <select value={editing.source_model_id} onChange={(e) => patch({ source_model_id: e.target.value, aggFieldId: '' })} className="form-input text-sm">
              <option value="">—</option>
              {models.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
            </select>
          </div>
          {editing.source_model_id && (
            <div>
              <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'القياس' : 'Aggregation'}</label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {AGG_TYPES.map((a) => (
                  <button key={a.value} onClick={() => patch({ aggType: a.value })} className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${editing.aggType === a.value ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>{isAr ? a.ar : a.en}</button>
                ))}
              </div>
              {needsField && (
                <select value={editing.aggFieldId} onChange={(e) => patch({ aggFieldId: e.target.value })} className="form-input text-sm">
                  <option value="">— {isAr ? 'اختر حقلاً' : 'Choose field'} —</option>
                  {aggFields.map((f) => <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>)}
                </select>
              )}
              {editing.aggType === 'percentage' && (
                <div className="mt-2 rounded-lg border border-sand/60 p-2">
                  <ConditionsEditor conditions={editing.partConditions} onChange={(c) => patch({ partConditions: c })} allFields={allFields} label={isAr ? 'شرط البسط (النسبة من)' : 'Numerator (% of records matching)'} compact />
                  <p className="mt-1 text-[11px] text-charcoal/40">{isAr ? 'المقام = كل السجلات ضمن النطاق' : 'Denominator = all records in scope'}</p>
                </div>
              )}
              <div className="mt-3 border-t border-sand/50 pt-3">
                <ConditionsEditor conditions={editing.conditions} onChange={(c) => patch({ conditions: c })} allFields={allFields} />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setEditing(null)}>{isAr ? 'رجوع' : 'Back'}</Button>
            <Button onClick={save} disabled={!editing.label.trim() || !editing.source_model_id || (!!needsField && !editing.aggFieldId)}>{isAr ? 'حفظ' : 'Save'}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function filterGroupToConds(group: FilterGroup | undefined): WidgetFilterCondition[] {
  if (!group) return [];
  return group.conditions
    .filter((c) => c.field.kind === 'field')
    .map((c) => ({
      id: c.id,
      field_id: c.field.kind === 'field' ? c.field.field_id : '',
      field_path: c.field.kind === 'field' ? c.field.field_path : undefined,
      operator: c.operator as WidgetFilterCondition['operator'],
      value: c.value,
    }));
}
