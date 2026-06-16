// Resolves the surrounding context for a follow-up record — the client,
// appointment, project, type, and phones the Workspace panels need. Pure: takes
// the store's models/records and returns plain data.

import type { AppModel, AppRecord } from '@/types';

export interface FollowupContext {
  clientId: string | null;
  client: Record<string, unknown> | null;
  /** Distinct phone values to try for calls / WhatsApp / call evidence. */
  phones: string[];
  appointment: Record<string, unknown> | null;
  project: Record<string, unknown> | null;
  /** Single follow-up type value (followup_type is stored as a multi array). */
  typeKey: string | null;
  attemptNumber: number | null;
}

function modelByName(models: AppModel[], name: string): AppModel | undefined {
  return models.find((m) => m.name === name);
}

function findRecord(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
  modelName: string,
  id: unknown,
): Record<string, unknown> | null {
  if (!id || typeof id !== 'string') return null;
  const model = modelByName(models, modelName);
  if (!model) return null;
  const rec = (records[model.id] ?? []).find((r) => r.id === id);
  return rec ? rec.data : null;
}

/** `followup_type` is a section_selector stored as an array — read the first value. */
export function readFollowupType(data: Record<string, unknown>): string | null {
  const v = data.followup_type;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return v ? String(v) : null;
}

function asString(v: unknown): string | null {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return typeof v === 'string' && v.trim() ? v : null;
}

export function resolveFollowupContext(
  data: Record<string, unknown>,
  models: AppModel[],
  records: Record<string, AppRecord[]>,
): FollowupContext {
  const clientId = asString(data.client_id);
  const client = findRecord(models, records, 'clients', clientId);
  const appointment = findRecord(models, records, 'appointments', asString(data.appointment_id));
  const projectId = asString(appointment?.project_id) ?? asString((client?.preferred_projects as unknown));
  const project = findRecord(models, records, 'all_projects', projectId);

  const phones = [
    typeof client?.phone_number === 'string' ? client.phone_number : null,
    typeof data.client_phone === 'string' ? data.client_phone : null,
  ].filter((p): p is string => Boolean(p && p.trim()));

  const attempt = data.followup_number;
  const attemptNumber = typeof attempt === 'number' ? attempt : Number.isFinite(Number(attempt)) ? Number(attempt) : null;

  return {
    clientId,
    client,
    phones: [...new Set(phones)],
    appointment,
    project,
    typeKey: readFollowupType(data),
    attemptNumber,
  };
}
