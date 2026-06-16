import { describe, it, expect } from 'vitest';
import { runAnalyticsQuery } from '../engine';
import { resolveDateRange } from '../dateWindows';
import { validateAnalyticsQuery, assertSerializable } from '../validate';
import type { AnalyticsContext } from '../context';
import type { AnalyticsQuery } from '../types';
import type { AppModel, AppRecord, FieldOption, ModelField, ModelView, MetricDefinition, User } from '@/types';

// ── fixtures (loose builders — tests aren't typechecked by tsc) ──────────────
function field(p: Partial<ModelField> & { name: string; type: ModelField['type'] }): ModelField {
  return {
    id: p.id ?? `f_${p.name}`,
    name: p.name,
    label_ar: p.label_ar ?? p.name,
    label_en: p.label_en ?? p.name,
    type: p.type,
    required: false,
    order: p.order ?? 0,
    section_id: 's1',
    width: 'full',
    show_in_table: true,
    ...p,
  } as ModelField;
}
function model(id: string, name: string, fields: ModelField[]): AppModel {
  return {
    id,
    name,
    label_ar: name,
    label_en: name,
    icon: 'box',
    color: '#000',
    schema: { sections: [{ id: 's1', label_ar: 'S', label_en: 'S', order: 0, is_base: true, fields }] },
  } as unknown as AppModel;
}
function opt(value: string, color: string): FieldOption {
  return { id: `o_${value}`, label_ar: value, label_en: value, value, color };
}
function rec(id: string, model_id: string, data: Record<string, unknown>, created_at = '2026-06-16T10:00:00Z'): AppRecord {
  return { id, model_id, data, created_by_user_id: null, created_at, updated_at: created_at };
}

const NOW = new Date('2026-06-16T06:00:00.000Z'); // → 09:00 Riyadh, Tue 2026-06-16
const USERS: User[] = [
  { id: 'u1', name_ar: 'أليس', name_en: 'Alice', email: '', profile_id: 'p', role_assignments: [], is_active: true, created_at: '', updated_at: '' },
  { id: 'u2', name_ar: 'بوب', name_en: 'Bob', email: '', profile_id: 'p', role_assignments: [], is_active: true, created_at: '', updated_at: '' },
];

const CALLS = model('m_calls', 'calls', [
  field({ name: 'call_result', type: 'dropdown', options: [opt('answered', '#22c55e'), opt('no_answer', '#ef4444'), opt('voicemail', '#9ca3af')] }),
  field({ name: 'agent', type: 'assignee' }),
  field({ name: 'call_date', type: 'datetime' }),
  field({ name: 'duration', type: 'number' }),
  field({ name: 'deal_value', type: 'currency' }),
]);

function callRecords(): AppRecord[] {
  return [
    rec('c1', 'm_calls', { call_result: 'answered', agent: 'u1', call_date: '2026-06-16T08:30', duration: 120, deal_value: 1000 }),
    rec('c2', 'm_calls', { call_result: 'answered', agent: 'u1', call_date: '2026-06-16T09:15', duration: 60, deal_value: 2000 }),
    rec('c3', 'm_calls', { call_result: 'no_answer', agent: 'u2', call_date: '2026-06-16T08:45', duration: 0 }),
    rec('c4', 'm_calls', { call_result: 'voicemail', agent: 'u2', call_date: '2026-06-15T10:00', duration: 30 }),
    rec('c5', 'm_calls', { call_result: 'answered', agent: 'u2', call_date: '2026-06-16T10:30', duration: 200, deal_value: 3000 }),
    rec('c6', 'm_calls', { call_result: 'answered', agent: 'u1', call_date: '2026-05-10T10:00', duration: 45, deal_value: 500 }),
  ];
}

function ctx(models: AppModel[], records: AppRecord[], sourceId: string, opts: Partial<AnalyticsContext> = {}): AnalyticsContext {
  const allRecords: Record<string, AppRecord[]> = {};
  for (const r of records) (allRecords[r.model_id] ||= []).push(r);
  return {
    models,
    records: allRecords[sourceId] ?? [],
    allRecords,
    users: opts.users ?? USERS,
    savedViews: opts.savedViews,
    metrics: opts.metrics,
    isAr: false,
    now: opts.now ?? NOW,
    options: opts.options,
  };
}

const callsCtx = (opts: Partial<AnalyticsContext> = {}) => ctx([CALLS], callRecords(), 'm_calls', opts);
const byRaw = (rows: { keys: { raw: string }[]; value: number | null }[], raw: string) =>
  rows.find((r) => r.keys[0]?.raw === raw)?.value;
const byPath = (rows: { keys: { raw: string }[]; value: number | null }[], path: string[]) =>
  rows.find((r) => r.keys.map((k) => k.raw).join('|') === path.join('|'))?.value;

