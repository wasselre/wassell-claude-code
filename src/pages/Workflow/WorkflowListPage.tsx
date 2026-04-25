import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Plus, Pencil, Trash2, Zap, ScrollText, Sparkles, Folder, FolderPlus, ChevronDown, ChevronRight, Check, X, FolderInput } from 'lucide-react';
import Button from '@/components/ui/Button';
import type { Workflow, WorkflowGroup } from '@/types';

// Sentinel id for the implicit "ungrouped" bucket. Workflows whose
// `group_id` is null/undefined render under this header — no DB row
// represents it, it's purely a UI grouping.
const UNGROUPED_ID = '__ungrouped__';

export default function WorkflowListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    workflows,
    workflowGroups,
    models,
    language,
    saveWorkflow,
    deleteWorkflow,
    saveWorkflowGroup,
    deleteWorkflowGroup,
    addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  const getModelName = (modelId: string) => {
    const m = models.find((mod) => mod.id === modelId);
    return m ? (isAr ? m.label_ar : m.label_en) : '—';
  };

  const eventLabels: Record<string, string> = {
    create: t('workflow.event_create'),
    update: t('workflow.event_update'),
    delete: t('workflow.event_delete'),
  };

  const toggleActive = (wf: Workflow) => {
    saveWorkflow({ ...wf, is_active: !wf.is_active });
  };

  // Folder UI state — purely local. Persists nothing across reloads on
  // purpose: collapsed-state and "currently renaming this folder" are UX,
  // not data.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const sortedGroups = useMemo(
    () => [...workflowGroups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [workflowGroups],
  );

  // Group workflows by their group_id; null/undefined → UNGROUPED bucket.
  const grouped = useMemo(() => {
    const map = new Map<string, Workflow[]>();
    map.set(UNGROUPED_ID, []);
    for (const g of sortedGroups) map.set(g.id, []);
    for (const wf of workflows) {
      const key = wf.group_id && map.has(wf.group_id) ? wf.group_id : UNGROUPED_ID;
      map.get(key)!.push(wf);
    }
    return map;
  }, [workflows, sortedGroups]);

  const handleAddGroup = () => {
    const id = uuid();
    const name = isAr ? 'مجلد جديد' : 'New folder';
    saveWorkflowGroup({
      id,
      label_ar: name,
      label_en: name,
      order: workflowGroups.length,
    });
    setRenamingId(id);
    setRenameValue(name);
  };

  const handleRenameCommit = (group: WorkflowGroup) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      saveWorkflowGroup({
        ...group,
        // Keep both languages in sync — this app's bilingual contract is
        // that every label has both fields. We don't auto-translate here;
        // the user can edit each via this same input on a second pass.
        label_ar: isAr ? trimmed : group.label_ar || trimmed,
        label_en: isAr ? group.label_en || trimmed : trimmed,
      });
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDeleteGroup = (group: WorkflowGroup) => {
    const count = (grouped.get(group.id) ?? []).length;
    const confirmMsg = count > 0
      ? (isAr
          ? `سيتم نقل ${count} قاعدة إلى "غير مصنّف". هل أنت متأكد؟`
          : `${count} workflow${count === 1 ? '' : 's'} will be moved to Ungrouped. Are you sure?`)
      : (isAr ? 'هل تريد حذف هذا المجلد؟' : 'Delete this folder?');
    if (!window.confirm(confirmMsg)) return;
    deleteWorkflowGroup(group.id);
  };

  const moveWorkflowToGroup = (wf: Workflow, groupId: string | null) => {
    saveWorkflow({ ...wf, group_id: groupId });
  };

  const renderWorkflow = (wf: Workflow) => (
    <div key={wf.id} className="card p-5 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="font-bold text-charcoal truncate">{isAr ? wf.label_ar : wf.label_en}</h3>
        <p className="text-sm text-charcoal/50 mt-1 truncate">
          {getModelName(wf.trigger_model_id)} — {eventLabels[wf.trigger_event] ?? wf.trigger_event}
        </p>
        <p className="text-xs text-charcoal/30 mt-1">
          {(() => {
            const branches = wf.branches ?? [];
            const branchCount = branches.length;
            const actionCount = branches.length > 0
              ? branches.reduce((sum, b) => sum + b.actions.length, 0)
              : wf.actions.length;
            const parts: string[] = [];
            if (branchCount > 1) {
              parts.push(isAr ? `${branchCount} فرع` : `${branchCount} branches`);
            }
            parts.push(isAr ? `${actionCount} إجراء` : `${actionCount} action${actionCount === 1 ? '' : 's'}`);
            return parts.join(' · ');
          })()}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {/* Folder dropdown — lets the user move this workflow into any
            existing folder or back to ungrouped without leaving the list. */}
        <div className="relative">
          <select
            value={wf.group_id ?? ''}
            onChange={(e) => moveWorkflowToGroup(wf, e.target.value || null)}
            className="appearance-none ps-7 pe-3 py-1.5 rounded-lg border border-sand/40 bg-white text-xs text-charcoal/70 hover:border-copper/50 transition-colors cursor-pointer"
            title={isAr ? 'نقل إلى مجلد' : 'Move to folder'}
          >
            <option value="">{isAr ? 'بدون مجلد' : 'Ungrouped'}</option>
            {sortedGroups.map((g) => (
              <option key={g.id} value={g.id}>{isAr ? g.label_ar : g.label_en}</option>
            ))}
          </select>
          <FolderInput size={12} className="absolute start-2 top-1/2 -translate-y-1/2 text-charcoal/40 pointer-events-none" />
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={wf.is_active}
            onChange={() => toggleActive(wf)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-sand/50 rounded-full peer peer-checked:bg-copper peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all" />
        </label>
        <button
          onClick={() => navigate(`/workflow/${wf.id}`)}
          className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal"
          aria-label={isAr ? 'تحرير' : 'Edit'}
        >
          <Pencil size={16} />
        </button>
        <button
          onClick={() => { deleteWorkflow(wf.id); addToast(t('toast.deleted'), 'success'); }}
          className="p-2 rounded-lg hover:bg-red-50 text-charcoal/40 hover:text-red-500"
          aria-label={isAr ? 'حذف' : 'Delete'}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );

  // Single section header — used by both real folders and the ungrouped
  // bucket. The ungrouped bucket has no rename / delete.
  const renderSection = (
    key: string,
    title: string,
    count: number,
    isUngrouped: boolean,
    group?: WorkflowGroup,
  ) => {
    const isCollapsed = !!collapsed[key];
    const items = grouped.get(key) ?? [];
    const isRenaming = !isUngrouped && group && renamingId === group.id;
    return (
      <section key={key} className="mb-6">
        <div className="flex items-center gap-2 mb-3 ps-1">
          <button
            onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
            className="p-1 rounded-md hover:bg-sand/30 text-charcoal/50"
            aria-label={isCollapsed ? (isAr ? 'توسيع' : 'Expand') : (isAr ? 'طي' : 'Collapse')}
          >
            {isCollapsed
              ? (isAr ? <ChevronDown size={14} className="rotate-90" /> : <ChevronRight size={14} />)
              : <ChevronDown size={14} />}
          </button>
          {isUngrouped ? (
            <Zap size={14} className="text-charcoal/40" />
          ) : (
            <Folder size={14} className="text-copper" />
          )}
          {isRenaming && group ? (
            <div className="flex items-center gap-1 flex-1 max-w-md">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameCommit(group);
                  else if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                }}
                className="form-input text-sm py-1.5 flex-1"
                dir={isAr ? 'rtl' : 'ltr'}
              />
              <button
                onClick={() => handleRenameCommit(group)}
                className="p-1.5 rounded-md hover:bg-emerald-50 text-emerald-600"
                aria-label={isAr ? 'حفظ' : 'Save'}
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => { setRenamingId(null); setRenameValue(''); }}
                className="p-1.5 rounded-md hover:bg-red-50 text-red-500"
                aria-label={isAr ? 'إلغاء' : 'Cancel'}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <h2 className="text-sm font-bold text-charcoal/80">{title}</h2>
          )}
          <span className="text-xs text-charcoal/40 px-1.5 py-0.5 rounded bg-sand/30">
            {count}
          </span>
          {!isUngrouped && group && !isRenaming && (
            <div className="flex items-center gap-0.5 ms-2">
              <button
                onClick={() => { setRenamingId(group.id); setRenameValue((isAr ? group.label_ar : group.label_en) || ''); }}
                className="p-1 rounded-md hover:bg-cream text-charcoal/40 hover:text-charcoal"
                aria-label={isAr ? 'إعادة تسمية المجلد' : 'Rename folder'}
                title={isAr ? 'إعادة تسمية' : 'Rename'}
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => handleDeleteGroup(group)}
                className="p-1 rounded-md hover:bg-red-50 text-charcoal/40 hover:text-red-500"
                aria-label={isAr ? 'حذف المجلد' : 'Delete folder'}
                title={isAr ? 'حذف' : 'Delete'}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
        {!isCollapsed && (
          items.length === 0 ? (
            <div className="ms-7 text-xs text-charcoal/40 italic py-2">
              {isAr ? 'فارغ' : 'Empty'}
            </div>
          ) : (
            <div className="grid gap-3 ms-7">
              {items.map(renderWorkflow)}
            </div>
          )
        )}
      </section>
    );
  };

  const ungroupedItems = grouped.get(UNGROUPED_ID) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-charcoal">{t('workflow.title')}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/workflow/logs')}
            className="pill text-charcoal/60 border-sand/30 hover:bg-cream-light"
          >
            <ScrollText size={14} />
            {isAr ? 'السجلات' : 'Logs'}
          </button>
          <button
            onClick={handleAddGroup}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-copper/40 text-copper hover:bg-copper/5 transition-colors text-sm font-bold"
            title={isAr ? 'مجلد جديد لتنظيم القواعد' : 'Create a folder to organize workflows'}
          >
            <FolderPlus size={14} />
            {isAr ? 'مجلد' : 'Folder'}
          </button>
          <button
            onClick={() => navigate('/workflow/agent')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-br from-amber-400 to-copper text-white hover:shadow-lg hover:shadow-copper/30 transition-all text-sm font-bold"
            title={isAr ? 'أنشئ قاعدة بمحادثة طبيعية' : 'Build a workflow by chatting in natural language'}
          >
            <Sparkles size={14} />
            {isAr ? 'مساعد ذكي' : 'AI Builder'}
          </button>
          <Button onClick={() => navigate('/workflow/new')}>
            <Plus size={16} />
            {t('workflow.new')}
          </Button>
        </div>
      </div>

      {workflows.length === 0 && workflowGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <Zap size={48} className="mb-4" />
          <p className="text-lg font-bold">{t('workflow.no_workflows')}</p>
          <p className="text-sm">{t('workflow.create_first')}</p>
        </div>
      ) : (
        <div>
          {/* Ungrouped first when it has anything in it; otherwise hide the
              empty Ungrouped section so a clean folder-only view stays
              clean. The ungrouped bucket is also hidden when no workflows
              exist at all so the empty state above takes over. */}
          {ungroupedItems.length > 0 &&
            renderSection(UNGROUPED_ID, isAr ? 'غير مصنّف' : 'Ungrouped', ungroupedItems.length, true)}
          {sortedGroups.map((g) =>
            renderSection(
              g.id,
              (isAr ? g.label_ar : g.label_en) || (isAr ? 'مجلد' : 'Folder'),
              (grouped.get(g.id) ?? []).length,
              false,
              g,
            ),
          )}
        </div>
      )}
    </div>
  );
}
