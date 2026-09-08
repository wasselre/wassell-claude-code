/**
 * Which PHASE of production a workflow step belongs to — writing, design, or
 * publishing — and therefore which tab of the content page (and which body of
 * the preview popup) shows the thing being worked on or reviewed.
 *
 * Workflows are user-editable data (Settings → Workflows), so the phase is NOT
 * keyed on hardcoded step keys. It is derived by walking the pinned step list
 * in order:
 *   - it starts as `writing`;
 *   - the first non-approval step owned by a production role (montage / ops)
 *     flips it to `design`, and every later step inherits that — so «مراجعة
 *     التصميم» owned by the manager, or «مراجعة الكاتب» owned by the writer,
 *     still counts as design (the reviewer looks at the DESIGN, not the copy);
 *   - a scheduling / publishing step flips it to `publish`.
 * A step key the pinned list no longer contains falls back to a keyword guess,
 * so a stale row still routes somewhere sensible instead of nowhere.
 */
import type { MosRole } from '@/lib/marketingOS/client';

export type StagePhase = 'writing' | 'design' | 'publish';

/** The subset of a step the classifier needs — satisfied by StepDef and MosStep. */
export interface PhaseStep {
  key: string;
  is_approval: boolean;
  /** StepDef carries `role_key`; MosStep carries `role`. Either is accepted. */
  role?: string | null;
  role_key?: string | null;
}

const PRODUCTION_ROLES: ReadonlySet<string> = new Set<MosRole>(['montage', 'ops_supervisor']);
const PUBLISH_KEY = /schedul|publish|نشر|جدول/i;
const DESIGN_KEY = /design|edit|montage|asset|version|footage|تصميم|مونتاج|مواد|نسخة/i;

function keywordPhase(stepKey: string): StagePhase {
  if (PUBLISH_KEY.test(stepKey)) return 'publish';
  if (DESIGN_KEY.test(stepKey)) return 'design';
  return 'writing';
}

/**
 * The phase of `stepKey` inside `steps` (already in workflow order). When the
 * key is absent from the list the keyword fallback decides.
 */
export function phaseOfStep(steps: ReadonlyArray<PhaseStep>, stepKey: string): StagePhase {
  let phase: StagePhase = 'writing';
  for (const s of steps) {
    const role = s.role ?? s.role_key ?? '';
    if (PUBLISH_KEY.test(s.key)) phase = 'publish';
    else if (phase === 'writing' && !s.is_approval && PRODUCTION_ROLES.has(role)) phase = 'design';
    if (s.key === stepKey) return phase;
  }
  return keywordPhase(stepKey);
}

/** The content-page tab that shows a phase's work. */
export type PhaseTab = 'content' | 'materials' | 'placements';

export function tabForPhase(phase: StagePhase): PhaseTab {
  if (phase === 'design') return 'materials';
  if (phase === 'publish') return 'placements';
  return 'content';
}

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
