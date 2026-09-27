import { describe, it, expect } from 'vitest';
import type { AppModel, AppRecord } from '@/types';
import { resolveFollowupContext } from '../followupContext';

const m = (id: string, name: string) => ({ id, name, schema: { sections: [] } }) as unknown as AppModel;
const rec = (id: string, modelId: string, data: Record<string, unknown>) =>
  ({ id, model_id: modelId, data }) as unknown as AppRecord;

const models = [m('m-clients', 'clients'), m('m-appts', 'appointments'), m('m-proj', 'all_projects'), m('m-opts', 'client_property_options')];
const baseRecords = (): Record<string, AppRecord[]> => ({
  'm-clients': [rec('c1', 'm-clients', { phone_number: '+966500000000' })],
  'm-proj': [
    rec('p-appt', 'm-proj', { project_name: 'Appointment project' }),
    rec('p-main', 'm-proj', { project_name: 'Main option' }),
    rec('p-other', 'm-proj', { project_name: 'Other option' }),
  ],
});

describe('resolveFollowupContext — project', () => {
  it("prefers the appointment's project", () => {
    const records = {
      ...baseRecords(),
      'm-appts': [rec('a1', 'm-appts', { project_id: 'p-appt' })],
      'm-opts': [rec('o1', 'm-opts', { client_id: 'c1', source_type: 'project', source_id: 'p-main', status: 'suitable', is_main: true })],
    };
    const ctx = resolveFollowupContext({ client_id: 'c1', appointment_id: 'a1' }, models, records);
    expect(ctx.project?.project_name).toBe('Appointment project');
  });

  it("falls back to the client's MAIN project option (Client Options), skipping eliminated ones", () => {
    const records = {
      ...baseRecords(),
      'm-opts': [
        rec('o0', 'm-opts', { client_id: 'c1', source_type: 'project', source_id: 'p-appt', status: 'eliminated' }),
        rec('o1', 'm-opts', { client_id: 'c1', source_type: 'project', source_id: 'p-other', status: 'suitable' }),
        rec('o2', 'm-opts', { client_id: 'c1', source_type: 'project', source_id: 'p-main', status: 'suitable', is_main: true }),
      ],
    };
    const ctx = resolveFollowupContext({ client_id: 'c1' }, models, records);
    expect(ctx.project?.project_name).toBe('Main option');
  });

  it('has no project when there is no appointment and no project option', () => {
    const ctx = resolveFollowupContext({ client_id: 'c1' }, models, baseRecords());
    expect(ctx.project).toBeNull();
  });
});
