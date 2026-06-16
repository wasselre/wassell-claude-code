/**
 * Turns a record + a group-by level into one or more `GroupKey`s. One record
 * yields multiple keys only for multi-value fields when fanning out
 * (multiselect / multi-lookup). Labels are always bilingual; dropdown options
 * carry their color and schema order; lookups resolve their display value;
 * dates/numbers bucket. Missing values fall into a visible "(Empty)" group —
 * never silently dropped.
 */
import type { AppRecord, ModelField } from '../../types';
import type { GroupByConfig, GroupKey, NumericBucket, TimeBucket } from './types';
import type { AnalyticsContext } from './context';
import { toNumeric } from './numeric';
import { bucketDate } from './dateWindows';
import { resolveLookupDisplayValue, resolveMirror } from '../mirrorResolver';

const EMPTY_AR = '(فارغ)';
const EMPTY_EN = '(Empty)';

function emptyKey(fieldId: string | null): GroupKey {
  return { field_id: fieldId, raw: '__empty__', label_ar: EMPTY_AR, label_en: EMPTY_EN };
}

function fmtNum(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function numericBucketKey(value: unknown, nb: NumericBucket, fieldId: string | null): GroupKey {
  const n = toNumeric(value);
  if (n === null) return emptyKey(fieldId);
  const width = nb.width > 0 ? nb.width : 1;
  if (nb.max !== undefined && n >= nb.max) {
    const label = `${fmtNum(nb.max)}+`;
    return { field_id: fieldId, raw: `${nb.max}+`, label_ar: label, label_en: label, bucket_start: String(nb.max) };
  }
  const anchor = nb.min ?? 0;
  const idx = Math.floor((n - anchor) / width);
  const lo = anchor + idx * width;
  const hi = lo + width;
  const label = `${fmtNum(lo)}–${fmtNum(hi)}`;
  return { field_id: fieldId, raw: String(lo), label_ar: label, label_en: label, bucket_start: String(lo), bucket_end: String(hi) };
}

function dateKey(value: unknown, bucket: TimeBucket, fieldId: string | null): GroupKey {
  const b = bucketDate(value, bucket);
  if (!b) return emptyKey(fieldId);
  return { field_id: fieldId, raw: b.raw, label_ar: b.label_ar, label_en: b.label_en, bucket_start: b.start, bucket_end: b.end };
}

function userKey(uid: string, ctx: AnalyticsContext, fieldId: string | null): GroupKey {
  const u = ctx.users.find((x) => x.id === uid);
  return {
    field_id: fieldId,
    raw: uid,
    label_ar: u?.name_ar || u?.name_en || uid,
    label_en: u?.name_en || u?.name_ar || uid,
  };
}

function resolveLinkedLabel(id: string, field: ModelField, ctx: AnalyticsContext): string {
  const targetModelId = field.type === 'unit_picker' ? field.unit_picker_unit_model_id : field.lookup_model_id;
  if (!targetModelId) return id;
  const recs = ctx.allRecords[targetModelId] ?? [];
  const target = recs.find((r) => r.id === id);
  if (!target) return id;
  const displaySlug = field.lookup_display_field || 'name';
  const targetModel = ctx.models.find((m) => m.id === targetModelId);
  const v = resolveLookupDisplayValue(target, displaySlug, {
    targetModel,
    allModels: ctx.models,
    allRecords: ctx.allRecords,
  });
  return v === null || v === undefined || v === '' ? id : String(v);
}

function scalarKey(value: unknown, field: ModelField, ctx: AnalyticsContext): GroupKey {
  if (value === null || value === undefined || value === '') return emptyKey(field.id);
  switch (field.type) {
    case 'dropdown':
    case 'section_selector':
    case 'multiselect': {
      const opt = (field.options ?? []).find((o) => o.value === String(value));
      if (opt) return { field_id: field.id, raw: opt.value, label_ar: opt.label_ar, label_en: opt.label_en, color: opt.color };
      return { field_id: field.id, raw: String(value), label_ar: String(value), label_en: String(value) };
    }
    case 'checkbox': {
      const b = value === true || value === 'true';
      return { field_id: field.id, raw: b ? 'true' : 'false', label_ar: b ? 'نعم' : 'لا', label_en: b ? 'Yes' : 'No' };
    }
    case 'assignee':
      return userKey(String(value), ctx, field.id);
    case 'lookup':
    case 'unit_picker': {
      const label = resolveLinkedLabel(String(value), field, ctx);
      return { field_id: field.id, raw: String(value), label_ar: label, label_en: label };
    }
    default:
      return { field_id: field.id, raw: String(value), label_ar: String(value), label_en: String(value) };
  }
}

export function groupKeysForRecord(
  record: AppRecord,
  cfg: GroupByConfig,
  field: ModelField | undefined,
  ctx: AnalyticsContext,
): GroupKey[] {
  const ref = cfg.field;
  if (ref.kind === 'created_by') {
    const uid = record.created_by_user_id;
    return uid ? [userKey(uid, ctx, null)] : [emptyKey(null)];
  }
  if (ref.kind === 'created_at' || ref.kind === 'updated_at') {
    const v = ref.kind === 'created_at' ? record.created_at : record.updated_at;
    return [dateKey(v, cfg.time_bucket ?? 'day', null)];
  }
  if (!field) return [emptyKey(null)];
  const raw = record.data[field.name];

  if ((field.type === 'date' || field.type === 'datetime') && cfg.time_bucket) {
    return [dateKey(raw, cfg.time_bucket, field.id)];
  }
  if ((field.type === 'number' || field.type === 'currency' || field.type === 'formula') && cfg.numeric_bucket) {
    return [numericBucketKey(raw, cfg.numeric_bucket, field.id)];
  }
  if (field.type === 'range') {
    const min = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).min : undefined;
    if (cfg.numeric_bucket) return [numericBucketKey(min, cfg.numeric_bucket, field.id)];
    if (min === null || min === undefined || min === '') return [emptyKey(field.id)];
    return [{ field_id: field.id, raw: String(min), label_ar: String(min), label_en: String(min) }];
  }
  if (field.type === 'mirror') {
    const res = resolveMirror(field, record.data, ctx.allRecords, ctx.models);
    const v = res.status === 'ok' ? res.value : undefined;
    const arr = Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v];
    if (arr.length === 0) return [emptyKey(field.id)];
    const fan = cfg.fan_out_multi !== false;
    const vals = fan ? arr : [arr.map((x) => String(x)).join(', ')];
    return vals.map((x) =>
      x === null || x === undefined || x === ''
        ? emptyKey(field.id)
        : { field_id: field.id, raw: String(x), label_ar: String(x), label_en: String(x) },
    );
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [emptyKey(field.id)];
    const fan = cfg.fan_out_multi !== false;
    const vals = fan ? raw : [raw.map((x) => String(x)).join(', ')];
    return vals.map((v) => scalarKey(v, field, ctx));
  }
  return [scalarKey(raw, field, ctx)];
}

/**
 * Zero-count seed keys for a single dropdown / section_selector level, so every
 * option renders even with no matching records (matches today's bar/pie). Only
 * applied for single-level grouping (multi-level groups are data-driven).
 */
export function seedOptionKeys(field: ModelField): GroupKey[] {
  if (field.type !== 'dropdown' && field.type !== 'section_selector') return [];
  return (field.options ?? []).map((o) => ({
    field_id: field.id,
    raw: o.value,
    label_ar: o.label_ar,
    label_en: o.label_en,
    color: o.color,
  }));
}
