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

export default function RangeField({ field, value, onChange }: RangeFieldProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const current = toRange(value);
  const unit = isAr ? field.range_unit_ar : field.range_unit_en;

  const update = (patch: Partial<RangeValue>) => {
    const next: RangeValue = { ...current, ...patch };
    if (next.min === undefined && next.max === undefined) {
      onChange(undefined);
    } else {
      onChange(next);
    }
  };

  const inputProps = {
    min: field.range_min,
    max: field.range_max,
    step: field.range_step ?? 'any',
  } as const;

  return (
    <div className="flex items-stretch gap-2">
      <div className="relative flex-1">
        <input
          type="number"
          value={current.min ?? ''}
          onChange={(e) =>
            update({ min: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          className={`form-input ${unit ? 'pe-12' : ''}`}
          placeholder={t('fields.range_min')}
          {...inputProps}
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
          type="number"
          value={current.max ?? ''}
          onChange={(e) =>
            update({ max: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          className={`form-input ${unit ? 'pe-12' : ''}`}
          placeholder={t('fields.range_max')}
          {...inputProps}
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
  const fmt = (n: number) => n.toLocaleString(isAr ? 'ar-SA' : 'en-US');
  const tail = unit ? ` ${unit}` : '';
  if (r.min !== undefined && r.max !== undefined) return `${fmt(r.min)} – ${fmt(r.max)}${tail}`;
  if (r.min !== undefined) return `≥ ${fmt(r.min)}${tail}`;
  if (r.max !== undefined) return `≤ ${fmt(r.max)}${tail}`;
  return '';
}
