import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Zap, CircleDot, Play } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import TriggerPanel from '../components/TriggerPanel';
import ConditionList from '../components/ConditionList';
import ActionList from '../components/ActionList';
import type { WorkflowCondition, WorkflowAction, ModelField, Workflow, WorkflowEvent } from '@/types';

export type DrawerNode =
  | { kind: 'trigger' }
  | { kind: 'conditionGroup'; branchId: string }
  | { kind: 'action'; branchId: string; action: WorkflowAction };

interface NodeDrawerProps {
  open: boolean;
  node: DrawerNode | null;
  workflow: Workflow;
  triggerFields: ModelField[];
  // Read-only viewer: the body is wrapped in a disabled <fieldset> so every
  // input / select / "+ Add" / delete control inside the embedded panels is
  // non-interactive. The header Close button stays active (it's outside).
  readOnly?: boolean;
  onClose: () => void;
  onUpdateTrigger: (patch: { trigger_model_id?: string; trigger_event?: WorkflowEvent; trigger_webhook_slug_id?: string | null }) => void;
  // Replace the entire conditions / actions array of a branch. The drawer
  // hands the embedded ConditionList / ActionList the FULL branch arrays,
  // so its built-in "+ Add condition" / "+ Add action" buttons stay
  // functional — they just emit a longer array via these callbacks.
  onReplaceBranchConditions: (branchId: string, conditions: WorkflowCondition[]) => void;
  onReplaceBranchActions: (branchId: string, actions: WorkflowAction[]) => void;
  // Toggle the join mode of a branch (AND vs OR over its conditions).
  onSetBranchConditionMode: (branchId: string, mode: 'all' | 'any') => void;
}

// Right-side slide-in panel hosting the existing ConditionList / ActionList /
// TriggerPanel editors in single-item mode. Opens from `inline-end` so it
// mirrors correctly in RTL. Reuses Modal's fadeIn animation CSS via a sibling
// class (see canvasStyles.css).
export default function NodeDrawer({
  open,
  node,
  workflow,
  triggerFields,
  readOnly = false,
  onClose,
  onUpdateTrigger,
  onReplaceBranchConditions,
  onReplaceBranchActions,
  onSetBranchConditionMode,
}: NodeDrawerProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Let form inputs keep Escape behavior (blur) — only close if the active
      // element is outside the drawer's inputs.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !node) return null;

  // Header varies by node kind. Icon + title + a muted subtitle.
  let header: { icon: ReactNode; title: string; subtitle: string; accent: string };
  if (node.kind === 'trigger') {
    header = {
      icon: <Zap size={18} className="text-white" fill="white" />,
      title: isAr ? 'تحرير المشغّل' : 'Edit Trigger',
      subtitle: isAr ? 'متى تبدأ هذه القاعدة؟' : 'When does this rule start?',
      accent: 'bg-amber-500',
    };
  } else if (node.kind === 'conditionGroup') {
    header = {
      icon: <CircleDot size={18} className="text-white" />,
      title: isAr ? 'تحرير الشروط' : 'Edit Conditions',
      subtitle: isAr ? 'كل الشروط لهذا الفرع' : 'All conditions for this branch',
      accent: 'bg-sky-500',
    };
  } else {
    header = {
      icon: <Play size={18} className="text-white" fill="white" />,
      title: isAr ? 'تحرير الإجراء' : 'Edit Action',
      subtitle: isAr ? 'ما الذي سيحدث عند تطابق الشروط؟' : 'What happens when conditions match?',
      accent: 'bg-emerald-500',
    };
  }

  // Body swaps in the existing embedded editor. Conditions and actions get
  // the FULL branch array so the embedded list's "+ Add" / delete / reorder
  // controls all stay functional — the drawer is now a focused view of the
  // branch, with the originally-clicked node visible at its position in the
  // list. The canvas's own + button still inserts a NEW node at a specific
  // edge position; this drawer "+ Add" appends to the same branch arrays.
  let body: ReactNode;
  if (node.kind === 'trigger') {
    body = (
      <TriggerPanel
        triggerModelId={workflow.trigger_model_id}
        triggerEvent={workflow.trigger_event}
        triggerWebhookSlugId={workflow.trigger_webhook_slug_id ?? null}
        onModelChange={(id) => onUpdateTrigger({ trigger_model_id: id })}
        onEventChange={(event) => onUpdateTrigger({ trigger_event: event })}
        onWebhookSlugChange={(slugId) => onUpdateTrigger({ trigger_webhook_slug_id: slugId })}
      />
    );
  } else if (node.kind === 'conditionGroup') {
    const branch = workflow.branches?.find((b) => b.id === node.branchId);
    const conditions = branch?.conditions ?? [];
    const mode = branch?.condition_mode ?? 'all';
    body = (
      <ConditionList
        embedded
        conditions={conditions}
        fields={triggerFields}
        triggerEvent={workflow.trigger_event}
        mode={mode}
        onModeChange={(next) => onSetBranchConditionMode(node.branchId, next)}
        onChange={(next) => onReplaceBranchConditions(node.branchId, next)}
      />
    );
  } else {
    const branch = workflow.branches?.find((b) => b.id === node.branchId);
    const actions = branch?.actions ?? [];
    body = (
      <ActionList
        embedded
        actions={actions}
        triggerFields={triggerFields}
        triggerModelId={workflow.trigger_model_id}
        onChange={(next) => onReplaceBranchActions(node.branchId, next)}
      />
    );
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-[900] animate-[fadeIn_0.15s_ease]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="workflow-drawer fixed top-0 bottom-0 w-full max-w-[520px] bg-cream-light border-s border-sand/50 shadow-2xl shadow-black/20 z-[950] flex flex-col"
        dir={isAr ? 'rtl' : 'ltr'}
        style={{ insetInlineEnd: 0 }}
      >
        <div className="flex items-center gap-3 p-5 border-b border-sand/50 bg-white/60 backdrop-blur">
          <div className={`w-10 h-10 rounded-xl ${header.accent} shadow-sm flex items-center justify-center shrink-0`}>
            {header.icon}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-charcoal text-base leading-tight">
              {readOnly ? (isAr ? header.title.replace('تحرير', 'عرض') : header.title.replace('Edit', 'View')) : header.title}
            </h2>
            <p className="text-xs text-charcoal/50 mt-0.5">
              {header.subtitle}
              {readOnly && <span className="ms-1 italic">· {isAr ? 'للعرض فقط' : 'read-only'}</span>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/50 hover:text-charcoal transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {/* Disabled fieldset makes every embedded input / select / button
              non-interactive in read-only mode without touching the panels. */}
          <fieldset disabled={readOnly} className="contents">
            {body}
          </fieldset>
        </div>
      </aside>
    </>,
    document.body,
  );
}
