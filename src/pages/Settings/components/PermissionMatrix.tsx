/**
 * PermissionMatrix — the per-profile-per-model access editor.
 *
 * Each row is one model, expandable to reveal:
 *   1. The 6 action toggles (View / Create / Edit / Delete / Import / Export)
 *   2. View scope: "all" or "filtered" with a condition list
 *   3. Edit scope: same shape; treated as a subset of view scope at evaluation
 *   4. Field rules: per-field Hidden / Read-only / Editable
 *
 * The component is purely controlled — receives the current
 * `ProfileModelPermissions[]` and emits the next one through `onChange`.
 * It never reaches into the store except to read the model + role lists.
 */

import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { ChevronDown, Eye, EyeOff, Lock, Pencil } from 'lucide-react';
import ScopeConditionEditor from './ScopeConditionEditor';
import type {
  AppModel,
  FieldPermission,
  ModelField,
  ModelPermission,
  ProfileModelPermissions,
  ScopeRule,
} from '@/types';

const ALL_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];

const PERM_LABELS_AR: Record<ModelPermission, string> = {
  view: 'عرض',
  create: 'إنشاء',
  edit: 'تعديل',
  delete: 'حذف',
  import: 'استيراد',
  export: 'تصدير',
};
const PERM_LABELS_EN: Record<ModelPermission, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  import: 'Import',
  export: 'Export',
};

// Field types that always render read-only regardless of profile config.
// Mirrors permissions.ts → COMPUTED_FIELD_TYPES; redefining here keeps the
// editor self-contained without a circular import.
const COMPUTED_FIELD_TYPES: ReadonlySet<ModelField['type']> = new Set([
  'formula',
  'auto_id',
  'mirror',
  'section_mirror',
]);

interface Props {
  modelPermissions: ProfileModelPermissions[];
  onChange: (permissions: ProfileModelPermissions[]) => void;
}

const DEFAULT_SCOPE: ScopeRule = { mode: 'all' };

function findEntry(
  list: ProfileModelPermissions[],
  modelId: string,
): ProfileModelPermissions | undefined {
  return list.find((mp) => mp.model_id === modelId);
}

/** Upsert one model's entry. If `update` returns null, the entry is removed. */
function upsertEntry(
  list: ProfileModelPermissions[],
  modelId: string,
  update: (current: ProfileModelPermissions) => ProfileModelPermissions | null,
): ProfileModelPermissions[] {
  const existing = findEntry(list, modelId);
  const base: ProfileModelPermissions =
    existing ?? { model_id: modelId, permissions: [] };
  const next = update(base);
  if (next === null) {
    return list.filter((mp) => mp.model_id !== modelId);
  }
  if (existing) {
    return list.map((mp) => (mp.model_id === modelId ? next : mp));
  }
  return [...list, next];
}

export default function PermissionMatrix({ modelPermissions, onChange }: Props) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {models.map((model) => {
        const entry = findEntry(modelPermissions, model.id);
        const isExpanded = expanded.has(model.id);
        return (
          <ModelCard
            key={model.id}
            model={model}
            entry={entry}
            isExpanded={isExpanded}
            isAr={isAr}
            onToggleExpand={() => toggleExpanded(model.id)}
            onChange={(updater) =>
              onChange(upsertEntry(modelPermissions, model.id, updater))
            }
          />
        );
      })}
      {models.length === 0 && (
        <p className="text-sm text-charcoal/40 italic text-center py-6">
          {isAr ? 'لا توجد نماذج' : 'No models yet'}
        </p>
      )}
    </div>
  );
}

interface CardProps {
  model: AppModel;
  entry: ProfileModelPermissions | undefined;
  isExpanded: boolean;
  isAr: boolean;
  onToggleExpand: () => void;
  onChange: (
    updater: (current: ProfileModelPermissions) => ProfileModelPermissions | null,
  ) => void;
}

