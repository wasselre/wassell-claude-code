// Journey Map builder — turns the sales-process config + the live workflows +
// a process-version overlay into the visual customer journey the Studio renders:
// stages → activities → workflow cards (plain-language, compatibility, the safe
// editable surfaces). Pure + in-memory; no execution.

import type { Workflow, WorkflowAction, FieldMapping, SalesWorkflowOverlay, SalesProcessVersionConfig } from '@/types';
import {
  DEFAULT_SALES_PROCESS,
  getFollowUpTypeConfig,
  getOutcome,
  type SalesProcessConfig,
  type SalesStageConfig,
} from '@/lib/salesProcess';
import { resolveBoundWorkflows, isWorkflowDrifted, isStudioManaged } from '@/lib/salesProcess';
import { getWorkflowBranches } from '@/lib/workflowEngine';

export type Bilingual = { ar: string; en: string };

/** How safely the Studio can edit a workflow. */
export type CompatibilityStatus = 'simple' | 'partial' | 'advanced' | 'drift';

export interface JourneyBranchCard {
  branch_id: string;
  label_ar?: string;
  label_en?: string;
  is_else: boolean;
  /** Matched outcome value (call_result) from the branch conditions, if any. */
  outcome?: string | null;
  /** From the overlay — disabled branches are dropped at execution. */
  enabled: boolean;
  primary_success: boolean;
  summary: Bilingual;
  /** Plain-language description of the next task this branch creates. */
  next_action: Bilingual | null;
}

/** One editable timing (a create_record date-expression). */
export interface JourneyTimingHandle {
  action_id: string;
  label: Bilingual;
  default_value: string | null;   // the workflow's built-in expression
  current_value: string;          // overlay value or the default
}

export interface JourneyMessageHandle {
  action_id: string;
  default_value: string;
  current_ar: string;
  current_en: string;
}

export interface JourneyAssignmentHandle {
  action_id: string;
  current_strategy: string;       // inferred from the mapping source
}

export interface JourneyMaxAttemptsHandle {
  action_id: string;
  label: Bilingual;
  current_value: number | null;
}

export interface WorkflowCard {
  workflow_id: string | null;     // null = no bound workflow (advisory "missing")
  activity_type: string;
  stage_key: string;
  label_ar: string;
  label_en: string;
  is_active: boolean;
  trigger_summary: Bilingual;
  explanation: Bilingual;
  compatibility: CompatibilityStatus;
  objective_ar: string;
  objective_en: string;
  branches: JourneyBranchCard[];
  timings: JourneyTimingHandle[];
  messages: JourneyMessageHandle[];
  assignments: JourneyAssignmentHandle[];
  max_attempts: JourneyMaxAttemptsHandle[];
}

export interface JourneyStage {
  key: string;
  label_ar: string;
  label_en: string;
  order: number;
  color?: string;
  /** Activities (follow-up types) anchored at this stage. */
  activity_types: string[];
  cards: WorkflowCard[];
}

// ── compatibility ────────────────────────────────────────────────────────────

const SIMPLE_ACTION_TYPES = new Set([
  'create_record',
  'update_record',
  'send_whatsapp_message',
  'send_notification',
  'assign_user',
]);

function allActions(workflow: Workflow): WorkflowAction[] {
  const fromBranches = (workflow.branches ?? []).flatMap((b) => b.actions);
  return fromBranches.length > 0 ? fromBranches : workflow.actions ?? [];
}

export function computeCompatibility(workflow: Workflow): CompatibilityStatus {
  if (isWorkflowDrifted(workflow)) return 'drift';
  if (!isStudioManaged(workflow)) return 'advanced';
  const acts = allActions(workflow);
  const everySimple = acts.every((a) => SIMPLE_ACTION_TYPES.has(a.type));
  return everySimple ? 'simple' : 'partial';
}

