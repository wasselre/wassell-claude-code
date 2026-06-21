// Client → process / experiment assignment logic. Pure functions that decide
// WHICH process version (and experiment group) a client lands on. The store
// action persists the resulting rows; nothing here writes or executes.

import type {
  AppRecord,
  SalesExperiment,
  SalesExperimentTargetRules,
  SalesExperimentGroup,
} from '@/types';

/** Resolve a client field by candidate slugs (live clients model drifts from seed). */
function clientField(client: AppRecord, candidates: string[]): unknown {
  for (const c of candidates) {
    const v = client.data[c];
    if (v != null && v !== '') return v;
  }
  return undefined;
}

const SOURCE_SLUGS = ['lead_source', 'source', 'client_source'];
const PROJECT_SLUGS = ['preferred_project', 'preferred_projects', 'project', 'interested_project'];
const CITY_SLUGS = ['preferred_city', 'city', 'client_city'];
const DISTRICT_SLUGS = ['district', 'preferred_district', 'neighborhood', 'preferred_neighborhoods'];
const BUDGET_SLUGS = ['budget', 'budget_max', 'max_budget', 'budget_amount'];
const STAGE_SLUGS = ['client_stage'];
const STATUS_SLUGS = ['client_status'];
const REP_SLUGS = ['sales_rep', 'assigned_to', 'owner'];

function asArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

function intersects(values: string[], filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) return true; // empty filter = match-all
  const set = new Set(filter);
  return values.some((v) => set.has(v));
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Number(v.replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : null; }
  return null;
}

function toMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** True when a client satisfies an experiment's target rules (empty rules = all). */
export function clientMatchesRules(client: AppRecord, rules: SalesExperimentTargetRules | undefined): boolean {
  if (!rules) return true;
  if (!intersects(asArray(clientField(client, SOURCE_SLUGS)), rules.source)) return false;
  if (!intersects(asArray(clientField(client, PROJECT_SLUGS)), rules.project)) return false;
  if (!intersects(asArray(clientField(client, CITY_SLUGS)), rules.city)) return false;
  if (!intersects(asArray(clientField(client, DISTRICT_SLUGS)), rules.district)) return false;
  if (!intersects(asArray(clientField(client, STAGE_SLUGS)), rules.client_stage)) return false;
  if (!intersects(asArray(clientField(client, STATUS_SLUGS)), rules.client_status)) return false;
  if (!intersects(asArray(clientField(client, REP_SLUGS)), rules.sales_rep)) return false;

  if (rules.budget_min != null || rules.budget_max != null) {
    const b = toNum(clientField(client, BUDGET_SLUGS));
    if (b == null) return false;
    if (rules.budget_min != null && b < rules.budget_min) return false;
    if (rules.budget_max != null && b > rules.budget_max) return false;
  }

  if (rules.lead_created_from || rules.lead_created_to) {
    const created = toMs(client.created_at) ?? toMs(clientField(client, ['created_at', 'lead_created_at']));
    if (created == null) return false;
    const from = toMs(rules.lead_created_from ?? null);
    const to = toMs(rules.lead_created_to ?? null);
    if (from != null && created < from) return false;
    if (to != null && created > to) return false;
  }
  return true;
}

/** Deterministic 0..99 bucket from a stable string (FNV-1a) — no Math.random. */
function bucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/**
 * Deterministic control/variant split. `split_percentage` is the % routed to
 * VARIANT. Same client+experiment always maps to the same group (no drift on
 * re-evaluation). Returns 'variant' when bucket < split, else 'control'.
 */
export function deterministicGroup(
  clientId: string,
  experimentId: string,
  splitPercentage: number,
): SalesExperimentGroup {
  const b = bucket(`${experimentId}:${clientId}`);
  return b < splitPercentage ? 'variant' : 'control';
}

export interface ResolvedExperimentAssignment {
  clientId: string;
  group: SalesExperimentGroup;
  versionId: string | null;
  reason: string;
}

/**
 * For an experiment in 'rules' or 'random_split' mode, decide every eligible
 * client's group + the process version that implies. Manual mode returns [] (the
 * manager assigns explicitly). Clients missing a control/variant version on the
 * chosen group are still assigned the group but with versionId = null (the
 * Studio surfaces that as a config gap, not a silent drop).
 */
export function resolveExperimentAssignments(
  experiment: SalesExperiment,
  clients: AppRecord[],
): ResolvedExperimentAssignment[] {
  if (experiment.assignment_mode === 'manual') return [];
  const eligible = clients.filter((c) => clientMatchesRules(c, experiment.target_rules_json));
  return eligible.map((c) => {
    const group =
      experiment.assignment_mode === 'random_split'
        ? deterministicGroup(c.id, experiment.id, experiment.split_percentage)
        : // 'rules' mode: rule-matched clients go to the variant (the thing under test).
          'variant';
    const versionId =
      group === 'variant'
        ? experiment.variant_process_version_id ?? null
        : experiment.control_process_version_id ?? null;
    const reason =
      experiment.assignment_mode === 'random_split'
        ? `Random split (${experiment.split_percentage}% variant) — experiment "${experiment.name_en}"`
        : `Matched target rules — experiment "${experiment.name_en}"`;
    return { clientId: c.id, group, versionId, reason };
  });
}
