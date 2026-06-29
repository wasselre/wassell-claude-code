import type { AppModel, AppRecord, ModelField, ModelSection, User } from '@/types';
import type { ClientViewCtx } from '../clientView';

/** Minimal test fixtures for the Clients view resolver + filters. */

let seq = 0;
const id = (p: string) => `${p}-${(seq += 1)}`;

function field(partial: Partial<ModelField> & { name: string; type: ModelField['type'] }): ModelField {
  return {
    id: id('f'),
    label_ar: partial.name,
    label_en: partial.name,
    required: false,
    order: 0,
    ...partial,
  } as ModelField;
}

function section(label: string, fields: ModelField[], is_base = true): ModelSection {
  return { id: id('s'), label_ar: label, label_en: label, order: 0, is_base, fields } as ModelSection;
}

function model(name: string, sections: ModelSection[]): AppModel {
  return {
    id: id('m'),
    name,
    label_ar: name,
    label_en: name,
    icon: 'User',
    color: '#B8734F',
    schema: { sections, section_selector_field_id: null },
    card_config: { title_field_id: null, shown_field_ids: [] },
    maps_config: {} as AppModel['maps_config'],
    is_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as AppModel;
}

export interface TestWorld {
  ctx: ClientViewCtx;
  clientsModel: AppModel;
  projectsModel: AppModel;
  listingsModel: AppModel;
  followupsModel: AppModel;
  user: User;
}

/** Build a coherent little world: clients + all_projects + market_listings + followups. */
export function makeWorld(): TestWorld {
  seq = 0;
  const user: User = {
    id: 'user-1',
    name_ar: 'سالم',
    name_en: 'Salem',
    email: 'salem@wassel.re',
  } as User;

  const projectsModel = model('all_projects', [
    section('Basic', [field({ name: 'project_name', type: 'text' })]),
  ]);
  const listingsModel = model('market_listings', [
    section('Basic', [field({ name: 'title', type: 'text' })]),
  ]);

  const clientsModel = model('clients', [
    section('Basic', [
      field({ name: 'client_name', type: 'text' }),
      field({ name: 'phone_number', type: 'phone' }),
      field({ name: 'client_owner', type: 'assignee' }),
      field({ name: 'client_stage', type: 'dropdown' }),
      field({ name: 'client_status', type: 'dropdown' }),
      field({ name: 'lifecycle_health', type: 'dropdown' }),
      field({ name: 'next_action_type', type: 'dropdown' }),
      field({ name: 'next_action_due_at', type: 'datetime' }),
      field({ name: 'next_followup_id', type: 'lookup' }),
      field({ name: 'last_activity_at', type: 'datetime' }),
      field({ name: 'lost_reason', type: 'dropdown' }),
      field({ name: 'lost_at', type: 'datetime' }),
    ]),
    section('Client Preferences', [
      field({ name: 'preferred_unit_type', type: 'multiselect' }),
      field({ name: 'budget', type: 'range' }),
      field({ name: 'preferred_direction', type: 'multiselect' }),
      field({
        name: 'preferred_projects',
        type: 'lookup',
        is_multi: true,
        lookup_model_id: projectsModel.id,
        lookup_display_field: 'project_name',
      }),
      field({
        name: 'preferred_market_listings',
        type: 'lookup',
        is_multi: true,
        lookup_model_id: listingsModel.id,
        lookup_display_field: 'title',
      }),
    ]),
  ]);

  // followups model with a lookup back to clients
  const followupsModel = model('followups', [
    section('Basic', [
      field({ name: 'client_link', type: 'lookup', lookup_model_id: clientsModel.id }),
      field({ name: 'followup_status', type: 'dropdown' }),
      field({ name: 'scheduled_datetime', type: 'datetime' }),
      field({ name: 'notes', type: 'textarea' }),
      field({ name: 'sales_rep', type: 'assignee' }),
    ]),
  ]);

  const ctx: ClientViewCtx = {
    models: [projectsModel, listingsModel, clientsModel, followupsModel],
    records: {},
    users: [user],
    language: 'en',
  };

  return { ctx, clientsModel, projectsModel, listingsModel, followupsModel, user };
}

export function clientRecord(modelId: string, data: Record<string, unknown>): AppRecord {
  return {
    id: id('client'),
    model_id: modelId,
    data,
    created_by_user_id: 'user-1',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    version: 1,
  };
}

export function genericRecord(modelId: string, recordId: string, data: Record<string, unknown>): AppRecord {
  return {
    id: recordId,
    model_id: modelId,
    data,
    created_by_user_id: 'user-1',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    version: 1,
  };
}