describe('aggregations', () => {
  it('count (scalar)', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'count' } }, callsCtx());
    expect(r.total).toBe(6);
    expect(r.scanned).toBe(6);
  });
  it('count with equals + in filters', () => {
    const eq = runAnalyticsQuery({ source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'f_call_result' }, operator: 'equals', value: 'answered' }] }, aggregation: { type: 'count' } }, callsCtx());
    expect(eq.total).toBe(4);
    const inOp = runAnalyticsQuery({ source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'f_call_result' }, operator: 'in', value: ['no_answer', 'voicemail'] }] }, aggregation: { type: 'count' } }, callsCtx());
    expect(inOp.total).toBe(2);
  });
  it('sum / avg skip empties (no non-numeric warning)', () => {
    const sum = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_deal_value' } } }, callsCtx());
    expect(sum.total).toBe(6500);
    expect(sum.warnings).toHaveLength(0);
    const avg = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'avg', field: { kind: 'field', field_id: 'f_deal_value' } } }, callsCtx());
    expect(avg.total).toBe(6500 / 4);
  });
  it('min / max / sum over duration', () => {
    const mk = (type: 'min' | 'max' | 'sum') => runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type, field: { kind: 'field', field_id: 'f_duration' } } }, callsCtx()).total;
    expect(mk('min')).toBe(0);
    expect(mk('max')).toBe(200);
    expect(mk('sum')).toBe(455);
  });
  it('count_distinct', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'count_distinct', field: { kind: 'field', field_id: 'f_call_result' } } }, callsCtx());
    expect(r.total).toBe(3);
  });
});

describe('grouping', () => {
  it('by dropdown — option order, colors, and zero-count seeding', () => {
    const all = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_call_result' } }], aggregation: { type: 'count' } }, callsCtx());
    expect(all.rows.map((r) => r.keys[0].raw)).toEqual(['answered', 'no_answer', 'voicemail']);
    expect(byRaw(all.rows, 'answered')).toBe(4);
    expect(byRaw(all.rows, 'no_answer')).toBe(1);
    expect(all.rows[0].keys[0].color).toBe('#22c55e');
    // today → voicemail seeded at 0
    const today = runAnalyticsQuery({ source_model_id: 'm_calls', date_filter: { field: { kind: 'field', field_id: 'f_call_date' }, mode: 'today' }, group_by: [{ field: { kind: 'field', field_id: 'f_call_result' } }], aggregation: { type: 'count' } }, callsCtx());
    expect(byRaw(today.rows, 'answered')).toBe(3);
    expect(byRaw(today.rows, 'voicemail')).toBe(0);
  });
  it('by assignee with name labels + sum', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_agent' } }], aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_deal_value' } } }, callsCtx());
    expect(byRaw(r.rows, 'u1')).toBe(3500);
    expect(byRaw(r.rows, 'u2')).toBe(3000);
    expect(r.rows.find((x) => x.keys[0].raw === 'u1')?.keys[0].label_en).toBe('Alice');
  });
  it('multi-level (result × agent)', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_call_result' } }, { field: { kind: 'field', field_id: 'f_agent' } }], aggregation: { type: 'count' } }, callsCtx());
    expect(byPath(r.rows, ['answered', 'u1'])).toBe(3);
    expect(byPath(r.rows, ['answered', 'u2'])).toBe(1);
    expect(byPath(r.rows, ['no_answer', 'u2'])).toBe(1);
  });
  it('numeric bucket', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_duration' }, numeric_bucket: { width: 100 } }], aggregation: { type: 'count' } }, callsCtx());
    expect(byRaw(r.rows, '0')).toBe(4);
    expect(byRaw(r.rows, '100')).toBe(1);
    expect(byRaw(r.rows, '200')).toBe(1);
  });
});

describe('time bucketing (Riyadh)', () => {
  it('by hour, today, chronological', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', date_filter: { field: { kind: 'field', field_id: 'f_call_date' }, mode: 'today' }, group_by: [{ field: { kind: 'field', field_id: 'f_call_date' }, time_bucket: 'hour' }], aggregation: { type: 'count' } }, callsCtx());
    expect(r.rows.map((x) => x.keys[0].raw)).toEqual(['2026-06-16T08', '2026-06-16T09', '2026-06-16T10']);
    expect(r.rows.map((x) => x.value)).toEqual([2, 1, 1]);
  });
});

