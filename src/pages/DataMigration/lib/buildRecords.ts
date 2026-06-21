import type { AppModel, AppRecord, ModelField } from '@/types';
import { normalizeMatch, splitMultiValue } from '@/lib/textMatch';
import { slugifyOptionLabel, findExistingOption, uniqueOptionValue } from '@/lib/optionSlug';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { importableFields, lookupCreateBlockReason } from './targetFields';
import {
  MARKETING_DOC_FIELD,
  ANALYSIS_DOC_FIELD,
  type BuiltRecord,
  type ColumnStandardization,
  type PendingNewLookupRecord,
  type PendingNewOption,
  type PreviewCellMeta,
  type ProjectIntelligenceSection,
  type RawTable,
  type RouteResolution,
  type RowIssue,
} from './types';

/**
 * The strict, decision-driven record builder — the heart of the standardization
 * layer. Given the raw table, column mappings, and the per-value decisions, it
 * produces the EXACT records that will be written, plus the pending options /
 * lookup records that must be created first, plus per-row validation.
 *
 * Design rules (from the standardization spec — never regress these):
 *  - Controlled fields (dropdown / multi-select / lookup) are resolved from the
 *    user's DECISIONS, never by round-tripping a record id → display → re-match
 *    (that links the wrong record when two records share a display name). A
 *    lookup decision stores the EXACT record id; a dropdown decision stores the
 *    EXACT option value.
 *  - No raw labels are ever stored in a controlled field. A value that can't be
 *    resolved to an option/record (and wasn't explicitly blanked) makes the row
 *    invalid — it is shown and blocked, never silently coerced.
 *  - New options / lookup records are NOT created here. We only record the
 *    pending decision (deterministic option slug, stable temp id for new
 *    records). The migrate step creates them, then saves the records.
 *  - Raw source values are never mutated — the builder reads the raw table and
 *    derives app-ready values into fresh record objects.
 */

export interface BuildPlanArgs {
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization>;
  /** PROJECT-PROFILE mode: written into each record's `marketing_document`. */
  projectDocument?: string;
  /** PROJECT-PROFILE mode: the intelligence sections — rendered to Markdown and
   * written into each record's `project_analysis`. */
  projectIntelligence?: ProjectIntelligenceSection[];
  allModels: AppModel[];
  allRecords: Record<string, AppRecord[]>;
  isAr: boolean;
  /** UUID factory — used for new-option ids + new-lookup-record temp ids. */
  makeId: () => string;
}

export interface MigrationPlan {
  /** The (unmutated) target model. New options are applied at migrate time. */
  model: AppModel;
  /** Every surviving, non-duplicate source row as a built record (valid + invalid). */
  records: BuiltRecord[];
  /** Options to add to the model schema before saving (if their rows migrate). */
  newOptions: PendingNewOption[];
  /** Lookup-target records to create before saving (if their rows migrate). */
  newLookupRecords: PendingNewLookupRecord[];
  /** Rows skipped as exact duplicates of an existing record / earlier row. */
  skipped: number;
}

const FROZEN_DISPLAY_TYPES = new Set(['mirror']);

/** True when a field's value is a controlled reference (option value / record id). */
function isControlledField(field: ModelField): boolean {
  return field.type === 'dropdown' || field.type === 'multiselect' || field.type === 'lookup';
}

/** True when a controlled field stores an array (multi-select, multi-lookup). */
function isMultiField(field: ModelField): boolean {
  return field.type === 'multiselect' || (field.type === 'lookup' && !!field.is_multi);
}

/** Render the extraction's project-intelligence sections into ONE Markdown
 * document for the `project_analysis` field — a "## title" heading per section.
 * Returns "" when there's nothing to write. */
function renderProjectAnalysis(sections: ProjectIntelligenceSection[]): string {
  return sections
    .map((s) => ({ title: (s.title ?? '').trim(), content: (s.content ?? '').trim() }))
    .filter((s) => s.title || s.content)
    .map((s) => (s.title ? `## ${s.title}\n\n${s.content}` : s.content))
    .join('\n\n')
    .trim();
}

/** A value is "empty" for required-field validation. */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const r = v as { min?: unknown; max?: unknown };
    if ('min' in r || 'max' in r) {
      return (r.min === undefined || r.min === null) && (r.max === undefined || r.max === null);
    }
  }
  return false;
}

