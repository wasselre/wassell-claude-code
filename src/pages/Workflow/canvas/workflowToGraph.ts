import type { Node, Edge } from '@xyflow/react';
import type { Workflow, WorkflowBranch, WorkflowAction, ModelField, AppModel } from '@/types';
import {
  LANE_WIDTH,
  LANE_GAP,
  LANE_PADDING_X,
  TRIGGER_HEIGHT,
  NODE_HEIGHT,
  NODE_VERTICAL_GAP,
  LANE_ROW_Y,
} from './constants';
import type { ConditionGroupNodeData } from './nodes/ConditionGroupNode';
import type { BranchHeaderNodeData } from './nodes/BranchHeaderNode';
import type { TailAddPillSpec } from './nodes/TailAddPill';

// Node data payloads. Each node's `type` in xyflow matches one of the keys
// registered in nodeTypes on the canvas, and the data shape is what the
// renderer component receives.

export interface TriggerNodeData extends Record<string, unknown> {
  kind: 'trigger';
  trigger_model_id: string;
  trigger_event: Workflow['trigger_event'];
  trigger_webhook_slug_id?: string | null;
  isAr: boolean;
  readOnly?: boolean;
}

export interface ActionNodeData extends Record<string, unknown> {
  kind: 'action';
  branchId: string;
  action: WorkflowAction;
  triggerFields: ModelField[];
  models: AppModel[];
  isAr: boolean;
  readOnly?: boolean;
  // When this action is the LAST node in its branch we render an attached
  // "+" pill at its bottom edge for appending another action.
  tailAdd?: TailAddPillSpec;
}

// Node ID helpers. The scheme is deterministic so round-tripping is stable:
// edges and layout never need to carry metadata beyond what the IDs encode.
//   trigger                  the single trigger node
//   bh-<branchId>            branch header card (only on else branches)
//   cg-<branchId>            condition group card (one per non-else branch,
//                            even when the branch has zero conditions)
//   act-<branchId>-<actId>   one node per individual action
// The "+ Add step" affordance for the bottom of a branch is no longer a
// separate node — it's rendered as a pill attached to whichever node is
// last in the branch, via the `tailAdd` field on that node's data.
export const TRIGGER_NODE_ID = 'trigger';
export const branchHeaderNodeId = (branchId: string) => `bh-${branchId}`;
export const conditionGroupNodeId = (branchId: string) => `cg-${branchId}`;
export const actionNodeId = (branchId: string, actionId: string) => `act-${branchId}-${actionId}`;