describe('percentage / ratio', () => {
  it('percentage answered/total (scalar + per-hour)', () => {
    const num: AnalyticsQuery = { source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'f_call_result' }, operator: 'equals', value: 'answered' }] }, aggregation: { type: 'count' } };
    const den: AnalyticsQuery = { source_model_id: 'm_calls', aggregation: { type: 'count' } };
    const scalar = runAnalyticsQuery({ source_model_id: 'm_calls', date_filter: { field: { kind: 'field', field_id: 'f_call_date' }, mode: 'today' }, aggregation: { type: 'percentage', numerator: num, denominator: den } }, callsCtx());
    expect(scalar.total).toBe(75);
    const perHour = runAnalyticsQuery({ source_model_id: 'm_calls', date_filter: { field: { kind: 'field', field_id: 'f_call_date' }, mode: 'today' }, group_by: [{ field: { kind: 'field', field_id: 'f_call_date' }, time_bucket: 'hour' }], aggregation: { type: 'percentage', numerator: num, denominator: den } }, callsCtx());
    expect(byRaw(perHour.rows, '2026-06-16T08')).toBe(50);
    expect(byRaw(perHour.rows, '2026-06-16T09')).toBe(100);
  });
  it('ratio sum/count', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'ratio', numerator: { source_model_id: 'm_calls', aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_deal_value' } } }, denominator: { source_model_id: 'm_calls', aggregation: { type: 'count' } } } }, callsCtx());
    expect(r.total).toBeCloseTo(6500 / 6, 5);
  });
  it('zero denominator → null + warning', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'ratio', numerator: { source_model_id: 'm_calls', aggregation: { type: 'count' } }, denominator: { source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'f_call_result' }, operator: 'equals', value: 'zzz' }] }, aggregation: { type: 'count' } } } }, callsCtx());
    expect(r.total).toBeNull();
    expect(r.warnings.some((w) => w.code === 'ratio_zero_denominator')).toBe(true);
  });
});

describe('date windows (Riyadh, fixed now)', () => {
  it('resolves the relative presets', () => {
    expect(resolveDateRange('today', NOW)).toEqual({ from: '2026-06-16T00:00:00.000', to: '2026-06-16T23:59:59.999' });
    expect(resolveDateRange('yesterday', NOW).from).toBe('2026-06-15T00:00:00.000');
    expect(resolveDateRange('this_month', NOW)).toEqual({ from: '2026-06-01T00:00:00.000', to: '2026-06-30T23:59:59.999' });
    expect(resolveDateRange('last_month', NOW)).toEqual({ from: '2026-05-01T00:00:00.000', to: '2026-05-31T23:59:59.999' });
    expect(resolveDateRange('this_year', NOW)).toEqual({ from: '2026-01-01T00:00:00.000', to: '2026-12-31T23:59:59.999' });
    expect(resolveDateRange('last_7_days', NOW).from).toBe('2026-06-10T00:00:00.000');
    expect(resolveDateRange('last_30_days', NOW).from).toBe('2026-05-18T00:00:00.000');
  });
  it('comparison: this_month vs last_month delta', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', date_filter: { field: { kind: 'field', field_id: 'f_call_date' }, mode: 'this_month' }, aggregation: { type: 'count' } }, callsCtx({ options: { comparison: true } }));
    expect(r.total).toBe(5); // c1-c5 are June; c6 is May
    expect(r.comparison?.total).toBe(1);
    expect(r.comparison?.delta_pct).toBe(400);
  });
});

describe('saved views', () => {
  it('layers a view’s conditions under the query', () => {
    const view: ModelView = {
      id: 'v1', model_id: 'm_calls', user_id: 'u1', is_shared: true, is_default: false,
      label_ar: 'Answered', label_en: 'Answered', field_ids: [], sort_field_id: null, sort_direction: null,
      conditions: [{ id: '1', field_id: 'f_call_result', operator: 'equals', value: 'answered' }],
      created_at: '', updated_at: '',
    };
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', saved_view_id: 'v1', aggregation: { type: 'count' } }, callsCtx({ savedViews: [view] }));
    expect(r.total).toBe(4);
  });
});

describe('semantic metrics', () => {
  const revenue: MetricDefinition = { id: 'revenue', label_ar: 'الإيراد', label_en: 'Revenue', query: { source_model_id: 'm_calls', aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_deal_value' } } }, is_system: true, created_at: '', updated_at: '' };
  const totalCalls: MetricDefinition = { id: 'total_calls', label_ar: '', label_en: 'Total', query: { source_model_id: 'm_calls', aggregation: { type: 'count' } }, is_system: true, created_at: '', updated_at: '' };
  const answered: MetricDefinition = { id: 'answered_calls', label_ar: '', label_en: 'Answered', query: { source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'f_call_result' }, operator: 'equals', value: 'answered' }] }, aggregation: { type: 'count' } }, is_system: true, created_at: '', updated_at: '' };
  const answerRate: MetricDefinition = { id: 'answer_rate', label_ar: '', label_en: 'Answer rate', query: { source_model_id: 'm_calls', aggregation: { type: 'count' } }, formula: '{ac} / {tc} * 100', inputs: [{ name: 'ac', metric_id: 'answered_calls' }, { name: 'tc', metric_id: 'total_calls' }], is_system: true, created_at: '', updated_at: '' };

  it('simple metric drives a grouped sum', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_agent' } }], aggregation: { type: 'count', metric_id: 'revenue' } }, callsCtx({ metrics: [revenue] }));
    expect(byRaw(r.rows, 'u1')).toBe(3500);
    expect(byRaw(r.rows, 'u2')).toBe(3000);
  });
  it('composite metric (formula over other metrics)', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'count', metric_id: 'answer_rate' } }, callsCtx({ metrics: [revenue, totalCalls, answered, answerRate] }));
    expect(r.total).toBeCloseTo((4 / 6) * 100, 4);
  });
});

