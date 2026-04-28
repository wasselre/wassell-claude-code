import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type { ModelField } from '@/types';

export interface RangeValue {
  min?: number;
  max?: number;
}

interface RangeFieldProps {
  field: ModelField;
  value: unknown;
  onChange: (value: RangeValue | undefined) => void;
}

function toRange(value: unknown): RangeValue {
  if (!value || typeof value !== 'object') return {};
  const v = value as Partial<RangeValue>;
  return {
    min: typeof v.min === 'number' ? v.min : undefined,
    max: typeof v.max === 'number' ? v.max : undefined,
  };
}

export function formatNumberWithCommas(n: number | undefined, isAr: boolean): string {
  if (n === undefined || Number.isNaN(n)) return '';
  return n.toLocaleString(isAr ? 'ar-SA' : 'en-US');
}

/**
 * Parse user-entered text to a number. Strips any non-digit / non-decimal /
 * non-minus characters (covers ASCII commas, Arabic thousands separator U+066C,
 * Arabic comma U+060C, spaces, etc.). Also normalizes Arabic-Indic digits
 * (٠–٩) and Eastern Arabic-Indic digits (۰–۹) back to ASCII so the user can
 * paste either form.
 */
export function parseFormattedNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  let s = raw;
  s = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  s = s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  s = s.replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.' || s === '-.') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export default function RangeField({ field, value, onChange }: RangeFieldProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const current = toRange(value);
  const unit = isAr ? field.range_unit_ar : field.range_unit_en;

  const [minDraft, setMinDraft] = useState<string | null>(null);
  const [maxDraft, setMaxDraft] = useState<string | null>(null);

  const update = (patch: Partial<RangeValue>) => {
    const next: RangeValue = { ...current, ...patch };
    if (next.min === undefined && next.max === undefined) {
      onChange(undefined);
    } else {
      onChange(next);
    }
  };

  const minDisplay = minDraft !== null ? minDraft : formatNumberWithCommas(current.min, isAr);
  const maxDisplay = maxDraft !== null ? maxDraft : formatNumberWithCommas(current.max, isAr);

  return (
    <div className="flex items-stretch gap-2">
      <div className="relative flex-1">
        <input
          type="text"
          inputMode="decimal"
          value={minDisplay}
          onChange={(e) => {
            setMinDraft(e.target.value);
            update({ min: parseFormattedNumber(e.target.value) });
          }}
          onBlur={() => setMinDraft(null)}
          className={`form-input ${unit ? 'pe-12' : ''}`}
          placeholder={t('fields.range_min')}
        />
        {unit && (
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-xs text-charcoal/40 font-bold pointer-events-none">
            {unit}
          </span>
        )}
      </div>
      <span className="self-center text-charcoal/30 text-sm">—</span>
      <div className="relative flex-1">
        <input
          type="text"
          inputMode="decimal"
          value={maxDisplay}
          onChange={(e) => {
            setMaxDraft(e.target.value);
            update({ max: parseFormattedNumber(e.target.value) });
          }}
          onBlur={() => setMaxDraft(null)}
          className={`form-input ${unit ? 'pe-12' : ''}`}
          placeholder={t('fields.range_max')}
        />
        {unit && (
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-xs text-charcoal/40 font-bold pointer-events-none">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

/** Format a range value for a read-only display (table cell, PDF, etc.). */
export function formatRangeValue(field: ModelField, value: unknown, isAr: boolean): string {
  const r = toRange(value);
  if (r.min === undefined && r.max === undefined) return '';
  const unit = isAr ? field.range_unit_ar : field.range_unit_en;
  const fmt = (n: number) => formatNumberWithCommas(n, isAr);
  const tail = unit ? ` ${unit}` : '';
  if (r.min !== undefined && r.max !== undefined) return `${fmt(r.min)} – ${fmt(r.max)}${tail}`;
  if (r.min !== undefined) return `≥ ${fmt(r.min)}${tail}`;
  if (r.max !== undefined) return `≤ ${fmt(r.max)}${tail}`;
  return '';
}
