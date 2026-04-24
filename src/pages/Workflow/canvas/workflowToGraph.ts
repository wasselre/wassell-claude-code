import type { Node, Edge } from '@xyflow/react';
import type { Workflow, WorkflowBranch, WorkflowCondition, WorkflowAction, ModelField, AppModel } from '@/types';
import {
  LANE_WIDTH,
  LANE_GAP,
  LANE_PADDING_X,
  LANE_HEADER_HEIGHT,
  TRIGGER_HEIGHT,
  LANE_MIN_HEIGHT,
  NODE_HEIGHT,
  NODE_VERTICAL_GAP,
  LANE_ROW_Y,
} from './constants';

// Node data payloads. Each node's `type` in xyflow matches one of the keys
// registered in nodeTypes on the canvas, and the data shape is what the
// renderer component receives.

export interface TriggerNodeData extends Record<string, unknown> {
  kind: 'trigger';
  trigger_model_id: string;
  trigger_event: Workflow['trigger_event'];
  trigger_webhook_slug_id?: string | null;
  isAr: boolean;
}

export interface ConditionNodeData extends Record<string, unknown> {
  kind: 'condition';
  branchId: string;
  condition: WorkflowCondition;
  fields: ModelField[];
  triggerEvent: Workflow['trigger_event'];
  isAr: boolean;
}

export interface ActionNodeData extends Record<string, unknown> {
  kind: 'action';
  branchId: string;
  action: WorkflowAction;
  triggerFields: ModelField[];
  models: AppModel[];
  isAr: boolean;
}

export interface BranchGroupNodeData extends Record<string, unknown> {
  kind: 'branch';
  branch: WorkflowBranch;
  index: number;           // visual index in the current (possibly RTL-reversed) order
  dataIndex: number;       // original index in workflow.branches
  positionLabel: 'IF' | 'ELSE IF' | 'OTHERWISE';
  isElse: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  isAr: boolean;
}

// Node ID helpers. The scheme is deterministic so round-tripping through
// graphToWorkflow is stable: edges and layout never need to carry metadata
// beyond what the IDs already encode.
export const TRIGGER_NODE_ID = 'trigger';
export const branchNodeId = (branchId: string) => `branch-${branchId}`;
export const conditionNodeId = (branchId: string, conditionId: string) => `cond-${branchId}-${conditionId}`;
export const actionNodeId = (branchId: string, actionId: string) => `act-${branchId}-${actionId}`;

export interface WorkflowToGraphInput {
  workflow: Workflow;
  triggerFields: ModelField[];
  models: AppModel[];
  isAr: boolean;
}

export interface WorkflowGraph {
  nodes: Node[];
  edges: Edge[];
}

// Compute the display order of branches. In RTL we reverse the visual lane
// order so the flow reads right-to-left, but the underlying workflow.branches
// array stays in its canonical order — this keeps save logic and engine
// semantics untouched.
function displayOrder(branches: WorkflowBranch[], isAr: boolean): WorkflowBranch[] {
  return isAr ? [...branches].reverse() : branches;
}

function positionLabelFor(branch: WorkflowBranch, dataIdx: number, nonElseCount: number): 'IF' | 'ELSE IF' | 'OTHERWISE' {
  if (branch.is_else) return 'OTHERWISE';
  if (dataIdx === 0) return 'IF';
  // nonElseCount === 1 would make this the only non-else — label as IF even if somehow non-first.
  return nonElseCount === 1 ? 'IF' : 'ELSE IF';
}

