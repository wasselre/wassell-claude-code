import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, Check, Plus, ArrowLeftRight, Sparkles, X, Search, AlertTriangle } from 'lucide-react';
import LookupCombobox from '@/pages/Records/components/LookupCombobox';
import { proposalToDecision } from '../lib/buildStandardization';
import { lookupCreateBlockReason } from '../lib/targetFields';
import type { AppModel, FieldOption, ModelField } from '@/types';
import type { ColumnStandardization, ValueDecision } from '../lib/types';

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
  const lookupModelId = field.lookup_model_id ?? undefined;
  const lookupDisplayField = field.lookup_display_field ?? undefined;
  const options = field.options ?? [];

  // One shared rule for "can a new record be created here?" — null = allowed.
  const createBlock = useMemo(
    () => (isLookup ? lookupCreateBlockReason(field, allModels, isAr) : null),
    [isLookup, field, allModels, isAr],
  );

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
  const willCreate = plan.values.filter((v) => v.decision.kind === 'create_option' || v.decision.kind === 'create_record').length;
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
            const isNew = d.kind === 'create_option' || d.kind === 'create_record';
            const isUnmatched = d.kind === 'unmatched';
            const isRoute = d.kind === 'route_to_field';
            const isProposalAccepted = JSON.stringify(d) === JSON.stringify(proposalToDecision(v.proposal));
            const blockedNow = isLookup && d.kind === 'create_record' && !!createBlock;

            return (
              <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-sand/20">
                <div className="w-1/3 min-w-0 pt-1">
                  <div className="text-sm text-charcoal truncate" title={v.raw}>{v.raw}</div>
                  {v.count > 1 && <div className="text-[10px] text-charcoal/40">×{v.count}</div>}
                </div>
                <ArrowLeftRight size={13} className="text-charcoal/30 shrink-0 mt-2.5" />
                <div className="flex-1 min-w-0 space-y-1">
                  {/* Primary picker — search/select an existing option or record */}
                  {isLookup && lookupModelId && lookupDisplayField ? (
                    <LookupCombobox
                      lookupModelId={lookupModelId}
                      lookupDisplayField={lookupDisplayField}
                      value={d.kind === 'lookup_record' ? d.recordId : undefined}
                      onChange={(val) => {
                        const id = Array.isArray(val) ? val[0] : val;
                        setDecision(i, id ? { kind: 'lookup_record', recordId: id } : { kind: 'unmatched' });
                      }}
                    />
                  ) : (
                    <OptionPicker
                      options={options}
                      isAr={isAr}
                      value={d.kind === 'option' ? d.optionValue : undefined}
                      onPick={(val) => setDecision(i, val ? { kind: 'option', optionValue: val } : { kind: 'unmatched' })}
                    />
                  )}

                  {/* Editable label for the new option/record being created.
                      Locally controlled + commit-on-pause/blur so realtime echoes
                      can't wipe the user's typing. */}
                  {isNew && (
                    <NewLabelInput
                      initial={d.newLabel ?? v.raw}
                      isAr={isAr}
                      onCommit={(label) =>
                        setDecision(i, isLookup
                          ? { kind: 'create_record', newLabel: label }
                          : { kind: 'create_option', newLabel: label })
                      }
                    />
                  )}

                  {/* Action buttons: create-new / leave-blank / route */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setDecision(i, isNew
                        ? { kind: 'unmatched' }
                        : isLookup
                          ? { kind: 'create_record', newLabel: v.raw }
                          : { kind: 'create_option', newLabel: v.raw })}
                      className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${isNew ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-sand/40 text-charcoal/55 hover:bg-cream'}`}
                    >
                      <Plus size={11} />
                      {isAr ? 'إنشاء جديد' : 'Create new'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDecision(i, { kind: 'unmatched' })}
                      className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${isUnmatched ? 'border-charcoal/30 bg-charcoal/5 text-charcoal/70' : 'border-sand/40 text-charcoal/55 hover:bg-cream'}`}
                    >
                      <X size={11} />
                      {isAr ? 'فارغ' : 'Blank'}
                    </button>
                    {otherFields.length > 0 && (
                      <select
                        value={isRoute ? d.routeFieldName ?? '' : ''}
                        onChange={(e) =>
                          e.target.value
                            ? setDecision(i, { kind: 'route_to_field', routeFieldName: e.target.value, routeValue: v.raw })
                            : setDecision(i, { kind: 'unmatched' })
                        }
                        className={`text-[11px] py-1 px-1.5 rounded-lg border bg-white ${isRoute ? 'border-blue-400 text-blue-700' : 'border-sand/40 text-charcoal/55'}`}
                      >
                        <option value="">{isAr ? '↪ نقل إلى…' : '↪ Route to…'}</option>
                        {otherFields.map((f) => (
                          <option key={f.name} value={f.name}>{f.label}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Status line */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {v.proposal.confidence > 0 && isProposalAccepted && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-copper/80">
                        <Sparkles size={10} />
                        {Math.round(v.proposal.confidence * 100)}%
                      </span>
                    )}
                    {isNew && !blockedNow && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600">
                        <Plus size={10} />
                        {isAr
                          ? (d.kind === 'create_record' ? 'سيُنشأ سجل' : model.is_hardcoded ? 'خيار جديد (يُضاف للمخطط)' : 'سيُنشأ خيار')
                          : (d.kind === 'create_record' ? 'will create record' : model.is_hardcoded ? 'new option (added to schema)' : 'will create option')}
                      </span>
                    )}
                    {blockedNow && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-red-600" title={createBlock ?? ''}>
                        <AlertTriangle size={10} />
                        {isAr ? 'لا يمكن الإنشاء' : "can't create"} — {createBlock}
                      </span>
                    )}
                    {d.kind === 'lookup_record' && (
                      <span className="text-[10px] text-copper/80">{isAr ? 'مرتبط بسجل موجود' : 'linked to existing'}</span>
                    )}
                    {isRoute && (
                      <span className="text-[10px] text-blue-600">
                        → {otherFields.find((f) => f.name === d.routeFieldName)?.label ?? ''}
                      </span>
                    )}
                    {v.proposal.reason && !isRoute && !blockedNow && (
                      <span className="text-[10px] text-charcoal/40 truncate" title={v.proposal.reason}>{v.proposal.reason}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
