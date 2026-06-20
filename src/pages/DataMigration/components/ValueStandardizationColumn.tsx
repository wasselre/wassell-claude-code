import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, Check, Plus, ArrowLeftRight, Sparkles, X, Search, AlertTriangle } from 'lucide-react';
import LookupCombobox from '@/pages/Records/components/LookupCombobox';
import { proposalToDecision, normalizeMatch } from '../lib/buildStandardization';
import { lookupCreateBlockReason } from '../lib/targetFields';
import type { AppModel, FieldOption, ModelField } from '@/types';
import type { ColumnStandardization, ValueDecision, RouteResolution } from '../lib/types';

interface Props {
  isAr: boolean;
  header: string;
  fieldLabel: string;
  /** The mapped field — gives type, options, and lookup config. */
  field: ModelField;
  /** Target model — for the frozen-option note. */
  model: AppModel;
  allModels: AppModel[];
  plan: ColumnStandardization;
  /** other importable fields a value can be routed to (slug → label). */
  otherFields: { name: string; label: string }[];
  onChange: (next: ColumnStandardization) => void;
}

/** The resolution subset shared by a value's own decision AND a routed value's
 * destination decision: match an option/record, create a new one, or blank. */
type ResValue = {
  kind: 'option' | 'create_option' | 'lookup_record' | 'create_record' | 'unmatched';
  optionValue?: string;
  recordId?: string;
  newLabel?: string;
};

const CONTROLLED = new Set(['dropdown', 'multiselect', 'lookup']);
const isControlledField = (f: ModelField | undefined): f is ModelField => !!f && CONTROLLED.has(f.type);

/**
 * Editable label for a "create new" option/record. CRITICAL: it holds its own
 * LOCAL text state and only commits (persists) on a short debounce + on blur —
 * NOT on every keystroke. The wizard fire-and-forget-saves the whole record on
 * each decision change, and a realtime echo of an earlier save would otherwise
 * snap a controlled input back to a stale value mid-typing ("it deletes what I
 * wrote"). While the field is focused we never overwrite the local text from the
 * incoming prop, so an out-of-order echo can't clobber the user.
 */
function NewLabelInput({
  initial,
  isAr,
  onCommit,
}: {
  initial: string;
  isAr: boolean;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(initial);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Adopt an externally-changed value ONLY when the user isn't actively typing.
  useEffect(() => {
    if (!focused.current) setText(initial);
  }, [initial]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const schedule = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommitRef.current(v), 500);
  };

  return (
    <input
      type="text"
      value={text}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => { setText(e.target.value); schedule(e.target.value); }}
      onBlur={() => {
        focused.current = false;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        onCommitRef.current(text);
      }}
      className="form-input text-sm py-1 w-full border-amber-300 bg-amber-50/40"
      placeholder={isAr ? 'اسم الجديد' : 'New value label'}
    />
  );
}

/** Searchable option selector for dropdown / multi-select columns — mirrors the
 * LookupCombobox UX so options and records feel the same to standardize. */