// Build the graph from a workflow. The caller rebuilds the graph on every
// workflow change; the function is cheap (no IO, linear in the number of
// conditions + actions).
export function workflowToGraph({ workflow, triggerFields, models, isAr }: WorkflowToGraphInput): WorkflowGraph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const branches = workflow.branches ?? [];
  const order = displayOrder(branches, isAr);
  const nonElseCount = branches.filter((b) => !b.is_else).length;

  // Trigger node sits centered above the lane row. Width matches a lane so the
  // visual anchor aligns with the first branch header. We set explicit
  // dimensions on the node (not just `style`) so xyflow has coordinates to
  // compute edge endpoints from on the very first render pass, instead of
  // waiting for the DOM measurement cycle to complete.
  const triggerNode: Node<TriggerNodeData> = {
    id: TRIGGER_NODE_ID,
    type: 'trigger',
    position: { x: LANE_PADDING_X, y: 0 },
    data: {
      kind: 'trigger',
      trigger_model_id: workflow.trigger_model_id,
      trigger_event: workflow.trigger_event,
      trigger_webhook_slug_id: workflow.trigger_webhook_slug_id ?? null,
      isAr,
    },
    draggable: false,
    selectable: true,
    width: LANE_WIDTH,
    height: TRIGGER_HEIGHT,
    style: { width: LANE_WIDTH, height: TRIGGER_HEIGHT },
  };
  nodes.push(triggerNode);

  order.forEach((branch, visualIdx) => {
    const dataIdx = branches.findIndex((b) => b.id === branch.id);
    const laneId = branchNodeId(branch.id);
    const positionLabel = positionLabelFor(branch, dataIdx, nonElseCount);
    const laneX = LANE_PADDING_X + visualIdx * (LANE_WIDTH + LANE_GAP);

    const childCount = branch.conditions.length + branch.actions.length;
    const childrenHeight = childCount === 0
      ? 120
      : childCount * NODE_HEIGHT + (childCount - 1) * NODE_VERTICAL_GAP;
    const laneHeight = Math.max(LANE_MIN_HEIGHT, LANE_HEADER_HEIGHT + 48 + childrenHeight + 48);

    const groupNode: Node<BranchGroupNodeData> = {
      id: laneId,
      type: 'branchGroup',
      position: { x: laneX, y: LANE_ROW_Y },
      data: {
        kind: 'branch',
        branch,
        index: visualIdx,
        dataIndex: dataIdx,
        positionLabel,
        isElse: !!branch.is_else,
        canDelete: branch.is_else ? true : nonElseCount > 1,
        canDuplicate: !branch.is_else,
        isAr,
      },
      width: LANE_WIDTH,
      height: laneHeight,
      style: { width: LANE_WIDTH, height: laneHeight },
      draggable: true,
      selectable: false,
      zIndex: 0,
    };
    nodes.push(groupNode);

    // Trigger → first child connector. Empty lanes don't get an edge — the
    // BranchGroupNode renders an in-lane "Add first step" button instead,
    // since xyflow won't draw edges that terminate on a handle-less group.
    const firstChildId = branch.conditions[0]
      ? conditionNodeId(branch.id, branch.conditions[0].id)
      : branch.actions[0]
        ? actionNodeId(branch.id, branch.actions[0].id)
        : null;
    if (firstChildId) {
      edges.push({
        id: `e-trigger-${laneId}-${firstChildId}`,
        source: TRIGGER_NODE_ID,
        target: firstChildId,
        type: 'addable',
        data: { branchId: branch.id, insertAfterId: null, isEntry: true, isElse: !!branch.is_else, isAfterAction: false },
      });
    }

    // Position conditions then actions top-to-bottom. We DON'T use xyflow's
    // group-node `parentId` relationship for children — it subtly breaks
    // edge rendering in v12 (edges silently skip children of group nodes
    // when the group's dimensions haven't been measured yet). Instead we
    // compute absolute flow-space coordinates directly. The lane node is
    // still rendered as a background rectangle at the same coords; it just
    // doesn't own the children as React Flow parents.
    const xInsideLane = (LANE_WIDTH - LANE_WIDTH * 0.82) / 2;
    const childWidth = Math.round(LANE_WIDTH * 0.82);
    let yCursor = LANE_ROW_Y + LANE_HEADER_HEIGHT + 48;
    const childStartX = laneX + xInsideLane;

    const childOrder: Array<{ id: string; kind: 'condition' | 'action' }> = [
      ...branch.conditions.map((c) => ({ id: conditionNodeId(branch.id, c.id), kind: 'condition' as const })),
      ...branch.actions.map((a) => ({ id: actionNodeId(branch.id, a.id), kind: 'action' as const })),
    ];

    branch.conditions.forEach((cond) => {
      const id = conditionNodeId(branch.id, cond.id);
      nodes.push({
        id,
        type: 'condition',
        position: { x: childStartX, y: yCursor },
        data: {
          kind: 'condition',
          branchId: branch.id,
          condition: cond,
          fields: triggerFields,
          triggerEvent: workflow.trigger_event,
          isAr,
        } satisfies ConditionNodeData,
        width: childWidth,
        height: NODE_HEIGHT,
        style: { width: childWidth, height: NODE_HEIGHT },
        draggable: true,
        selectable: true,
        zIndex: 10,
      });
      yCursor += NODE_HEIGHT + NODE_VERTICAL_GAP;
    });

    branch.actions.forEach((action) => {
      const id = actionNodeId(branch.id, action.id);
      nodes.push({
        id,
        type: 'action',
        position: { x: childStartX, y: yCursor },
        data: {
          kind: 'action',
          branchId: branch.id,
          action,
          triggerFields,
          models,
          isAr,
        } satisfies ActionNodeData,
        width: childWidth,
        height: NODE_HEIGHT,
        style: { width: childWidth, height: NODE_HEIGHT },
        draggable: true,
        selectable: true,
        zIndex: 10,
      });
      yCursor += NODE_HEIGHT + NODE_VERTICAL_GAP;
    });

    // Chain edges between successive children inside the lane, each carrying
    // `insertAfterId` so the "+" button on the edge knows where to inject.
    for (let i = 0; i < childOrder.length - 1; i++) {
      const from = childOrder[i]!;
      const to = childOrder[i + 1]!;
      edges.push({
        id: `e-${from.id}-${to.id}`,
        source: from.id,
        target: to.id,
        type: 'addable',
        data: {
          branchId: branch.id,
          insertAfterId: from.id,
          isEntry: false,
          isElse: !!branch.is_else,
          // Once we're past a condition, only actions can be inserted — the
          // engine expects all conditions to come before all actions within a
          // branch. We expose both kinds on the menu; the menu itself disables
          // conditions when isAfterAction is true.
          isAfterAction: from.kind === 'action',
        },
      });
    }

    // Trailing "+ add at end" lives inside the BranchGroupNode as an in-lane
    // button (see BranchGroupNode.tsx) instead of as an edge targeting the
    // handle-less lane, so xyflow doesn't silently drop it.
  });

  return { nodes, edges };
}

