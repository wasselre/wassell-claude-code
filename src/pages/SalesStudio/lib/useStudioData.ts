// Store-derived data for the Sales Studio surfaces: client cohorts, downstream
// model records, funnel results per process / experiment group. All in-memory,
// reactive to the store (no fetching).

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord, SalesExperiment, SalesProcess } from '@/types';
import {
  resolveDownstream,
  activeAssignmentsByClient,
  clientsForProcess,
  clientsForExperimentGroup,
  countAssignedClients,
  computeSalesFunnel,
  compareExperiment,
  type SalesFunnelResult,
  type ExperimentComparison,
  type FunnelMetricKey,
} from '@/lib/salesStudio';

export function useStudioBase() {
  const { models, records, salesProcessVersions, clientSalesProcessAssignments, salesExperiments, salesProcesses } = useAppStore();
  return useMemo(() => {
    const clientsModel = models.find((m) => m.name === 'clients');
    const followupsModel = models.find((m) => m.name === 'followups');
    const clients: AppRecord[] = clientsModel ? records[clientsModel.id] ?? [] : [];
    const followups: AppRecord[] = followupsModel ? records[followupsModel.id] ?? [] : [];
    const downstream = resolveDownstream(models, records);
    const byClient = activeAssignmentsByClient(clientSalesProcessAssignments);
    return {
      clientsModel,
      clients,
      followups,
      downstream,
      byClient,
      salesProcesses,
      salesProcessVersions,
      salesExperiments,
      versionsById: new Map(salesProcessVersions.map((v) => [v.id, v])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, records, salesProcessVersions, clientSalesProcessAssignments, salesExperiments, salesProcesses]);
}

export interface ProcessRollup {
  assignedCount: number;
  activeExperiments: number;
  funnel: SalesFunnelResult;
}

export function useProcessRollup(process: SalesProcess): ProcessRollup {
  const base = useStudioBase();
  const now = Date.now();
  return useMemo(() => {
    const cohort = clientsForProcess(process.id, process.is_default, base.clients, base.byClient);
    const funnel = computeSalesFunnel(cohort, { followups: base.followups, downstream: base.downstream, now });
    const assignedCount = countAssignedClients(process.id, base.byClient);
    const activeExperiments = base.salesExperiments.filter(
      (e) => e.status === 'active' &&
        (versionBelongsToProcess(e.control_process_version_id, process.id, base.versionsById) ||
         versionBelongsToProcess(e.variant_process_version_id, process.id, base.versionsById)),
    ).length;
    return { assignedCount, activeExperiments, funnel };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [process.id, process.is_default, base]);
}

function versionBelongsToProcess(
  versionId: string | null | undefined,
  processId: string,
  versionsById: Map<string, { sales_process_id: string }>,
): boolean {
  if (!versionId) return false;
  return versionsById.get(versionId)?.sales_process_id === processId;
}

export interface ExperimentAnalytics {
  control: SalesFunnelResult;
  variant: SalesFunnelResult;
  comparison: ExperimentComparison;
  controlCount: number;
  variantCount: number;
}

export function useExperimentAnalytics(
  experiment: SalesExperiment | undefined,
  primaryFunnelKey: FunnelMetricKey | null,
  guardrails: FunnelMetricKey[],
): ExperimentAnalytics | null {
  const base = useStudioBase();
  const now = Date.now();
  return useMemo(() => {
    if (!experiment) return null;
    const controlClients = clientsForExperimentGroup(experiment.id, 'control', base.clients, base.byClient);
    const variantClients = clientsForExperimentGroup(experiment.id, 'variant', base.clients, base.byClient);
    const control = computeSalesFunnel(controlClients, { followups: base.followups, downstream: base.downstream, now });
    const variant = computeSalesFunnel(variantClients, { followups: base.followups, downstream: base.downstream, now });
    const comparison = compareExperiment(control, variant, primaryFunnelKey, guardrails);
    return { control, variant, comparison, controlCount: controlClients.length, variantCount: variantClients.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment?.id, primaryFunnelKey, guardrails.join(','), base]);
}
