import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, Save, Plus, GitBranch, CornerDownRight, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { bilingualFromInput } from '@/lib/autoTranslate';
import TriggerPanel from './components/TriggerPanel';
import BranchCard from './components/BranchCard';
import type { Workflow, WorkflowEvent, WorkflowBranch, WorkflowAction } from '@/types';

// Build the branch list for the editor. New workflows get a single empty "IF"
// branch. Older saves that only have flat `conditions` / `actions` are wrapped
// into a single branch so the editor doesn't lose their data.
function initialBranches(workflow: Workflow): WorkflowBranch[] {
  if (workflow.branches && workflow.branches.length > 0) return workflow.branches;
  // Legacy migration — wrap the flat shape in one branch.
  return [{
    id: uuid(),
    conditions: workflow.conditions ?? [],
    actions: workflow.actions ?? [],
  }];
}

// Deep-clone an action, giving every nested entity (the action itself, each
// field mapping, each role condition) a fresh UUID so the copy is fully
// independent of the original. Keeps all field values identical — callers can
// tweak them after.
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

// Deep-clone a branch, fresh IDs throughout. The `isAr` flag picks which name
// to suffix with "(copy)" so the duplicate reads as a distinct row in the
// current language.
function cloneBranch(branch: WorkflowBranch, isAr: boolean): WorkflowBranch {
  const copySuffix = isAr ? ' (نسخة)' : ' (copy)';
  return {
    id: uuid(),
    label_ar: branch.label_ar ? `${branch.label_ar}${isAr ? copySuffix : ' (نسخة)'}` : branch.label_ar,
    label_en: branch.label_en ? `${branch.label_en}${isAr ? ' (copy)' : copySuffix}` : branch.label_en,
    is_else: branch.is_else,
    conditions: branch.conditions.map((c) => ({ ...c, id: uuid() })),
    actions: branch.actions.map((a) => cloneAction(a)),
  };
}

