import { useMemo, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppModel, AppRecord } from '@/types';
import { useSv, optOf, Pill, PageHeader, Modal } from './components/shared';

export default function CategoriesPage() {
  const { isAr, m, rows } = useSv();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const [editing, setEditing] = useState<AppRecord | 'new' | null>(null);

  const categories = useMemo(
    () => [...rows(m.categories)].sort((a, b) => Number(a.data.display_order ?? 99) - Number(b.data.display_order ?? 99)),
    [m.categories, rows],
  );

  async function toggleActive(c: AppRecord) {
    const res = await saveRecord({ ...c, data: { ...c.data, is_active: !(c.data.is_active !== false) }, updated_at: new Date().toISOString() }, { expectedVersion: c.version ?? null });
    if (res.status === 'conflict') addToast(isAr ? 'تم التعديل من مستخدم آخر' : 'Edited elsewhere', 'error');
  }

  if (!m.categories) return null;

  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <PageHeader title={isAr ? 'تصنيفات أخطاء المبيعات' : 'Sales Mistake Categories'}
        subtitle={isAr ? 'إعداد تصنيفات الأخطاء ودرجاتها' : 'Configure mistake categories and deductions'}
        right={<Button onClick={() => setEditing('new')}><Plus size={16} /> {isAr ? 'إضافة تصنيف' : 'Add Category'}</Button>} />

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold text-charcoal/55 border-b border-sand/40">
              <th className="text-start px-3 py-2.5">{isAr ? 'اسم التصنيف' : 'Category'}</th>
              <th className="text-start px-3 py-2.5">{isAr ? 'الشدة' : 'Severity'}</th>
              <th className="text-start px-3 py-2.5">{isAr ? 'خصم الدرجة' : 'Deduction'}</th>
              <th className="text-start px-3 py-2.5">{isAr ? 'يتطلب تصحيح' : 'Correction'}</th>
              <th className="text-start px-3 py-2.5">{isAr ? 'مفعل' : 'Active'}</th>
              <th className="text-start px-3 py-2.5">{isAr ? 'الترتيب' : 'Order'}</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const sev = optOf(m.categories, 'default_severity', c.data.default_severity, isAr);
              const active = c.data.is_active !== false;
              return (
                <tr key={c.id} className="border-b border-sand/20 hover:bg-cream/40">
                  <td className="px-3 py-2.5 font-semibold text-charcoal">{(c.data.category_name as string) || '—'}</td>
                  <td className="px-3 py-2.5"><Pill label={sev.label} color={sev.color} /></td>
                  <td className="px-3 py-2.5">{typeof c.data.score_deduction === 'number' ? c.data.score_deduction : '—'}</td>
                  <td className="px-3 py-2.5">{c.data.requires_correction_by_default ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No')}</td>
                  <td className="px-3 py-2.5">
                    <button type="button" onClick={() => toggleActive(c)}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${active ? 'bg-green-100 text-green-700' : 'bg-charcoal/10 text-charcoal/60'}`}>
                      {active ? (isAr ? 'مفعل' : 'Active') : (isAr ? 'معطّل' : 'Off')}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">{(c.data.display_order as number) ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    <button type="button" title={isAr ? 'تعديل' : 'Edit'} onClick={() => setEditing(c)}
                      className="p-1.5 rounded-lg text-charcoal/60 hover:bg-copper/10 hover:text-copper"><Pencil size={15} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <CategoryEditor model={m.categories} record={editing === 'new' ? null : editing} isAr={isAr}
          nextOrder={categories.length + 1}
          onClose={() => setEditing(null)}
          onSave={async (data, base) => {
            const rec: AppRecord = base ?? { id: uuid(), model_id: m.categories!.id, data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as AppRecord;
            const res = await saveRecord({ ...rec, data, updated_at: new Date().toISOString() }, { expectedVersion: base?.version ?? null });
            if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر' : 'Edited elsewhere', 'error'); return; }
            addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
            setEditing(null);
          }} />
      )}
    </div>
  );
}

function CategoryEditor({ model, record, isAr, nextOrder, onClose, onSave }: {
  model: AppModel; record: AppRecord | null; isAr: boolean; nextOrder: number;
  onClose: () => void; onSave: (data: Record<string, unknown>, base: AppRecord | null) => void;
}) {
  const [d, setD] = useState<Record<string, unknown>>(() => ({
    is_active: true, display_order: nextOrder, requires_correction_by_default: false, ...(record?.data ?? {}),
  }));
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const sevField = model.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'default_severity');

  return (
    <Modal title={record ? (isAr ? 'تعديل التصنيف' : 'Edit Category') : (isAr ? 'إضافة تصنيف' : 'Add Category')} onClose={onClose} isAr={isAr}>
      <div className="space-y-3">
        <L label={isAr ? 'اسم التصنيف' : 'Category Name'}>
          <input className="form-input w-full" value={(d.category_name as string) ?? ''} onChange={(e) => set('category_name', e.target.value)} />
        </L>
        <L label={isAr ? 'الوصف' : 'Description'}>
          <textarea className="form-input w-full" rows={2} value={(d.description as string) ?? ''} onChange={(e) => set('description', e.target.value)} />
        </L>
        <div className="grid grid-cols-2 gap-3">
          <L label={isAr ? 'الشدة' : 'Severity'}>
            <select className="form-input w-full" value={(d.default_severity as string) ?? ''} onChange={(e) => set('default_severity', e.target.value)}>
              <option value="">—</option>
              {(sevField?.options ?? []).map((o) => <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
            </select>
          </L>
          <L label={isAr ? 'خصم الدرجة' : 'Score Deduction'}>
            <input type="number" className="form-input w-full" value={String(d.score_deduction ?? '')} onChange={(e) => set('score_deduction', e.target.value === '' ? '' : Number(e.target.value))} />
          </L>
        </div>
        <L label={isAr ? 'قالب التوجيه' : 'Coaching Template'}>
          <textarea className="form-input w-full" rows={2} value={(d.coaching_template as string) ?? ''} onChange={(e) => set('coaching_template', e.target.value)} />
        </L>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-charcoal">
            <input type="checkbox" checked={Boolean(d.requires_correction_by_default)} onChange={(e) => set('requires_correction_by_default', e.target.checked)} />
            {isAr ? 'يتطلب تصحيح افتراضياً' : 'Requires correction'}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-charcoal">
            <input type="checkbox" checked={d.is_active !== false} onChange={(e) => set('is_active', e.target.checked)} />
            {isAr ? 'مفعل' : 'Active'}
          </label>
        </div>
        <L label={isAr ? 'ترتيب العرض' : 'Display Order'}>
          <input type="number" className="form-input w-32" value={String(d.display_order ?? '')} onChange={(e) => set('display_order', e.target.value === '' ? '' : Number(e.target.value))} />
        </L>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button disabled={!d.category_name} onClick={() => onSave(d, record)}>{isAr ? 'حفظ' : 'Save'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs font-medium text-charcoal/60 mb-1">{label}</label>{children}</div>;
}
