import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
  useNodesState,
  type NodeMouseHandler,
  type Node,
} from '@xyflow/react';
import { Plus, GitBranch } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './canvasStyles.css';
import { useAppStore } from '@/stores/appStore';
import type { Workflow, ModelField, WorkflowEvent } from '@/types';
import TriggerNode from './nodes/TriggerNode';
import ConditionNode from './nodes/ConditionNode';
import ActionNode from './nodes/ActionNode';
import BranchGroupNode from './nodes/BranchGroupNode';
import AddableEdge from './edges/AddableEdge';
import NodeDrawer, { type DrawerNode } from './NodeDrawer';
import AddNodeMenu, { type AddMenuPayload, type AddableKind } from './AddNodeMenu';
import { workflowToGraph, TRIGGER_NODE_ID, conditionNodeId, actionNodeId } from './workflowToGraph';
import { useWorkflowGraph } from './useWorkflowGraph';

// nodeTypes and edgeTypes are registered module-scope. React Flow treats a
// new object reference as a change and warns loudly — keeping them stable
// avoids the "new nodeTypes / edgeTypes" console warning on every render.
const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
  branchGroup: BranchGroupNode,
};

const edgeTypes = {
  addable: AddableEdge,
};

interface WorkflowCanvasProps {
  workflow: Workflow;
  setWorkflow: (updater: (w: Workflow) => Workflow) => void;
  triggerFields: ModelField[];
}

