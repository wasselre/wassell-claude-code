import { useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import type { Workflow, WorkflowAction, WorkflowBranch, WorkflowCondition } from '@/types';
import type { AddableKind } from './AddNodeMenu';

// Mutation helpers bound to a workflow setter. Kept out of the canvas
// component so the React Flow view stays focused on rendering. Each helper
// produces a new workflow value via the setter — no internal state.
export function useWorkflowGraph(
  _workflow: Workflow,
  setWorkflow: (updater: (w: Workflow) => Workflow) => void,
) {
  // Build a fresh action with a sensible default config per type. Mirrors the
  // dropdown-switch logic in ActionList.tsx so new nodes drop in cleanly.
  const makeAction = useCallback((kind: Exclude<AddableKind, 'condition'>): WorkflowAction => {
    const id = uuid();
    switch (kind) {
      case 'create_record':
        return { id, type: 'create_record', target_model_id: '', field_mappings: [] };
      case 'update_record':
        return { id, type: 'update_record', target_model_id: '', filter_field_id: '', filter_value_source: 'static', filter_value: '', field_mappings: [] };
      case 'send_notification':
        return { id, type: 'send_notification', message_ar: '', message_en: '' };
      case 'assign_user':
        return { id, type: 'assign_user', assignment_field_id: '', mode: 'role_based', role_conditions: [], selection_strategy: 'least_workload' };
      case 'http_request':
        return { id, type: 'http_request', method: 'POST', url: '', headers: [], body_mode: 'json_template', body_template: '{\n  "operation_id": "{id}"\n}', timeout_ms: 30000 };
      case 'outbound_ivr':
        return {
          id,
          type: 'outbound_ivr',
          to: { kind: 'trigger_field', field_name: '' },
          audio_mode: 'tts',
          tts_text: '',
          tts_voice: 'Female',
          options: [{ id: uuid(), digit: '1', label_ar: 'تأكيد', label_en: 'Confirm' }],
          language: 'ar',
        };
      case 'send_whatsapp_message':
        return { id, type: 'send_whatsapp_message', to_field_id: '', body_template: '' };
    }
  }, []);

  // Insert a new condition or action into a branch. `insertAfterId` is the
  // full canvas-node id (`act-<branchId>-<actionId>` etc.) — not the bare
  // entity id — so we have to strip the type prefix before looking it up
  // inside the branch's arrays.
  const stripNodePrefix = (nodeId: string, branchId: string): string => {
    if (nodeId.startsWith(`act-${branchId}-`)) return nodeId.slice(`act-${branchId}-`.length);
    if (nodeId.startsWith(`cond-${branchId}-`)) return nodeId.slice(`cond-${branchId}-`.length);
    return nodeId;
  };

  const insertNode = useCallback((kind: AddableKind, branchId: string, insertAfterId: string | null): string => {
    const newId = uuid();
    const bareAfterId = insertAfterId ? stripNodePrefix(insertAfterId, branchId) : null;
    setWorkflow((w) => {
      const branches = (w.branches ?? []).map((b): WorkflowBranch => {
        if (b.id !== branchId) return b;
        if (kind === 'condition') {
          const newCond: WorkflowCondition = { id: newId, field_id: '', operator: 'equals', value: '' };
          if (!bareAfterId) return { ...b, conditions: [...b.conditions, newCond] };
          const idx = b.conditions.findIndex((c) => c.id === bareAfterId);
          if (idx === -1) return { ...b, conditions: [...b.conditions, newCond] };
          const next = [...b.conditions];
          next.splice(idx + 1, 0, newCond);
          return { ...b, conditions: next };
        }
        // Action insertion.
        const action = makeAction(kind);
        // Override the generated id with our deterministic `newId` so
        // callers can select the new node immediately after insertion.
        const actionWithId = { ...action, id: newId } as WorkflowAction;
        if (!bareAfterId) return { ...b, actions: [actionWithId, ...b.actions] };
        const actIdx = b.actions.findIndex((a) => a.id === bareAfterId);
        if (actIdx === -1) {
          // The id refers to something that isn't in the actions array
          // (e.g. a condition id) — append to the end so the new action
          // lands after every existing action.
          return { ...b, actions: [...b.actions, actionWithId] };
        }
        const next = [...b.actions];
        next.splice(actIdx + 1, 0, actionWithId);
        return { ...b, actions: next };
      });
      return { ...w, branches };
    });
    return newId;
  }, [setWorkflow, makeAction]);

  // Delete a condition or action node by its full node id (`cond-*` / `act-*`).
  const deleteNode = useCallback((nodeId: string) => {
    setWorkflow((w) => {
      const branches = (w.branches ?? []).map((b): WorkflowBranch => {
        const condMatch = nodeId.startsWith(`cond-${b.id}-`);
        const actMatch = nodeId.startsWith(`act-${b.id}-`);
        if (!condMatch && !actMatch) return b;
        if (condMatch) {
          const conditionId = nodeId.slice(`cond-${b.id}-`.length);
          return { ...b, conditions: b.conditions.filter((c) => c.id !== conditionId) };
        }
        const actionId = nodeId.slice(`act-${b.id}-`.length);
        return { ...b, actions: b.actions.filter((a) => a.id !== actionId) };
      });
      return { ...w, branches };
    });
  }, [setWorkflow]);

  const updateCondition = useCallback((branchId: string, next: WorkflowCondition) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).map((b) =>
        b.id === branchId ? { ...b, conditions: b.conditions.map((c) => c.id === next.id ? next : c) } : b,
      ),
    }));
  }, [setWorkflow]);

  const updateAction = useCallback((branchId: string, next: WorkflowAction) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).map((b) =>
        b.id === branchId ? { ...b, actions: b.actions.map((a) => a.id === next.id ? next : a) } : b,
      ),
    }));
  }, [setWorkflow]);

  // Replace the full conditions / actions array of a branch. Used by the
  // drawer when the embedded ConditionList / ActionList grows or shrinks
  // (e.g. user clicks "+ Add condition" inside the drawer) so those builtin
  // controls stay functional.
  const replaceBranchConditions = useCallback((branchId: string, conditions: WorkflowCondition[]) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).map((b) =>
        b.id === branchId ? { ...b, conditions } : b,
      ),
    }));
  }, [setWorkflow]);

  const replaceBranchActions = useCallback((branchId: string, actions: WorkflowAction[]) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).map((b) =>
        b.id === branchId ? { ...b, actions } : b,
      ),
    }));
  }, [setWorkflow]);

  // Add a new conditional branch right before the else branch (if any).
  const addBranch = useCallback(() => {
    const id = uuid();
    setWorkflow((w) => {
      const current = w.branches ?? [];
      const elseIdx = current.findIndex((b) => b.is_else);
      const newBranch: WorkflowBranch = { id, conditions: [], actions: [] };
      if (elseIdx === -1) return { ...w, branches: [...current, newBranch] };
      const next = [...current];
      next.splice(elseIdx, 0, newBranch);
      return { ...w, branches: next };
    });
    return id;
  }, [setWorkflow]);

  const addElseBranch = useCallback(() => {
    const id = uuid();
    setWorkflow((w) => {
      if ((w.branches ?? []).some((b) => b.is_else)) return w;
      const elseBranch: WorkflowBranch = { id, conditions: [], actions: [], is_else: true };
      return { ...w, branches: [...(w.branches ?? []), elseBranch] };
    });
    return id;
  }, [setWorkflow]);

  const deleteBranch = useCallback((branchId: string) => {
    setWorkflow((w) => {
      const branches = (w.branches ?? []).filter((b) => b.id !== branchId);
      return { ...w, branches };
    });
  }, [setWorkflow]);

  // Deep-clone helpers — mirror what WorkflowEditorPage did with cloneBranch /
  // cloneAction so duplicates get fresh IDs throughout.
  const duplicateBranch = useCallback((branchId: string, isAr: boolean) => {
    setWorkflow((w) => {
      const current = w.branches ?? [];
      const idx = current.findIndex((b) => b.id === branchId);
      if (idx === -1) return w;
      const original = current[idx]!;
      if (original.is_else) return w;
      const copySuffix = isAr ? ' (نسخة)' : ' (copy)';
      const copy: WorkflowBranch = {
        id: uuid(),
        label_ar: original.label_ar ? `${original.label_ar}${isAr ? copySuffix : ' (نسخة)'}` : original.label_ar,
        label_en: original.label_en ? `${original.label_en}${isAr ? ' (copy)' : copySuffix}` : original.label_en,
        is_else: original.is_else,
        conditions: original.conditions.map((c) => ({ ...c, id: uuid() })),
        actions: original.actions.map((a) => cloneAction(a)),
      };
      const next = [...current];
      next.splice(idx + 1, 0, copy);
      return { ...w, branches: next };
    });
  }, [setWorkflow]);

  return {
    insertNode,
    deleteNode,
    updateCondition,
    updateAction,
    replaceBranchConditions,
    replaceBranchActions,
    addBranch,
    addElseBranch,
    deleteBranch,
    duplicateBranch,
  };
}

// Clone an action with fresh UUIDs for every nested ID so duplicates are fully
// independent of the original. Mirrors the version that used to live in
// WorkflowEditorPage.tsx.
function cloneAction(action: WorkflowAction): WorkflowAction {
  if (action.type === 'create_record') {
    return {
      ...action,
      id: uuid(),
      field_mappings: action.field_mappings.map((m) => ({
        ...m,
        id: uuid(),
        role_conditions: m.role_conditions?.map((rc) => ({ ...rc, id: uuid() })),
      })),
    };
  }
  if (action.type === 'update_record') {
    return {
      ...action,
      id: uuid(),
      field_mappings: action.field_mappings.map((m) => ({
        ...m,
        id: uuid(),
        role_conditions: m.role_conditions?.map((rc) => ({ ...rc, id: uuid() })),
      })),
    };
  }
  if (action.type === 'assign_user') {
    return {
      ...action,
      id: uuid(),
      role_conditions: action.role_conditions.map((rc) => ({ ...rc, id: uuid() })),
    };
  }
  return { ...action, id: uuid() };
}
