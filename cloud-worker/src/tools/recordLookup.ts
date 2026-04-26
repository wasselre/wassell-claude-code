import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `record_lookup` — read records from the Wassell CRM.
 *
 * Each model in the CRM is a JSONB schema; each record is a JSONB document
 * keyed by field slug. The agent can:
 *   - Pass `record_id` to fetch one record
 *   - Omit it and get the most recent N records of that model
 *
 * We deliberately don't expose write operations. Agents reading data is
 * low-blast-radius; agents writing data needs a separate review.
 */

export const RECORD_LOOKUP_TOOL = {
  name: 'record_lookup',
  description:
    'Look up records from the Wassell CRM. Each "model" is like a database table (e.g. "clients", "all_projects", "followups"). Each record is a JSONB document keyed by field slug. Pass `record_id` to fetch one record by UUID, or omit it to list the most recent records of that model.',
  input_schema: {
    type: 'object' as const,
    properties: {
      model_slug: {
        type: 'string',
        description:
          'The slug of the CRM model to query. Common slugs: "clients", "all_projects", "targeted_projects", "our_projects", "followups", "projects_research".',
      },
      record_id: {
        type: 'string',
        description:
          'Optional UUID of a specific record. If omitted, returns up to `limit` most recent records.',
      },
      limit: {
        type: 'integer',
        description:
          'Max number of records to return when listing. Default 20, max 50. Ignored when `record_id` is given.',
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['model_slug'],
  },
};

export interface RecordLookupInput {
  model_slug: string;
  record_id?: string;
  limit?: number;
}

export async function runRecordLookup(
  supabase: SupabaseClient,
  input: RecordLookupInput,
): Promise<string> {
  // 1. Resolve the model id by slug.
  const { data: model, error: mErr } = await supabase
    .from('models')
    .select('id, name, label_en, label_ar')
    .eq('name', input.model_slug)
    .maybeSingle();
  if (mErr) {
    return `Error reading models table: ${mErr.message}`;
  }
  if (!model) {
    // List available slugs so the agent can pick a real one on retry.
    const { data: all } = await supabase
      .from('models')
      .select('name, label_en')
      .order('name');
    const slugs = (all ?? []).map((m) => m.name).join(', ');
    return `Error: model "${input.model_slug}" not found. Available models: ${slugs}.`;
  }

  // 2. Fetch records.
  if (input.record_id) {
    const { data: rec, error: rErr } = await supabase
      .from('records')
      .select('id, data, created_at, updated_at')
      .eq('model_id', model.id)
      .eq('id', input.record_id)
      .maybeSingle();
    if (rErr) return `Error reading records: ${rErr.message}`;
    if (!rec) return `Error: no record with id "${input.record_id}" in model "${model.name}".`;
    return JSON.stringify(
      { model: model.name, record: rec },
      null,
      2,
    );
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const { data: records, error: rErr } = await supabase
    .from('records')
    .select('id, data, created_at, updated_at')
    .eq('model_id', model.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (rErr) return `Error reading records: ${rErr.message}`;
  return JSON.stringify(
    { model: model.name, count: records?.length ?? 0, records: records ?? [] },
    null,
    2,
  );
}
