import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, Plus, ArrowLeftRight, Sparkles } from 'lucide-react';
import { proposalToDecision } from '../lib/buildStandardization';
import type { StandardizeCandidate } from '../lib/client';
import type { ColumnStandardization, ValueDecision } from '../lib/types';

interface Props {
  isAr: boolean;
  header: string;
  fieldLabel: string;
  plan: ColumnStandardization;
  /** dropdown/multiselect → option candidates; lookup → existing record candidates. */
  candidates: StandardizeCandidate[];
  /** other importable fields a value can be routed to (slug → label). */
  otherFields: { name: string; label: string }[];
  onChange: (next: ColumnStandardization) => void;
}

// select-value encoding so one <select> covers options/records/new/unmatched/route
const decisionToValue = (d: ValueDecision['decision']): string => {
  switch (d.kind) {
    case 'option': return `opt:${d.optionValue ?? ''}`;
    case 'lookup_record': return `rec:${d.recordId ?? ''}`;
    case 'create_option':
    case 'create_record': return 'new';
    case 'route_to_field': return `route:${d.routeFieldName ?? ''}`;
    default: return 'unmatched';
  }
};

export default function ValueStandardizationColumn({
  isAr,
  header,
  fieldLabel,
  plan,
  candidates,
  otherFields,
  onChange,
}: Props) {
  const [open, setOpen] = useState(true);
  const isLookup = plan.fieldType === 'lookup';

  const setDecision = (i: number, decision: ValueDecision['decision']) =>
    onChange({ ...plan, values: plan.values.map((v, vi) => (vi === i ? { ...v, decision } : v)) });

  const onSelect = (i: number, raw: string, value: string) => {
    if (value === 'unmatched') return setDecision(i, { kind: 'unmatched' });
    if (value === 'new') {
      return setDecision(i, isLookup
        ? { kind: 'create_record', newLabel: raw }
        : { kind: 'create_option', newLabel: raw });
    }
    if (value.startsWith('opt:')) return setDecision(i, { kind: 'option', optionValue: value.slice(4) });
    if (value.startsWith('rec:')) return setDecision(i, { kind: 'lookup_record', recordId: value.slice(4) });
    if (value.startsWith('route:')) {
      return setDecision(i, { kind: 'route_to_field', routeFieldName: value.slice(6), routeValue: raw });
    }
  };

  const acceptAllHighConfidence = () =>
    onChange({
      ...plan,
      values: plan.values.map((v) =>
        v.proposal.confidence >= 0.9 && v.proposal.kind !== 'unmatched'
          ? { ...v, decision: proposalToDecision(v.proposal) }
          : v,
      ),
    });

  // capped candidate list for the <select> (lookups can have thousands)
  const candOptions = isLookup
    ? candidates.slice(0, 100).map((c) => ({ key: `rec:${c.id ?? ''}`, label: c.display ?? '' }))
    : candidates.map((c) => ({ key: `opt:${c.value ?? ''}`, label: (isAr ? c.label_ar : c.label_en) ?? c.value ?? '' }));

  // counts
  const resolved = plan.values.filter((v) => v.decision.kind !== 'unmatched').length;
  const willCreate = plan.values.filter((v) => v.decision.kind === 'create_option' || v.decision.kind === 'create_record').length;
  const willLink = plan.values.filter((v) => v.decision.kind === 'lookup_record').length;
  const routed = plan.values.filter((v) => v.decision.kind === 'route_to_field').length;

  return (
    <div className="rounded-xl border border-sand/30 bg-white">
      <div className="w-full flex items-center gap-2 p-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 flex-1 min-w-0 text-start"
        >
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
        <div className="px-3 pb-3 space-y-1.5 max-h-[40vh] overflow-y-auto">
          {plan.values.map((v, i) => {
            const d = v.decision;
            const selVal = decisionToValue(d);
            const isNew = d.kind === 'create_option' || d.kind === 'create_record';
            const isUnmatched = d.kind === 'unmatched';
            const isRoute = d.kind === 'route_to_field';
            return (
              <div key={i} className="flex items-center gap-2 p-2 rounded-lg border border-sand/20">
                <div className="w-1/3 min-w-0">
                  <div className="text-sm text-charcoal truncate" title={v.raw}>{v.raw}</div>
                  {v.count > 1 && <div className="text-[10px] text-charcoal/40">×{v.count}</div>}
                </div>
                <ArrowLeftRight size={13} className="text-charcoal/30 shrink-0" />
                <div className="flex-1 min-w-0">
                  <select
                    value={selVal}
                    onChange={(e) => onSelect(i, v.raw, e.target.value)}
                    className={`form-input text-sm py-1 w-full ${isUnmatched ? 'text-charcoal/40' : ''}`}
                  >
                    <optgroup label={isAr ? 'القيم المسموحة' : 'Allowed values'}>
                      {candOptions.map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label={isAr ? 'إجراءات' : 'Actions'}>
                      <option value="new">
                        {isLookup
                          ? (isAr ? `➕ إنشاء سجل جديد "${v.raw}"` : `➕ Create new "${v.raw}"`)
                          : (isAr ? `➕ إنشاء خيار جديد "${v.raw}"` : `➕ Create new option "${v.raw}"`)}
                      </option>
                      <option value="unmatched">{isAr ? '— اتركه فارغًا —' : '— Leave blank —'}</option>
                    </optgroup>
                    {otherFields.length > 0 && (
                      <optgroup label={isAr ? '↪ نقل إلى حقل آخر' : '↪ Move to another field'}>
                        {otherFields.map((f) => (
                          <option key={f.name} value={`route:${f.name}`}>{f.label}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <div className="flex items-center gap-2 mt-0.5">
                    {v.proposal.confidence > 0 && selVal === decisionToValue(proposalToDecision(v.proposal)) && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-copper/80">
                        <Sparkles size={10} />
                        {Math.round(v.proposal.confidence * 100)}%
                      </span>
                    )}
                    {isNew && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600">
                        <Plus size={10} />
                        {isAr ? 'سيُنشأ' : 'will create'}
                      </span>
                    )}
                    {isRoute && (
                      <span className="text-[10px] text-blue-600">
                        {isAr ? `→ ${otherFields.find((f) => f.name === d.routeFieldName)?.label ?? ''}` : `→ ${otherFields.find((f) => f.name === d.routeFieldName)?.label ?? ''}`}
                      </span>
                    )}
                    {v.proposal.reason && !isRoute && (
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