function OptionPicker({
  options,
  isAr,
  value,
  onPick,
}: {
  options: FieldOption[];
  isAr: boolean;
  value: string | undefined;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? options.filter(
          (o) =>
            (o.label_ar ?? '').toLowerCase().includes(q) ||
            (o.label_en ?? '').toLowerCase().includes(q) ||
            (o.value ?? '').toLowerCase().includes(q),
        )
      : options;
    return base.slice(0, 50);
  }, [query, options]);

  if (selected) {
    return (
      <div className="form-input flex items-center justify-between py-1">
        <span className="text-copper font-bold text-sm truncate">{isAr ? selected.label_ar : selected.label_en}</span>
        <button type="button" onClick={() => onPick('')} className="text-charcoal/30 hover:text-red-500 shrink-0">
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <Search size={13} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-charcoal/30" />
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={isAr ? 'ابحث عن خيار…' : 'Search options…'}
        className="form-input ps-7 text-sm py-1 w-full"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg max-h-44 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-charcoal/30 text-center">{isAr ? 'لا توجد خيارات' : 'No options'}</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onPick(o.value); setOpen(false); setQuery(''); }}
                className="w-full px-3 py-1.5 text-start hover:bg-cream transition-colors text-sm"
              >
                {isAr ? o.label_ar : o.label_en}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Decide what to do with this value against THIS field" — the searchable
 * option/record picker + create-new (with editable label) + leave-blank. Shared
 * by a value's OWN field and (when routed) by its DESTINATION field, so a routed
 * value gets the exact same choices as one that wasn't moved.
 */
function ResolutionControls({
  isAr,
  field,
  model,
  allModels,
  value,
  rawDefault,
  onChange,
}: {
  isAr: boolean;
  field: ModelField;
  model: AppModel;
  allModels: AppModel[];
  value: ResValue;
  rawDefault: string;
  onChange: (v: ResValue) => void;
}) {
  const isLookup = field.type === 'lookup';
  const lookupModelId = field.lookup_model_id ?? undefined;
  const lookupDisplayField = field.lookup_display_field ?? undefined;
  const options = field.options ?? [];
  const createBlock = useMemo(
    () => (isLookup ? lookupCreateBlockReason(field, allModels, isAr) : null),
    [isLookup, field, allModels, isAr],
  );
  const isNew = value.kind === 'create_option' || value.kind === 'create_record';
  const isUnmatched = value.kind === 'unmatched';
  const blockedNow = isLookup && value.kind === 'create_record' && !!createBlock;

  return (
    <div className="space-y-1">
      {/* Primary picker — search/select an existing option or record. */}
      {isLookup && lookupModelId && lookupDisplayField ? (
        <LookupCombobox
          lookupModelId={lookupModelId}
          lookupDisplayField={lookupDisplayField}
          value={value.kind === 'lookup_record' ? value.recordId : undefined}
          onChange={(val) => {
            const id = Array.isArray(val) ? val[0] : val;
            onChange(id ? { kind: 'lookup_record', recordId: id } : { kind: 'unmatched' });
          }}
        />
      ) : (
        <OptionPicker
          options={options}
          isAr={isAr}
          value={value.kind === 'option' ? value.optionValue : undefined}
          onPick={(val) => onChange(val ? { kind: 'option', optionValue: val } : { kind: 'unmatched' })}
        />
      )}

      {/* Editable label for the new option/record being created. */}
      {isNew && (
        <NewLabelInput
          initial={value.newLabel ?? rawDefault}
          isAr={isAr}
          onCommit={(label) =>
            onChange(isLookup ? { kind: 'create_record', newLabel: label } : { kind: 'create_option', newLabel: label })}
        />
      )}

      {/* Create-new / leave-blank. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onChange(isNew
            ? { kind: 'unmatched' }
            : isLookup ? { kind: 'create_record', newLabel: rawDefault } : { kind: 'create_option', newLabel: rawDefault })}
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${isNew ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-sand/40 text-charcoal/55 hover:bg-cream'}`}
        >
          <Plus size={11} />
          {isAr ? 'إنشاء جديد' : 'Create new'}
        </button>
        <button
          type="button"
          onClick={() => onChange({ kind: 'unmatched' })}
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${isUnmatched ? 'border-charcoal/30 bg-charcoal/5 text-charcoal/70' : 'border-sand/40 text-charcoal/55 hover:bg-cream'}`}
        >
          <X size={11} />
          {isAr ? 'فارغ' : 'Blank'}
        </button>
      </div>

      {/* Create status / blocked-create warning. */}
      {(isNew || blockedNow) && (
        <div className="flex items-center gap-2 flex-wrap">
          {isNew && !blockedNow && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600">
              <Plus size={10} />
              {isAr
                ? (value.kind === 'create_record' ? 'سيُنشأ سجل' : model.is_hardcoded ? 'خيار جديد (يُضاف للمخطط)' : 'سيُنشأ خيار')
                : (value.kind === 'create_record' ? 'will create record' : model.is_hardcoded ? 'new option (added to schema)' : 'will create option')}
            </span>
          )}
          {blockedNow && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-red-600" title={createBlock ?? ''}>
              <AlertTriangle size={10} />
              {isAr ? 'لا يمكن الإنشاء' : "can't create"} — {createBlock}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A sensible default for how a routed value resolves in its new field: match an
 * existing dropdown/multiselect option deterministically (Arabic-normalized);
 * otherwise leave it for the user to decide. Scalar destinations get none (the
 * value is written as-is). */
function defaultRouteResolution(destField: ModelField | undefined, raw: string): RouteResolution | undefined {
  if (!destField) return undefined;
  if (destField.type === 'dropdown' || destField.type === 'multiselect') {
    const n = normalizeMatch(raw);
    const opt = (destField.options ?? []).find(
      (o) => normalizeMatch(o.value) === n || normalizeMatch(o.label_ar) === n || normalizeMatch(o.label_en) === n,
    );
    return opt ? { kind: 'option', optionValue: opt.value } : { kind: 'unmatched' };
  }
  if (destField.type === 'lookup') return { kind: 'unmatched' };
  return undefined; // scalar — written as-is, no controlled resolution
}

const asResValue = (d: ValueDecision['decision']): ResValue =>
  d.kind === 'route_to_field'
    ? { kind: 'unmatched' }
    : { kind: d.kind, optionValue: d.optionValue, recordId: d.recordId, newLabel: d.newLabel };

const routeResAsValue = (rd: RouteResolution | undefined): ResValue =>
  rd ? { kind: rd.kind, optionValue: rd.optionValue, recordId: rd.recordId, newLabel: rd.newLabel } : { kind: 'unmatched' };

export default function ValueStandardizationColumn({
  isAr,
  header,
  fieldLabel,
  field,
  model,
  allModels,
  plan,
  otherFields,
  onChange,
}: Props) {
  const [open, setOpen] = useState(true);
  const isLookup = field.type === 'lookup';

  // Lookup other fields in the target model by slug (a route destination is a
  // plain slug for controlled fields; range/table destinations carry a ".part").
  const fieldByName = useMemo(
    () => new Map(model.schema.sections.flatMap((s) => s.fields).map((f) => [f.name, f])),
    [model],
  );
  const destFieldOf = (routeFieldName: string | undefined): ModelField | undefined =>
    routeFieldName ? fieldByName.get(routeFieldName.split('.')[0]!) : undefined;

  const setDecision = (i: number, decision: ValueDecision['decision']) =>
    onChange({ ...plan, values: plan.values.map((v, vi) => (vi === i ? { ...v, decision } : v)) });

  const acceptAllHighConfidence = () =>
    onChange({
      ...plan,
      values: plan.values.map((v) =>
        v.proposal.confidence >= 0.9 && v.proposal.kind !== 'unmatched'
          ? { ...v, decision: proposalToDecision(v.proposal) }
          : v,
      ),
    });

  // counts
  const isActionable = (d: ValueDecision['decision']) => d.kind !== 'unmatched';
  const resolved = plan.values.filter((v) => isActionable(v.decision)).length;
  const willCreate = plan.values.filter(
    (v) =>
      v.decision.kind === 'create_option' ||
      v.decision.kind === 'create_record' ||
      v.decision.routeDecision?.kind === 'create_option' ||
      v.decision.routeDecision?.kind === 'create_record',
  ).length;
  const willLink = plan.values.filter((v) => v.decision.kind === 'lookup_record').length;
  const routed = plan.values.filter((v) => v.decision.kind === 'route_to_field').length;

  return (
    <div className="rounded-xl border border-sand/30 bg-white">
      <div className="w-full flex items-center gap-2 p-3">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 flex-1 min-w-0 text-start">
          {open ? <ChevronDown size={16} className="text-charcoal/40" /> : <ChevronRight size={16} className="text-charcoal/40" />}
          <span className="flex-1 min-w-0">
            <span className="block font-bold text-sm text-charcoal truncate">
              {fieldLabel}
              <span className="text-charcoal/40 font-normal"> ← {header}</span>
            </span>
            <span className="block text-[11px] text-charcoal/50">
              {isAr ? `${resolved}/${plan.values.length} محسوم` : `${resolved}/${plan.values.length} resolved`}
              {willCreate > 0 && (isAr ? ` · ${willCreate} جديد` : ` · ${willCreate} new`)}
              {isLookup && willLink > 0 && (isAr ? ` · ${willLink} مرتبط` : ` · ${willLink} linked`)}
              {routed > 0 && (isAr ? ` · ${routed} مُحوّل` : ` · ${routed} routed`)}
            </span>
          </span>
        </button>
        <button
          onClick={acceptAllHighConfidence}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg bg-copper/10 hover:bg-copper/20 text-copper transition-colors"
        >
          <Check size={11} />
          {isAr ? 'قبول العالية' : 'Accept high-conf.'}
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-1.5 max-h-[44vh] overflow-y-auto">
          {plan.values.map((v, i) => {
            const d = v.decision;
            const isRoute = d.kind === 'route_to_field';
            const destField = isRoute ? destFieldOf(d.routeFieldName) : undefined;
            const destControlled = isControlledField(destField);
            const isProposalAccepted = !isRoute && JSON.stringify(d) === JSON.stringify(proposalToDecision(v.proposal));

            return (
              <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-sand/20">
                <div className="w-1/3 min-w-0 pt-1">
                  <div className="text-sm text-charcoal truncate" title={v.raw}>{v.raw}</div>
                  {v.count > 1 && <div className="text-[10px] text-charcoal/40">×{v.count}</div>}
                </div>
                <ArrowLeftRight size={13} className="text-charcoal/30 shrink-0 mt-2.5" />
                <div className="flex-1 min-w-0 space-y-1">
                  {/* Resolve against the value's OWN field — hidden once routed. */}
                  {!isRoute && (
                    <ResolutionControls
                      isAr={isAr}
                      field={field}
                      model={model}
                      allModels={allModels}
                      value={asResValue(d)}
                      rawDefault={v.raw}
                      onChange={(rv) =>
                        setDecision(i, { kind: rv.kind, optionValue: rv.optionValue, recordId: rv.recordId, newLabel: rv.newLabel })}
                    />
                  )}

                  {/* Route-to-another-field selector — always available. */}
                  {otherFields.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <select
                        value={isRoute ? d.routeFieldName ?? '' : ''}
                        onChange={(e) => {
                          const name = e.target.value;
                          if (!name) { setDecision(i, { kind: 'unmatched' }); return; }
                          setDecision(i, {
                            kind: 'route_to_field',
                            routeFieldName: name,
                            routeValue: v.raw,
                            routeDecision: defaultRouteResolution(destFieldOf(name), v.raw),
                          });
                        }}
                        className={`text-[11px] py-1 px-1.5 rounded-lg border bg-white ${isRoute ? 'border-blue-400 text-blue-700' : 'border-sand/40 text-charcoal/55'}`}
                      >
                        <option value="">{isAr ? '↪ نقل إلى…' : '↪ Route to…'}</option>
                        {otherFields.map((f) => (
                          <option key={f.name} value={f.name}>{f.label}</option>
                        ))}
                      </select>
                      {isRoute && (
                        <span className="text-[10px] text-blue-600">
                          → {otherFields.find((f) => f.name === d.routeFieldName)?.label ?? ''}
                        </span>
                      )}
                    </div>
                  )}

                  {/* When routed to a CONTROLLED field, decide what to do there —
                      same choices as a non-routed value (match / create / blank). */}
                  {isRoute && destControlled && destField && (
                    <div className="ps-2 border-s-2 border-blue-200 space-y-1">
                      <div className="text-[10px] text-blue-700/70">
                        {isAr ? 'ماذا نفعل بهذه القيمة في حقل الوجهة؟' : 'What to do with this value in the destination field?'}
                      </div>
                      <ResolutionControls
                        isAr={isAr}
                        field={destField}
                        model={model}
                        allModels={allModels}
                        value={routeResAsValue(d.routeDecision)}
                        rawDefault={d.routeValue ?? v.raw}
                        onChange={(rv) =>
                          setDecision(i, {
                            kind: 'route_to_field',
                            routeFieldName: d.routeFieldName,
                            routeValue: d.routeValue ?? v.raw,
                            routeDecision: rv,
                          })}
                      />
                    </div>
                  )}
                  {isRoute && !destControlled && d.routeFieldName && (
                    <div className="text-[10px] text-charcoal/40">
                      {isAr ? 'تُكتب القيمة كما هي في حقل الوجهة.' : 'The value is written as-is into the destination field.'}
                    </div>
                  )}

                  {/* AI confidence / reason — only for the value's own resolution. */}
                  {!isRoute && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {v.proposal.confidence > 0 && isProposalAccepted && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-copper/80">
                          <Sparkles size={10} />
                          {Math.round(v.proposal.confidence * 100)}%
                        </span>
                      )}
                      {d.kind === 'lookup_record' && (
                        <span className="text-[10px] text-copper/80">{isAr ? 'مرتبط بسجل موجود' : 'linked to existing'}</span>
                      )}
                      {v.proposal.reason && (
                        <span className="text-[10px] text-charcoal/40 truncate" title={v.proposal.reason}>{v.proposal.reason}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