/** How a single token resolved — the building block of a controlled cell. */
type TokenResolution =
  | { kind: 'value'; storeValue: string; action: 'option' | 'create_option' }
  | { kind: 'lookup'; recordId: string; action: 'link' | 'create_record' }
  | { kind: 'route'; routeFieldName: string; routeRaw: string; routeDecision?: RouteResolution }
  | { kind: 'blank' }
  | { kind: 'invalid'; code: RowIssue['code']; detail?: string };

export function buildMigrationPlan(args: BuildPlanArgs): MigrationPlan {
  const { model, table, mappings, standardization, allRecords, allModels, makeId } = args;

  const fields = model.schema.sections.flatMap((s) => s.fields);
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const importables = importableFields(model);

  // ── Accumulators for pending creates (deterministic, dedup-aware) ──────────
  const newOptions = new Map<string, PendingNewOption>(); // key = fieldId::value
  const newLookups = new Map<string, PendingNewLookupRecord>(); // key = modelId::normLabel
  // Per-field set of option values in use (existing ∪ pending) for slug uniqueness.
  const usedOptionValues = new Map<string, Set<string>>();
  // Per-field: normalized new-option label → its pending entry (reuse, no dup).
  const pendingOptionByLabel = new Map<string, Map<string, PendingNewOption>>();

  const getUsedValues = (field: ModelField): Set<string> => {
    let set = usedOptionValues.get(field.id);
    if (!set) {
      set = new Set((field.options ?? []).map((o) => o.value));
      usedOptionValues.set(field.id, set);
    }
    return set;
  };

  // Lazy display index for a lookup target: normalized display → record id.
  // Resolves computed display fields (mirror / section_mirror) too, so existing
  // records are matched the same way the picker shows them.
  const displayIndexCache = new Map<string, Map<string, string>>();
  const getDisplayIndex = (modelId: string, displayField: string): Map<string, string> => {
    const cacheKey = `${modelId}::${displayField}`;
    let idx = displayIndexCache.get(cacheKey);
    if (idx) return idx;
    idx = new Map();
    const targetModel = allModels.find((m) => m.id === modelId);
    const isComputed =
      displayField.includes('::') ||
      FROZEN_DISPLAY_TYPES.has(
        targetModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === displayField)?.type ?? '',
      );
    for (const rec of allRecords[modelId] ?? []) {
      const raw = isComputed
        ? resolveLookupDisplayValue(rec, displayField, { targetModel, allModels, allRecords })
        : rec.data[displayField];
      const k = normalizeMatch(String(raw ?? ''));
      if (k && !idx.has(k)) idx.set(k, rec.id);
    }
    displayIndexCache.set(cacheKey, idx);
    return idx;
  };

  /** Register (or reuse) a pending new option for `field`; returns its value.
   * Dedups against existing options AND earlier pending ones. */
  const registerNewOption = (field: ModelField, label: string): { value: string; created: boolean } => {
    const existing = findExistingOption(field.options ?? [], label);
    if (existing) return { value: existing.value, created: false };
    const norm = normalizeMatch(label);
    let byLabel = pendingOptionByLabel.get(field.id);
    if (!byLabel) {
      byLabel = new Map();
      pendingOptionByLabel.set(field.id, byLabel);
    }
    const already = byLabel.get(norm);
    if (already) return { value: already.value, created: true };
    const used = getUsedValues(field);
    const value = uniqueOptionValue(slugifyOptionLabel(label), used);
    used.add(value);
    const entry: PendingNewOption = {
      fieldId: field.id,
      fieldName: field.name,
      fieldLabel: args.isAr ? field.label_ar : field.label_en,
      label,
      value,
      frozen: !!model.is_hardcoded,
    };
    byLabel.set(norm, entry);
    newOptions.set(`${field.id}::${value}`, entry);
    return { value, created: true };
  };

  /** Register (or reuse / link-existing) a pending new lookup record; returns a
   * record id (existing match or the pending temp id) or an invalid result. */
  const registerNewLookupRecord = (
    field: ModelField,
    label: string,
  ): { recordId: string; created: boolean } | { invalid: string } => {
    const block = lookupCreateBlockReason(field, allModels, args.isAr);
    if (block) return { invalid: block };
    const modelId = field.lookup_model_id!;
    const disp = field.lookup_display_field!;
    const norm = normalizeMatch(label);
    // Dedup against an existing record with the same display — link it instead
    // of minting a duplicate.
    const existingId = getDisplayIndex(modelId, disp).get(norm);
    if (existingId) return { recordId: existingId, created: false };
    const key = `${modelId}::${norm}`;
    const already = newLookups.get(key);
    if (already) return { recordId: already.tempId, created: true };
    const targetModel = allModels.find((m) => m.id === modelId);
    const entry: PendingNewLookupRecord = {
      tempId: makeId(),
      targetModelId: modelId,
      targetModelLabel: targetModel ? (args.isAr ? targetModel.label_ar : targetModel.label_en) : modelId,
      displayField: disp,
      label,
    };
    newLookups.set(key, entry);
    return { recordId: entry.tempId, created: true };
  };

  // ── Pre-pass: resolve every distinct decision to a token resolution ────────
  // Keyed by colIndex → (normalized raw token → resolution). Done once so the
  // same raw always resolves identically and pending creates are deterministic.
  const columnRes = new Map<number, Map<string, TokenResolution>>();
  for (const [colStr, plan] of Object.entries(standardization)) {
    const col = Number(colStr);
    if (!plan) continue;
    // Guard: the mapping may have changed since the plan was computed.
    if (mappings[col] !== plan.fieldName) continue;
    const field = fieldByName.get(plan.fieldName);
    if (!field || !isControlledField(field)) continue;
    const map = new Map<string, TokenResolution>();
    for (const v of plan.values) {
      const key = normalizeMatch(v.raw);
      map.set(key, resolveDecision(field, v.decision, v.raw));
    }
    columnRes.set(col, map);
  }

  /** Resolve a decision object to a token resolution (registers pending creates). */
  function resolveDecision(
    field: ModelField,
    decision: ColumnStandardization['values'][number]['decision'],
    raw: string,
  ): TokenResolution {
    switch (decision.kind) {
      case 'option': {
        const val = decision.optionValue ?? '';
        const exists = (field.options ?? []).some((o) => o.value === val);
        if (val && exists) return { kind: 'value', storeValue: val, action: 'option' };
        return { kind: 'invalid', code: 'unresolved_option' };
      }
      case 'lookup_record': {
        const id = decision.recordId ?? '';
        const exists = id && (allRecords[field.lookup_model_id ?? ''] ?? []).some((r) => r.id === id);
        if (exists) return { kind: 'lookup', recordId: id, action: 'link' };
        return { kind: 'invalid', code: 'unresolved_lookup' };
      }
      case 'create_option': {
        const label = (decision.newLabel ?? raw).trim();
        if (!label) return { kind: 'blank' };
        const { value, created } = registerNewOption(field, label);
        return { kind: 'value', storeValue: value, action: created ? 'create_option' : 'option' };
      }
      case 'create_record': {
        const label = (decision.newLabel ?? raw).trim();
        if (!label) return { kind: 'blank' };
        const res = registerNewLookupRecord(field, label);
        if ('invalid' in res) return { kind: 'invalid', code: 'create_blocked', detail: res.invalid };
        return { kind: 'lookup', recordId: res.recordId, action: res.created ? 'create_record' : 'link' };
      }
      case 'route_to_field': {
        if (!decision.routeFieldName) return { kind: 'blank' };
        return {
          kind: 'route',
          routeFieldName: decision.routeFieldName,
          routeRaw: decision.routeValue ?? raw,
          routeDecision: decision.routeDecision,
        };
      }
      case 'unmatched':
      default:
        return { kind: 'blank' };
    }
  }

  /** Resolve a controlled token with NO decision (mapping had no plan, or a raw
   * value not seen at plan time). Deterministic match only — never creates, never
   * stores a raw label. */
  function fallbackResolveControlled(field: ModelField, token: string): TokenResolution {
    if (field.type === 'lookup') {
      const modelId = field.lookup_model_id;
      const disp = field.lookup_display_field;
      if (!modelId || !disp) return { kind: 'invalid', code: 'unresolved_lookup' };
      const id = getDisplayIndex(modelId, disp).get(normalizeMatch(token));
      return id ? { kind: 'lookup', recordId: id, action: 'link' } : { kind: 'invalid', code: 'unresolved_lookup' };
    }
    const opt = (field.options ?? []).find(
      (o) =>
        o.value === token ||
        normalizeMatch(o.value ?? '') === normalizeMatch(token) ||
        normalizeMatch(o.label_ar ?? '') === normalizeMatch(token) ||
        normalizeMatch(o.label_en ?? '') === normalizeMatch(token),
    );
    return opt ? { kind: 'value', storeValue: opt.value, action: 'option' } : { kind: 'invalid', code: 'unresolved_option' };
  }

  /** Resolve a routed raw value against its DESTINATION field (re-standardize).
   * No creation on a route — must match an existing option/record. */
  function resolveRoutedControlledToken(field: ModelField, token: string): TokenResolution {
    return fallbackResolveControlled(field, token);
  }

  // ── Row pass ───────────────────────────────────────────────────────────────
  const builtRows: BuiltRecord[] = [];

  for (let r = 0; r < table.rows.length; r++) {
    const rawRow = table.rows[r] ?? [];
    if (!rawRow.some((c) => (c ?? '').trim() !== '')) continue; // all-empty → skip

    const data: Record<string, unknown> = {};
    const audit: Record<string, PreviewCellMeta> = {};
    const issues: RowIssue[] = [];
    const mappedFieldNames = new Set<string>();
    // destFieldName → routed values, each with its (optional) destination
    // resolution (match / create / link / create-record / blank).
    const routed = new Map<string, { raw: string; routeDecision?: RouteResolution }[]>();
    // table field name → (sub-column name → row tokens); assembled into rows below.
    const tableInputs = new Map<string, Map<string, string[]>>();

    const addIssue = (field: ModelField, severity: RowIssue['severity'], code: RowIssue['code'], raw?: string, detail?: string) => {
      issues.push({ fieldName: field.name, fieldLabel: args.isAr ? field.label_ar : field.label_en, severity, code, raw, detail });
    };

    for (const [colStr, mapped] of Object.entries(mappings)) {
      if (!mapped) continue;
      const col = Number(colStr);
      const dot = mapped.indexOf('.');
      const fieldName = dot === -1 ? mapped : mapped.slice(0, dot);
      const subPath = dot === -1 ? null : mapped.slice(dot + 1);
      const field = fieldByName.get(fieldName);
      if (!field || field.type === 'mirror' || field.type === 'notes' || field.is_rollup) continue;
      mappedFieldNames.add(fieldName);

      const cell = (rawRow[col] ?? '').trim();
      if (!cell) continue;

      if (field.type === 'table') {
        // A table sub-column (`slug.colName`). A multi-value cell becomes one
        // row per item; sibling sub-columns of the same table zip by row index.
        if (!subPath) continue; // whole-table mapping is unsupported
        const tokens = splitMultiValue(cell);
        let cols = tableInputs.get(fieldName);
        if (!cols) { cols = new Map(); tableInputs.set(fieldName, cols); }
        cols.set(subPath, tokens.length ? tokens : [cell]);
        continue;
      }

      if (isControlledField(field)) {
        const res = columnRes.get(col);
        const multi = isMultiField(field);
        const tokens = multi ? splitMultiValue(cell) : [cell];
        const collected: string[] = [];
        let notableAction: PreviewCellMeta['action'] = 'blank';
        let routeName: string | undefined;
        const rank: Record<PreviewCellMeta['action'], number> = {
          invalid: 6, create_record: 5, create_option: 5, route: 4, link: 3, option: 2, blank: 1,
        };
        const bump = (a: PreviewCellMeta['action'], rn?: string) => {
          if (rank[a] >= rank[notableAction]) { notableAction = a; if (rn) routeName = rn; }
        };

        for (const token of tokens) {
          const tr = (res?.get(normalizeMatch(token))) ?? fallbackResolveControlled(field, token);
          switch (tr.kind) {
            case 'value':
              if (!collected.includes(tr.storeValue)) collected.push(tr.storeValue);
              bump(tr.action);
              break;
            case 'lookup':
              if (!collected.includes(tr.recordId)) collected.push(tr.recordId);
              bump(tr.action);
              break;
            case 'route': {
              const list = routed.get(tr.routeFieldName) ?? [];
              list.push({ raw: tr.routeRaw, routeDecision: tr.routeDecision });
              routed.set(tr.routeFieldName, list);
              bump('route', tr.routeFieldName);
              break;
            }
            case 'invalid':
              addIssue(field, 'error', tr.code, token, tr.detail);
              bump('invalid');
              break;
            case 'blank':
            default:
              bump('blank');
              break;
          }
        }

        if (collected.length > 0) {
          data[fieldName] = multi ? collected : collected[0];
        }
        audit[fieldName] = { raw: cell, action: notableAction, routeFieldName: routeName };
      } else {
        applyScalar(field, subPath, cell, data, (sev, code) => addIssue(field, sev, code, cell));
      }
    }

    // ── Routed values: re-standardize against the DESTINATION field ──────────
    // A routed value carries the SAME decision a non-routed value has, just aimed
    // at the field it was moved to (match / create option / link / create record
    // / blank). We replay it through `resolveDecision` against the destination, so
    // a routed "create new" registers a pending option/record on the DESTINATION
    // exactly like a normal create. With no explicit decision (legacy routes) we
    // fall back to deterministic match-or-fail.
    for (const [destName, items] of routed) {
      const raws = items.map((it) => it.raw);
      const destField = fieldByName.get(destName);
      if (!destField || destField.type === 'mirror' || destField.type === 'notes' || destField.is_rollup) {
        // Routed to an unimportable field — surface, don't store.
        issues.push({
          fieldName: destName, fieldLabel: destName, severity: 'error', code: 'route_invalid',
          raw: raws.join('، '), detail: args.isAr ? 'حقل الوجهة غير صالح' : 'destination field is not importable',
        });
        continue;
      }
      mappedFieldNames.add(destName);

      if (isControlledField(destField)) {
        const multi = isMultiField(destField);
        const existing = Array.isArray(data[destName]) ? (data[destName] as string[]) : [];
        const collected: string[] = [...existing];
        let any = false;
        const take = (tr: TokenResolution, raw: string) => {
          if (tr.kind === 'value') { if (!collected.includes(tr.storeValue)) collected.push(tr.storeValue); any = true; }
          else if (tr.kind === 'lookup') { if (!collected.includes(tr.recordId)) collected.push(tr.recordId); any = true; }
          else if (tr.kind === 'invalid') addIssue(destField, 'error', tr.code, raw, tr.detail);
          // 'blank' → contributes nothing
        };
        for (const item of items) {
          if (item.routeDecision) {
            // Replay the chosen destination decision (single resolved token).
            take(resolveDecision(destField, { ...item.routeDecision }, item.raw), item.raw);
          } else {
            // Legacy: deterministic match-or-fail, splitting a multi-value cell.
            for (const token of multi ? splitMultiValue(item.raw) : [item.raw]) {
              const tr = resolveRoutedControlledToken(destField, token);
              if (tr.kind === 'value' || tr.kind === 'lookup') take(tr, token);
              else addIssue(destField, 'error', 'route_invalid', token);
            }
          }
        }
        if (collected.length > 0) data[destName] = multi ? collected : collected[0];
        if (any && !audit[destName]) audit[destName] = { raw: raws.join('، '), action: 'route' };
      } else {
        // Scalar destination — join multi raws for text, take first for the rest.
        const joined = destField.type === 'text' || destField.type === 'textarea' ? raws.join('، ') : raws[0] ?? '';
        if (isEmptyValue(data[destName])) {
          applyScalar(destField, null, joined, data, (sev, code) => addIssue(destField, sev, code, joined));
          if (!audit[destName]) audit[destName] = { raw: raws.join('، '), action: 'route' };
        }
      }
    }

    // ── Assemble table fields from their collected sub-column tokens ──────────
    for (const [tableName, cols] of tableInputs) {
      let rowCount = 0;
      for (const toks of cols.values()) rowCount = Math.max(rowCount, toks.length);
      const rows: Record<string, string>[] = [];
      for (let i = 0; i < rowCount; i++) {
        const row: Record<string, string> = {};
        let any = false;
        for (const [colName, toks] of cols) {
          const v = toks[i] ?? '';
          row[colName] = v;
          if (v !== '') any = true;
        }
        if (any) rows.push(row);
      }
      if (rows.length > 0) data[tableName] = rows;
    }

    // ── Required-field validation ────────────────────────────────────────────
    for (const f of importables) {
      if (!f.required) continue;
      if (isEmptyValue(data[f.name])) {
        // Mapped-but-blank is a hard error (the source intended to fill it);
        // an unmapped required field is a warning (no source data to resolve).
        const severity: RowIssue['severity'] = mappedFieldNames.has(f.name) ? 'error' : 'warning';
        addIssue(f, severity, 'required_blank');
      }
    }

    const hasError = issues.some((i) => i.severity === 'error');
    // Skip rows that produced nothing AND have no error to explain — pure noise.
    if (Object.keys(data).length === 0 && !hasError) continue;

    builtRows.push({ rowIndex: r, data, issues, audit });
  }

  // ── Exact-duplicate skip (same field the rest of the app dedupes on) ────────
  const dupFieldId = model.schema.duplicate_check_field_id ?? null;
  const dupField = dupFieldId ? fields.find((f) => f.id === dupFieldId) : null;
  const dupSlug = dupField?.name ?? null;
  const seen = new Set<string>();
  const normDup = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());
  if (dupSlug) {
    for (const rec of allRecords[model.id] ?? []) {
      const k = normDup(rec.data[dupSlug]);
      if (k) seen.add(k);
    }
  }

  const records: BuiltRecord[] = [];
  let skipped = 0;
  for (const row of builtRows) {
    if (dupSlug) {
      const key = normDup(row.data[dupSlug]);
      if (key) {
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
      }
    }
    records.push(row);
  }

  // ── PROJECT-PROFILE: attach the marketing document ───────────────────────
  const doc = (args.projectDocument ?? '').trim();
  if (doc && fields.some((f) => f.name === MARKETING_DOC_FIELD)) {
    for (const rec of records) {
      if (!(MARKETING_DOC_FIELD in rec.data)) rec.data[MARKETING_DOC_FIELD] = doc;
    }
  }

  // ── PROJECT-PROFILE: attach the project analysis (intelligence sections) ──
  // The amazing per-dimension analysis (location / pricing / audience / …) was
  // shown read-only and then dropped at import — now it's flattened to Markdown
  // and written into `project_analysis`, the same way the marketing doc is.
  const analysis = renderProjectAnalysis(args.projectIntelligence ?? []);
  if (analysis && fields.some((f) => f.name === ANALYSIS_DOC_FIELD)) {
    for (const rec of records) {
      if (!(ANALYSIS_DOC_FIELD in rec.data)) rec.data[ANALYSIS_DOC_FIELD] = analysis;
    }
  }

  return {
    model,
    records,
    newOptions: [...newOptions.values()],
    newLookupRecords: [...newLookups.values()],
    skipped,
  };
}

