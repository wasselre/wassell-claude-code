import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Plus, Trash2, Play, UserCheck, ChevronDown, ChevronUp, Phone, Upload, Loader2 } from 'lucide-react';
import FieldValueInput from './FieldValueInput';
import { supabase } from '@/lib/supabase';
import type { WorkflowAction, WorkflowActionAssignUser, WorkflowActionCreateRecord, WorkflowActionHttpRequest, WorkflowActionOutboundIvr, WorkflowIvrOption, OutboundIvrDestination, HttpMethod, HttpHeaderPair, FieldMapping, ModelField, RoleFieldCondition, ConditionOperator, AppModel } from '@/types';

type DateOffsetUnit = 'min' | 'h' | 'd' | 'w' | 'mo' | 'y';
interface DateOffsetRow {
  id: string;
  op: '+' | '-';
  amount: string; // string so the input can be cleared while editing
  unit: DateOffsetUnit;
}

function parseDateExpression(expr: string): DateOffsetRow[] {
  const tokens = expr.match(/[+-]\s*\d+\s*(?:mo|min|d|w|y|h)/gi) ?? [];
  const rows: DateOffsetRow[] = [];
  for (const raw of tokens) {
    const m = raw.replace(/\s+/g, '').match(/^([+-])(\d+)(mo|min|d|w|y|h)$/i);
    if (!m) continue;
    rows.push({
      id: uuid(),
      op: m[1] as '+' | '-',
      amount: m[2]!,
      unit: m[3]!.toLowerCase() as DateOffsetUnit,
    });
  }
  return rows;
}

function serializeDateOffsets(rows: DateOffsetRow[]): string {
  return rows
    .map((r) => ({ ...r, n: parseInt(r.amount, 10) }))
    .filter((r) => Number.isFinite(r.n) && r.n > 0)
    .map((r) => `${r.op}${r.n}${r.unit}`)
    .join(' ');
}

interface ActionListProps {
  actions: WorkflowAction[];
  triggerFields: ModelField[];
  onChange: (actions: WorkflowAction[]) => void;
  // When true, drop the outer card / "Then..." header so this nests inside a
  // branch card.
  embedded?: boolean;
}

// Color-coded styling per action type. Full class strings (not template
// interpolation) so Tailwind's JIT scanner picks them up at build time.
interface ActionStyle {
  bg: string;      // header bg tint
  hoverBorder: string;
  badgeBg: string;
  badgeText: string;
  label_ar: string;
  label_en: string;
}
const ACTION_STYLE: Record<WorkflowAction['type'], ActionStyle> = {
  create_record: {
    bg: 'bg-emerald-500/5 border-b border-sand/25',
    hoverBorder: 'hover:border-emerald-400/40',
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-700',
    label_ar: 'إنشاء سجل',
    label_en: 'Create Record',
  },
  update_record: {
    bg: 'bg-sky-500/5 border-b border-sand/25',
    hoverBorder: 'hover:border-sky-400/40',
    badgeBg: 'bg-sky-500/15',
    badgeText: 'text-sky-700',
    label_ar: 'تحديث سجل',
    label_en: 'Update Record',
  },
  send_notification: {
    bg: 'bg-amber-500/5 border-b border-sand/25',
    hoverBorder: 'hover:border-amber-400/40',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-700',
    label_ar: 'إرسال إشعار',
    label_en: 'Send Notification',
  },
  assign_user: {
    bg: 'bg-violet-500/5 border-b border-sand/25',
    hoverBorder: 'hover:border-violet-400/40',
    badgeBg: 'bg-violet-500/15',
    badgeText: 'text-violet-700',
    label_ar: 'تعيين مستخدم',
    label_en: 'Assign User',
  },
  http_request: {
    bg: 'bg-rose-500/5 border-b border-sand/25',
    hoverBorder: 'hover:border-rose-400/40',
    badgeBg: 'bg-rose-500/15',
    badgeText: 'text-rose-700',
    label_ar: 'طلب HTTP',
    label_en: 'HTTP Request',
  },
  outbound_ivr: {
    bg: 'bg-copper/5 border-b border-sand/25',
    hoverBorder: 'hover:border-copper/40',
    badgeBg: 'bg-copper/15',
    badgeText: 'text-copper',
    label_ar: 'مكالمة آلية',
    label_en: 'Automated Call',
  },
};

