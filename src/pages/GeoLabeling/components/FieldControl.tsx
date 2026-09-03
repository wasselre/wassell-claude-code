import { useState } from 'react';
import Button from '@/components/ui/Button';
import type { FieldDescriptor } from '../lib/client';

/**
 * Renders ONE ontology field for labeling, straight from its server-served
 * FieldDescriptor: the exact enum values, plus the three escape hatches
 * (unknown / insufficient_context / must_confirm) the instrument always offers on
 * fuzzy fields. No field name or value list is hardcoded here — the descriptor is
 * the single source of truth, so the form can never drift from the schema.
 */
const ESCAPE_LABEL: Record<string, { ar: string; en: string }> = {
  unknown: { ar: 'غير معروف', en: 'Unknown' },
  insufficient_context: { ar: 'سياق غير كافٍ', en: 'Insufficient context' },
  must_confirm: { ar: 'يجب التأكيد', en: 'Must confirm' },
};

export default function FieldControl({
  descriptor, value, isAr, disabled, onChange,
}: {
  descriptor: FieldDescriptor;
  value: string | null;
  isAr: boolean;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [text, setText] = useState(value ?? '');
  const isEscape = (v: string | null) => v != null && v in ESCAPE_LABEL;

  return (
    <div className="rounded-lg border border-sand/40 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-charcoal">{descriptor.label}</span>
          {descriptor.required && <span className="text-red-500" title={isAr ? 'مطلوب' : 'required'}>*</span>}
          {descriptor.fuzzy && (
            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">
              {isAr ? 'تقديري' : 'fuzzy'}
            </span>
          )}
        </div>
        <code className="text-[10px] text-charcoal/40">{descriptor.entity}.{descriptor.field}</code>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-charcoal/50">{descriptor.help}</p>

      {descriptor.kind === 'enum' && descriptor.allowed_values ? (
        <div className="flex flex-wrap gap-1.5">
          {descriptor.allowed_values.map((v) => (
            <button
              key={v}
              type="button"
              disabled={disabled}
              onClick={() => onChange(v)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                value === v
                  ? 'border-copper bg-copper text-white'
                  : 'border-sand/50 bg-cream/40 text-charcoal hover:bg-cream'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      ) : (
        <input
          type={descriptor.kind === 'number' ? 'number' : 'text'}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => onChange(text.trim() === '' ? null : text.trim())}
          placeholder={isAr ? 'اكتب القيمة…' : 'type value…'}
          className="w-full rounded-lg border border-sand/50 bg-cream/30 px-2.5 py-1.5 text-sm text-charcoal focus:border-copper focus:outline-none disabled:opacity-40"
        />
      )}

      {descriptor.escapes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-sand/30 pt-2">
          {descriptor.escapes.map((esc) => (
            <button
              key={esc}
              type="button"
              disabled={disabled}
              onClick={() => onChange(esc)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-40 ${
                value === esc
                  ? 'border-terracotta bg-terracotta text-white'
                  : 'border-terracotta/40 bg-terracotta/5 text-terracotta hover:bg-terracotta/10'
              }`}
            >
              {isAr ? ESCAPE_LABEL[esc]?.ar : ESCAPE_LABEL[esc]?.en}
            </button>
          ))}
        </div>
      )}

      {value != null && (
        <div className="mt-2 flex items-center gap-2">
          <span className={`text-[11px] ${isEscape(value) ? 'text-terracotta' : 'text-emerald-600'}`}>
            {isAr ? 'المُختار:' : 'selected:'} <b>{value}</b>
          </span>
          <Button variant="ghost" className="!px-2 !py-0.5 !text-[11px]" onClick={() => onChange(null)} disabled={disabled}>
            {isAr ? 'مسح' : 'clear'}
          </Button>
        </div>
      )}
    </div>
  );
}
