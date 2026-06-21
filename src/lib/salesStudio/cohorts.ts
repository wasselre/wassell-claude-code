// Cohort + model resolution helpers shared by the analytics surfaces. Resolves
// the downstream sales models (appointments / visits / offers / …) by candidate
// slug (the live models drift from seed) and builds the client cohorts a funnel
// is computed over.

import type { AppModel, AppRecord, ClientSalesProcessAssignment, SalesExperimentGroup } from '@/types';
import type { FunnelDownstream } from './analytics';

function modelByNames(models: AppModel[], names: string[]): AppModel | undefined {
  for (const n of names) {
    const m = models.find((x) => x.name === n);
    if (m) return m;
  }
  return undefined;
}

function recordsFor(models: AppModel[], records: Record<string, AppRecord[]>, names: string[]): AppRecord[] | undefined {
  const m = modelByNames(models, names);
  return m ? records[m.id] ?? [] : undefined;
}

/** Resolve the downstream sales models' records (undefined = model not present). */
export function resolveDownstream(models: AppModel[], records: Record<string, AppRecord[]>): FunnelDownstream {
  return {
    appointments: recordsFor(models, records, ['appointments', 'appointment']),
    visits: recordsFor(models, records, ['visits', 'visit']),
    offers: recordsFor(models, records, ['offer_prices', 'offers', 'offer']),
    reservations: recordsFor(models, records, ['reservations', 'reservation']),
    financing: recordsFor(models, records, ['financing']),
    ownership: recordsFor(models, records, ['ownership_transfer', 'ownership_transfers']),
  };
}

/** Index active assignments by client id (only is_active rows). */
export function activeAssignmentsByClient(
  assignments: ClientSalesProcessAssignment[],
): Map<string, ClientSalesProcessAssignment> {
  const m = new Map<string, ClientSalesProcessAssignment>();
  for (const a of assignments) {
    if (a.is_active) m.set(a.client_id, a);
  }
  return m;
}

/**
 * Clients in a process's cohort. For the DEFAULT process, unassigned clients are
 * included (they run the default process). For a non-default process, only
 * clients with an active assignment to it.
 */
export function clientsForProcess(
  processId: string,
  isDefault: boolean,
  clients: AppRecord[],
  byClient: Map<string, ClientSalesProcessAssignment>,
): AppRecord[] {
  return clients.filter((c) => {
    const a = byClient.get(c.id);
    if (!a) return isDefault;                 // unassigned → default process cohort
    return a.sales_process_id === processId;
  });
}

/** Clients assigned to an experiment group. */
export function clientsForExperimentGroup(
  experimentId: string,
  group: SalesExperimentGroup,
  clients: AppRecord[],
  byClient: Map<string, ClientSalesProcessAssignment>,
): AppRecord[] {
  return clients.filter((c) => {
    const a = byClient.get(c.id);
    return a?.sales_experiment_id === experimentId && a?.experiment_group === group;
  });
}

/** Count active clients assigned to a process (excludes the default fallback). */
export function countAssignedClients(
  processId: string,
  byClient: Map<string, ClientSalesProcessAssignment>,
): number {
  let n = 0;
  for (const a of byClient.values()) {
    if (a.sales_process_id === processId) n++;
  }
  return n;
}
