// Runtime drift guard for the sales-process config (correction #7).
//
// The generated `arabicEnums.generated.ts` catches drift at BUILD time, but a
// Builder user can add/remove a `client_stage` / `client_status` / `call_result`
// option at RUNTIME, after the build. This guard re-validates the config against
// the actually-loaded models so such drift fails loudly (a red console error +
// a throw in dev/test) instead of silently producing workflow writes the
// dropdown can't store. Run it at app start (after models load) and in unit tests.

import type { AppModel } from '@/types';
import { OUTCOME_VALUES } from './outcomes';

/** All `value`s of a dropdown/multiselect/section_selector field on a model. */
function optionValues(models: AppModel[], modelName: string, fieldSlug: string): Set<string> | null {
  const model = models.find((m) => m.name === modelName);
  if (!model) return null;
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      if (field.name === fieldSlug) {
        return new Set((field.options ?? []).map((o) => o.value));
      }
    }
  }
  return new Set();
}

export interface SalesEnumRefs {
  /** client_stage values the config writes. */
  stages?: readonly string[];
  /** client_status values the config writes. */
  statuses?: readonly string[];
  /** call_result (outcome) values the config references. Defaults to the full catalog. */
  outcomes?: readonly string[];
}

/** Returns a list of human-readable drift problems (empty array = all good). */
export function checkSalesProcessEnums(models: AppModel[], refs: SalesEnumRefs = {}): string[] {
  const problems: string[] = [];

  const stageOpts = optionValues(models, 'clients', 'client_stage');
  const statusOpts = optionValues(models, 'clients', 'client_status');
  const outcomeOpts = optionValues(models, 'followups', 'call_result');

  if (!stageOpts) problems.push('clients model not loaded — cannot verify client_stage options');
  if (!outcomeOpts) problems.push('followups model not loaded — cannot verify call_result options');

  for (const s of refs.stages ?? []) {
    if (stageOpts && !stageOpts.has(s)) problems.push(`clients.client_stage is missing option "${s}"`);
  }
  for (const s of refs.statuses ?? []) {
    if (statusOpts && !statusOpts.has(s)) problems.push(`clients.client_status is missing option "${s}"`);
  }
  for (const o of refs.outcomes ?? OUTCOME_VALUES) {
    if (outcomeOpts && !outcomeOpts.has(o)) problems.push(`followups.call_result is missing outcome option "${o}"`);
  }

  return problems;
}

/**
 * Loud assertion: logs every drift problem via console.error; throws in
 * dev/test so it surfaces immediately, but only logs in production so a single
 * missing option can't white-screen the whole app.
 */
export function assertSalesProcessEnums(models: AppModel[], refs: SalesEnumRefs = {}): void {
  const problems = checkSalesProcessEnums(models, refs);
  if (problems.length === 0) return;
  const msg = `[salesProcess] enum drift detected — ${problems.length} issue(s):\n  ${problems.join('\n  ')}`;
  // eslint-disable-next-line no-console
  console.error(msg);
  const isDevOrTest =
    (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env?.DEV) ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test');
  if (isDevOrTest) throw new Error(msg);
}