export const COMPATIBILITY_LABEL: Record<CompatibilityStatus, Bilingual> = {
  simple: { ar: 'تحرير مبسّط', en: 'Simple editable' },
  partial: { ar: 'تحرير جزئي', en: 'Partially editable' },
  advanced: { ar: 'متقدم فقط', en: 'Advanced only' },
  drift: { ar: 'تم تعديله يدويًا', en: 'Drift detected' },
};

// ── plain-language helpers ────────────────────────────────────────────────────

function triggerSummary(workflow: Workflow, activityLabel: Bilingual): Bilingual {
  const ev = workflow.trigger_event;
  if (ev === 'on_due') {
    return {
      ar: `يعمل عند استحقاق متابعة «${activityLabel.ar}»`,
      en: `Runs when a "${activityLabel.en}" follow-up becomes due`,
    };
  }
  if (ev === 'create') {
    return {
      ar: `يعمل عند إنشاء سجل «${activityLabel.ar}»`,
      en: `Runs when a "${activityLabel.en}" record is created`,
    };
  }
  if (ev === 'update') {
    return {
      ar: `يعمل عند تسجيل نتيجة متابعة «${activityLabel.ar}»`,
      en: `Runs when a "${activityLabel.en}" outcome is recorded`,
    };
  }
  return { ar: `محفّز: ${ev}`, en: `Trigger: ${ev}` };
}

/** Read the matched outcome (call_result) value from a branch's conditions. */
function branchOutcome(conditions: { field_id: string; value: unknown }[]): string | null {
  const c = conditions.find((x) => x.field_id === 'call_result' || x.field_id === 'outcome');
  if (!c) return null;
  return typeof c.value === 'string' ? c.value : null;
}

function describeNextAction(actions: WorkflowAction[]): Bilingual | null {
  const create = actions.find((a) => a.type === 'create_record');
  const updateClient = actions.find(
    (a) => a.type === 'update_record',
  );
  const wa = actions.find((a) => a.type === 'send_whatsapp_message');
  const parts_ar: string[] = [];
  const parts_en: string[] = [];
  if (updateClient) { parts_ar.push('تحديث حالة العميل'); parts_en.push('update the client status'); }
  if (create) {
    const m = (create.field_mappings ?? []).find((x) => x.target_field_id === 'followup_type');
    const typeVal = typeof m?.static_value === 'string' ? (m.static_value as string)
      : Array.isArray(m?.static_value) ? String((m!.static_value as unknown[])[0] ?? '') : '';
    const cfg = getFollowUpTypeConfig(typeVal);
    if (cfg) { parts_ar.push(`إنشاء متابعة «${cfg.label_ar}»`); parts_en.push(`create a "${cfg.label_en}" follow-up`); }
    else { parts_ar.push('إنشاء المهمة التالية'); parts_en.push('create the next task'); }
  }
  if (wa) { parts_ar.push('إرسال رسالة واتساب'); parts_en.push('send a WhatsApp message'); }
  if (parts_ar.length === 0) return null;
  return { ar: parts_ar.join(' و'), en: parts_en.join(' and ') };
}

function explanationFor(workflow: Workflow, activityLabel: Bilingual): Bilingual {
  const branches = getWorkflowBranches(workflow);
  const realBranches = branches.filter((b) => !b.is_else);
  const ar = `عند ${triggerSummary(workflow, activityLabel).ar.replace(/^يعمل /, '')}، يقيّم ${realBranches.length || 1} مسار${realBranches.length > 1 ? 'ات' : ''} ثم ينفّذ الإجراء المناسب.`;
  const en = `${triggerSummary(workflow, activityLabel).en}, evaluates ${realBranches.length || 1} branch${realBranches.length === 1 ? '' : 'es'}, then runs the matching action.`;
  return { ar, en };
}

// ── editable-surface extraction ───────────────────────────────────────────────

function inferAssignmentStrategy(mapping: FieldMapping): string {
  switch (mapping.source_type) {
    case 'trigger_field': return mapping.trigger_field_id === 'sales_rep' ? 'same_sales_rep' : 'trigger_field';
    case 'current_user': return 'current_user';
    case 'static': return 'fixed_user';
    case 'role_variable': return mapping.selection_strategy === 'least_workload' ? 'role_least_workload' : 'role';
    default: return mapping.source_type;
  }
}

