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
import { ChevronDown, Eye, EyeOff, Lock, Pencil, MousePointerClick, Layers, Link2, PanelLeft, X } from 'lucide-react';
import ScopeConditionEditor from './ScopeConditionEditor';
import { resolveModelDataDependencies } from '@/lib/moduleDependencies';
import type {
  AppModel,
  FieldPermission,
  ModelField,
  ModelPermission,
  ModelView,
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
  /**
   * IDs of `ModelView` rows hidden from this profile (deny-list). The
   * matrix surfaces a per-model "Saved views" section that toggles
   * entries in this list. Optional — caller passes an empty array if
   * unset on the profile being edited.
   */
  hiddenViewIds?: string[];
  onHiddenViewIdsChange?: (next: string[]) => void;
  /**
   * IDs of `CustomButton` entries hidden from this profile. Same
   * deny-list semantics as views.
   */
  hiddenButtonIds?: string[];
  onHiddenButtonIdsChange?: (next: string[]) => void;
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

/**
 * True when an entry carries no state worth keeping beyond its `permissions`
 * array — i.e. removing the last permission should drop the whole entry. The
 * `hidden_from_sidebar` / `auto_reference` flags are deliberately NOT counted:
 * a zero-permission entry is "no access", where those nav/marker flags are
 * meaningless.
 */
function entryIsScopeless(e: ProfileModelPermissions): boolean {
  return (
    (!e.view_scope || e.view_scope.mode === 'all') &&
    (!e.edit_scope || e.edit_scope.mode === 'all') &&
    (!e.field_permissions || Object.keys(e.field_permissions).length === 0)
  );
}

export default function PermissionMatrix({
  modelPermissions,
  onChange,
  hiddenViewIds,
  onHiddenViewIdsChange,
  hiddenButtonIds,
  onHiddenButtonIdsChange,
}: Props) {
  const { models, views, language } = useAppStore();
  const isAr = language === 'ar';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hiddenViewSet = new Set(hiddenViewIds ?? []);
  const hiddenButtonSet = new Set(hiddenButtonIds ?? []);

  const modelById = new Map(models.map((m) => [m.id, m]));

  // ── Reference (data-only) dependency wiring ─────────────────────────────
  // Granting `view` on a module auto-adds read-only, sidebar-hidden "reference"
  // grants for every OTHER module whose data it displays (lookup / mirror /
  // section_mirror chain) — so mirrored fields never render blank. These fire
  // ONLY on an explicit view toggle, never continuously, so once added an admin
  // can freely remove or customize them without them silently re-appearing.

  /** Add missing reference deps for a module whose view was just turned ON. */
  const addReferenceDeps = (
    list: ProfileModelPermissions[],
    modelId: string,
  ): ProfileModelPermissions[] => {
    const deps = resolveModelDataDependencies(modelId, models);
    const present = new Set(list.map((e) => e.model_id));
    let next = list;
    for (const depId of deps) {
      if (present.has(depId)) continue; // never clobber an existing grant
      next = [
        ...next,
        { model_id: depId, permissions: ['view'], hidden_from_sidebar: true, auto_reference: true },
      ];
    }
    return next;
  };

  /** Drop auto-reference grants no longer needed by any intentional (non-auto)
   *  viewable module — runs when a module's view is turned OFF. Prune-only:
   *  it never adds, so a manually-removed reference stays removed. */
  const pruneOrphanReferenceDeps = (
    list: ProfileModelPermissions[],
  ): ProfileModelPermissions[] => {
    const primaries = list.filter((e) => e.permissions.includes('view') && !e.auto_reference);
    const needed = new Set<string>();
    for (const p of primaries) {
      for (const dep of resolveModelDataDependencies(p.model_id, models)) needed.add(dep);
    }
    return list.filter((e) => !e.auto_reference || needed.has(e.model_id));
  };

  const toggleView = (modelId: string) => {
    const existing = findEntry(modelPermissions, modelId);
    const turningOn = !existing?.permissions.includes('view');
    let next = upsertEntry(modelPermissions, modelId, (current) => {
      const nextPerms = turningOn
        ? [...current.permissions, 'view' as ModelPermission]
        : current.permissions.filter((p) => p !== 'view');
      // Toggling view is an intentional act on THIS model → no longer an
      // auto-reference; a promoted grant is never auto-pruned.
      if (nextPerms.length === 0 && entryIsScopeless(current)) return null;
      return { ...current, permissions: nextPerms, auto_reference: false };
    });
    next = turningOn ? addReferenceDeps(next, modelId) : pruneOrphanReferenceDeps(next);
    onChange(next);
  };

  const setSidebarHidden = (modelId: string, hidden: boolean) => {
    onChange(
      upsertEntry(modelPermissions, modelId, (current) => ({
        ...current,
        hidden_from_sidebar: hidden ? true : undefined,
      })),
    );
  };

  const removeEntry = (modelId: string) => {
    onChange(modelPermissions.filter((e) => e.model_id !== modelId));
  };

  const referenceEntries = modelPermissions
    .filter((e) => e.auto_reference && modelById.has(e.model_id))
    .map((e) => ({ entry: e, model: modelById.get(e.model_id) as AppModel }));

  const toggleHiddenView = (viewId: string) => {
    if (!onHiddenViewIdsChange) return;
    const next = new Set(hiddenViewSet);
    if (next.has(viewId)) next.delete(viewId);
    else next.add(viewId);
    onHiddenViewIdsChange(Array.from(next));
  };
  const toggleHiddenButton = (buttonId: string) => {
    if (!onHiddenButtonIdsChange) return;
    const next = new Set(hiddenButtonSet);
    if (next.has(buttonId)) next.delete(buttonId);
    else next.add(buttonId);
    onHiddenButtonIdsChange(Array.from(next));
  };

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
      {/* Reference (data-only) modules — auto-granted so mirrored/looked-up
          data resolves in the modules this profile actually navigates. Read-only
          and hidden from this profile's sidebar; removable here. */}
      {referenceEntries.length > 0 && (
        <div className="rounded-xl border border-copper/25 bg-copper/[0.04] p-3">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-copper/80 mb-1 inline-flex items-center gap-1.5">
            <Link2 size={12} />
            {isAr ? 'وحدات مرجعية (بيانات فقط)' : 'Reference modules (data-only)'}
          </h4>
          <p className="text-[11px] text-charcoal/50 mb-2.5">
            {isAr
              ? 'مُنِح الوصول للقراءة تلقائياً كي تظهر البيانات المرتبطة داخل الوحدات الممنوحة. مخفية من القائمة الجانبية. أزل ما لا تريده.'
              : 'Read access auto-granted so linked data resolves inside the modules you granted. Hidden from this profile’s sidebar. Remove any you don’t want.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {referenceEntries.map(({ entry, model }) => {
              const Icon = getIconComponent(model.icon);
              const shown = !entry.hidden_from_sidebar;
              return (
                <span
                  key={model.id}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-white/70 border border-sand/40 text-xs"
                >
                  <Icon size={12} style={{ color: model.color }} />
                  <span className="text-charcoal">{isAr ? model.label_ar : model.label_en}</span>
                  <button
                    type="button"
                    onClick={() => setSidebarHidden(model.id, shown)}
                    className="p-0.5 rounded hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors"
                    title={
                      shown
                        ? isAr ? 'مخفي من القائمة الجانبية — اضغط للإظهار' : 'Hidden from sidebar — click to show'
                        : isAr ? 'ظاهر في القائمة الجانبية — اضغط للإخفاء' : 'Shown in sidebar — click to hide'
                    }
                  >
                    {shown ? <PanelLeft size={12} /> : <EyeOff size={12} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEntry(model.id)}
                    className="p-0.5 rounded hover:bg-terracotta/15 text-charcoal/40 hover:text-terracotta transition-colors"
                    title={isAr ? 'إزالة الوصول المرجعي' : 'Remove reference access'}
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {models.map((model) => {
        const entry = findEntry(modelPermissions, model.id);
        const isExpanded = expanded.has(model.id);
        const modelViews = views.filter((v) => v.model_id === model.id);
        const modelButtons = model.schema.custom_buttons ?? [];
        return (
          <ModelCard
            key={model.id}
            model={model}
            entry={entry}
            isExpanded={isExpanded}
            isAr={isAr}
            modelViews={modelViews}
            hiddenViewSet={hiddenViewSet}
            onToggleHiddenView={toggleHiddenView}
            modelButtons={modelButtons}
            hiddenButtonSet={hiddenButtonSet}
            onToggleHiddenButton={toggleHiddenButton}
            onToggleExpand={() => toggleExpanded(model.id)}
            onToggleView={() => toggleView(model.id)}
            onSetSidebarHidden={(hidden) => setSidebarHidden(model.id, hidden)}
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
  modelViews: ModelView[];
  hiddenViewSet: Set<string>;
  onToggleHiddenView: (viewId: string) => void;
  modelButtons: NonNullable<AppModel['schema']['custom_buttons']>;
  hiddenButtonSet: Set<string>;
  onToggleHiddenButton: (buttonId: string) => void;
  onToggleExpand: () => void;
  /** Toggle the `view` action — routed to the parent so it can add/prune the
   *  reference-dependency grants that riding on view requires. */
  onToggleView: () => void;
  /** Flip this model's `hidden_from_sidebar` flag for the profile. */
  onSetSidebarHidden: (hidden: boolean) => void;
  onChange: (
    updater: (current: ProfileModelPermissions) => ProfileModelPermissions | null,
  ) => void;
}

function ModelCard({
  model,
  entry,
  isExpanded,
  isAr,
  modelViews,
  hiddenViewSet,
  onToggleHiddenView,
  modelButtons,
  hiddenButtonSet,
  onToggleHiddenButton,
  onToggleExpand,
  onToggleView,
  onSetSidebarHidden,
  onChange,
}: CardProps) {
  const Icon = getIconComponent(model.icon);
  const perms = entry?.permissions ?? [];
  const labels = isAr ? PERM_LABELS_AR : PERM_LABELS_EN;
  const hasAnyAccess = perms.length > 0;
  const canView = perms.includes('view');
  const isReference = entry?.auto_reference === true;
  const sidebarHidden = entry?.hidden_from_sidebar === true;

  const togglePerm = (perm: ModelPermission) => {
    // `view` carries reference-dependency side-effects — the parent owns it.
    if (perm === 'view') {
      onToggleView();
      return;
    }
    onChange((current) => {
      const has = current.permissions.includes(perm);
      const nextPerms = has
        ? current.permissions.filter((p) => p !== perm)
        : [...current.permissions, perm];
      // Clean up empty entries so the stored shape stays minimal.
      if (nextPerms.length === 0 && entryIsScopeless(current)) {
        return null;
      }
      // Customizing actions promotes an auto-reference grant to an intentional
      // one so it's never auto-pruned when the module that pulled it in changes.
      return { ...current, permissions: nextPerms, auto_reference: false };
    });
  };

  const setScope = (which: 'view_scope' | 'edit_scope', rule: ScopeRule) => {
    onChange((current) => ({
      ...current,
      [which]: rule.mode === 'all' ? undefined : rule,
      auto_reference: false,
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
        auto_reference: false,
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
        {isReference && (
          <span className="inline-flex items-center gap-1 text-[9px] font-bold text-copper bg-copper/10 px-1.5 py-0.5 rounded uppercase tracking-wide">
            <Link2 size={9} />
            {isAr ? 'مرجعي' : 'reference'}
          </span>
        )}
        {!isReference && canView && sidebarHidden && (
          <span
            className="inline-flex items-center gap-1 text-[9px] text-charcoal/45"
            title={isAr ? 'مخفي من القائمة الجانبية' : 'Hidden from sidebar'}
          >
            <EyeOff size={9} />
          </span>
        )}
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

          {/* Sidebar visibility — decouples "can read this model's data" from
              "this is a place I navigate to". Only meaningful once `view` is
              granted; a model with no view never appears in the sidebar anyway. */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-1 inline-flex items-center gap-1.5">
              <PanelLeft size={11} />
              {isAr ? 'القائمة الجانبية' : 'Sidebar'}
            </h4>
            {isReference && (
              <p className="text-[11px] text-copper/70 mb-2 inline-flex items-start gap-1.5">
                <Link2 size={12} className="mt-0.5 shrink-0" />
                {isAr
                  ? 'وصول مرجعي تلقائي — مُنِح للقراءة كي تظهر بياناته داخل وحدة أخرى ممنوحة. أضف إجراءً أو نطاقاً لتثبيته كوصول مقصود.'
                  : 'Auto reference access — read-only so its data resolves inside another granted module. Add an action or scope to keep it as an intentional grant.'}
              </p>
            )}
            <label
              className={`inline-flex items-center gap-2 text-xs cursor-pointer ${
                canView ? 'text-charcoal' : 'text-charcoal/35 cursor-not-allowed'
              }`}
            >
              <input
                type="checkbox"
                checked={canView && !sidebarHidden}
                disabled={!canView}
                onChange={(e) => onSetSidebarHidden(!e.target.checked)}
                className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
              />
              {isAr ? 'إظهار في القائمة الجانبية لهذا الملف' : "Show in this profile's sidebar"}
            </label>
            {canView && sidebarHidden && (
              <p className="text-[11px] text-charcoal/45 mt-1 inline-flex items-center gap-1">
                <EyeOff size={11} />
                {isAr
                  ? 'يمكن قراءة البيانات، لكن لا يظهر زر في القائمة الجانبية.'
                  : 'Data is readable, but no button appears in the sidebar.'}
              </p>
            )}
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

          {/* Saved views — toggle visibility per shared view. The user's
              own personal views always show in their selector regardless
              of profile config (see permissions.isViewVisible). */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-2 inline-flex items-center gap-1.5">
              <Layers size={11} />
              {isAr ? 'العروض المحفوظة' : 'Saved views'}
            </h4>
            <p className="text-[11px] text-charcoal/50 mb-2">
              {isAr
                ? 'افتراضياً كل العروض ظاهرة. أصحاب العرض يرونه دائماً بغض النظر عن هذه القاعدة.'
                : 'All views are visible by default. Authors always see their own views regardless of this rule.'}
            </p>
            <ToggleList
              items={modelViews.map((v) => ({
                id: v.id,
                label: isAr ? v.label_ar : v.label_en,
                badge: v.is_shared ? (isAr ? 'مشترك' : 'shared') : (isAr ? 'خاص' : 'private'),
              }))}
              hiddenSet={hiddenViewSet}
              onToggle={onToggleHiddenView}
              isAr={isAr}
              emptyLabel={isAr ? 'لا توجد عروض' : 'No views yet'}
            />
          </section>

          {/* Custom buttons — toggle visibility per button defined on the
              model. Hidden buttons disappear from the record form / list
              toolbar for users with this profile. */}
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-charcoal/60 mb-2 inline-flex items-center gap-1.5">
              <MousePointerClick size={11} />
              {isAr ? 'الأزرار المخصصة' : 'Custom buttons'}
            </h4>
            <p className="text-[11px] text-charcoal/50 mb-2">
              {isAr
                ? 'افتراضياً كل الأزرار ظاهرة. ألغِ التحديد لإخفاء الزر عن هذا الملف.'
                : 'All buttons are visible by default. Uncheck to hide a button from this profile.'}
            </p>
            <ToggleList
              items={modelButtons.map((b) => ({
                id: b.id,
                label: (isAr ? b.label_ar : b.label_en) || b.id,
                badge: b.enabled === false ? (isAr ? 'معطل' : 'disabled') : null,
              }))}
              hiddenSet={hiddenButtonSet}
              onToggle={onToggleHiddenButton}
              isAr={isAr}
              emptyLabel={isAr ? 'لا توجد أزرار مخصصة' : 'No custom buttons'}
            />
          </section>
        </div>
      )}
    </div>
  );
}

interface ToggleItem {
  id: string;
  label: string;
  badge?: string | null;
}

function ToggleList({
  items,
  hiddenSet,
  onToggle,
  isAr,
  emptyLabel,
}: {
  items: ToggleItem[];
  hiddenSet: Set<string>;
  onToggle: (id: string) => void;
  isAr: boolean;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-charcoal/40 italic">{emptyLabel}</p>;
  }
  return (
    <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2">
      {items.map((item) => {
        const visible = !hiddenSet.has(item.id);
        return (
          <label
            key={item.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/60 border border-sand/20 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={visible}
              onChange={() => onToggle(item.id)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-xs text-charcoal flex-1 truncate">{item.label}</span>
            {item.badge && (
              <span className="text-[9px] text-charcoal/40 italic shrink-0">
                {item.badge}
              </span>
            )}
            {!visible && (
              <span className="text-[10px] text-charcoal/50 inline-flex items-center gap-1 shrink-0">
                <EyeOff size={10} />
                {isAr ? 'مخفي' : 'hidden'}
              </span>
            )}
          </label>
        );
      })}
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