export interface WorkflowToGraphInput {
  workflow: Workflow;
  triggerFields: ModelField[];
  models: AppModel[];
  isAr: boolean;
  // When true the graph is built for a read-only viewer: no "+" add pills,
  // no addable edges, and node data carries `readOnly` so each node hides its
  // delete / duplicate / add-condition affordances.
  readOnly?: boolean;
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
export function workflowToGraph({ workflow, triggerFields, models, isAr, readOnly = false }: WorkflowToGraphInput): WorkflowGraph {
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
      readOnly,
    },
    draggable: false,
    selectable: true,
    width: LANE_WIDTH,
    height: TRIGGER_HEIGHT,
    // `measured` set up-front signals to xyflow's `adoptUserNodes` that the
    // node has known dimensions, which causes it to preserve the existing
    // `handleBounds` rather than wiping them every time the nodes prop
    // changes (e.g. after a new condition or action is added).
    measured: { width: LANE_WIDTH, height: TRIGGER_HEIGHT },
    style: { width: LANE_WIDTH, height: TRIGGER_HEIGHT },
  };
  nodes.push(triggerNode);

  // Each branch is its own vertical column. Width matches the trigger so
  // every chain reads as a parallel arm of the if/else-if/else tree.
  const childWidth = LANE_WIDTH;
  const COND_GROUP_BASE_HEIGHT = 60;       // header + body padding
  const COND_ROW_HEIGHT = 36;              // each condition row inside the group
  const COND_ADD_BUTTON_HEIGHT = 36;
  const HEADER_NODE_HEIGHT = 96;           // standalone branch header (else)

  order.forEach((branch, visualIdx) => {
    const dataIdx = branches.findIndex((b) => b.id === branch.id);
    const positionLabel = positionLabelFor(branch, dataIdx, nonElseCount);
    const colX = LANE_PADDING_X + visualIdx * (LANE_WIDTH + LANE_GAP);
    const branchName = (isAr ? branch.label_ar : branch.label_en)
      || (isAr ? `فرع ${positionLabel}` : `${positionLabel} branch`);

    let yCursor = LANE_ROW_Y;

    // The "+ Add step" affordance is a pill rendered on whichever node
    // ends up last in the branch — no separate tail-add node, no
    // connecting edge from the last action down to a "+" element. We
    // know upfront which node will be last:
    //   - if there are actions, the last action node
    //   - else, the entry node (conditionGroup or branchHeader)
    const lastInsertAfter = branch.actions.length > 0
      ? actionNodeId(branch.id, branch.actions[branch.actions.length - 1]!.id)
      : null;
    const entryIsLast = branch.actions.length === 0;
    const tailSpec: TailAddPillSpec = {
      branchId: branch.id,
      insertAfterId: lastInsertAfter,
      isElse: !!branch.is_else,
    };

    // Entry node for this branch: a ConditionGroupNode for non-else
    // branches (bundles all conditions + branch header in one card), or a
    // small BranchHeaderNode for else branches (no conditions).
    let entryNodeId: string;
    if (branch.is_else) {
      entryNodeId = branchHeaderNodeId(branch.id);
      const headerHeight = HEADER_NODE_HEIGHT;
      nodes.push({
        id: entryNodeId,
        type: 'branchHeader',
        position: { x: colX, y: yCursor },
        data: {
          kind: 'branchHeader',
          branch,
          positionLabel,
          branchName,
          isElse: true,
          canDelete: true,
          canDuplicate: false,
          isAr,
          readOnly,
          ...(entryIsLast && !readOnly ? { tailAdd: tailSpec } : {}),
        } satisfies BranchHeaderNodeData,
        width: childWidth,
        height: headerHeight,
        measured: { width: childWidth, height: headerHeight },
        style: { width: childWidth, height: headerHeight },
        draggable: true,
        selectable: true,
        zIndex: 10,
      });
      yCursor += headerHeight + NODE_VERTICAL_GAP;
    } else {
      entryNodeId = conditionGroupNodeId(branch.id);
      const condCount = branch.conditions.length;
      const groupHeight = COND_GROUP_BASE_HEIGHT
        + Math.max(1, condCount) * COND_ROW_HEIGHT
        + (condCount > 1 ? (condCount - 1) * 18 : 0)
        + COND_ADD_BUTTON_HEIGHT;
      nodes.push({
        id: entryNodeId,
        type: 'conditionGroup',
        position: { x: colX, y: yCursor },
        data: {
          kind: 'conditionGroup',
          branch,
          branchId: branch.id,
          conditions: branch.conditions,
          conditionMode: branch.condition_mode ?? 'all',
          fields: triggerFields,
          triggerEvent: workflow.trigger_event,
          positionLabel,
          branchName,
          isElse: false,
          canDelete: nonElseCount > 1,
          canDuplicate: true,
          isAr,
          readOnly,
          ...(entryIsLast && !readOnly ? { tailAdd: tailSpec } : {}),
        } satisfies ConditionGroupNodeData,
        width: childWidth,
        height: groupHeight,
        measured: { width: childWidth, height: groupHeight },
        style: { width: childWidth, height: groupHeight },
        draggable: true,
        selectable: true,
        zIndex: 10,
      });
      yCursor += groupHeight + NODE_VERTICAL_GAP;
    }

    // Trigger → entry edge. Plain edge (no "+"): adding "before" the
    // entry doesn't make sense — conditions belong inside the entry, and
    // actions live below it.
    edges.push({
      id: `e-trigger-${entryNodeId}`,
      source: TRIGGER_NODE_ID,
      target: entryNodeId,
      type: 'default',
    });

    // Action chain. Edge from the entry to the first action gets "+" so
    // users can insert there too. The LAST action gets a `tailAdd` pill
    // attached at its bottom — no separate tail node, no trailing edge.
    let prevId = entryNodeId;
    branch.actions.forEach((action, idx) => {
      const id = actionNodeId(branch.id, action.id);
      const isLastAction = idx === branch.actions.length - 1;
      nodes.push({
        id,
        type: 'action',
        position: { x: colX, y: yCursor },
        data: {
          kind: 'action',
          branchId: branch.id,
          action,
          triggerFields,
          models,
          isAr,
          readOnly,
          ...(isLastAction && !readOnly ? { tailAdd: tailSpec } : {}),
        } satisfies ActionNodeData,
        width: childWidth,
        height: NODE_HEIGHT,
        measured: { width: childWidth, height: NODE_HEIGHT },
        style: { width: childWidth, height: NODE_HEIGHT },
        draggable: true,
        selectable: true,
        zIndex: 10,
      });
      const isPrevAction = prevId.startsWith('act-');
      edges.push({
        id: `e-${prevId}-${id}`,
        source: prevId,
        target: id,
        // Read-only viewers get plain edges (no "+" insert affordance).
        type: readOnly ? 'default' : 'addable',
        data: {
          branchId: branch.id,
          insertAfterId: isPrevAction ? prevId : null,
          isEntry: !isPrevAction,
          isElse: !!branch.is_else,
          isAfterAction: isPrevAction,
        },
      });
      prevId = id;
      yCursor += NODE_HEIGHT + NODE_VERTICAL_GAP;
    });
  });

  return { nodes, edges };
}

// (graphToWorkflow used to round-trip drag-reordered children back into the
// workflow tree under the old per-condition node model. With conditions now
// grouped in a single ConditionGroupNode and actions edited via the workflow
// store directly, the workflow tree IS the source of truth — no graph→tree
// reconstruction is needed. Removed to keep the surface area small.)
