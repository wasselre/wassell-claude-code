/**
 * A post path with a MULTI-DAY step, chained one day after another.
 *
 * WHY THIS EXISTS. Until 2026-09-16 the shipped post path was exactly this
 * shape — `design` took two working days and no two steps could share a day —
 * so the engine's mechanics tests used it as a convenient example. That shape
 * was wrong about the POST work (the operator: «a full post takes one day max
 * … a designer does four a day»), and `POST_WORKFLOW` now chains inside a day
 * with a one-day design.
 *
 * But the MECHANICS those tests prove are still real and still load-bearing:
 * a step that spans days must skip a Friday rather than stretch across it, the
 * time bound must be provable, a batch must be pulled earlier into its slack,
 * and a loose item must spread one slot per working day. Video still works this
 * way (editing is three days). So the tests keep proving exactly what they
 * proved, on a path that still has that shape — rather than being loosened to
 * match the new post path and quietly testing nothing.
 */
import { POST_WORKFLOW } from '../defaults';
import { DEFAULT_RULES, type RuleSet } from '../plan';
import type { WorkflowSpec } from '../types';

export const CLASSIC_POST_WORKFLOW: WorkflowSpec = {
  workflowKey: POST_WORKFLOW.workflowKey,
  bucket: POST_WORKFLOW.bucket,
  // Deliberately NO `sameDayChain`: every step ends the working day before the
  // next begins.
  steps: POST_WORKFLOW.steps.map((s) => (s.key === 'design' ? { ...s, workingDays: 2 } : s)),
};

/** `rules` with the post path swapped for the classic multi-day one. */
export function withClassicPost(rules: RuleSet = DEFAULT_RULES): RuleSet {
  return {
    ...rules,
    workflows: { ...rules.workflows, [CLASSIC_POST_WORKFLOW.workflowKey]: CLASSIC_POST_WORKFLOW },
  };
}

export const CLASSIC_RULES: RuleSet = withClassicPost(DEFAULT_RULES);