// Wrapper that provides the React Flow context. The actual canvas body needs
// `useReactFlow` which requires a provider above it.
export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner({ workflow, setWorkflow, triggerFields }: WorkflowCanvasProps) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';
  const rf = useReactFlow();
  const storeApi = useStoreApi();
  const updateNodeInternals = useUpdateNodeInternals();

  const graphHelpers = useWorkflowGraph(workflow, setWorkflow);

  // Derived graph. Rebuilt on every workflow change — the function is cheap
  // (linear in the number of conditions + actions).
  // Derive the target graph from the workflow tree every time it changes. We
  // then feed the result into xyflow's `useNodesState` / `useEdgesState` hooks
  // so xyflow owns the node/edge stores internally and can preserve each
  // node's measurement + handle bounds across updates.
  const graph = useMemo(
    () => workflowToGraph({ workflow, triggerFields, models, isAr }),
    [workflow, triggerFields, models, isAr],
  );

  // We use `useNodesState` so xyflow can manage node drag locally without us
  // re-deriving positions on every render. When the workflow tree changes
  // (a node added / removed / edited) we MERGE the new graph with the
  // existing nodes — keeping the position the user has dragged a node to,
  // and only adopting the freshly-computed position for nodes that didn't
  // previously exist. This makes nodes truly draggable without losing the
  // tree-as-source-of-truth contract.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph.nodes);
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((g) => {
        const old = prevById.get(g.id);
        if (!old) return g;
        // Preserve the user's dragged position + selected flag, replace
        // everything else (data, type, style, etc.) with the fresh graph
        // values so summary text and styling reflect the latest workflow.
        return { ...g, position: old.position, selected: old.selected };
      });
    });
  }, [graph.nodes, setNodes]);
  // xyflow relies on a ResizeObserver to measure nodes and populate each
  // node's `handleBounds`; edges refuse to render until bounds are
  // populated. Some environments (headless browsers, certain iframe setups)
  // don't fire ResizeObserver for elements that mount at their final size,
  // and xyflow also drops bounds whenever the user-facing `nodes` array
  // changes (our graph rebuilds every workflow mutation). To stay robust we
  // run an rAF loop that continuously backfills missing bounds from the
  // live DOM into xyflow's internal store. The loop idles (via rAF, not a
  // busy spin) whenever every node already has bounds.
  useEffect(() => {
    let stopped = false;
    let raf = 0;

    const patchMissingBounds = (): boolean => {
      const state = storeApi.getState();
      const container = state.domNode;
      if (!container) return true;
      const nodes = [...state.nodeLookup.values()];
      if (nodes.length === 0) return true;
      const zoom = state.transform?.[2] ?? 1;
      const nextLookup = new Map(state.nodeLookup);
      let patched = false;
      let allHaveBounds = true;
      for (const n of nodes) {
        if (n.internals?.handleBounds) continue;
        const el = container.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
        if (!el) { allHaveBounds = false; continue; }
        const nodeRect = (el as HTMLElement).getBoundingClientRect();
        if (nodeRect.width === 0 || nodeRect.height === 0) { allHaveBounds = false; continue; }
        const sourceEls = el.querySelectorAll('.react-flow__handle.source');
        const targetEls = el.querySelectorAll('.react-flow__handle.target');
        const makeBounds = (els: NodeListOf<Element>, type: 'source' | 'target') => Array.from(els).map((h) => {
          const r = (h as HTMLElement).getBoundingClientRect();
          return {
            id: h.getAttribute('data-handleid'),
            type,
            nodeId: n.id,
            position: h.getAttribute('data-handlepos') as 'top' | 'bottom' | 'left' | 'right',
            x: (r.left - nodeRect.left) / zoom,
            y: (r.top - nodeRect.top) / zoom,
            width: (h as HTMLElement).offsetWidth,
            height: (h as HTMLElement).offsetHeight,
          };
        });
        const newInternals = {
          ...n.internals,
          handleBounds: { source: makeBounds(sourceEls, 'source'), target: makeBounds(targetEls, 'target') },
        } as unknown as typeof n.internals;
        // Preserve everything else on the node (notably `position`, which
        // may be the user's dragged location) — only swap measured + the
        // internals.handleBounds we just computed.
        nextLookup.set(n.id, { ...n, measured: { width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }, internals: newInternals });
        patched = true;
      }
      if (patched) {
        // Only update `nodeLookup` (xyflow's derived structure with
        // internals) — we DON'T overwrite `state.nodes`, because that's the
        // user-facing array owned by `useNodesState` and writing it here
        // would clobber any drag positions the user has applied.
        storeApi.setState({
          nodeLookup: nextLookup,
          nodesInitialized: true,
        });
        // Nudge xyflow's edge renderer — it subscribes to
        // `updateNodeInternals` changes, not raw nodeLookup mutations.
        updateNodeInternals([...nextLookup.keys()]);
      }
      return allHaveBounds;
    };

    const initialIds = storeApi.getState().nodes.map((n) => n.id);
    updateNodeInternals(initialIds);

    // Keep ticking forever. Each tick is a tiny DOM query; when bounds are
    // already complete it's a no-op. The cost vs. the correctness win is
    // fine for the editor (users rarely have >50 nodes).
    // Run a modest-cadence interval for the lifetime of the canvas. Each tick
    // is a tiny DOM query, and a write only when a node is missing bounds —
    // so the cost is negligible. We prefer setInterval over rAF because some
    // environments (headless browsers, backgrounded tabs) pause rAF entirely
    // while still honouring setInterval.
    const interval = window.setInterval(() => {
      if (stopped) return;
      patchMissingBounds();
    }, 120);
    patchMissingBounds();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drawer state — open when a node is selected, closed otherwise.
  const [drawer, setDrawer] = useState<DrawerNode | null>(null);
  // Which node xyflow considers selected (used to draw the copper ring).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Add-menu state — tracked when a user clicks the "+" on an edge.
  const [addMenu, setAddMenu] = useState<AddMenuPayload | null>(null);

  // Ref so event listeners can read the latest workflow without re-attaching.
  const workflowRef = useRef(workflow);
  useEffect(() => { workflowRef.current = workflow; }, [workflow]);

  // Selecting a node from the canvas opens the drawer with the right editor.
  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    setSelectedId(node.id);
    if (node.id === TRIGGER_NODE_ID) {
      setDrawer({ kind: 'trigger' });
      return;
    }
    if (node.type === 'condition') {
      const data = node.data as { branchId: string };
      const branch = workflowRef.current.branches?.find((b) => b.id === data.branchId);
      const conditionId = node.id.slice(`cond-${data.branchId}-`.length);
      const condition = branch?.conditions.find((c) => c.id === conditionId);
      if (condition) setDrawer({ kind: 'condition', branchId: data.branchId, condition });
      return;
    }
    if (node.type === 'action') {
      const data = node.data as { branchId: string };
      const branch = workflowRef.current.branches?.find((b) => b.id === data.branchId);
      const actionId = node.id.slice(`act-${data.branchId}-`.length);
      const action = branch?.actions.find((a) => a.id === actionId);
      if (action) setDrawer({ kind: 'action', branchId: data.branchId, action });
    }
  }, []);

  // Keep the drawer's copy of the node in sync with the workflow. Without
  // this, editing a condition/action would freeze the drawer body after the
  // first change because it holds a stale object.
  useEffect(() => {
    if (!drawer) return;
    if (drawer.kind === 'condition') {
      const branch = workflow.branches?.find((b) => b.id === drawer.branchId);
      const updated = branch?.conditions.find((c) => c.id === drawer.condition.id);
      if (updated && updated !== drawer.condition) {
        setDrawer({ kind: 'condition', branchId: drawer.branchId, condition: updated });
      }
    } else if (drawer.kind === 'action') {
      const branch = workflow.branches?.find((b) => b.id === drawer.branchId);
      const updated = branch?.actions.find((a) => a.id === drawer.action.id);
      if (updated && updated !== drawer.action) {
        setDrawer({ kind: 'action', branchId: drawer.branchId, action: updated });
      }
    }
  }, [workflow, drawer]);

  // Listen for the custom events dispatched from nodes / edges. Keeping these
  // as DOM events instead of prop drilling means the node components don't
  // need to know about the canvas, keeping them independently composable.
  useEffect(() => {
    const onDelete = (e: Event) => {
      const { id } = (e as CustomEvent).detail as { id: string };
      graphHelpers.deleteNode(id);
      // If the deleted node is open in the drawer, close it.
      setDrawer((d) => {
        if (!d) return d;
        if (d.kind === 'condition' && conditionNodeId(d.branchId, d.condition.id) === id) return null;
        if (d.kind === 'action' && actionNodeId(d.branchId, d.action.id) === id) return null;
        return d;
      });
    };
    const onDeleteBranch = (e: Event) => {
      const { id } = (e as CustomEvent).detail as { id: string };
      graphHelpers.deleteBranch(id);
      setDrawer(null);
    };
    const onDuplicateBranch = (e: Event) => {
      const { id } = (e as CustomEvent).detail as { id: string };
      graphHelpers.duplicateBranch(id, isAr);
    };
    const onOpenAddMenu = (e: Event) => {
      const { flowX, flowY, branchId, insertAfterId, isEntry, isElse, isAfterAction } = (e as CustomEvent).detail as {
        flowX: number; flowY: number; branchId: string; insertAfterId: string | null; isEntry: boolean; isElse: boolean; isAfterAction: boolean;
      };
      // Translate flow-space to screen-space using xyflow's viewport.
      const screen = rf.flowToScreenPosition({ x: flowX, y: flowY });
      setAddMenu({
        branchId,
        insertAfterId,
        isEntry,
        isElse,
        isAfterAction,
        screenX: screen.x,
        screenY: screen.y,
      });
    };

    window.addEventListener('workflow-canvas:delete-node', onDelete);
    window.addEventListener('workflow-canvas:delete-branch', onDeleteBranch);
    window.addEventListener('workflow-canvas:duplicate-branch', onDuplicateBranch);
    window.addEventListener('workflow-canvas:open-add-menu', onOpenAddMenu);
    return () => {
      window.removeEventListener('workflow-canvas:delete-node', onDelete);
      window.removeEventListener('workflow-canvas:delete-branch', onDeleteBranch);
      window.removeEventListener('workflow-canvas:duplicate-branch', onDuplicateBranch);
      window.removeEventListener('workflow-canvas:open-add-menu', onOpenAddMenu);
    };
  }, [graphHelpers, rf, isAr]);

  // Keyboard delete. xyflow has its own Delete handler; we intercept to pass
  // through our own deletion logic and to guard the "only non-else branch"
  // invariant. Ignored when the drawer holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!selectedId || selectedId === TRIGGER_NODE_ID) return;
      if (selectedId.startsWith('branch-')) return; // branch deletion via lane button only
      e.preventDefault();
      graphHelpers.deleteNode(selectedId);
      setSelectedId(null);
      setDrawer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedId, graphHelpers]);

  const onPickAddKind = useCallback((kind: AddableKind) => {
    if (!addMenu) return;
    const newId = graphHelpers.insertNode(kind, addMenu.branchId, addMenu.insertAfterId);
    setAddMenu(null);
    // Auto-select the new node and open its drawer so the user can configure
    // it without an extra click. For conditions the newId matches the
    // conditionId; for actions it matches the actionId.
    const nodeId = kind === 'condition' ? conditionNodeId(addMenu.branchId, newId) : actionNodeId(addMenu.branchId, newId);
    setSelectedId(nodeId);
    if (kind === 'condition') {
      setDrawer({ kind: 'condition', branchId: addMenu.branchId, condition: { id: newId, field_id: '', operator: 'equals', value: '' } });
    } else {
      // The action itself will be synced via the effect above once workflow
      // updates; for now seed the drawer with a minimal shape.
      setTimeout(() => {
        const branch = workflowRef.current.branches?.find((b) => b.id === addMenu.branchId);
        const action = branch?.actions.find((a) => a.id === newId);
        if (action) setDrawer({ kind: 'action', branchId: addMenu.branchId, action });
      }, 0);
    }
  }, [addMenu, graphHelpers]);

  // Editor callbacks passed into the drawer.
  const onUpdateTrigger = useCallback((patch: { trigger_model_id?: string; trigger_event?: WorkflowEvent; trigger_webhook_slug_id?: string | null }) => {
    // Reset conditions on trigger changes to avoid stale field references —
    // mirrors the same invariant the old editor upheld.
    setWorkflow((w) => {
      const base = { ...w, ...patch };
      const anyKey = Object.keys(patch)[0];
      if (!anyKey) return base;
      return {
        ...base,
        branches: (w.branches ?? []).map((b) => ({ ...b, conditions: [] })),
      };
    });
  }, [setWorkflow]);

  // Sync the canvas selection state with our drawer state — clicking a node
  // both opens the drawer and applies xyflow's `selected` flag for the
  // copper ring.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId }));
  }, [selectedId, setNodes]);

  // When the user adds a whole new branch / else via the toolbar, open the
  // drawer on the trigger (there's no empty-branch editor; they immediately
  // see the new lane appear and can click "+").
  const onAddBranch = () => { graphHelpers.addBranch(); };
  const onAddElse = () => { graphHelpers.addElseBranch(); };

  const hasElse = (workflow.branches ?? []).some((b) => b.is_else);

  // Fit the view once after the first render with branches. Subsequent fits
  // are handled by xyflow's Controls panel.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if ((workflow.branches ?? []).length === 0) return;
    didFitRef.current = true;
    // Schedule after paint so node dimensions settle first.
    const t = setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [workflow.branches, rf]);

  return (
    // Full-height canvas: the wrap fills the parent's flex slot, and the
    // Add-branch / Add-else buttons float over the top-start corner of the
    // canvas instead of eating a whole row above it.
    <div className="workflow-canvas-wrap relative h-full">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelectedId(null)}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode="Shift"
        selectNodesOnDrag={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
      >
        <Background color="#D4B896" gap={20} size={1} />
        <Controls position={isAr ? 'bottom-left' : 'bottom-right'} showInteractive={false} />
        <MiniMap
          position={isAr ? 'top-left' : 'top-right'}
          pannable
          zoomable
          maskColor="rgba(74, 44, 42, 0.08)"
          nodeColor={(n) => {
            if (n.type === 'trigger') return '#F59E0B';
            if (n.type === 'condition') return '#0EA5E9';
            if (n.type === 'action') return '#B8734F';
            if (n.type === 'branchGroup') return 'rgba(184, 115, 79, 0.15)';
            return '#D4B896';
          }}
        />
      </ReactFlow>

      {/* Floating toolbar — sits over the canvas's top-start corner. Uses
          `pointer-events-none` on the wrap + `pointer-events-auto` on the
          buttons so the canvas pane stays pan-draggable everywhere else. */}
      <div className="absolute top-3 start-3 z-10 flex flex-wrap items-center gap-2 pointer-events-none">
        <button
          onClick={onAddBranch}
          className="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-xl bg-white/90 backdrop-blur border border-dashed border-copper/40 text-copper hover:bg-copper/5 transition-colors text-sm font-bold shadow-sm"
          title={isAr ? 'أضف فرعًا مشروطًا جديدًا' : 'Add another conditional branch'}
        >
          <Plus size={14} />
          <GitBranch size={12} />
          {isAr ? 'إضافة فرع' : 'Add branch'}
        </button>
        {!hasElse && (
          <button
            onClick={onAddElse}
            className="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-xl bg-white/90 backdrop-blur border border-dashed border-chocolate/30 text-chocolate/70 hover:bg-chocolate/5 transition-colors text-sm font-bold shadow-sm"
            title={isAr ? 'أضف حالة افتراضية' : 'Add default case'}
          >
            <Plus size={14} />
            {isAr ? 'حالة افتراضية' : 'Else case'}
          </button>
        )}
      </div>

      <NodeDrawer
        open={!!drawer}
        node={drawer}
        workflow={workflow}
        triggerFields={triggerFields}
        onClose={() => { setDrawer(null); setSelectedId(null); }}
        onUpdateTrigger={onUpdateTrigger}
        onReplaceBranchConditions={graphHelpers.replaceBranchConditions}
        onReplaceBranchActions={graphHelpers.replaceBranchActions}
      />

      {addMenu && (
        <AddNodeMenu
          payload={addMenu}
          onClose={() => setAddMenu(null)}
          onPick={onPickAddKind}
        />
      )}
    </div>
  );
}