// Rebuild a workflow from the current graph state. Invoked after drag-reorder
// inside a lane, or after lane drag-reorder. Node IDs alone are enough to
// recover branch membership (prefixes) and item IDs — positions give us the
// sort order within each bucket.
export interface GraphToWorkflowInput {
  nodes: Node[];
  baseWorkflow: Workflow;
  isAr: boolean;
}

export function graphToWorkflow({ nodes, baseWorkflow, isAr }: GraphToWorkflowInput): Workflow {
  const existingBranches = baseWorkflow.branches ?? [];
  // Index branches by id for O(1) lookup when rebuilding children.
  const branchById = new Map(existingBranches.map((b) => [b.id, b]));
  const conditionById = new Map<string, { branchId: string; cond: WorkflowCondition }>();
  const actionById = new Map<string, { branchId: string; action: WorkflowAction }>();
  existingBranches.forEach((b) => {
    b.conditions.forEach((c) => conditionById.set(c.id, { branchId: b.id, cond: c }));
    b.actions.forEach((a) => actionById.set(a.id, { branchId: b.id, action: a }));
  });

  // Group child nodes by the branch prefix in their ID (`cond-{bid}-...` or
  // `act-{bid}-...`). Children are no longer parented via React Flow's
  // group mechanism — they live in absolute flow space — so we recover
  // lane membership from the ID, not from `parentId`.
  const childrenByLane = new Map<string, Node[]>();
  const laneNodes: Node[] = [];
  for (const n of nodes) {
    if (n.type === 'branchGroup') {
      laneNodes.push(n);
      continue;
    }
    if (n.type !== 'condition' && n.type !== 'action') continue;
    const m = n.id.match(/^(?:cond|act)-([^-]+(?:-[^-]+){4})-/);
    if (!m) continue;
    const laneKey = `branch-${m[1]}`;
    const list = childrenByLane.get(laneKey) ?? [];
    list.push(n);
    childrenByLane.set(laneKey, list);
  }

  // Lane order from x position. In RTL we invert — the visual right-to-left
  // layout should still produce the same data-order the user sees.
  const sortedLanes = [...laneNodes].sort((a, b) => a.position.x - b.position.x);
  const visualOrder = sortedLanes.map((n) => n.id.replace(/^branch-/, ''));
  const dataOrderIds = isAr ? [...visualOrder].reverse() : visualOrder;

  // Reconstruct branches in the canonical (non-visual) order, pulling children
  // from the graph. Children are assigned to whatever lane they currently
  // belong to (parentId), which may differ from where they started if we ever
  // allow cross-lane drag. We preserve the condition-then-action invariant by
  // sorting by node type first, then by y. That means a user dragging an
  // action above a condition in the same lane cannot violate the invariant.
  const rebuiltBranches: WorkflowBranch[] = dataOrderIds.map((branchId): WorkflowBranch => {
    const base = branchById.get(branchId);
    const laneChildren = (childrenByLane.get(`branch-${branchId}`) ?? [])
      .slice()
      .sort((a, b) => {
        const typeRank = a.type === b.type ? 0 : a.type === 'condition' ? -1 : 1;
        return typeRank !== 0 ? typeRank : a.position.y - b.position.y;
      });

    const nextConditions: WorkflowCondition[] = [];
    const nextActions: WorkflowAction[] = [];
    for (const child of laneChildren) {
      if (child.type === 'condition') {
        const conditionId = child.id.slice(`cond-${branchId}-`.length);
        const hit = conditionById.get(conditionId);
        if (hit) nextConditions.push(hit.cond);
      } else if (child.type === 'action') {
        const actionId = child.id.slice(`act-${branchId}-`.length);
        const hit = actionById.get(actionId);
        if (hit) nextActions.push(hit.action);
      }
    }

    // Spread `base` first so optional label fields remain optional (not
    // explicit undefined) in the resulting shape — that matches
    // WorkflowBranch's optional-property contract under strict TS.
    return {
      ...(base ?? {}),
      id: branchId,
      conditions: nextConditions,
      actions: nextActions,
    };
  });

  // Else branch must remain pinned to the end of the array. If the user
  // dragged it somewhere else, clamp it back to the last slot.
  const elseIdx = rebuiltBranches.findIndex((b) => b.is_else);
  if (elseIdx !== -1 && elseIdx !== rebuiltBranches.length - 1) {
    const [elseBranch] = rebuiltBranches.splice(elseIdx, 1);
    rebuiltBranches.push(elseBranch!);
  }

  return { ...baseWorkflow, branches: rebuiltBranches };
}