function ModelCard({ model, entry, isExpanded, isAr, onToggleExpand, onChange }: CardProps) {
  const Icon = getIconComponent(model.icon);
  const perms = entry?.permissions ?? [];
  const labels = isAr ? PERM_LABELS_AR : PERM_LABELS_EN;
  const hasAnyAccess = perms.length > 0;

  const togglePerm = (perm: ModelPermission) => {
    onChange((current) => {
      const has = current.permissions.includes(perm);
      const nextPerms = has
        ? current.permissions.filter((p) => p !== perm)
        : [...current.permissions, perm];
      // Clean up empty entries so the stored shape stays minimal.
      if (
        nextPerms.length === 0 &&
        (!current.view_scope || current.view_scope.mode === 'all') &&
        (!current.edit_scope || current.edit_scope.mode === 'all') &&
        (!current.field_permissions || Object.keys(current.field_permissions).length === 0)
      ) {
        return null;
      }
      return { ...current, permissions: nextPerms };
    });
  };

  const setScope = (which: 'view_scope' | 'edit_scope', rule: ScopeRule) => {
    onChange((current) => ({
      ...current,
      [which]: rule.mode === 'all' ? undefined : rule,
    }));
  };

  const setFieldRule = (fieldId: string, rule: FieldPermission) => {
    onChange((current) => {
      const next = { ...(current.field_permissions ?? {}) };
      if (rule === 'editable') delete next[fieldId];
      else next[fieldId] = rule;
      return {
        ...current,
        field_permissions: Object.keys(next).length === 0 ? undefined : next,
      };
    });
  };

  const viewScope: ScopeRule = entry?.view_scope ?? DEFAULT_SCOPE;
  const editScope: ScopeRule = entry?.edit_scope ?? DEFAULT_SCOPE;
  const fieldRules = entry?.field_permissions ?? {};

  // Status pills shown on the collapsed row — quick at-a-glance state.
  const viewLabel = viewScope.mode === 'all'
    ? (isAr ? 'الكل' : 'All')
    : (isAr ? `مفلتر (${viewScope.conditions.length})` : `Filtered (${viewScope.conditions.length})`);
  const editLabel = editScope.mode === 'all'
    ? (isAr ? 'الكل' : 'All')
    : (isAr ? `مفلتر (${editScope.conditions.length})` : `Filtered (${editScope.conditions.length})`);
  const fieldRulesCount = Object.keys(fieldRules).length;

  return (
    <div className="rounded-xl border border-sand/30 bg-cream/20 overflow-hidden">
      {/* Row header */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-start hover:bg-sand/15 transition-colors"
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${model.color}15` }}
        >
          <Icon size={14} style={{ color: model.color }} />
        </div>
        <span className="font-bold text-charcoal text-sm flex-1 truncate">
          {isAr ? model.label_ar : model.label_en}
        </span>
        {hasAnyAccess ? (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="font-bold text-copper bg-copper/10 px-1.5 py-0.5 rounded">
              {perms.length}/{ALL_PERMISSIONS.length}
            </span>
            <span className="text-charcoal/50 hidden sm:inline">
              {isAr ? 'عرض' : 'view'}: {viewLabel}
            </span>
            <span className="text-charcoal/50 hidden sm:inline">
              {isAr ? 'تعديل' : 'edit'}: {editLabel}
            </span>
            {fieldRulesCount > 0 && (
              <span className="text-charcoal/50 hidden md:inline">
                {fieldRulesCount} {isAr ? 'قاعدة حقل' : 'field rules'}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-charcoal/40">{isAr ? 'لا يوجد وصول' : 'no access'}</span>
        )}
        <ChevronDown
          size={14}
          className={`text-charcoal/40 transition-transform ${isExpanded ? '' : '-rotate-90 rtl:rotate-90'}`}
        />
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-2 space-y-4 border-t border-sand/30 bg-cream/10">
          {/* Actions */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-2">
              {isAr ? 'الإجراءات' : 'Actions'}
            </h4>
            <div className="flex flex-wrap gap-3">
              {ALL_PERMISSIONS.map((p) => (
                <label
                  key={p}
                  className="inline-flex items-center gap-1.5 text-xs text-charcoal cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={perms.includes(p)}
                    onChange={() => togglePerm(p)}
                    className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                  />
                  {labels[p]}
                </label>
              ))}
            </div>
          </section>

          {/* View scope */}
          <ScopeSection
            title={isAr ? 'السجلات المرئية' : 'Records visible'}
            subtitle={isAr ? 'يحدد السجلات التي يراها هذا الملف.' : 'Determines which records this profile can see.'}
            icon={<Eye size={13} />}
            model={model}
            scope={viewScope}
            isAr={isAr}
            onChange={(rule) => setScope('view_scope', rule)}
          />

          {/* Edit scope */}
          <ScopeSection
            title={isAr ? 'السجلات القابلة للتعديل' : 'Records editable'}
            subtitle={
              isAr
                ? 'يحدد السجلات التي يمكن تعديلها أو حذفها. يقتصر دائماً على ما يمكن عرضه.'
                : 'Determines which visible records can be edited or deleted. Always narrowed by view scope.'
            }
            icon={<Pencil size={13} />}
            model={model}
            scope={editScope}
            isAr={isAr}
            onChange={(rule) => setScope('edit_scope', rule)}
          />

          {/* Field rules */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-2 inline-flex items-center gap-1.5">
              <Lock size={11} />
              {isAr ? 'قواعد الحقول' : 'Field rules'}
            </h4>
            <p className="text-[11px] text-charcoal/50 mb-2">
              {isAr
                ? 'افتراضياً جميع الحقول قابلة للتعديل. الحقول المحسوبة (صيغة، معرف تلقائي، مرآة) للقراءة فقط دائماً.'
                : 'All fields are editable by default. Computed fields (formula, auto-id, mirror) are always read-only.'}
            </p>
            <FieldRulesEditor
              model={model}
              rules={fieldRules}
              isAr={isAr}
              onChange={setFieldRule}
            />
          </section>
        </div>
      )}
    </div>
  );
}

interface ScopeSectionProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  model: AppModel;
  scope: ScopeRule;
  isAr: boolean;
  onChange: (rule: ScopeRule) => void;
}

function ScopeSection({ title, subtitle, icon, model, scope, isAr, onChange }: ScopeSectionProps) {
  const switchToFiltered = () => onChange({ mode: 'filtered', conditions: [] });
  const switchToAll = () => onChange({ mode: 'all' });

  return (
    <section>
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-1 inline-flex items-center gap-1.5">
        {icon}
        {title}
      </h4>
      <p className="text-[11px] text-charcoal/50 mb-2">{subtitle}</p>
      <div className="flex items-center gap-4 mb-2">
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="radio"
            checked={scope.mode === 'all'}
            onChange={switchToAll}
            className="text-copper focus:ring-copper/30"
          />
          {isAr ? 'كل السجلات' : 'All records'}
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="radio"
            checked={scope.mode === 'filtered'}
            onChange={switchToFiltered}
            className="text-copper focus:ring-copper/30"
          />
          {isAr ? 'مفلتر' : 'Filtered'}
        </label>
      </div>
      {scope.mode === 'filtered' && (
        <ScopeConditionEditor
          model={model}
          conditions={scope.conditions}
          onChange={(conditions) => onChange({ mode: 'filtered', conditions })}
        />
      )}
    </section>
  );
}

interface FieldRulesEditorProps {
  model: AppModel;
  rules: Record<string, FieldPermission>;
  isAr: boolean;
  onChange: (fieldId: string, rule: FieldPermission) => void;
}

function FieldRulesEditor({ model, rules, isAr, onChange }: FieldRulesEditorProps) {
  const fields = model.schema.sections.flatMap((s) => s.fields).sort((a, b) => a.order - b.order);

  return (
    <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2">
      {fields.map((field) => {
        const computed = COMPUTED_FIELD_TYPES.has(field.type);
        const value: FieldPermission = computed ? 'readonly' : (rules[field.id] ?? 'editable');
        return (
          <div
            key={field.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/60 border border-sand/20"
          >
            <span className="text-xs text-charcoal flex-1 truncate">
              {isAr ? field.label_ar : field.label_en}
              {computed && (
                <span className="ms-1.5 text-[9px] text-charcoal/40 italic">
                  {isAr ? '(محسوب)' : '(computed)'}
                </span>
              )}
            </span>
            <select
              className="form-input text-[11px] py-0.5 px-1.5 w-28"
              value={value}
              disabled={computed}
              onChange={(e) => onChange(field.id, e.target.value as FieldPermission)}
            >
              <option value="editable">{isAr ? 'تعديل' : 'Editable'}</option>
              <option value="readonly">{isAr ? 'قراءة فقط' : 'Read-only'}</option>
              <option value="hidden">{isAr ? 'مخفي' : 'Hidden'}</option>
            </select>
            {value === 'hidden' && <EyeOff size={11} className="text-charcoal/40" />}
            {value === 'readonly' && !computed && <Lock size={11} className="text-charcoal/40" />}
          </div>
        );
      })}
      {fields.length === 0 && (
        <p className="text-xs text-charcoal/40 italic col-span-full">
          {isAr ? 'لا توجد حقول' : 'No fields'}
        </p>
      )}
    </div>
  );
}
