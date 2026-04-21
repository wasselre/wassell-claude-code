import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { GitBranch, Trash2, Copy, CircleDot, Play, ChevronDown, ChevronUp } from 'lucide-react';
import ConditionList from './ConditionList';
import ActionList from './ActionList';
import type { WorkflowBranch, WorkflowEvent, ModelField } from '@/types';

interface BranchCardProps {
  branch: WorkflowBranch;
  index: number;                  // position within the workflow (0 = first)
  triggerEvent: WorkflowEvent;
  triggerFields: ModelField[];
  onChange: (updated: WorkflowBranch) => void;
  onDelete: () => void;
  onDuplicate: () => void;        // deep-clones this branch after itself
  canDelete: boolean;             // the last non-else branch cannot be deleted
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

// One arm of the if / else-if / else tree, rendered as a column. Each branch
// has its own conditions (AND-joined) and its own action list. Branches
// render side-by-side in the editor; the engine walks them left-to-right
// (or top-to-bottom in data order) and picks the first match.
export default function BranchCard({
  branch,
  index,
  triggerEvent,
  triggerFields,
  onChange,
  onDelete,
  onDuplicate,
  canDelete,
  collapsed,
  onToggleCollapsed,
}: BranchCardProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  // Per-section collapse state, scoped to this BranchCard instance. Lives in
  // component state (not in the editor page) because it's purely a display
  // preference — it doesn't survive a branch reorder or a full page reload,
  // which is fine.
  const [conditionsCollapsed, setConditionsCollapsed] = useState(false);
  const [actionsCollapsed, setActionsCollapsed] = useState(false);

  const isElse = !!branch.is_else;
  const positionLabel = isElse
    ? (isAr ? 'وإلا' : 'OTHERWISE')
    : index === 0
      ? (isAr ? 'إذا' : 'IF')
      : (isAr ? 'وإلا إذا' : 'ELSE IF');

  const branchName = isAr ? branch.label_ar : branch.label_en;

  return (
    <div className="relative flex flex-col shrink-0 w-[400px]">
      <div className={`rounded-2xl bg-white border transition-all flex flex-col flex-1 ${
        isElse
          ? 'border-sand/60 bg-gradient-to-br from-sand/10 to-transparent'
          : 'border-copper/20 hover:border-copper/40 shadow-sm'
      }`}>
        {/* Header */}
        <div className={`flex items-center gap-3 px-5 py-3.5 border-b ${
          isElse ? 'border-sand/40' : 'border-sand/30'
        }`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            isElse ? 'bg-chocolate/10 text-chocolate' : 'bg-copper/15 text-copper'
          }`}>
            <GitBranch size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-[11px] font-bold tracking-widest uppercase ${
              isElse ? 'text-chocolate/60' : 'text-copper'
            }`}>
              {index === 0 && !isElse
                ? (isAr ? 'الفرع الرئيسي' : 'Main branch')
                : positionLabel}
              {!isElse && <span className="opacity-60 ms-1">#{index + 1}</span>}
            </div>
            <input
              type="text"
              value={branchName ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                onChange({
                  ...branch,
                  label_ar: isAr ? val : branch.label_ar,
                  label_en: isAr ? branch.label_en : val,
                });
              }}
              placeholder={isElse
                ? (isAr ? 'الحالة الافتراضية (اختياري)' : 'Default case (optional)')
                : (isAr ? 'اسم الفرع (اختياري)...' : 'Branch name (optional)...')}
              className="w-full bg-transparent border-0 focus:outline-none font-bold text-chocolate text-base p-0 placeholder:text-charcoal/25 placeholder:font-normal"
            />
          </div>
          {!branch.is_else && (
            <button
              onClick={onDuplicate}
              className="p-1.5 rounded-md text-charcoal/30 hover:text-copper hover:bg-copper/5 transition-colors"
              aria-label={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
              title={isAr ? 'تكرار الفرع' : 'Duplicate branch'}
            >
              <Copy size={16} />
            </button>
          )}
          <button
            onClick={onToggleCollapsed}
            className="p-1.5 rounded-md text-charcoal/30 hover:text-charcoal hover:bg-sand/20 transition-colors"
            aria-label={collapsed ? (isAr ? 'توسيع' : 'Expand') : (isAr ? 'طي' : 'Collapse')}
            title={collapsed ? (isAr ? 'توسيع' : 'Expand') : (isAr ? 'طي' : 'Collapse')}
          >
            {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
          {canDelete && (
            <button
              onClick={onDelete}
              className="p-1.5 rounded-md text-charcoal/30 hover:text-red-500 hover:bg-red-50 transition-colors"
              aria-label={isAr ? 'حذف الفرع' : 'Delete branch'}
              title={isAr ? 'حذف الفرع' : 'Delete branch'}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="p-5 space-y-5">
            {/* Conditions section — hidden entirely on else branches (they have
                no conditions). The section header is a toggle: clicking it
                collapses/expands just this section without hiding the rest of
                the branch body. */}
            {!isElse && (
              <div>
                <button
                  type="button"
                  onClick={() => setConditionsCollapsed((c) => !c)}
                  className="flex items-center gap-2 mb-3 w-full text-start group"
                  aria-expanded={!conditionsCollapsed}
                >
                  <CircleDot size={14} className="text-blue-600 shrink-0" />
                  <h4 className="text-[11px] font-bold tracking-widest uppercase text-charcoal/60 group-hover:text-charcoal">
                    {isAr ? 'الشروط (جميعها يجب أن تتحقق)' : 'Conditions (ALL must match)'}
                  </h4>
                  {branch.conditions.length > 0 && (
                    <span className="text-[10px] font-bold text-blue-600 bg-blue-500/10 px-1.5 py-0.5 rounded">
                      {branch.conditions.length}
                    </span>
                  )}
                  <span className="ms-auto text-charcoal/30 group-hover:text-charcoal/60 transition-colors">
                    {conditionsCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  </span>
                </button>
                {!conditionsCollapsed && (
                  <ConditionList
                    embedded
                    conditions={branch.conditions}
                    fields={triggerFields}
                    triggerEvent={triggerEvent}
                    onChange={(conditions) => onChange({ ...branch, conditions })}
                  />
                )}
              </div>
            )}

            {/* Actions section — same collapse pattern. ActionList itself also
                handles per-action collapse (each action card has its own
                chevron). */}
            <div>
              <button
                type="button"
                onClick={() => setActionsCollapsed((c) => !c)}
                className="flex items-center gap-2 mb-3 w-full text-start group"
                aria-expanded={!actionsCollapsed}
              >
                <Play size={14} className="text-emerald-700 shrink-0" fill="currentColor" />
                <h4 className="text-[11px] font-bold tracking-widest uppercase text-charcoal/60 group-hover:text-charcoal">
                  {isAr ? 'الإجراءات (بالترتيب)' : 'Actions (run in order)'}
                </h4>
                {branch.actions.length > 0 && (
                  <span className="text-[10px] font-bold text-emerald-700 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                    {branch.actions.length}
                  </span>
                )}
                <span className="ms-auto text-charcoal/30 group-hover:text-charcoal/60 transition-colors">
                  {actionsCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </span>
              </button>
              {!actionsCollapsed && (
                <ActionList
                  embedded
                  actions={branch.actions}
                  triggerFields={triggerFields}
                  onChange={(actions) => onChange({ ...branch, actions })}
                />
              )}
            </div>
          </div>
        )}

        {/* Compact summary when collapsed */}
        {collapsed && (
          <div className="px-5 py-3 text-xs text-charcoal/50 flex items-center gap-4">
            {!isElse && (
              <span className="flex items-center gap-1.5">
                <CircleDot size={12} className="text-blue-600" />
                <span className="font-bold">{branch.conditions.length}</span>
                <span>{isAr ? 'شرط' : branch.conditions.length === 1 ? 'condition' : 'conditions'}</span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Play size={12} className="text-emerald-700" fill="currentColor" />
              <span className="font-bold">{branch.actions.length}</span>
              <span>{isAr ? 'إجراء' : branch.actions.length === 1 ? 'action' : 'actions'}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
