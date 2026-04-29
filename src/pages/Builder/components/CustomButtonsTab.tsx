import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Plus, Trash2, Edit2, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppModel, CustomButton, CustomButtonLocation } from '@/types';

interface CustomButtonsTabProps {
  model: AppModel;
  onChange: (next: AppModel) => void;
}

/**
 * Builder tab — manage the user-defined buttons attached to a model.
 *
 * Each button stores: bilingual label, lucide icon name, where it renders
 * (record form / list view / both), and which workflow it triggers on
 * click. The workflow runs server-side with the clicked record as the
 * trigger context, so any `trigger_field` references in the workflow's
 * actions resolve against fields on that record.
 *
 * The actual rendering of buttons in record form / list view is wired up
 * separately — this tab only owns the configuration.
 */
export default function CustomButtonsTab({ model, onChange }: CustomButtonsTabProps) {
  const { workflows, language } = useAppStore();
  const isAr = language === 'ar';

  const buttons: CustomButton[] = model.schema.custom_buttons ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const writeButtons = (next: CustomButton[]): void => {
    onChange({
      ...model,
      schema: { ...model.schema, custom_buttons: next },
    });
  };

  const addButton = (): void => {
    const created: CustomButton = {
      id: uuid(),
      label_ar: '',
      label_en: '',
      icon: 'sparkles',
      locations: ['record_form'],
      action: { type: 'trigger_workflow', workflow_id: '' },
      enabled: true,
    };
    writeButtons([...buttons, created]);
    setExpandedId(created.id);
  };

  const patchButton = (id: string, patch: Partial<CustomButton>): void => {
    writeButtons(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const removeButton = (id: string): void => {
    writeButtons(buttons.filter((b) => b.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  // Workflows are filtered to ones that fire on the `button_click` event.
  // Workflows on other events (create / update / etc.) won't be triggered
  // by a button click anyway, so we don't list them here.
  const triggerableWorkflows = workflows.filter(
    (wf) => wf.trigger_event === 'button_click' && wf.trigger_model_id === model.id,
  );

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-charcoal">
            {isAr ? 'الأزرار المخصصة' : 'Custom Buttons'}
          </h2>
          <p className="text-sm text-charcoal/60 mt-1">
            {isAr
              ? 'أزرار تظهر داخل السجلات أو في قائمة السجلات وتشغّل سير عمل عند الضغط.'
              : 'Buttons that appear inside records or the list view and trigger a workflow on click.'}
          </p>
        </div>
        <Button onClick={addButton}>
          <Plus size={16} />
          {isAr ? 'زر جديد' : 'New Button'}
        </Button>
      </div>

      {buttons.length === 0 && (
        <div className="text-center py-12 text-charcoal/50 italic border-2 border-dashed border-sand/40 rounded-xl">
          {isAr
            ? 'لا توجد أزرار مخصصة. اضغط "زر جديد" لإضافة أول زر.'
            : 'No custom buttons yet. Click "New Button" to add one.'}
        </div>
      )}

      {buttons.map((btn) => {
        const expanded = expandedId === btn.id;
        const label = (isAr ? btn.label_ar : btn.label_en) || (isAr ? '(بدون اسم)' : '(unnamed)');
        const wf = workflows.find((w) => w.id === btn.action.workflow_id);
        const wfLabel = wf
          ? (isAr ? wf.label_ar : wf.label_en) || wf.id
          : isAr ? '(بدون سير عمل)' : '(no workflow)';
        return (
          <div
            key={btn.id}
            className={`border rounded-xl bg-white transition-colors ${
              expanded ? 'border-copper/40' : 'border-sand/40'
            }`}
          >
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : btn.id)}
              className="w-full flex items-center justify-between p-4 text-start"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${btn.color ?? model.color}15` }}
                >
                  <Sparkles size={16} style={{ color: btn.color ?? model.color }} />
                </div>
                <div>
                  <div className="font-bold text-charcoal">{label}</div>
                  <div className="text-xs text-charcoal/60 mt-0.5">
                    {btn.locations.length === 0
                      ? isAr ? 'بلا مكان' : 'no location'
                      : btn.locations
                          .map((l) =>
                            l === 'record_form'
                              ? isAr ? 'سجل' : 'record'
                              : isAr ? 'قائمة' : 'list',
                          )
                          .join(' · ')}
                    {' · '}
                    {wfLabel}
                    {btn.enabled === false && (isAr ? ' · معطّل' : ' · disabled')}
                  </div>
                </div>
              </div>
              {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>

            {expanded && (
              <div className="px-4 pb-4 pt-1 space-y-3 border-t border-sand/30">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-charcoal/60 mb-1">
                      {isAr ? 'الاسم (عربي)' : 'Label (Arabic)'}
                    </label>
                    <input
                      className="form-input w-full"
                      value={btn.label_ar}
                      onChange={(e) => patchButton(btn.id, { label_ar: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-charcoal/60 mb-1">
                      {isAr ? 'الاسم (إنجليزي)' : 'Label (English)'}
                    </label>
                    <input
                      className="form-input w-full"
                      value={btn.label_en}
                      onChange={(e) => patchButton(btn.id, { label_en: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-charcoal/60 mb-1">
                      {isAr ? 'الأيقونة (اسم Lucide)' : 'Icon (Lucide name)'}
                    </label>
                    <input
                      className="form-input w-full"
                      placeholder="sparkles"
                      value={btn.icon ?? ''}
                      onChange={(e) => patchButton(btn.id, { icon: e.target.value })}
                    />
                    <p className="text-xs text-charcoal/40 mt-1">
                      {isAr
                        ? 'أمثلة: sparkles · play · wand-2 · file-down'
                        : 'e.g. sparkles · play · wand-2 · file-down'}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-charcoal/60 mb-1">
                      {isAr ? 'لون الأيقونة (اختياري)' : 'Icon color (optional)'}
                    </label>
                    <input
                      type="color"
                      className="h-10 w-20 rounded border border-sand/40 cursor-pointer"
                      value={btn.color ?? model.color}
                      onChange={(e) => patchButton(btn.id, { color: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-charcoal/60 mb-1">
                    {isAr ? 'مكان الزر' : 'Location'}
                  </label>
                  <div className="flex gap-3 mt-1">
                    {(['record_form', 'record_list'] as CustomButtonLocation[]).map((loc) => {
                      const on = btn.locations.includes(loc);
                      return (
                        <label
                          key={loc}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                            on
                              ? 'border-copper/50 bg-copper/5 text-copper'
                              : 'border-sand/40 text-charcoal/60 hover:border-sand'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              patchButton(btn.id, {
                                locations: on
                                  ? btn.locations.filter((l) => l !== loc)
                                  : [...btn.locations, loc],
                              })
                            }
                          />
                          <span className="text-sm font-bold">
                            {loc === 'record_form'
                              ? isAr ? 'داخل السجل' : 'Inside record form'
                              : isAr ? 'في القائمة' : 'In list view'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-charcoal/60 mb-1">
                    {isAr ? 'سير العمل عند الضغط' : 'Workflow to trigger on click'}
                  </label>
                  <select
                    className="form-input w-full"
                    value={btn.action.workflow_id}
                    onChange={(e) =>
                      patchButton(btn.id, {
                        action: { type: 'trigger_workflow', workflow_id: e.target.value },
                      })
                    }
                  >
                    <option value="">
                      {isAr ? '— اختر سير عمل —' : '— Select a workflow —'}
                    </option>
                    {triggerableWorkflows.map((wf) => (
                      <option key={wf.id} value={wf.id}>
                        {isAr ? wf.label_ar : wf.label_en}
                      </option>
                    ))}
                  </select>
                  {triggerableWorkflows.length === 0 && (
                    <p className="text-xs text-amber-700 mt-1">
                      {isAr
                        ? 'لا توجد سير عمل بحدث "ضغطة زر" مرتبط بهذا النموذج. أضف سير عمل من صفحة أتمتة.'
                        : 'No workflows on this model with event "Button click" yet. Create one from the Workflows page first.'}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-sand/20">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={btn.enabled !== false}
                      onChange={(e) => patchButton(btn.id, { enabled: e.target.checked })}
                    />
                    {isAr ? 'الزر مفعّل' : 'Button enabled'}
                  </label>
                  <button
                    type="button"
                    onClick={() => removeButton(btn.id)}
                    className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700 px-3 py-1.5 rounded hover:bg-red-50"
                  >
                    <Trash2 size={14} />
                    {isAr ? 'حذف الزر' : 'Delete button'}
                  </button>
                </div>
              </div>
            )}

            {!expanded && (
              <button
                type="button"
                onClick={() => setExpandedId(btn.id)}
                className="w-full flex items-center justify-end gap-1 px-4 py-2 text-xs text-charcoal/50 hover:text-charcoal border-t border-sand/20"
              >
                <Edit2 size={12} />
                {isAr ? 'تعديل' : 'Edit'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
