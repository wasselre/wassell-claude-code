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
  | { kind: 'condition'; branchId: string; condition: WorkflowCondition }
  | { kind: 'action'; branchId: string; action: WorkflowAction };

interface NodeDrawerProps {
  open: boolean;
  node: DrawerNode | null;
  workflow: Workflow;
  triggerFields: ModelField[];
  onClose: () => void;
  onUpdateTrigger: (patch: { trigger_model_id?: string; trigger_event?: WorkflowEvent; trigger_webhook_slug_id?: string | null }) => void;
  onUpdateCondition: (branchId: string, next: WorkflowCondition) => void;
  onUpdateAction: (branchId: string, next: WorkflowAction) => void;
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
  onClose,
  onUpdateTrigger,
  onUpdateCondition,
  onUpdateAction,
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
  } else if (node.kind === 'condition') {
    header = {
      icon: <CircleDot size={18} className="text-white" />,
      title: isAr ? 'تحرير الشرط' : 'Edit Condition',
      subtitle: isAr ? 'ما الذي يجب أن يكون صحيحًا لهذا الفرع؟' : 'What must be true for this branch?',
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

  // Body swaps in the existing embedded editor. All three components receive
  // array-shaped callbacks; we wrap them to pass single-item lists so the
  // editor drives updates for just this node. When a user adds or removes
  // items inside the drawer, we take the first of the resulting array — this
  // keeps the canvas contract of one editor per node.
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
  } else if (node.kind === 'condition') {
    body = (
      <ConditionList
        embedded
        conditions={[node.condition]}
        fields={triggerFields}
        triggerEvent={workflow.trigger_event}
        onChange={(next) => {
          // The embedded editor may emit zero or more conditions. We always
          // take the first — deletion inside the drawer is a no-op (users
          // delete from the node itself).
          const first = next[0];
          if (first) onUpdateCondition(node.branchId, first);
        }}
      />
    );
  } else {
    body = (
      <ActionList
        embedded
        actions={[node.action]}
        triggerFields={triggerFields}
        onChange={(next) => {
          const first = next[0];
          if (first) onUpdateAction(node.branchId, first);
        }}
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
            <h2 className="font-bold text-charcoal text-base leading-tight">{header.title}</h2>
            <p className="text-xs text-charcoal/50 mt-0.5">{header.subtitle}</p>
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
          {body}
        </div>
      </aside>
    </>,
    document.body,
  );
}
