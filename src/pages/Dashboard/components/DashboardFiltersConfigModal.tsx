import { useState, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { Plus, Trash2 } from 'lucide-react';
import { flattenFields } from '@/lib/analytics';
import type { DashboardFilter, DashboardFilterControl, ModelField } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  initial: DashboardFilter[];
  onSave: (filters: DashboardFilter[]) => void;
}

const CONTROLS: { value: DashboardFilterControl; ar: string; en: string }[] = [
  { value: 'date_range', ar: 'نطاق تاريخ', en: 'Date range' },
  { value: 'select', ar: 'اختيار', en: 'Select' },
  { value: 'search', ar: 'بحث', en: 'Search' },
];

/** Admin UI to define a dashboard's global filter controls. */
export default function DashboardFiltersConfigModal({ open, onClose, initial, onSave }: Props) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';
  const [filters, setFilters] = useState<DashboardFilter[]>(initial);

  useEffect(() => {
    if (open) setFilters(initial.map((f) => ({ ...f })));
  }, [open, initial]);

  const update = (id: string, patch: Partial<DashboardFilter>) =>
    setFilters((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (id: string) => setFilters((fs) => fs.filter((f) => f.id !== id));
  const add = () =>
    setFilters((fs) => [...fs, { id: uuid(), label_ar: '', label_en: '', control: 'select', ref_model_id: null, ref_field_id: null }]);

  const fieldsForControl = (modelId: string | null | undefined, control: DashboardFilterControl): ModelField[] => {
    const m = models.find((x) => x.id === modelId);
    if (!m) return [];
    const all = flattenFields(m);
    if (control === 'date_range') return all.filter((f) => f.type === 'date' || f.type === 'datetime');
    if (control === 'select') return all.filter((f) => ['dropdown', 'multiselect', 'assignee', 'section_selector'].includes(f.type));
    return all.filter((f) => ['text', 'textarea', 'email', 'phone', 'url', 'auto_id'].includes(f.type));
  };

  const handleSave = () => {
    // Keep only filters with a reference field; default the empty label side.
    const cleaned = filters
      .filter((f) => f.ref_model_id && f.ref_field_id)
      .map((f) => ({
        ...f,
        label_ar: f.label_ar.trim() || f.label_en.trim() || (isAr ? 'تصفية' : 'Filter'),
        label_en: f.label_en.trim() || f.label_ar.trim() || 'Filter',
      }));
    onSave(cleaned);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'تصفية اللوحة' : 'Dashboard filters'}
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button onClick={handleSave}>{isAr ? 'حفظ' : 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'عناصر تحكم تظهر أعلى اللوحة وتصفّي كل العناصر التي ترث تصفية اللوحة (بمطابقة اسم الحقل).'
            : 'Controls shown atop the dashboard; they filter every widget that inherits dashboard filters (matched by field slug).'}
        </p>
        {filters.length === 0 && <p className="text-sm text-charcoal/40">{isAr ? 'لا توجد عوامل تصفية بعد' : 'No filters yet'}</p>}
        {filters.map((f) => (
          <div key={f.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-sand/60 p-2">
            <div className="flex-1 min-w-[140px]">
              <label className="mb-0.5 block text-[11px] text-charcoal/50">{isAr ? 'الاسم' : 'Label'}</label>
              <input
                value={isAr ? f.label_ar : f.label_en}
                onChange={(e) => update(f.id, isAr ? { label_ar: e.target.value } : { label_en: e.target.value })}
                className="form-input w-full bg-white py-1 text-xs"
                placeholder={isAr ? 'مثال: الوكيل' : 'e.g. Agent'}
              />
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-charcoal/50">{isAr ? 'النوع' : 'Type'}</label>
              <select value={f.control} onChange={(e) => update(f.id, { control: e.target.value as DashboardFilterControl, ref_field_id: null })} className="form-input bg-white py-1 text-xs">
                {CONTROLS.map((c) => <option key={c.value} value={c.value}>{isAr ? c.ar : c.en}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-charcoal/50">{isAr ? 'النموذج' : 'Model'}</label>
              <select value={f.ref_model_id ?? ''} onChange={(e) => update(f.id, { ref_model_id: e.target.value || null, ref_field_id: null })} className="form-input bg-white py-1 text-xs">
                <option value="">—</option>
                {models.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[11px] text-charcoal/50">{isAr ? 'الحقل' : 'Field'}</label>
              <select value={f.ref_field_id ?? ''} onChange={(e) => update(f.id, { ref_field_id: e.target.value || null })} disabled={!f.ref_model_id} className="form-input bg-white py-1 text-xs disabled:opacity-40">
                <option value="">—</option>
                {fieldsForControl(f.ref_model_id, f.control).map((fld) => <option key={fld.id} value={fld.id}>{isAr ? fld.label_ar : fld.label_en}</option>)}
              </select>
            </div>
            <button onClick={() => remove(f.id)} className="mb-1 rounded p-1 text-charcoal/30 hover:bg-red-50 hover:text-red-500"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={add} className="pill border-copper/30 text-xs text-copper hover:bg-copper/5"><Plus size={12} /> {isAr ? 'إضافة عامل تصفية' : 'Add filter'}</button>
      </div>
    </Modal>
  );
}