function extractHandles(workflow: Workflow, overlay: SalesWorkflowOverlay | undefined) {
  const timings: JourneyTimingHandle[] = [];
  const messages: JourneyMessageHandle[] = [];
  const assignments: JourneyAssignmentHandle[] = [];
  const maxAttempts: JourneyMaxAttemptsHandle[] = [];
  const seenTiming = new Set<string>();

  for (const action of allActions(workflow)) {
    if (action.type === 'create_record') {
      const dateMap = action.field_mappings.find((m) => m.source_type === 'date_expression');
      if (dateMap && !seenTiming.has(action.id)) {
        seenTiming.add(action.id);
        const def = dateMap.date_expression ?? '';
        const typeMap = action.field_mappings.find((m) => m.target_field_id === 'followup_type');
        const typeVal = typeof typeMap?.static_value === 'string' ? (typeMap.static_value as string)
          : Array.isArray(typeMap?.static_value) ? String((typeMap!.static_value as unknown[])[0] ?? '') : '';
        const cfg = getFollowUpTypeConfig(typeVal);
        timings.push({
          action_id: action.id,
          label: cfg ? { ar: `توقيت «${cfg.label_ar}»`, en: `"${cfg.label_en}" timing` } : { ar: 'توقيت المهمة التالية', en: 'Next task timing' },
          default_value: def || null,
          current_value: overlay?.timings?.[action.id] ?? def,
        });
        if (overlay?.max_attempts?.[action.id] !== undefined || cfg) {
          maxAttempts.push({
            action_id: action.id,
            label: cfg ? { ar: `حد محاولات «${cfg.label_ar}»`, en: `"${cfg.label_en}" max attempts` } : { ar: 'حد المحاولات', en: 'Max attempts' },
            current_value: overlay?.max_attempts?.[action.id] ?? null,
          });
        }
      }
      const repMap = action.field_mappings.find((m) => m.target_field_id === 'sales_rep');
      if (repMap) {
        const ov = overlay?.assignments?.[action.id];
        assignments.push({
          action_id: action.id,
          current_strategy: ov?.strategy ?? inferAssignmentStrategy(repMap),
        });
      }
    } else if (action.type === 'send_whatsapp_message') {
      const ov = overlay?.messages?.[action.id];
      messages.push({
        action_id: action.id,
        default_value: action.body_template,
        current_ar: ov?.ar ?? action.body_template,
        current_en: ov?.en ?? action.body_template,
      });
    }
  }
  return { timings, messages, assignments, maxAttempts };
}

function buildBranchCards(workflow: Workflow, overlay: SalesWorkflowOverlay | undefined): JourneyBranchCard[] {
  const branches = getWorkflowBranches(workflow);
  return branches.map((b) => {
    const outcome = branchOutcome(b.conditions);
    const oc = outcome ? getOutcome(outcome) : undefined;
    const bo = overlay?.branches?.[b.id];
    const summary: Bilingual = oc
      ? { ar: `النتيجة: ${oc.label_ar}`, en: `Outcome: ${oc.label_en}` }
      : b.is_else
        ? { ar: 'وإلا (الحالة الافتراضية)', en: 'Otherwise (default case)' }
        : { ar: b.label_ar || 'مسار', en: b.label_en || 'Branch' };
    return {
      branch_id: b.id,
      label_ar: bo?.label_ar ?? b.label_ar,
      label_en: bo?.label_en ?? b.label_en,
      is_else: !!b.is_else,
      outcome,
      enabled: bo?.enabled !== false,
      primary_success: !!bo?.primary_success,
      summary,
      next_action: describeNextAction(b.actions),
    };
  });
}

// ── public builder ─────────────────────────────────────────────────────────────