export default function WorkflowEditorPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { workflows, models, saveWorkflow, addToast, language } = useAppStore();
  const isAr = language === 'ar';

  const isNew = workflowId === 'new';
  const existing = !isNew ? workflows.find((w) => w.id === workflowId) : null;

  const [workflow, setWorkflow] = useState<Workflow>(() => {
    if (existing) {
      return { ...existing, branches: initialBranches(existing) };
    }
    const firstBranch: WorkflowBranch = {
      id: uuid(),
      conditions: [],
      actions: [],
    };
    return {
      id: uuid(),
      label_ar: '',
      label_en: '',
      trigger_model_id: '',
      trigger_event: 'create' as WorkflowEvent,
      branches: [firstBranch],
      conditions: [],
      actions: [],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  // Which branches are currently collapsed (key = branch.id). Collapsed state
  // is purely UI — it's reset when the editor opens a different workflow.
  const [collapsedBranches, setCollapsedBranches] = useState<Record<string, boolean>>({});

  // Canvas zoom — purely visual. We use the CSS `zoom` property (not transform)
  // because it reflows layout, so the parent's overflow-auto scrollbars
  // naturally reflect the scaled content size and no manual width math is
  // needed. Supported in all modern browsers including Firefox 126+.
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Top scrollbar proxy — browsers only render one native scrollbar per
  // scrollable element, at the bottom. For long branch trees users have to
  // scroll to the bottom to find the scrollbar. We render a thin empty
  // scrollable strip ABOVE the canvas whose spacer width matches the branch
  // row's total width, then sync scroll positions both ways.
  const topScrollRef = useRef<HTMLDivElement>(null);
  // Flag prevents the two scroll handlers from ping-ponging forever.
  const syncingRef = useRef<'top' | 'canvas' | null>(null);

  // Bidirectional scroll sync via native addEventListener. Re-attached when
  // the trigger model changes — the canvas only renders once trigger_model_id
  // is set, so refs are null on initial mount. Listing the trigger id as a
  // dep re-runs the effect once the DOM nodes exist.
  useEffect(() => {
    const top = topScrollRef.current;
    const canvas = canvasRef.current;
    if (!top || !canvas) return;

    // The guard prevents scroll-echo ping-pong: when we programmatically
    // update the OTHER element's scrollLeft inside a handler, that triggers
    // its own scroll event, which would re-fire this one. We release the
    // guard on the next macrotask — scroll events are dispatched
    // synchronously after the assignment, so by the time the tick flushes
    // both handlers have settled. setTimeout(0) is more reliable across
    // environments than requestAnimationFrame (which can throttle when tab
    // is backgrounded or inside headless browsers).
    const onTopScroll = () => {
      if (syncingRef.current === 'canvas') return;
      syncingRef.current = 'top';
      canvas.scrollLeft = top.scrollLeft;
      setTimeout(() => { syncingRef.current = null; }, 0);
    };
    const onCanvasScroll = () => {
      if (syncingRef.current === 'top') return;
      syncingRef.current = 'canvas';
      top.scrollLeft = canvas.scrollLeft;
      setTimeout(() => { syncingRef.current = null; }, 0);
    };

    top.addEventListener('scroll', onTopScroll, { passive: true });
    canvas.addEventListener('scroll', onCanvasScroll, { passive: true });
    return () => {
      top.removeEventListener('scroll', onTopScroll);
      canvas.removeEventListener('scroll', onCanvasScroll);
    };
  }, [workflow.trigger_model_id]);
  const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.85, 1, 1.15, 1.3, 1.5];
  const zoomIn = () => setZoom((z) => {
    const next = ZOOM_STEPS.find((s) => s > z + 0.001);
    return next ?? z;
  });
  const zoomOut = () => setZoom((z) => {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
    return prev ?? z;
  });
  const fitToScreen = () => {
    // Scale so all branches fit in the visible canvas width without horizontal
    // scroll. 400px per branch + 16px gap; container padding already accounted
    // for by the canvas's measured clientWidth. Floor at 0.3 so text stays
    // barely legible even for very wide trees — user can zoom back in with
    // the +/- buttons afterwards.
    const container = canvasRef.current;
    if (!container) return;
    const count = (workflow.branches ?? []).length;
    if (count === 0) return;
    const totalContent = count * 400 + (count - 1) * 16;
    const available = container.clientWidth - 16;
    const ratio = available / totalContent;
    const clamped = Math.max(0.3, Math.min(1, ratio));
    setZoom(clamped);
  };

  useEffect(() => {
    if (existing) setWorkflow({ ...existing, branches: initialBranches(existing) });
  }, [existing]);

  const triggerModel = models.find((m) => m.id === workflow.trigger_model_id);
  const triggerFields = useMemo(
    () => triggerModel?.schema.sections.flatMap((s) => s.fields) ?? [],
    [triggerModel],
  );

  const branches = workflow.branches ?? [];
  const hasElseBranch = branches.some((b) => b.is_else);
  const nonElseCount = branches.filter((b) => !b.is_else).length;

  // Spacer width for the top scrollbar proxy. Derived from the known branch
  // dimensions (400px each + 16px gap) and zoom level — matches whatever
  // `zoom` does to the real canvas. No DOM measurement needed, so it stays
  // in sync without effect-timing issues.
  const BRANCH_W = 400;
  const BRANCH_GAP = 16;
  const spacerWidth = branches.length === 0
    ? 0
    : Math.round((branches.length * BRANCH_W + (branches.length - 1) * BRANCH_GAP) * zoom);

  const updateBranch = (id: string, updated: WorkflowBranch) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).map((b) => (b.id === id ? updated : b)),
    }));
  };

  const deleteBranch = (id: string) => {
    setWorkflow((w) => ({
      ...w,
      branches: (w.branches ?? []).filter((b) => b.id !== id),
    }));
  };

  // Duplicate a branch: deep-clone with fresh UUIDs, insert right after the
  // original. Else branches aren't duplicable (only one allowed) — the UI
  // hides the button for them.
  const duplicateBranch = (id: string) => {
    setWorkflow((w) => {
      const current = w.branches ?? [];
      const idx = current.findIndex((b) => b.id === id);
      if (idx === -1) return w;
      const original = current[idx]!;
      if (original.is_else) return w;
      const copy = cloneBranch(original, isAr);
      const next = [...current];
      next.splice(idx + 1, 0, copy);
      return { ...w, branches: next };
    });
  };

  const addBranch = () => {
    const newBranch: WorkflowBranch = { id: uuid(), conditions: [], actions: [] };
    setWorkflow((w) => {
      const current = w.branches ?? [];
      // Insert before the else branch (if any) so else stays at the bottom.
      const elseIdx = current.findIndex((b) => b.is_else);
      if (elseIdx === -1) return { ...w, branches: [...current, newBranch] };
      const next = [...current];
      next.splice(elseIdx, 0, newBranch);
      return { ...w, branches: next };
    });
  };

  const addElseBranch = () => {
    if (hasElseBranch) return;
    const elseBranch: WorkflowBranch = {
      id: uuid(),
      conditions: [],
      actions: [],
      is_else: true,
    };
    setWorkflow((w) => ({ ...w, branches: [...(w.branches ?? []), elseBranch] }));
  };

  const toggleCollapsed = (id: string) => {
    setCollapsedBranches((c) => ({ ...c, [id]: !c[id] }));
  };

  const handleSave = () => {
    if (!workflow.label_ar.trim() || !workflow.label_en.trim()) {
      addToast(t('common.required'), 'error');
      return;
    }
    // Mirror the first (non-else) branch into the legacy flat fields so any
    // consumer that still reads `workflow.conditions` / `workflow.actions`
    // (list page counter, field-rename propagation) stays sensible. Engine
    // prefers `branches` — this is pure back-compat.
    const primary = branches.find((b) => !b.is_else) ?? branches[0];
    saveWorkflow({
      ...workflow,
      conditions: primary?.conditions ?? [],
      actions: primary?.actions ?? [],
      updated_at: new Date().toISOString(),
    });
    addToast(t('toast.saved'), 'success');
    navigate('/workflow');
  };

  const canDeleteBranch = (b: WorkflowBranch) => {
    if (b.is_else) return true;
    // Keep at least one non-else branch so the workflow always has somewhere
    // to put actions.
    return nonElseCount > 1;
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/workflow')}
            className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors"
          >
            <ArrowRight size={20} className="rtl:rotate-0 ltr:rotate-180" />
          </button>
          <h1 className="text-xl font-bold text-chocolate">
            {isNew ? t('workflow.new') : (workflow.label_ar || workflow.label_en)}
          </h1>
        </div>
        <Button onClick={handleSave}>
          <Save size={16} />
          {t('common.save')}
        </Button>
      </div>

      {/* Name input — single language, auto-translates to the other. */}
      <div className="mb-6">
        <Input
          label={isAr ? 'اسم القاعدة' : 'Rule Name'}
          value={isAr ? workflow.label_ar : workflow.label_en}
          onChange={(e) => {
            const labels = bilingualFromInput(e.target.value, language);
            setWorkflow({
              ...workflow,
              label_ar: isAr ? e.target.value : labels.label_ar,
              label_en: isAr ? labels.label_en : e.target.value,
            });
          }}
          required
          dir={isAr ? 'rtl' : 'ltr'}
          placeholder={isAr ? 'اكتب اسم القاعدة هنا...' : 'Write rule name here...'}
        />
      </div>

      {/* Vertical tree flow: Trigger → Branches */}
      <div className="space-y-0">
        {/* Trigger */}
        <TriggerPanel
          triggerModelId={workflow.trigger_model_id}
          triggerEvent={workflow.trigger_event}
          onModelChange={(id) => setWorkflow({
            ...workflow,
            trigger_model_id: id,
            // Reset conditions inside every branch since the available fields changed.
            branches: (workflow.branches ?? []).map((b) => ({ ...b, conditions: [] })),
          })}
          onEventChange={(event) => setWorkflow({ ...workflow, trigger_event: event })}
        />

        {/* Connector from trigger to first branch */}
        {workflow.trigger_model_id && branches.length > 0 && (
          <div className="flex flex-col items-center py-2">
            <div className="w-px h-6 bg-sand/50" />
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-cream border border-sand/40">
              <CornerDownRight size={12} className="text-charcoal/50" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-charcoal/60">
                {isAr ? 'إذن' : 'THEN'}
              </span>
            </div>
            <div className="w-px h-2 bg-sand/50" />
          </div>
        )}

        {/* Branches */}
        {workflow.trigger_model_id ? (
          <>
            {/* Add branch / else controls — shown up top so they're reachable
                without scrolling past a long list of branches. New branches are
                appended to the end of the list regardless of where this bar
                lives, and the "else" branch is always pinned to the bottom of
                the tree. */}
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={addBranch}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-copper/40 text-copper hover:bg-copper/5 transition-colors text-sm font-bold"
                title={isAr ? 'أضف فرعًا مشروطًا جديدًا (else if) — له شروطه وإجراءاته الخاصة' : 'Add another conditional branch (else if) with its own conditions and actions'}
              >
                <Plus size={16} />
                <GitBranch size={14} />
                {isAr ? 'إضافة فرع (وإلا إذا)' : 'Add branch (else if)'}
              </button>
              {!hasElseBranch && (
                <button
                  onClick={addElseBranch}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-chocolate/30 text-chocolate/70 hover:bg-chocolate/5 transition-colors text-sm font-bold"
                  title={isAr ? 'أضف حالة افتراضية (else) — تعمل فقط عندما لا يتطابق أي فرع سابق' : 'Add default case (else) — runs only when no earlier branch matched'}
                >
                  <Plus size={16} />
                  {isAr ? 'إضافة حالة افتراضية (وإلا)' : 'Add default case (else)'}
                </button>
              )}
            </div>

            {/* Canvas toolbar — zoom + fit controls. Sticky on the inline-end
                so it stays visible while scrolling the branch row. */}
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-charcoal/40">
                {branches.length} {isAr ? 'فرع' : branches.length === 1 ? 'branch' : 'branches'}
                {branches.length > 2 && (
                  <span className="ms-2">
                    · {isAr ? 'اسحب يساراً/يميناً للتنقل' : 'scroll sideways to pan'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 bg-white border border-sand/40 rounded-lg p-1 shadow-sm">
                <button
                  onClick={zoomOut}
                  disabled={zoom <= ZOOM_STEPS[0]!}
                  className="p-1.5 rounded-md text-charcoal/50 hover:text-charcoal hover:bg-sand/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={isAr ? 'تصغير' : 'Zoom out'}
                >
                  <ZoomOut size={14} />
                </button>
                <button
                  onClick={() => setZoom(1)}
                  className="px-2 py-1 text-xs font-bold text-charcoal/60 hover:text-charcoal hover:bg-sand/20 rounded-md transition-colors min-w-[46px]"
                  title={isAr ? 'حجم طبيعي' : 'Reset zoom'}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  onClick={zoomIn}
                  disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
                  className="p-1.5 rounded-md text-charcoal/50 hover:text-charcoal hover:bg-sand/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={isAr ? 'تكبير' : 'Zoom in'}
                >
                  <ZoomIn size={14} />
                </button>
                <div className="w-px h-5 bg-sand/40 mx-0.5" />
                <button
                  onClick={fitToScreen}
                  className="p-1.5 rounded-md text-charcoal/50 hover:text-charcoal hover:bg-sand/20 transition-colors"
                  title={isAr ? 'ملاءمة الشاشة' : 'Fit to screen'}
                >
                  <Maximize2 size={14} />
                </button>
              </div>
            </div>

            {/* Top scrollbar proxy — a thin scrollable strip whose spacer
                matches the canvas's scrollWidth. Scrolling here drives the
                real canvas below, and vice versa. Height set to match a
                typical horizontal scrollbar (~12px on desktop). */}
            <div
              ref={topScrollRef}
              className="overflow-x-auto overflow-y-hidden -mx-2 px-2"
              style={{ height: '14px' }}
              aria-hidden="true"
            >
              <div style={{ width: spacerWidth, height: '1px' }} />
            </div>

            {/* Branches laid out side-by-side as columns — each branch is a
                parallel alternative path, not a sequential step, so it reads
                more like a flowchart than a list. Canvas wrapper handles the
                horizontal scroll + zoom. `zoom` property is used instead of
                `transform: scale` because it reflows layout, so the parent's
                scrollbars reflect the scaled content width naturally. */}
            <div
              ref={canvasRef}
              className="overflow-x-auto overflow-y-visible pb-4 -mx-2 px-2 rounded-xl"
              style={{ scrollbarGutter: 'stable' }}
            >
              <div
                className="flex items-stretch gap-4"
                style={{ zoom, transformOrigin: isAr ? 'top right' : 'top left' }}
              >
                {branches.map((branch, idx) => (
                  <BranchCard
                    key={branch.id}
                    branch={branch}
                    index={idx}
                    triggerEvent={workflow.trigger_event}
                    triggerFields={triggerFields}
                    onChange={(updated) => updateBranch(branch.id, updated)}
                    onDelete={() => deleteBranch(branch.id)}
                    onDuplicate={() => duplicateBranch(branch.id)}
                    canDelete={canDeleteBranch(branch)}
                    collapsed={!!collapsedBranches[branch.id]}
                    onToggleCollapsed={() => toggleCollapsed(branch.id)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-6 p-4 rounded-xl bg-cream-light/60 border border-sand/30 text-xs text-charcoal/55 leading-relaxed">
              <strong className="text-charcoal/70">{isAr ? 'كيف تعمل الفروع:' : 'How branches work:'}</strong>{' '}
              {isAr
                ? 'يتم فحص الفروع بالترتيب من الأعلى للأسفل. أول فرع تتحقق جميع شروطه يتم تنفيذ إجراءاته، وتُتجاهل باقي الفروع. إذا أضفت "وإلا" (الحالة الافتراضية) فستُنفّذ فقط عندما لا يتطابق أي فرع سابق.'
                : 'Branches are evaluated top to bottom. The first branch whose conditions all pass runs, and the rest are skipped. If you add an "else" branch, it runs only when no earlier branch matched.'
              }
            </div>
          </>
        ) : (
          <div className="py-12 text-center text-charcoal/40 bg-cream-light/50 rounded-2xl border border-dashed border-sand/40">
            <GitBranch size={36} className="mx-auto mb-3 opacity-50" />
            <p className="font-bold">{isAr ? 'اختر مشغّلًا للبدء' : 'Pick a trigger to get started'}</p>
            <p className="text-xs mt-1">{isAr ? 'حدد النموذج والحدث أعلاه، ثم أضف الفروع والإجراءات.' : 'Choose a model and event above, then add branches and actions.'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
