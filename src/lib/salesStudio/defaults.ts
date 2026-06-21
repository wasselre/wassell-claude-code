// Default Sales Process seeding — derives a v1 process-version config from the
// LIVE workflows + DEFAULT_SALES_PROCESS so the Journey Map renders immediately
// the first time an admin opens Sales Studio. The v1 overlay is EMPTY per
// workflow (every workflow runs its built-in behavior unchanged) — the manager
// then edits safe values into a draft. No execution here.

import type { Workflow, SalesProcessVersionConfig, SalesProcessStep, SalesWorkflowOverlay } from '@/types';
import { DEFAULT_SALES_PROCESS, resolveBoundWorkflows } from '@/lib/salesProcess';

/**
 * Build the v1 config: one step per (stage, activity) that has a bound workflow,
 * plus an EMPTY overlay entry per involved workflow id (so the journey knows the
 * workflow belongs to this process; empty = run unchanged).
 */
export function buildDefaultVersionConfig(workflows: Workflow[]): SalesProcessVersionConfig {
  const steps: SalesProcessStep[] = [];
  const wfOverlays: Record<string, SalesWorkflowOverlay> = {};
  let order = 0;
  const stages = [...DEFAULT_SALES_PROCESS.stages].sort((a, b) => a.order - b.order);
  const seenStepKey = new Set<string>();
  for (const stage of stages) {
    for (const activityType of stage.followup_types) {
      const key = `${stage.value}::${activityType}`;
      if (seenStepKey.has(key)) continue;
      seenStepKey.add(key);
      const bound = resolveBoundWorkflows(workflows, { activity_type: activityType, sales_stage: stage.value });
      const wf = bound[0];
      steps.push({
        stage_key: stage.value,
        activity_type: activityType,
        workflow_id: wf?.id ?? null,
        display_order: order++,
        simple_config: {},
      });
      for (const w of bound) {
        if (!wfOverlays[w.id]) wfOverlays[w.id] = {};
      }
    }
  }
  return { steps, workflows: wfOverlays, schema_version: 1 };
}

export const DEFAULT_PROCESS_NAME = { ar: 'مسار المبيعات الافتراضي', en: 'Default Sales Process' };
export const DEFAULT_PROCESS_DESCRIPTION = {
  ar: 'دورة حياة المبيعات القياسية — من العميل الجديد حتى الإفراغ. هذا هو المسار الافتراضي للعملاء غير المعيّنين.',
  en: 'The standard sales lifecycle — from new lead to ownership transfer. This is the default process for unassigned clients.',
};