export interface BuildJourneyOptions {
  config?: SalesProcessConfig;
  /** The active/draft version overlay being viewed (drives current values). */
  overlayByWorkflow?: Record<string, SalesWorkflowOverlay>;
}

/** Build a single workflow card for an activity + bound workflow (or a missing card). */
export function buildWorkflowCard(
  activityType: string,
  stageKey: string,
  workflow: Workflow | undefined,
  overlayByWorkflow: Record<string, SalesWorkflowOverlay> | undefined,
  config: SalesProcessConfig,
): WorkflowCard {
  const cfg = getFollowUpTypeConfig(activityType, config);
  const activityLabel: Bilingual = { ar: cfg?.label_ar ?? activityType, en: cfg?.label_en ?? activityType };
  if (!workflow) {
    return {
      workflow_id: null,
      activity_type: activityType,
      stage_key: stageKey,
      label_ar: activityLabel.ar,
      label_en: activityLabel.en,
      is_active: false,
      trigger_summary: { ar: 'لا يوجد سير عمل مرتبط', en: 'No workflow bound' },
      explanation: { ar: 'هذا النشاط ليس له سير عمل ينفّذه — يُدار يدويًا حاليًا.', en: 'This activity has no workflow executing it — currently handled manually.' },
      compatibility: 'advanced',
      objective_ar: cfg?.objective_ar ?? '',
      objective_en: cfg?.objective_en ?? '',
      branches: [],
      timings: [],
      messages: [],
      assignments: [],
      max_attempts: [],
    };
  }
  const overlay = overlayByWorkflow?.[workflow.id];
  const handles = extractHandles(workflow, overlay);
  return {
    workflow_id: workflow.id,
    activity_type: activityType,
    stage_key: stageKey,
    label_ar: workflow.label_ar || activityLabel.ar,
    label_en: workflow.label_en || activityLabel.en,
    is_active: workflow.is_active,
    trigger_summary: triggerSummary(workflow, activityLabel),
    explanation: explanationFor(workflow, activityLabel),
    compatibility: computeCompatibility(workflow),
    objective_ar: overlay?.objective_ar?.trim() || cfg?.objective_ar || '',
    objective_en: overlay?.objective_en?.trim() || cfg?.objective_en || '',
    branches: buildBranchCards(workflow, overlay),
    timings: handles.timings,
    messages: handles.messages,
    assignments: handles.assignments,
    max_attempts: handles.maxAttempts,
  };
}

/**
 * Build the full stage-by-stage journey: each stage's activities resolved to
 * their bound workflow card. An activity with no bound workflow yields a
 * "missing" advisory card.
 */
export function buildJourney(workflows: Workflow[], opts: BuildJourneyOptions = {}): JourneyStage[] {
  const config = opts.config ?? DEFAULT_SALES_PROCESS;
  const stages: SalesStageConfig[] = [...config.stages].sort((a, b) => a.order - b.order);
  return stages.map((stage) => {
    const cards: WorkflowCard[] = [];
    const seen = new Set<string>();
    for (const activityType of stage.followup_types) {
      if (seen.has(activityType)) continue;
      seen.add(activityType);
      const bound = resolveBoundWorkflows(workflows, { activity_type: activityType, sales_stage: stage.value });
      if (bound.length === 0) {
        cards.push(buildWorkflowCard(activityType, stage.value, undefined, opts.overlayByWorkflow, config));
      } else {
        for (const w of bound) cards.push(buildWorkflowCard(activityType, stage.value, w, opts.overlayByWorkflow, config));
      }
    }
    return {
      key: stage.value,
      label_ar: stage.label_ar,
      label_en: stage.label_en,
      order: stage.order,
      color: stage.color,
      activity_types: stage.followup_types,
      cards,
    };
  });
}

/** Derive an empty overlay-by-workflow map from a version config (safe default). */
export function overlayMapFromConfig(config: SalesProcessVersionConfig | undefined): Record<string, SalesWorkflowOverlay> {
  return config?.workflows ?? {};
}