export default function ActionList({ actions, triggerFields, onChange, embedded = false }: ActionListProps) {
  const { t } = useTranslation();
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  // Per-action collapse — keyed by action.id so it survives reorders. Default
  // expanded. Collapsed actions show just the header bar (number + type).
  const [collapsedActions, setCollapsedActions] = useState<Record<string, boolean>>({});
  const toggleActionCollapsed = (id: string) => {
    setCollapsedActions((c) => ({ ...c, [id]: !c[id] }));
  };
  const isActionCollapsed = (id: string) => !!collapsedActions[id];

  const addAction = () => {
    const action: WorkflowAction = {
      id: uuid(),
      type: 'create_record',
      target_model_id: '',
      field_mappings: [],
    };
    onChange([...actions, action]);
  };

  const updateAction = (id: string, updated: WorkflowAction) => {
    onChange(actions.map((a) => (a.id === id ? updated : a)));
  };

  const deleteAction = (id: string) => {
    onChange(actions.filter((a) => a.id !== id));
  };

  const body = (
    <>
      <div className="space-y-2.5">
        {actions.length === 0 && (
          <div className="text-center py-6 text-charcoal/35 text-sm bg-cream-light/60 rounded-xl border border-dashed border-sand/40">
            {isAr ? 'لا توجد إجراءات — أضف إجراءً للبدء.' : 'No actions yet — add one to get started.'}
          </div>
        )}
        {actions.map((action, idx) => {
          const style = ACTION_STYLE[action.type];
          return (
            <div key={action.id}>
              {idx > 0 && (
                <div className="flex items-center gap-2 my-1.5 ms-2">
                  <span className="text-[10px] font-bold tracking-wider uppercase text-emerald-700/70 bg-emerald-500/10 px-2 py-0.5 rounded">
                    {isAr ? 'ثم' : 'THEN'}
                  </span>
                  <div className="flex-1 h-px bg-sand/30" />
                </div>
              )}
              <div className={`group bg-white rounded-xl border border-sand/30 transition-colors overflow-hidden ${style.hoverBorder}`}>
                <div className={`flex items-center gap-2 px-3 py-2.5 ${style.bg}`}>
                  <span className={`shrink-0 w-7 h-7 rounded-md text-sm font-bold flex items-center justify-center ${style.badgeBg} ${style.badgeText}`}>{idx + 1}</span>
                  <select
                    value={action.type}
                    onChange={(e) => {
                      const type = e.target.value as WorkflowAction['type'];
                      if (type === 'send_notification') {
                        updateAction(action.id, { id: action.id, type: 'send_notification', message_ar: '', message_en: '' });
                      } else if (type === 'update_record') {
                        updateAction(action.id, { id: action.id, type: 'update_record', target_model_id: '', filter_field_id: '', filter_value_source: 'static', filter_value: '', field_mappings: [] });
                      } else if (type === 'assign_user') {
                        updateAction(action.id, { id: action.id, type: 'assign_user', assignment_field_id: '', mode: 'role_based', role_conditions: [], selection_strategy: 'least_workload' });
                      } else if (type === 'http_request') {
                        updateAction(action.id, { id: action.id, type: 'http_request', method: 'POST', url: '', headers: [], body_mode: 'json_template', body_template: '{\n  "operation_id": "{id}"\n}', timeout_ms: 30000 });
                      } else if (type === 'outbound_ivr') {
                        updateAction(action.id, {
                          id: action.id,
                          type: 'outbound_ivr',
                          to: { kind: 'trigger_field', field_name: '' },
                          audio_mode: 'tts',
                          tts_text: '',
                          tts_voice: 'Female',
                          options: [{ id: uuid(), digit: '1', label_ar: 'تأكيد', label_en: 'Confirm' }],
                          language: 'ar',
                        });
                      } else {
                        updateAction(action.id, { id: action.id, type: 'create_record', target_model_id: '', field_mappings: [] });
                      }
                    }}
                    className="form-input text-sm py-1.5 flex-1 font-bold"
                  >
                    <option value="create_record">{isAr ? ACTION_STYLE.create_record.label_ar : ACTION_STYLE.create_record.label_en}</option>
                    <option value="update_record">{isAr ? ACTION_STYLE.update_record.label_ar : ACTION_STYLE.update_record.label_en}</option>
                    <option value="send_notification">{isAr ? ACTION_STYLE.send_notification.label_ar : ACTION_STYLE.send_notification.label_en}</option>
                    <option value="assign_user">{isAr ? ACTION_STYLE.assign_user.label_ar : ACTION_STYLE.assign_user.label_en}</option>
                    <option value="http_request">{isAr ? ACTION_STYLE.http_request.label_ar : ACTION_STYLE.http_request.label_en}</option>
                    <option value="outbound_ivr">{isAr ? ACTION_STYLE.outbound_ivr.label_ar : ACTION_STYLE.outbound_ivr.label_en}</option>
                  </select>
                  <button
                    onClick={() => toggleActionCollapsed(action.id)}
                    className="p-1.5 rounded-md text-charcoal/30 hover:text-charcoal hover:bg-sand/20 transition-colors shrink-0"
                    aria-label={isActionCollapsed(action.id) ? (isAr ? 'توسيع' : 'Expand') : (isAr ? 'طي' : 'Collapse')}
                    title={isActionCollapsed(action.id) ? (isAr ? 'توسيع' : 'Expand') : (isAr ? 'طي' : 'Collapse')}
                  >
                    {isActionCollapsed(action.id) ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  </button>
                  <button
                    onClick={() => deleteAction(action.id)}
                    className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                    aria-label={isAr ? 'حذف' : 'Delete'}
                    title={isAr ? 'حذف' : 'Delete'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {!isActionCollapsed(action.id) && (
                <div className="p-3">
                  {action.type === 'send_notification' && (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={action.message_ar}
                        onChange={(e) => updateAction(action.id, { ...action, message_ar: e.target.value })}
                        className="form-input text-sm"
                        placeholder={isAr ? 'الرسالة (عربي)' : 'Message (Arabic)'}
                        dir="rtl"
                      />
                      <input
                        type="text"
                        value={action.message_en}
                        onChange={(e) => updateAction(action.id, { ...action, message_en: e.target.value })}
                        className="form-input text-sm"
                        placeholder={isAr ? 'الرسالة (إنجليزي)' : 'Message (English)'}
                        dir="ltr"
                      />
                    </div>
                  )}

                  {(action.type === 'create_record' || action.type === 'update_record') && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-bold text-charcoal/40 mb-1">{t('workflow.target_model')}</label>
                        <select
                          value={action.target_model_id}
                          onChange={(e) => updateAction(action.id, { ...action, target_model_id: e.target.value, field_mappings: [] })}
                          className="form-input text-sm"
                        >
                          <option value="">—</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>
                          ))}
                        </select>
                      </div>

                      {action.type === 'update_record' && (
                        <UpdateRecordFilter
                          action={action}
                          triggerFields={triggerFields}
                          onUpdate={(updated) => updateAction(action.id, updated)}
                        />
                      )}

                      {action.target_model_id && (
                        <FieldMappings
                          mappings={action.field_mappings}
                          targetModelId={action.target_model_id}
                          triggerFields={triggerFields}
                          onChange={(mappings) => updateAction(action.id, { ...action, field_mappings: mappings })}
                        />
                      )}

                      {action.type === 'create_record' && action.target_model_id && action.field_mappings.length > 0 && (
                        <CreateRecordDedup
                          action={action}
                          onUpdate={(updated) => updateAction(action.id, updated)}
                        />
                      )}
                    </div>
                  )}

                  {action.type === 'assign_user' && (
                    <AssignUserConfig
                      action={action}
                      triggerFields={triggerFields}
                      onUpdate={(updated) => updateAction(action.id, updated)}
                    />
                  )}

                  {action.type === 'http_request' && (
                    <HttpRequestConfig
                      action={action}
                      triggerFields={triggerFields}
                      onUpdate={(updated) => updateAction(action.id, updated)}
                    />
                  )}

                  {action.type === 'outbound_ivr' && (
                    <OutboundIvrConfig
                      action={action}
                      triggerFields={triggerFields}
                      allModels={models}
                      priorActions={actions.slice(0, idx)}
                      onUpdate={(updated) => updateAction(action.id, updated)}
                    />
                  )}
                </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={addAction}
        className="mt-3 w-full py-2 rounded-xl border border-dashed border-emerald-400/40 text-emerald-700 hover:bg-emerald-500/5 transition-colors text-sm font-bold flex items-center justify-center gap-1.5"
      >
        <Plus size={14} />
        {t('workflow.add_action')}
      </button>
    </>
  );

  if (embedded) return body;

  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
          <Play size={20} className="text-green-600" />
        </div>
        <h3 className="font-bold text-chocolate text-lg">{t('workflow.then')}</h3>
      </div>
      {body}
    </div>
  );
}

/** Data-aware filter for update_record actions */
function UpdateRecordFilter({
  action,
  triggerFields,
  onUpdate,
}: {
  action: Extract<WorkflowAction, { type: 'update_record' }>;
  triggerFields: ModelField[];
  onUpdate: (action: WorkflowAction) => void;
}) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  const targetModel = models.find((m) => m.id === action.target_model_id);
  const targetFields = targetModel?.schema.sections.flatMap((s) => s.fields) ?? [];
  const filterField = targetFields.find((f) => f.name === action.filter_field_id);
  const source = action.filter_value_source ?? 'static';

  return (
    <div className="p-3 bg-white rounded-xl border border-sand/20 space-y-2">
      <label className="block text-xs font-bold text-charcoal/40">
        {isAr ? 'البحث عن السجل حيث' : 'Find record where'}
      </label>
      <div className="flex items-center gap-2">
        <select
          value={action.filter_field_id}
          onChange={(e) => onUpdate({ ...action, filter_field_id: e.target.value, filter_value: '', filter_trigger_field_id: undefined })}
          className="form-input text-sm flex-1"
        >
          <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
          {targetFields.map((f) => (
            <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
          ))}
        </select>
        <span className="text-xs text-charcoal/30 font-bold">=</span>
      </div>
      {action.filter_field_id && (
        <div className="flex items-center gap-2">
          <select
            value={source}
            onChange={(e) => {
              const next = e.target.value as 'static' | 'trigger_field';
              onUpdate(next === 'trigger_field'
                ? { ...action, filter_value_source: 'trigger_field', filter_value: '' }
                : { ...action, filter_value_source: 'static', filter_trigger_field_id: undefined });
            }}
            className="form-input text-sm w-32 shrink-0"
            title={isAr ? 'مصدر القيمة' : 'Value source'}
          >
            <option value="static">{isAr ? 'قيمة ثابتة' : 'Static value'}</option>
            <option value="trigger_field">{isAr ? 'من حقل المصدر' : 'From trigger'}</option>
          </select>
          <div className="flex-1 min-w-0">
            {source === 'trigger_field' ? (
              <select
                value={action.filter_trigger_field_id ?? ''}
                onChange={(e) => onUpdate({ ...action, filter_trigger_field_id: e.target.value })}
                className="form-input text-sm w-full"
              >
                <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
                {triggerFields.map((f) => (
                  <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                ))}
              </select>
            ) : (
              <FieldValueInput
                field={filterField}
                value={action.filter_value}
                onChange={(val) => onUpdate({ ...action, filter_value: val })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Data-aware field mappings for create/update actions */
function FieldMappings({
  mappings,
  targetModelId,
  triggerFields,
  onChange,
}: {
  mappings: FieldMapping[];
  targetModelId: string;
  triggerFields: ModelField[];
  onChange: (mappings: FieldMapping[]) => void;
}) {
  const { t } = useTranslation();
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  const targetModel = models.find((m) => m.id === targetModelId);
  const targetFields = targetModel?.schema.sections.flatMap((s) => s.fields) ?? [];

  const addMapping = () => {
    onChange([...mappings, { id: uuid(), target_field_id: '', source_type: 'static', static_value: '' }]);
  };

  const updateMapping = (id: string, updates: Partial<FieldMapping>) => {
    onChange(mappings.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  };

  const deleteMapping = (id: string) => {
    onChange(mappings.filter((m) => m.id !== id));
  };

  return (
    <div>
      <label className="block text-xs font-bold text-charcoal/40 mb-2">{t('workflow.field_mapping')}</label>
      <div className="space-y-3">
        {mappings.map((mapping) => {
          const targetField = targetFields.find((f) => f.name === mapping.target_field_id);
          const isAssignee = targetField?.type === 'assignee';
          const isDateTarget = targetField?.type === 'date' || targetField?.type === 'datetime';
          const triggerDateFields = triggerFields.filter((f) => f.type === 'date' || f.type === 'datetime');

          return (
            <div key={mapping.id} className="p-3 bg-white rounded-xl border border-sand/15 space-y-2">
              {/* Target field row — takes the full width so long field names
                  stay readable inside the narrow branch card. Delete button
                  sits inline since it's compact. */}
              <div className="flex items-center gap-2">
                <select
                  value={mapping.target_field_id}
                  onChange={(e) => {
                    const newField = targetFields.find((f) => f.name === e.target.value);
                    const newIsAssignee = newField?.type === 'assignee';
                    updateMapping(mapping.id, {
                      target_field_id: e.target.value,
                      static_value: '',
                      trigger_field_id: '',
                      source_type: newIsAssignee ? 'static' : mapping.source_type,
                      role_id: undefined,
                      role_conditions: undefined,
                      selection_strategy: undefined,
                    });
                  }}
                  className="form-input text-xs py-1.5 flex-1 min-w-0"
                >
                  <option value="">— {isAr ? 'الحقل المستهدف' : 'Target field'} —</option>
                  {targetFields.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.type === 'assignee' ? '👤 ' : ''}{isAr ? f.label_ar : f.label_en}
                    </option>
                  ))}
                </select>
                {/* Delete moved up here so the source row below gets full width */}
                <button
                  onClick={() => deleteMapping(mapping.id)}
                  className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                  aria-label={isAr ? 'حذف' : 'Delete'}
                  title={isAr ? 'حذف' : 'Delete'}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Source-type row — own line, full width. Narrow 144px cap
                  clipped long labels ("Date expression", "From trigger record")
                  inside 400px branch cards. */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-charcoal/40 uppercase tracking-wider shrink-0">{isAr ? 'من' : 'from'}</span>
                <select
                  value={mapping.source_type}
                  onChange={(e) => {
                    const nextSource = e.target.value as FieldMapping['source_type'];
                    updateMapping(mapping.id, {
                      source_type: nextSource,
                      static_value: '',
                      trigger_field_id: '',
                      role_id: undefined,
                      role_conditions: undefined,
                      selection_strategy: undefined,
                      date_base: nextSource === 'date_expression' ? 'current_date' : undefined,
                      date_base_field_id: undefined,
                      date_expression: nextSource === 'date_expression' ? '+0d' : undefined,
                      formula_expression: nextSource === 'formula' ? '' : undefined,
                    });
                  }}
                  className="form-input text-xs py-1.5 flex-1 min-w-0"
                >
                  {isAssignee ? (
                    <>
                      <option value="static">{isAr ? 'مستخدم محدد' : 'Specific user'}</option>
                      <option value="role_variable">{isAr ? 'متغير (حسب الدور)' : 'Variable (by role)'}</option>
                    </>
                  ) : (
                    <>
                      <option value="static">{t('workflow.source_static')}</option>
                      <option value="trigger_field">{t('workflow.source_trigger')}</option>
                      <option value="current_date">{t('workflow.source_date')}</option>
                      <option value="current_user">{isAr ? 'المستخدم الحالي' : 'Current user'}</option>
                      <option value="record_id">{isAr ? 'معرّف السجل' : 'Record ID'}</option>
                      {isDateTarget && (
                        <option value="date_expression">{t('workflow.source_date_expression')}</option>
                      )}
                      <option value="formula">{t('workflow.source_formula')}</option>
                    </>
                  )}
                </select>
              </div>

              {/* Source value — data-aware */}
              {mapping.source_type === 'static' && mapping.target_field_id && (
                <FieldValueInput
                  field={targetField}
                  value={mapping.static_value}
                  onChange={(val) => updateMapping(mapping.id, { static_value: val })}
                />
              )}
              {mapping.source_type === 'trigger_field' && (
                <select
                  value={mapping.trigger_field_id ?? ''}
                  onChange={(e) => updateMapping(mapping.id, { trigger_field_id: e.target.value })}
                  className="form-input text-xs py-1.5"
                >
                  <option value="">— {isAr ? 'من حقل المصدر' : 'From trigger field'} —</option>
                  {triggerFields.map((f) => (
                    <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>
              )}
              {mapping.source_type === 'current_date' && (
                <div className="text-xs text-charcoal/30 py-1">
                  {isAr ? 'سيتم تعيين التاريخ والوقت الحالي تلقائياً' : 'Will automatically set to current date/time'}
                </div>
              )}
              {mapping.source_type === 'current_user' && (
                <div className="text-xs text-charcoal/30 py-1">
                  {isAr ? 'سيتم تعيين المستخدم الذي نفّذ الإجراء تلقائياً' : 'Will automatically set to the user who triggered this workflow'}
                </div>
              )}
              {mapping.source_type === 'record_id' && (
                <div className="text-xs text-charcoal/30 py-1">
                  {isAr ? 'سيتم تعيين معرّف السجل المُشغِّل تلقائياً' : 'Will automatically set to the trigger record ID'}
                </div>
              )}
              {mapping.source_type === 'date_expression' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-charcoal/40 w-24 shrink-0">
                      {t('workflow.date_expression_base')}
                    </label>
                    <select
                      value={mapping.date_base ?? 'current_date'}
                      onChange={(e) => updateMapping(mapping.id, {
                        date_base: e.target.value as 'current_date' | 'trigger_field',
                        date_base_field_id: undefined,
                      })}
                      className="form-input text-xs py-1.5 flex-1"
                    >
                      <option value="current_date">{t('workflow.date_expression_base_current')}</option>
                      <option value="trigger_field">{t('workflow.date_expression_base_field')}</option>
                    </select>
                  </div>
                  {mapping.date_base === 'trigger_field' && (
                    <select
                      value={mapping.date_base_field_id ?? ''}
                      onChange={(e) => updateMapping(mapping.id, { date_base_field_id: e.target.value })}
                      className="form-input text-xs py-1.5 w-full"
                    >
                      <option value="">— {isAr ? 'اختر حقل تاريخ' : 'Select a date field'} —</option>
                      {triggerDateFields.map((f) => (
                        <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-start gap-2">
                    <label className="text-xs text-charcoal/40 w-24 shrink-0 pt-1.5">
                      {t('workflow.date_expression_value')}
                    </label>
                    <div className="flex-1">
                      <DateOffsetEditor
                        value={mapping.date_expression ?? ''}
                        onChange={(next) => updateMapping(mapping.id, { date_expression: next })}
                      />
                    </div>
                  </div>
                </div>
              )}
              {/* Formula — computed value from trigger record fields */}
              {mapping.source_type === 'formula' && (
                <FormulaEditor
                  expression={mapping.formula_expression ?? ''}
                  triggerFields={triggerFields}
                  onChange={(next) => updateMapping(mapping.id, { formula_expression: next })}
                />
              )}
              {/* Role variable — dynamic user selection by role field conditions */}
              {mapping.source_type === 'role_variable' && targetField?.type === 'assignee' && (
                <RoleVariableConfig
                  mapping={mapping}
                  triggerFields={triggerFields}
                  onUpdate={(updates) => updateMapping(mapping.id, updates)}
                />
              )}
            </div>
          );
        })}
      </div>
      <button onClick={addMapping} className="mt-3 pill text-copper border-copper/30 hover:bg-copper/5 text-xs">
        <Plus size={12} />
        {isAr ? 'ربط حقل' : 'Map field'}
      </button>
    </div>
  );
}

/** Role variable configuration — dynamic assignee selection by role field conditions */
function RoleVariableConfig({
  mapping,
  triggerFields,
  onUpdate,
}: {
  mapping: FieldMapping;
  triggerFields: ModelField[];
  onUpdate: (updates: Partial<FieldMapping>) => void;
}) {
  const { t } = useTranslation();
  const { roles, language } = useAppStore();
  const isAr = language === 'ar';

  const selectedRole = roles.find((r) => r.id === mapping.role_id);
  const roleIsDangling = !!mapping.role_id && !selectedRole;
  const conditions = mapping.role_conditions ?? [];

  const addCondition = () => {
    onUpdate({
      role_conditions: [...conditions, { id: uuid(), field_name: '', operator: 'equals' as ConditionOperator, value: '' }],
    });
  };

  const updateCondition = (id: string, updates: Partial<RoleFieldCondition>) => {
    onUpdate({
      role_conditions: conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    });
  };

  const deleteCondition = (id: string) => {
    onUpdate({
      role_conditions: conditions.filter((c) => c.id !== id),
    });
  };

  return (
    <div className="p-3 bg-cream/30 rounded-xl border border-sand/15 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <UserCheck size={14} className="text-purple-500" />
        <span className="text-xs font-bold text-charcoal/50">
          {isAr ? 'تعيين ديناميكي حسب حقول الدور' : 'Dynamic assignment by role field values'}
        </span>
      </div>

      {/* Role selector */}
      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1">
          {isAr ? 'البحث في دور' : 'Search in role'}
        </label>
        <select
          value={selectedRole ? mapping.role_id ?? '' : ''}
          onChange={(e) => onUpdate({ role_id: e.target.value, role_conditions: [] })}
          className={`form-input text-xs py-1.5 ${roleIsDangling ? 'border-red-400' : ''}`}
        >
          <option value="">— {isAr ? 'اختر دور' : 'Select role'} —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{isAr ? r.label_ar : r.label_en}</option>
          ))}
        </select>
        {roleIsDangling && (
          <p className="text-xs text-red-500 font-bold mt-1">{t('workflow.role_deleted_warning')}</p>
        )}
      </div>

      {/* Conditions on role fields */}
      {selectedRole && (
        <div className="space-y-2">
          <label className="block text-xs font-bold text-charcoal/40">
            {isAr ? 'شروط (حيث حقول الدور تساوي...)' : 'Conditions (where role fields match...)'}
          </label>
          {conditions.map((cond) => {
            const selectedRoleFields = selectedRole.schema.sections.flatMap((s) => s.fields);
            const roleField = selectedRoleFields.find((f) => f.name === cond.field_name);
            const source = cond.value_source ?? 'static';
            return (
              <div key={cond.id} className="flex items-center gap-2 flex-wrap">
                <select
                  value={cond.field_name}
                  onChange={(e) => updateCondition(cond.id, { field_name: e.target.value, value: '', trigger_field_id: undefined })}
                  className="form-input text-xs py-1.5 flex-1 min-w-[80px]"
                >
                  <option value="">—</option>
                  {selectedRoleFields.map((f) => (
                    <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>
                <select
                  value={cond.operator}
                  onChange={(e) => updateCondition(cond.id, { operator: e.target.value as ConditionOperator })}
                  className="form-input text-xs py-1.5 w-24"
                >
                  <option value="equals">{isAr ? 'يساوي' : 'equals'}</option>
                  <option value="not_equals">{isAr ? 'لا يساوي' : '≠'}</option>
                  <option value="contains">{isAr ? 'يحتوي' : 'contains'}</option>
                  <option value="intersects">{isAr ? 'يتقاطع' : 'intersects'}</option>
                  <option value="greater_than">&gt;</option>
                  <option value="less_than">&lt;</option>
                </select>
                <select
                  value={source}
                  onChange={(e) => {
                    const next = e.target.value as 'static' | 'trigger_field';
                    updateCondition(cond.id, next === 'trigger_field'
                      ? { value_source: 'trigger_field', value: '' }
                      : { value_source: 'static', trigger_field_id: undefined });
                  }}
                  className="form-input text-xs py-1.5 w-20"
                  title={isAr ? 'مصدر القيمة' : 'Value source'}
                >
                  <option value="static">{isAr ? 'قيمة' : 'Value'}</option>
                  <option value="trigger_field">{isAr ? 'حقل' : 'Field'}</option>
                </select>
                {source === 'trigger_field' ? (
                  <select
                    value={cond.trigger_field_id ?? ''}
                    onChange={(e) => updateCondition(cond.id, { trigger_field_id: e.target.value })}
                    className="form-input text-xs py-1.5 flex-1 min-w-[80px]"
                  >
                    <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
                    {triggerFields.map((f) => (
                      <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                    ))}
                  </select>
                ) : !roleField ? (
                  <input
                    disabled
                    placeholder={isAr ? 'اختر حقل أولاً' : 'Pick a field first'}
                    className="form-input text-xs py-1.5 flex-1 min-w-[80px] opacity-50"
                  />
                ) : roleField.type === 'checkbox' ? (
                  <select
                    value={String(cond.value ?? '')}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value === 'true' })}
                    className="form-input text-xs py-1.5 w-20"
                  >
                    <option value="true">{isAr ? 'نعم' : 'Yes'}</option>
                    <option value="false">{isAr ? 'لا' : 'No'}</option>
                  </select>
                ) : roleField.type === 'dropdown' && roleField.options ? (
                  <select
                    value={String(cond.value ?? '')}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                    className="form-input text-xs py-1.5 flex-1 min-w-[80px]"
                  >
                    <option value="">—</option>
                    {roleField.options.map((o) => (
                      <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={roleField.type === 'number' ? 'number' : 'text'}
                    value={String(cond.value ?? '')}
                    onChange={(e) => updateCondition(cond.id, { value: roleField.type === 'number' ? Number(e.target.value) : e.target.value })}
                    className="form-input text-xs py-1.5 flex-1 min-w-[80px]"
                  />
                )}
                <button onClick={() => deleteCondition(cond.id)} className="p-1 rounded hover:bg-red-50 text-charcoal/20 hover:text-red-500">
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
          <button onClick={addCondition} className="text-xs text-copper hover:text-terracotta font-bold">
            + {isAr ? 'إضافة شرط' : 'Add condition'}
          </button>
        </div>
      )}

      {/* Selection strategy */}
      {selectedRole && (
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1.5">
            {isAr ? 'طريقة الاختيار' : 'Selection strategy'}
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => onUpdate({ selection_strategy: 'least_workload' })}
              className={`pill text-xs ${(mapping.selection_strategy ?? 'first_match') === 'least_workload' ? 'active' : ''}`}
            >
              {isAr ? 'أقل حمل عمل' : 'Least workload'}
            </button>
            <button
              onClick={() => onUpdate({ selection_strategy: 'first_match' })}
              className={`pill text-xs ${(mapping.selection_strategy ?? 'first_match') === 'first_match' ? 'active' : ''}`}
            >
              {isAr ? 'أول تطابق' : 'First match'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Assign User action configuration */
function AssignUserConfig({
  action,
  triggerFields,
  onUpdate,
}: {
  action: WorkflowActionAssignUser;
  triggerFields: ModelField[];
  onUpdate: (action: WorkflowAction) => void;
}) {
  const { t } = useTranslation();
  const { users, roles, language } = useAppStore();
  const isAr = language === 'ar';

  // Detect assignee field constraints
  const assigneeField = triggerFields.find((f) => f.name === action.assignment_field_id && f.type === 'assignee');
  const constrainedRoleIds = assigneeField?.assignee_role_ids ?? [];
  const availableRoles = constrainedRoleIds.length > 0 ? roles.filter((r) => constrainedRoleIds.includes(r.id)) : roles;

  // Filter users by assignee field's role constraints
  const activeUsers = users.filter((u) => {
    if (!u.is_active) return false;
    if (constrainedRoleIds.length === 0) return true;
    return u.role_assignments.some((ra) => constrainedRoleIds.includes(ra.role_id));
  });

  const selectedRole = roles.find((r) => r.id === action.role_id);
  const roleIsDangling = action.mode === 'role_based' && !!action.role_id && !selectedRole;

  const addCondition = () => {
    onUpdate({
      ...action,
      role_conditions: [...action.role_conditions, { id: uuid(), field_name: '', operator: 'equals' as ConditionOperator, value: '' }],
    });
  };

  const updateCondition = (id: string, updates: Partial<RoleFieldCondition>) => {
    onUpdate({
      ...action,
      role_conditions: action.role_conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    });
  };

  const deleteCondition = (id: string) => {
    onUpdate({
      ...action,
      role_conditions: action.role_conditions.filter((c) => c.id !== id),
    });
  };

  return (
    <div className="space-y-3">
      {/* Assignment field */}
      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1">
          {isAr ? 'حقل التعيين (يُكتب فيه معرّف المستخدم)' : 'Assignment field (stores user ID)'}
        </label>
        <select value={action.assignment_field_id} onChange={(e) => onUpdate({ ...action, assignment_field_id: e.target.value })} className="form-input text-sm">
          <option value="">—</option>
          {triggerFields.filter((f) => f.type === 'text' || f.type === 'lookup' || f.type === 'assignee').map((f) => (
            <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
          ))}
        </select>
      </div>

      {/* Mode */}
      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1.5">{isAr ? 'طريقة التعيين' : 'Assignment mode'}</label>
        <div className="flex gap-2">
          <button onClick={() => onUpdate({ ...action, mode: 'specific_user' })} className={`pill ${action.mode === 'specific_user' ? 'active' : ''}`}>
            {isAr ? 'مستخدم محدد' : 'Specific User'}
          </button>
          <button onClick={() => onUpdate({ ...action, mode: 'role_based' })} className={`pill ${action.mode === 'role_based' ? 'active' : ''}`}>
            {isAr ? 'حسب الدور' : 'Role-Based'}
          </button>
        </div>
      </div>

      {action.mode === 'specific_user' && (
        <select value={action.specific_user_id ?? ''} onChange={(e) => onUpdate({ ...action, specific_user_id: e.target.value })} className="form-input text-sm">
          <option value="">— {isAr ? 'اختر مستخدم' : 'Select user'} —</option>
          {activeUsers.map((u) => <option key={u.id} value={u.id}>{isAr ? u.name_ar : u.name_en} ({u.email})</option>)}
        </select>
      )}

      {action.mode === 'role_based' && (
        <div className="space-y-3">
          <div>
            <select
              value={selectedRole ? action.role_id ?? '' : ''}
              onChange={(e) => onUpdate({ ...action, role_id: e.target.value, role_conditions: [] })}
              className={`form-input text-sm ${roleIsDangling ? 'border-red-400' : ''}`}
            >
              <option value="">— {isAr ? 'اختر دور' : 'Select role'} —</option>
              {availableRoles.map((r) => <option key={r.id} value={r.id}>{isAr ? r.label_ar : r.label_en}</option>)}
            </select>
            {roleIsDangling && (
              <p className="text-xs text-red-500 font-bold mt-1">{t('workflow.role_deleted_warning')}</p>
            )}
          </div>

          {selectedRole && (
            <div className="p-3 bg-white rounded-xl border border-sand/15 space-y-2">
              <label className="block text-xs font-bold text-charcoal/40">{isAr ? 'شروط حقول الدور' : 'Role field conditions'}</label>
              {action.role_conditions.map((cond) => {
                const selectedRoleFields = selectedRole.schema.sections.flatMap((s) => s.fields);
                const roleField = selectedRoleFields.find((f) => f.name === cond.field_name);
                const source = cond.value_source ?? 'static';
                return (
                  <div key={cond.id} className="flex items-center gap-2 flex-wrap">
                    <select value={cond.field_name} onChange={(e) => updateCondition(cond.id, { field_name: e.target.value, value: '', trigger_field_id: undefined })} className="form-input text-xs py-1.5 flex-1 min-w-[100px]">
                      <option value="">—</option>
                      {selectedRoleFields.map((f) => <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>)}
                    </select>
                    <select value={cond.operator} onChange={(e) => updateCondition(cond.id, { operator: e.target.value as ConditionOperator })} className="form-input text-xs py-1.5 w-28">
                      <option value="equals">{isAr ? 'يساوي' : 'equals'}</option>
                      <option value="not_equals">{isAr ? 'لا يساوي' : 'not equals'}</option>
                      <option value="contains">{isAr ? 'يحتوي' : 'contains'}</option>
                      <option value="intersects">{isAr ? 'يتقاطع مع' : 'intersects'}</option>
                      <option value="greater_than">{isAr ? 'أكبر من' : 'greater than'}</option>
                      <option value="less_than">{isAr ? 'أصغر من' : 'less than'}</option>
                    </select>
                    <select
                      value={source}
                      onChange={(e) => {
                        const next = e.target.value as 'static' | 'trigger_field';
                        updateCondition(cond.id, next === 'trigger_field'
                          ? { value_source: 'trigger_field', value: '' }
                          : { value_source: 'static', trigger_field_id: undefined });
                      }}
                      className="form-input text-xs py-1.5 w-24"
                      title={isAr ? 'مصدر القيمة' : 'Value source'}
                    >
                      <option value="static">{isAr ? 'قيمة' : 'Value'}</option>
                      <option value="trigger_field">{isAr ? 'حقل' : 'Field'}</option>
                    </select>
                    {source === 'trigger_field' ? (
                      <select value={cond.trigger_field_id ?? ''} onChange={(e) => updateCondition(cond.id, { trigger_field_id: e.target.value })} className="form-input text-xs py-1.5 flex-1 min-w-[100px]">
                        <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
                        {triggerFields.map((f) => <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>)}
                      </select>
                    ) : !roleField ? (
                      <input disabled placeholder={isAr ? 'اختر حقل أولاً' : 'Pick a field first'} className="form-input text-xs py-1.5 flex-1 min-w-[100px] opacity-50" />
                    ) : roleField.type === 'checkbox' ? (
                      <select value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value === 'true' })} className="form-input text-xs py-1.5 w-20">
                        <option value="true">{isAr ? 'نعم' : 'Yes'}</option>
                        <option value="false">{isAr ? 'لا' : 'No'}</option>
                      </select>
                    ) : roleField.type === 'dropdown' && roleField.options ? (
                      <select value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: e.target.value })} className="form-input text-xs py-1.5 flex-1 min-w-[100px]">
                        <option value="">—</option>
                        {roleField.options.map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
                      </select>
                    ) : (
                      <input type={roleField.type === 'number' ? 'number' : 'text'} value={String(cond.value ?? '')} onChange={(e) => updateCondition(cond.id, { value: roleField.type === 'number' ? Number(e.target.value) : e.target.value })} className="form-input text-xs py-1.5 flex-1 min-w-[100px]" />
                    )}
                    <button onClick={() => deleteCondition(cond.id)} className="p-1 rounded hover:bg-red-50 text-charcoal/20 hover:text-red-500"><Trash2 size={12} /></button>
                  </div>
                );
              })}
              <button onClick={addCondition} className="text-xs text-copper hover:text-terracotta font-bold">+ {isAr ? 'إضافة شرط' : 'Add condition'}</button>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-charcoal/40 mb-1.5">{isAr ? 'طريقة الاختيار' : 'Selection strategy'}</label>
            <div className="flex gap-2">
              <button onClick={() => onUpdate({ ...action, selection_strategy: 'least_workload' })} className={`pill text-xs ${action.selection_strategy === 'least_workload' ? 'active' : ''}`}>
                {isAr ? 'أقل حمل عمل' : 'Least workload'}
              </button>
              <button onClick={() => onUpdate({ ...action, selection_strategy: 'first_match' })} className={`pill text-xs ${action.selection_strategy === 'first_match' ? 'active' : ''}`}>
                {isAr ? 'أول تطابق' : 'First match'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Duplicate guard for create_record: skip creation if a record in target_model_id already has the same value in the matched field. */
function CreateRecordDedup({
  action,
  onUpdate,
}: {
  action: WorkflowActionCreateRecord;
  onUpdate: (action: WorkflowAction) => void;
}) {
  const { t } = useTranslation();
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  const targetModel = models.find((m) => m.id === action.target_model_id);
  const targetFields = targetModel?.schema.sections.flatMap((s) => s.fields) ?? [];
  const mappedTargetFields = action.field_mappings
    .map((m) => targetFields.find((f) => f.name === m.target_field_id))
    .filter((f): f is NonNullable<typeof f> => !!f);

  return (
    <div className="p-3 bg-white rounded-xl border border-sand/20 space-y-2">
      <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          checked={!!action.skip_if_exists}
          onChange={(e) => onUpdate({ ...action, skip_if_exists: e.target.checked })}
          className="mt-0.5 accent-copper"
        />
        <span className="leading-tight">
          <span className="font-bold text-charcoal/60">{t('action.skip_if_exists')}</span>
          <span className="block text-charcoal/40">{t('action.skip_if_exists_hint')}</span>
        </span>
      </label>

      {action.skip_if_exists && (
        <div className="ps-6">
          <label className="block text-xs font-bold text-charcoal/40 mb-1">{t('action.dedup_field')}</label>
          <select
            value={action.dedup_target_field_id ?? ''}
            onChange={(e) => onUpdate({ ...action, dedup_target_field_id: e.target.value || undefined })}
            className="form-input text-xs py-1.5"
          >
            <option value="">— {isAr ? 'اختر حقل' : 'Select field'} —</option>
            {mappedTargetFields.map((f) => (
              <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
            ))}
          </select>
          {mappedTargetFields.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">
              {isAr ? 'أضف ربط حقل أولاً ليتم استخدامه كمفتاح للمقارنة.' : 'Add a field mapping first to use it as the match key.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Formula editor for workflow field mappings — structured row UI matching the
 * date-offset editor pattern. Each row is a term (field or number literal); rows
 * after the first carry an operator (+ − × ÷). Rows are serialized into the
 * canonical formula-engine grammar at commit time (e.g. "{price} * 0.05 + {fee}")
 * and reparsed on mount, so the stored shape stays a plain expression string.
 */
type FormulaBinOp = '+' | '-' | '*' | '/';
type FormulaTermKind = 'field' | 'number';

interface FormulaTerm {
  id: string;
  op: FormulaBinOp | null; // null only for the first term
  kind: FormulaTermKind;
  field_slug: string; // when kind === 'field' (includes .min/.max for range)
  number_value: string; // when kind === 'number'; string so the input can be cleared
}

function parseFormulaTerms(expr: string): FormulaTerm[] {
  const src = expr.trim();
  if (!src) return [];
  // Canonical grammar: operand (op operand)*. Operand = {slug} or {slug.path} or number.
  const operandRe = /\{[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?\}|-?\d+(?:\.\d+)?/gi;
  const matches: { value: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = operandRe.exec(src)) !== null) {
    matches.push({ value: m[0], index: m.index });
  }
  if (matches.length === 0) return [];
  const terms: FormulaTerm[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { value, index } = matches[i]!;
    let op: FormulaBinOp | null = null;
    if (i > 0) {
      const prev = matches[i - 1]!;
      const between = src.slice(prev.index + prev.value.length, index);
      const opChar = between.match(/[+\-*/]/);
      op = (opChar?.[0] ?? '+') as FormulaBinOp;
    }
    if (value.startsWith('{')) {
      terms.push({ id: uuid(), op, kind: 'field', field_slug: value.slice(1, -1), number_value: '' });
    } else {
      terms.push({ id: uuid(), op, kind: 'number', field_slug: '', number_value: value });
    }
  }
  return terms;
}

function serializeFormulaTerms(terms: FormulaTerm[]): string {
  return terms
    .map((t, i) => {
      const operand = t.kind === 'field'
        ? (t.field_slug ? `{${t.field_slug}}` : '')
        : (t.number_value.trim() !== '' ? t.number_value.trim() : '');
      if (!operand) return '';
      return i === 0 ? operand : `${t.op ?? '+'} ${operand}`;
    })
    .filter(Boolean)
    .join(' ');
}

function FormulaEditor({
  expression,
  triggerFields,
  onChange,
}: {
  expression: string;
  triggerFields: ModelField[];
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  // Field options for each term's field-picker (range fields expose .min/.max).
  const fieldOptions = useMemo(() => {
    const out: { slug: string; label: string }[] = [];
    for (const f of triggerFields) {
      if (f.type === 'section_mirror') continue;
      const base = isAr ? f.label_ar : f.label_en;
      if (f.type === 'range') {
        out.push({ slug: `${f.name}.min`, label: `${base} — ${t('fields.range_min')}` });
        out.push({ slug: `${f.name}.max`, label: `${base} — ${t('fields.range_max')}` });
      } else {
        out.push({ slug: f.name, label: base });
      }
    }
    return out;
  }, [triggerFields, isAr, t]);

  // Parse once from the stored expression into local rows. All edits commit back
  // to the parent via `onChange(serialize(rows))` so the stored shape stays canonical.
  const [rows, setRows] = useState<FormulaTerm[]>(() => {
    const parsed = parseFormulaTerms(expression);
    return parsed.length > 0 ? parsed : [{ id: uuid(), op: null, kind: 'field', field_slug: '', number_value: '' }];
  });

  const commit = (next: FormulaTerm[]) => {
    setRows(next);
    onChange(serializeFormulaTerms(next));
  };

  const updateRow = (id: string, updates: Partial<FormulaTerm>) => {
    commit(rows.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const addRow = () => {
    commit([...rows, { id: uuid(), op: '+', kind: 'field', field_slug: '', number_value: '' }]);
  };

  const removeRow = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    if (next.length === 0) {
      commit([{ id: uuid(), op: null, kind: 'field', field_slug: '', number_value: '' }]);
      return;
    }
    // First row never carries an operator. If we just removed row 0, clear op on new first row.
    if (next[0]!.op !== null) next[0] = { ...next[0]!, op: null };
    commit(next);
  };

  const opLabels: Record<FormulaBinOp, { ar: string; en: string }> = {
    '+': { ar: 'جمع (+)', en: 'Add (+)' },
    '-': { ar: 'طرح (−)', en: 'Subtract (−)' },
    '*': { ar: 'ضرب (×)', en: 'Multiply (×)' },
    '/': { ar: 'قسمة (÷)', en: 'Divide (÷)' },
  };

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => (
        <div key={row.id} className="flex items-center gap-2">
          {idx === 0 ? (
            <span className="text-[11px] text-charcoal/40 w-24 shrink-0">
              {t('workflow.formula_first_term')}
            </span>
          ) : (
            <select
              value={row.op ?? '+'}
              onChange={(e) => updateRow(row.id, { op: e.target.value as FormulaBinOp })}
              className="form-input text-xs py-1.5 w-24 shrink-0"
              aria-label={isAr ? 'العملية' : 'Operation'}
            >
              {(Object.keys(opLabels) as FormulaBinOp[]).map((op) => (
                <option key={op} value={op}>{isAr ? opLabels[op].ar : opLabels[op].en}</option>
              ))}
            </select>
          )}
          <select
            value={row.kind}
            onChange={(e) => updateRow(row.id, { kind: e.target.value as FormulaTermKind, field_slug: '', number_value: '' })}
            className="form-input text-xs py-1.5 w-20 shrink-0"
            aria-label={isAr ? 'النوع' : 'Type'}
          >
            <option value="field">{isAr ? 'حقل' : 'Field'}</option>
            <option value="number">{isAr ? 'رقم' : 'Number'}</option>
          </select>
          {row.kind === 'field' ? (
            <select
              value={row.field_slug}
              onChange={(e) => updateRow(row.id, { field_slug: e.target.value })}
              className="form-input text-xs py-1.5 flex-1"
            >
              <option value="">— {isAr ? 'اختر حقل' : 'Select a field'} —</option>
              {fieldOptions.map((f) => (
                <option key={f.slug} value={f.slug}>{f.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              value={row.number_value}
              onChange={(e) => updateRow(row.id, { number_value: e.target.value })}
              className="form-input text-xs py-1.5 flex-1"
              placeholder="0"
              step="any"
            />
          )}
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="p-1 rounded hover:bg-red-50 text-charcoal/25 hover:text-red-500 shrink-0"
              aria-label={isAr ? 'حذف' : 'Remove'}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-copper hover:text-terracotta font-bold"
      >
        + {t('workflow.formula_add_term')}
      </button>
    </div>
  );
}

/** Date offset editor — structured rows of [+/-] [number] [unit] that compose into a date_expression string. */
function DateOffsetEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const [rows, setRows] = useState<DateOffsetRow[]>(() => {
    const parsed = parseDateExpression(value);
    return parsed.length > 0 ? parsed : [{ id: uuid(), op: '+', amount: '', unit: 'd' }];
  });

  const commit = (next: DateOffsetRow[]) => {
    setRows(next);
    onChange(serializeDateOffsets(next));
  };

  const updateRow = (id: string, updates: Partial<DateOffsetRow>) => {
    commit(rows.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const addRow = () => {
    commit([...rows, { id: uuid(), op: '+', amount: '', unit: 'd' }]);
  };

  const removeRow = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    commit(next.length > 0 ? next : [{ id: uuid(), op: '+', amount: '', unit: 'd' }]);
  };

  const unitLabels: Record<DateOffsetUnit, { ar: string; en: string }> = {
    min: { ar: 'دقيقة', en: 'Minute' },
    h:   { ar: 'ساعة',  en: 'Hour'   },
    d:   { ar: 'يوم',   en: 'Day'    },
    w:   { ar: 'أسبوع', en: 'Week'   },
    mo:  { ar: 'شهر',   en: 'Month'  },
    y:   { ar: 'سنة',   en: 'Year'   },
  };

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <select
            value={row.op}
            onChange={(e) => updateRow(row.id, { op: e.target.value as '+' | '-' })}
            className="form-input text-xs py-1.5 w-24"
            aria-label={isAr ? 'العملية' : 'Operation'}
          >
            <option value="+">{isAr ? 'إضافة (+)' : 'Add (+)'}</option>
            <option value="-">{isAr ? 'طرح (−)' : 'Subtract (−)'}</option>
          </select>
          <input
            type="number"
            min={0}
            value={row.amount}
            onChange={(e) => updateRow(row.id, { amount: e.target.value.replace(/[^0-9]/g, '') })}
            placeholder="0"
            className="form-input text-xs py-1.5 w-20 text-center"
            aria-label={isAr ? 'العدد' : 'Amount'}
          />
          <select
            value={row.unit}
            onChange={(e) => updateRow(row.id, { unit: e.target.value as DateOffsetUnit })}
            className="form-input text-xs py-1.5 flex-1"
            aria-label={isAr ? 'الوحدة' : 'Unit'}
          >
            {(Object.keys(unitLabels) as DateOffsetUnit[]).map((u) => (
              <option key={u} value={u}>{isAr ? unitLabels[u].ar : unitLabels[u].en}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            className="p-1 rounded hover:bg-red-50 text-charcoal/25 hover:text-red-500"
            aria-label={isAr ? 'حذف' : 'Remove'}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-copper hover:text-terracotta font-bold"
      >
        + {isAr ? 'إضافة إزاحة' : 'Add offset'}
      </button>
    </div>
  );
}

// Config panel for the http_request action. Supports URL + method + headers
// + body mode with a JSON template. Templating uses {trigger_field_slug}.
function HttpRequestConfig({
  action,
  triggerFields,
  onUpdate,
}: {
  action: WorkflowActionHttpRequest;
  triggerFields: ModelField[];
  onUpdate: (updated: WorkflowActionHttpRequest) => void;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const headers = action.headers ?? [];

  const setHeaders = (next: HttpHeaderPair[]) => onUpdate({ ...action, headers: next });
  const addHeader = () =>
    setHeaders([...headers, { id: uuid(), name: '', value: '' }]);
  const updateHeader = (id: string, patch: Partial<HttpHeaderPair>) =>
    setHeaders(headers.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  const removeHeader = (id: string) => setHeaders(headers.filter((h) => h.id !== id));

  const timeoutSeconds = Math.round((action.timeout_ms ?? 30000) / 1000);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end">
        <div className="shrink-0">
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'الطريقة' : 'Method'}
          </label>
          <select
            value={action.method}
            onChange={(e) => onUpdate({ ...action, method: e.target.value as HttpMethod })}
            className="form-input text-sm font-bold"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-bold text-charcoal/40 mb-1">URL</label>
          <input
            type="url"
            dir="ltr"
            value={action.url}
            onChange={(e) => onUpdate({ ...action, url: e.target.value })}
            placeholder="https://…/functions/v1/inbox?slug=research-done"
            className="form-input text-sm font-mono"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-bold text-charcoal/40">
            {isAr ? 'الترويسات' : 'Headers'}
          </label>
          <button
            type="button"
            onClick={addHeader}
            className="text-xs text-copper hover:text-terracotta font-bold"
          >
            + {isAr ? 'إضافة ترويسة' : 'Add header'}
          </button>
        </div>
        {headers.length === 0 && (
          <div className="text-xs text-charcoal/35 py-1">
            {isAr ? 'لا توجد ترويسات (Content-Type سيُضاف تلقائياً)' : 'No headers (Content-Type is auto-added)'}
          </div>
        )}
        {headers.map((h) => (
          <div key={h.id} className="flex gap-2 items-center mb-1">
            <input
              type="text"
              dir="ltr"
              value={h.name}
              onChange={(e) => updateHeader(h.id, { name: e.target.value })}
              placeholder="Authorization"
              className="form-input text-xs flex-1 font-mono"
            />
            <input
              type="text"
              dir="ltr"
              value={h.value}
              onChange={(e) => updateHeader(h.id, { value: e.target.value })}
              placeholder="Bearer eyJ..."
              className="form-input text-xs flex-[2] font-mono"
            />
            <button
              type="button"
              onClick={() => removeHeader(h.id)}
              className="p-1 rounded hover:bg-red-50 text-charcoal/25 hover:text-red-500"
              aria-label={isAr ? 'حذف' : 'Remove'}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1">
          {isAr ? 'نوع الجسم' : 'Body mode'}
        </label>
        <select
          value={action.body_mode}
          onChange={(e) =>
            onUpdate({ ...action, body_mode: e.target.value as WorkflowActionHttpRequest['body_mode'] })
          }
          className="form-input text-sm"
        >
          <option value="none">{isAr ? 'بدون جسم' : 'No body'}</option>
          <option value="json_template">{isAr ? 'قالب JSON' : 'JSON template'}</option>
          <option value="form_mappings">{isAr ? 'خرائط حقول' : 'Field mappings'}</option>
        </select>
      </div>

      {action.body_mode === 'json_template' && (
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'القالب' : 'Template'}{' '}
            <span className="text-charcoal/35 font-normal">
              ({isAr ? 'استخدم' : 'use'} <code className="bg-sand/20 px-1 rounded">{'{field_slug}'}</code>)
            </span>
          </label>
          <textarea
            dir="ltr"
            value={action.body_template ?? ''}
            onChange={(e) => onUpdate({ ...action, body_template: e.target.value })}
            rows={6}
            className="form-input text-xs font-mono w-full"
            placeholder={'{\n  "operation_id": "{id}",\n  "status": "{status}"\n}'}
          />
          {triggerFields.length > 0 && (
            <div className="mt-1 text-[10px] text-charcoal/40">
              {isAr ? 'حقول متاحة:' : 'Available fields:'}{' '}
              {triggerFields.map((f) => (
                <code key={f.id} className="bg-sand/15 px-1 rounded mx-0.5">{`{${f.name}}`}</code>
              ))}
            </div>
          )}
        </div>
      )}

      {action.body_mode === 'form_mappings' && (
        <div className="text-xs text-charcoal/50 bg-cream-light/40 rounded-lg p-2 border border-sand/30">
          {isAr
            ? 'قريباً — استخدم "قالب JSON" الآن.'
            : 'Coming soon — use "JSON template" for now.'}
        </div>
      )}

      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1">
          {isAr ? 'المهلة (ثوان)' : 'Timeout (s)'}
        </label>
        <input
          type="number"
          min={1}
          max={120}
          value={timeoutSeconds}
          onChange={(e) => {
            const raw = parseInt(e.target.value, 10);
            if (Number.isFinite(raw)) {
              onUpdate({ ...action, timeout_ms: Math.max(1000, Math.min(120000, raw * 1000)) });
            }
          }}
          className="form-input text-sm w-24"
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// OutboundIvrConfig — editor for the `outbound_ivr` workflow action.
// Lets the user pick the phone field to dial, choose TTS vs a pre-uploaded
// audio file, author the script (with `{field_slug}` tokens), and define
// the DTMF menu options. Audio upload goes through /api/hatif/upload-audio
// inline — the returned URL is stored in `audio_file_url` on the action.
// ─────────────────────────────────────────────────────────────────
function OutboundIvrConfig({
  action,
  triggerFields,
  allModels,
  priorActions,
  onUpdate,
}: {
  action: WorkflowActionOutboundIvr;
  triggerFields: ModelField[];
  allModels: AppModel[];
  /** Actions earlier in the same branch — used for the `prev_action_output` source. */
  priorActions: WorkflowAction[];
  onUpdate: (a: WorkflowActionOutboundIvr) => void;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  // Normalize storage shape: old actions saved `to_field_id`; new ones save `to`.
  const destination: OutboundIvrDestination =
    action.to ?? { kind: 'trigger_field', field_name: action.to_field_id ?? '' };

  function setDestination(next: OutboundIvrDestination) {
    // Drop the legacy `to_field_id` whenever a new destination is written,
    // so the two shapes never disagree on the same action.
    const { to_field_id: _ignored, ...rest } = action;
    void _ignored;
    onUpdate({ ...rest, to: next });
  }

  // Per-source context.
  const triggerPhoneFields = triggerFields.filter((f) => f.type === 'phone');
  const triggerLookupFields = triggerFields.filter(
    (f) => f.type === 'lookup' && !!f.lookup_model_id,
  );
  const priorCreateActions = priorActions.filter(
    (a): a is Extract<WorkflowAction, { type: 'create_record' }> => a.type === 'create_record' && !!a.target_model_id,
  );

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleAudioUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('audioFile', file);
      // Attach the Supabase JWT — same pattern as the Haberchat client.
      const authHeaders: Record<string, string> = {};
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (token) authHeaders.Authorization = `Bearer ${token}`;
      }
      const res = await fetch('/api/hatif/upload-audio', { method: 'POST', body: form, headers: authHeaders });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const parsed = (await res.json()) as { url?: string };
      const url = parsed.url;
      if (!url) throw new Error('No URL returned from upload');
      onUpdate({ ...action, audio_file_url: url, audio_file_label: file.name });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function updateOption(id: string, patch: Partial<WorkflowIvrOption>) {
    onUpdate({ ...action, options: action.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  }
  function addOption() {
    const nextDigit = String(Math.min(9, action.options.length + 1));
    onUpdate({
      ...action,
      options: [...action.options, { id: uuid(), digit: nextDigit, label_ar: '', label_en: '' }],
    });
  }
  function removeOption(id: string) {
    onUpdate({ ...action, options: action.options.filter((o) => o.id !== id) });
  }

  return (
    <div className="space-y-3">
      {/* Destination — source picker + per-source sub-fields */}
      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-2">
          {isAr ? 'مصدر رقم الوجهة' : 'Destination source'}
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
          {(
            [
              { kind: 'trigger_field',      ar: 'حقل في المُشغِّل', en: 'Trigger field' },
              { kind: 'lookup',             ar: 'حقل مرجعي',        en: 'Lookup' },
              { kind: 'static',             ar: 'رقم ثابت',          en: 'Static number' },
              { kind: 'prev_action_output', ar: 'مخرج إجراء سابق',   en: 'Previous action' },
            ] as const
          ).map(({ kind, ar, en }) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                if (destination.kind === kind) return;
                // Reset sub-fields when switching source to avoid leaking stale ids.
                if (kind === 'trigger_field')      setDestination({ kind, field_name: '' });
                if (kind === 'lookup')             setDestination({ kind, lookup_field_name: '', target_phone_field_name: '' });
                if (kind === 'static')             setDestination({ kind, phone: '' });
                if (kind === 'prev_action_output') setDestination({ kind, action_id: '', phone_field_name: '' });
              }}
              className={`text-xs px-2 py-1.5 rounded-md border transition-colors text-center ${
                destination.kind === kind
                  ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                  : 'bg-white border-sand/40 text-charcoal/60 hover:bg-sand/10'
              }`}
            >
              {isAr ? ar : en}
            </button>
          ))}
        </div>

        {/* Per-source sub-fields */}
        {destination.kind === 'trigger_field' && (
          triggerFields.length === 0 ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
              {isAr ? 'اختر النموذج المشغّل أولاً من لوحة المُشغّل أعلاه.' : 'Pick a trigger model first (in the trigger panel above).'}
            </p>
          ) : triggerPhoneFields.length === 0 ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
              {isAr ? 'النموذج المشغّل لا يحتوي على حقل هاتف. أضف حقل من نوع "هاتف" في المنشئ أولاً.' : 'The trigger model has no phone field. Add a "Phone" field in the Builder first.'}
            </p>
          ) : (
            <select
              value={destination.field_name}
              onChange={(e) => setDestination({ kind: 'trigger_field', field_name: e.target.value })}
              className="form-input text-sm w-full"
            >
              <option value="">{isAr ? '— اختر حقل —' : '— Pick a phone field —'}</option>
              {triggerPhoneFields.map((f) => (
                <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
              ))}
            </select>
          )
        )}

        {destination.kind === 'lookup' && (
          triggerLookupFields.length === 0 ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
              {isAr ? 'النموذج المشغّل لا يحتوي على حقل مرجعي (Lookup).' : 'The trigger model has no lookup fields.'}
            </p>
          ) : (() => {
            const pickedLookup = triggerLookupFields.find((f) => f.name === destination.lookup_field_name);
            const targetModel = pickedLookup?.lookup_model_id
              ? allModels.find((m) => m.id === pickedLookup.lookup_model_id)
              : undefined;
            const targetPhoneFields = targetModel
              ? targetModel.schema.sections.flatMap((s) => s.fields).filter((f) => f.type === 'phone')
              : [];
            return (
              <div className="space-y-1.5">
                <select
                  value={destination.lookup_field_name}
                  onChange={(e) => setDestination({ kind: 'lookup', lookup_field_name: e.target.value, target_phone_field_name: '' })}
                  className="form-input text-sm w-full"
                >
                  <option value="">{isAr ? '— اختر الحقل المرجعي —' : '— Pick the lookup field —'}</option>
                  {triggerLookupFields.map((f) => (
                    <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>
                {pickedLookup && (
                  targetPhoneFields.length === 0 ? (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
                      {isAr
                        ? `النموذج "${targetModel ? (isAr ? targetModel.label_ar : targetModel.label_en) : ''}" لا يحتوي على حقل هاتف.`
                        : `Target model "${targetModel ? (isAr ? targetModel.label_ar : targetModel.label_en) : ''}" has no phone field.`}
                    </p>
                  ) : (
                    <select
                      value={destination.target_phone_field_name}
                      onChange={(e) => setDestination({ kind: 'lookup', lookup_field_name: destination.lookup_field_name, target_phone_field_name: e.target.value })}
                      className="form-input text-sm w-full"
                    >
                      <option value="">{isAr ? '— اختر حقل الهاتف في النموذج المرتبط —' : '— Pick a phone field on the linked model —'}</option>
                      {targetPhoneFields.map((f) => (
                        <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                      ))}
                    </select>
                  )
                )}
              </div>
            );
          })()
        )}

        {destination.kind === 'static' && (
          <input
            type="tel"
            dir="ltr"
            value={destination.phone}
            onChange={(e) => setDestination({ kind: 'static', phone: e.target.value })}
            placeholder="+9665XXXXXXXX"
            className="form-input text-sm w-full"
          />
        )}

        {destination.kind === 'prev_action_output' && (
          priorCreateActions.length === 0 ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
              {isAr
                ? 'لا يوجد إجراء "إنشاء سجل" قبل هذا الإجراء. أضف إجراء إنشاء سجل في موضع أعلى أولاً.'
                : 'No "Create Record" action exists before this one. Add a Create Record action earlier in the workflow first.'}
            </p>
          ) : (() => {
            const pickedAction = priorCreateActions.find((a) => a.id === destination.action_id);
            const targetModel = pickedAction ? allModels.find((m) => m.id === pickedAction.target_model_id) : undefined;
            const targetPhoneFields = targetModel
              ? targetModel.schema.sections.flatMap((s) => s.fields).filter((f) => f.type === 'phone')
              : [];
            // Each prior create_record action shows up as "Action N: Create in <Model>".
            const priorLabel = (a: Extract<WorkflowAction, { type: 'create_record' }>) => {
              const idx = priorActions.findIndex((p) => p.id === a.id);
              const m = allModels.find((mm) => mm.id === a.target_model_id);
              const mName = m ? (isAr ? m.label_ar : m.label_en) : (isAr ? '(بدون نموذج)' : '(no model)');
              return isAr ? `الإجراء ${idx + 1}: إنشاء في ${mName}` : `Action ${idx + 1}: Create in ${mName}`;
            };
            return (
              <div className="space-y-1.5">
                <select
                  value={destination.action_id}
                  onChange={(e) => setDestination({ kind: 'prev_action_output', action_id: e.target.value, phone_field_name: '' })}
                  className="form-input text-sm w-full"
                >
                  <option value="">{isAr ? '— اختر إجراء إنشاء سابق —' : '— Pick a prior Create Record action —'}</option>
                  {priorCreateActions.map((a) => (
                    <option key={a.id} value={a.id}>{priorLabel(a)}</option>
                  ))}
                </select>
                {pickedAction && (
                  targetPhoneFields.length === 0 ? (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
                      {isAr ? 'النموذج المُستهدف لا يحتوي على حقل هاتف.' : 'The target model has no phone field.'}
                    </p>
                  ) : (
                    <select
                      value={destination.phone_field_name}
                      onChange={(e) => setDestination({ kind: 'prev_action_output', action_id: destination.action_id, phone_field_name: e.target.value })}
                      className="form-input text-sm w-full"
                    >
                      <option value="">{isAr ? '— اختر حقل الهاتف —' : '— Pick a phone field —'}</option>
                      {targetPhoneFields.map((f) => (
                        <option key={f.id} value={f.name}>{isAr ? f.label_ar : f.label_en}</option>
                      ))}
                    </select>
                  )
                )}
              </div>
            );
          })()
        )}
      </div>

      {/* Audio mode */}
      <div>
        <label className="block text-xs font-bold text-charcoal/40 mb-1">
          {isAr ? 'مصدر الصوت' : 'Audio source'}
        </label>
        <div className="flex gap-2">
          {(['tts', 'audio'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onUpdate({ ...action, audio_mode: mode })}
              className={`flex-1 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                action.audio_mode === mode
                  ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                  : 'bg-white border-sand/40 text-charcoal/60 hover:bg-sand/10'
              }`}
            >
              {mode === 'tts'
                ? (isAr ? 'نص إلى كلام (TTS)' : 'Text-to-speech')
                : (isAr ? 'ملف صوتي' : 'Audio file')}
            </button>
          ))}
        </div>
      </div>

      {/* TTS text */}
      {action.audio_mode === 'tts' && (
        <>
          <div>
            <label className="block text-xs font-bold text-charcoal/40 mb-1">
              {isAr ? 'نص الرسالة' : 'Message text'}
            </label>
            <textarea
              value={action.tts_text ?? ''}
              onChange={(e) => onUpdate({ ...action, tts_text: e.target.value })}
              rows={3}
              dir={isAr ? 'rtl' : 'ltr'}
              placeholder={
                isAr
                  ? 'مثال: مرحباً {client_name}، اضغط 1 للتأكيد أو 2 للإلغاء'
                  : 'e.g. Hello {client_name}, press 1 to confirm or 2 to cancel'
              }
              className="form-input text-sm w-full"
            />
            <p className="mt-1 text-[11px] text-charcoal/50">
              {isAr ? 'استخدم {اسم_الحقل} لإدراج قيم من السجل.' : 'Use {field_slug} to insert record values.'}
            </p>
          </div>
          <div className="flex gap-4">
            <div>
              <label className="block text-xs font-bold text-charcoal/40 mb-1">
                {isAr ? 'الصوت' : 'Voice'}
              </label>
              <div className="flex gap-2">
                {(['Female', 'Male'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onUpdate({ ...action, tts_voice: v })}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      (action.tts_voice ?? 'Female') === v
                        ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                        : 'bg-white border-sand/40 text-charcoal/60 hover:bg-sand/10'
                    }`}
                  >
                    {v === 'Female' ? (isAr ? 'أنثى' : 'Female') : (isAr ? 'ذكر' : 'Male')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-charcoal/40 mb-1">
                {isAr ? 'لغة الرسالة' : 'Message language'}
              </label>
              <div className="flex gap-2">
                {(['ar', 'en'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => onUpdate({ ...action, language: l })}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                      (action.language ?? 'ar') === l
                        ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                        : 'bg-white border-sand/40 text-charcoal/60 hover:bg-sand/10'
                    }`}
                  >
                    {l === 'ar' ? 'العربية' : 'English'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Audio upload */}
      {action.audio_mode === 'audio' && (
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'ملف الصوت' : 'Audio file'}
          </label>
          {action.audio_file_url ? (
            <div className="flex items-center gap-2 text-sm bg-sand/10 border border-sand/30 rounded-md px-3 py-2">
              <Phone size={14} className="text-copper" />
              <span className="flex-1 truncate">{action.audio_file_label ?? action.audio_file_url}</span>
              <button
                type="button"
                onClick={() => onUpdate({ ...action, audio_file_url: undefined, audio_file_label: undefined })}
                className="text-xs text-charcoal/50 hover:text-red-500"
              >
                {isAr ? 'إزالة' : 'Remove'}
              </button>
            </div>
          ) : (
            <label className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-dashed border-sand/50 cursor-pointer hover:bg-sand/10">
              {uploading ? <Loader2 size={14} className="animate-spin text-copper" /> : <Upload size={14} />}
              <span>{uploading ? (isAr ? 'جارٍ الرفع…' : 'Uploading…') : (isAr ? 'رفع ملف صوتي' : 'Upload audio file')}</span>
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleAudioUpload(file);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          {uploadError && (
            <p className="mt-1 text-xs text-red-600">{uploadError}</p>
          )}
          <p className="mt-1 text-[11px] text-charcoal/50">
            {isAr
              ? 'الحد الأقصى 10 ميغابايت. يتم تحويله إلى WAV تلقائياً.'
              : 'Max 10 MB. Hatif converts it to WAV automatically.'}
          </p>
        </div>
      )}

      {/* Options / DTMF menu */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-bold text-charcoal/40">
            {isAr ? 'خيارات القائمة (DTMF)' : 'Menu options (DTMF)'}
          </label>
          <button
            type="button"
            onClick={addOption}
            className="text-xs text-copper hover:underline inline-flex items-center gap-1"
          >
            <Plus size={12} /> {isAr ? 'خيار' : 'Option'}
          </button>
        </div>
        <div className="space-y-1.5">
          {action.options.map((opt) => (
            <div key={opt.id} className="flex items-center gap-2">
              <select
                value={opt.digit}
                onChange={(e) => updateOption(opt.id, { digit: e.target.value })}
                className="form-input text-sm w-14"
              >
                {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <input
                type="text"
                value={opt.label_ar}
                onChange={(e) => updateOption(opt.id, { label_ar: e.target.value })}
                placeholder={isAr ? 'التسمية بالعربية' : 'Arabic label'}
                dir="rtl"
                className="form-input text-sm flex-1"
              />
              <input
                type="text"
                value={opt.label_en}
                onChange={(e) => updateOption(opt.id, { label_en: e.target.value })}
                placeholder="English label"
                dir="ltr"
                className="form-input text-sm flex-1"
              />
              <button
                type="button"
                onClick={() => removeOption(opt.id)}
                disabled={action.options.length === 1}
                title={action.options.length === 1 ? (isAr ? 'يجب وجود خيار واحد على الأقل' : 'At least one option required') : undefined}
                className="p-1.5 rounded-md text-charcoal/25 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-charcoal/25"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        {action.options.length === 0 && (
          <p className="text-xs text-red-600">
            {isAr ? 'مطلوب خيار واحد على الأقل.' : 'At least one option is required.'}
          </p>
        )}
      </div>
    </div>
  );
}