describe('lookup grouping', () => {
  it('groups by a lookup field resolving the linked display value', () => {
    const projects = model('m_proj', 'projects', [field({ name: 'name', type: 'text' })]);
    const reservations = model('m_res', 'reservations', [field({ name: 'project_id', type: 'lookup', lookup_model_id: 'm_proj', lookup_display_field: 'name' })]);
    const records = [
      rec('p1', 'm_proj', { name: 'Narjis' }),
      rec('p2', 'm_proj', { name: 'Wahaa' }),
      rec('rs1', 'm_res', { project_id: 'p1' }),
      rec('rs2', 'm_res', { project_id: 'p1' }),
      rec('rs3', 'm_res', { project_id: 'p2' }),
    ];
    const r = runAnalyticsQuery({ source_model_id: 'm_res', group_by: [{ field: { kind: 'field', field_id: 'f_project_id' } }], aggregation: { type: 'count' } }, ctx([projects, reservations], records, 'm_res'));
    expect(byRaw(r.rows, 'p1')).toBe(2);
    expect(r.rows.find((x) => x.keys[0].raw === 'p1')?.keys[0].label_en).toBe('Narjis');
    expect(byRaw(r.rows, 'p2')).toBe(1);
  });
});

describe('warnings (never silently dropped)', () => {
  it('unknown field in a filter is skipped + warned', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', filters: { mode: 'all', conditions: [{ id: '1', field: { kind: 'field', field_id: 'nope' }, operator: 'equals', value: 'x' }] }, aggregation: { type: 'count' } }, callsCtx());
    expect(r.total).toBe(6);
    expect(r.warnings.some((w) => w.code === 'unknown_field' && w.field_id === 'nope')).toBe(true);
  });
  it('sum over a non-numeric field type warns not_aggregatable', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_call_result' } } }, callsCtx());
    expect(r.warnings.some((w) => w.code === 'not_aggregatable')).toBe(true);
  });
  it('non-numeric values under sum are skipped + counted', () => {
    const recs = [rec('a', 'm_calls', { duration: 10 }), rec('b', 'm_calls', { duration: 'abc' }), rec('c', 'm_calls', { duration: 5 })];
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', aggregation: { type: 'sum', field: { kind: 'field', field_id: 'f_duration' } } }, ctx([CALLS], recs, 'm_calls'));
    expect(r.total).toBe(15);
    expect(r.warnings.find((w) => w.code === 'non_numeric_skipped')).toMatchObject({ count: 1 });
  });
});

describe('drill-through recordIds', () => {
  it('collects per-group record ids when requested', () => {
    const r = runAnalyticsQuery({ source_model_id: 'm_calls', group_by: [{ field: { kind: 'field', field_id: 'f_call_result' } }], aggregation: { type: 'count' } }, callsCtx({ options: { include_record_ids: true } }));
    const answered = r.rows.find((x) => x.keys[0].raw === 'answered');
    expect(answered?.recordIds?.sort()).toEqual(['c1', 'c2', 'c5', 'c6']);
  });
});

describe('validation + serializability', () => {
  it('validateAnalyticsQuery flags structural problems', () => {
    expect(validateAnalyticsQuery({})).toMatch(/source_model_id/);
    expect(validateAnalyticsQuery({ source_model_id: 'm', aggregation: { type: 'sum' } })).toMatch(/requires a field/);
    expect(validateAnalyticsQuery({ source_model_id: 'm', aggregation: { type: 'count' } })).toBeNull();
  });
  it('assertSerializable throws on functions, passes on pure JSON', () => {
    const clean: AnalyticsQuery = { source_model_id: 'm', aggregation: { type: 'count' } };
    expect(() => assertSerializable(clean)).not.toThrow();
    const dirty = { source_model_id: 'm', aggregation: { type: 'count' }, sort: [{ by: () => 1 }] } as unknown as AnalyticsQuery;
    expect(() => assertSerializable(dirty)).toThrow();
  });
});