/** Parse + store a non-controlled (scalar) cell, mirroring the importer's
 * type coercion. Reports invalid numerics via `onIssue` instead of silently
 * dropping them. */
function applyScalar(
  field: ModelField,
  subPath: string | null,
  cell: string,
  data: Record<string, unknown>,
  onIssue: (severity: RowIssue['severity'], code: RowIssue['code']) => void,
): void {
  const name = field.name;
  switch (field.type) {
    case 'range': {
      if (subPath !== 'min' && subPath !== 'max') return; // range needs .min/.max
      const stripped = cell.replace(/[^\d.-]/g, '');
      const num = Number(stripped);
      if (!stripped || !Number.isFinite(num)) { onIssue('error', 'invalid_number'); return; }
      const existing = (data[name] as { min?: number; max?: number } | undefined) ?? {};
      data[name] = { ...existing, [subPath]: num };
      return;
    }
    case 'number':
    case 'currency': {
      const num = Number(cell.replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(num)) { onIssue('error', 'invalid_number'); return; }
      data[name] = num;
      return;
    }
    case 'checkbox':
      data[name] = ['yes', 'نعم', 'true', '1', 'on'].includes(cell.toLowerCase());
      return;
    case 'section_selector': {
      // Not standardizable, but still option-backed: keep only values that map
      // to a real option (never store a raw label that the form would drop).
      const parts = splitMultiValue(cell);
      const vals = parts
        .map((p) => (field.options ?? []).find((o) => o.value === p || normalizeMatch(o.label_ar ?? '') === normalizeMatch(p) || normalizeMatch(o.label_en ?? '') === normalizeMatch(p))?.value)
        .filter((v): v is string => !!v);
      if (vals.length > 0) data[name] = vals;
      return;
    }
    default:
      data[name] = cell;
  }
}
