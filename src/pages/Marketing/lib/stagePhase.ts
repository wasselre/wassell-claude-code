/**
 * Which PHASE of production a workflow step belongs to — writing, design, or
 * publishing — and therefore which tab of the content page shows the thing
 * being worked on or reviewed.
 *
 * SUPERSEDED, kept for back-compat. The real resolver is `contentRoute.ts`,
 * which answers the same question one notch finer (ten sections instead of
 * three phases) and which the server twin `api/_lib/marketing/routes.ts`
 * mirrors. Everything here is now a projection of that: `phaseOfStep` is
 * `sectionForStep` collapsed to three buckets. Prefer `contentHref` /
 * `sectionForStep` / `tabForSection` in new code; this file exists so the
 * call sites that only need "writing, design, or publishing" keep working.
 *
 * `stageIsMine` is NOT a routing concern and has no twin — it stays here.
 */
import type { MosRole } from '@/lib/marketingOS/client';
import {
  sectionForStep, tabForSection, type ContentSection, type RouteStep,
} from './contentRoute';

export type StagePhase = 'writing' | 'design' | 'publish';

/** The subset of a step the classifier needs — satisfied by StepDef and MosStep. */
export type PhaseStep = RouteStep & { is_approval: boolean };

/** The three-bucket view of a section. */
const SECTION_PHASE: Record<ContentSection, StagePhase> = {
  writing: 'writing',
  writing_review: 'writing',
  caption: 'writing',
  design_upload: 'design',
  design_review_writer: 'design',
  final_review: 'design',
  materials_final: 'design',
  schedule: 'publish',
  publish_check: 'publish',
  // No open stage — the writing tab is where an item with nothing in flight
  // starts, which is what the old keyword fallback returned for an empty key.
  overview: 'writing',
};

export function phaseOfSection(section: ContentSection): StagePhase {
  return SECTION_PHASE[section] ?? 'writing';
}

/**
 * The phase of `stepKey` inside `steps` (already in workflow order). When the
 * key is absent from the list the keyword fallback inside `sectionForStep`
 * decides. `stepKey` is a step KEY — passing a step UUID here has always
 * fallen through to the fallback, which is the bug `contentRoute` names.
 */
export function phaseOfStep(steps: ReadonlyArray<PhaseStep>, stepKey: string): StagePhase {
  return phaseOfSection(sectionForStep(steps, stepKey));
}

/** The content-page tab that shows a phase's work. */
export type PhaseTab = 'content' | 'materials' | 'placements';

export function tabForPhase(phase: StagePhase): PhaseTab {
  if (phase === 'design') return 'materials';
  if (phase === 'publish') return 'placements';
  return 'content';
}

/** The tab for a section — the finer-grained twin of `tabForPhase`. */
export { tabForSection };

/**
 * Whether a stage owned by `stepRole` is actionable by someone holding `roles`
 * — the same rule as the content page's `canAct`: the owning role, or a
 * manager/admin, who may act on any stage. Capability truth is the UNION of
 * held roles; this never looks at the active role.
 */
export function stageIsMine(roles: ReadonlyArray<MosRole>, stepRole: MosRole | null | undefined): boolean {
  if (!stepRole) return false;
  if (roles.includes('administrator') || roles.includes('marketing_manager')) return true;
  return roles.includes(stepRole);
}
