import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField } from '@/types';
import { adhocKindFor, type AdhocFieldFilter } from '@/lib/adhocFilterUtils';

interface FieldFilterPopoverProps {
  anchorEl: HTMLElement | null;
  field: ModelField;
  value: AdhocFieldFilter | undefined;
  onChange: (filter: AdhocFieldFilter | undefined) => void;
  onClose: () => void;
}

/**
 * Floating popover anchored to a chip. Renders type-aware inputs for the field.
 * Closes on outside click or Escape. Uses a portal so it escapes any overflow-hidden parents.
 */
export default function FieldFilterPopover({
  anchorEl,
  field,
  value,
  onChange,
  onClose,
}: FieldFilterPopoverProps) {
  const { t } = useTranslation();
  const { language, records, users } = useAppStore();
  const isAr = language === 'ar';

  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  // Position below the anchor, clamped to the viewport.
  useEffect(() => {
    if (!anchorEl) return;
    const measure = () => {
      const rect = anchorEl.getBoundingClientRect();
      const width = Math.max(Math.min(rect.width + 40, 360), 280);
      const maxLeft = window.innerWidth - width - 8;
      const rawLeft = isAr ? rect.right - width : rect.left;
      const left = Math.max(8, Math.min(maxLeft, rawLeft));
      const top = Math.min(window.innerHeight - 320, rect.bottom + 6);
      setPosition({ top, left, width });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorEl, isAr]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      if (anchorEl && anchorEl.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose]);

  const kind = adhocKindFor(field.type);
  if (!kind || !position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 bg-white rounded-xl shadow-xl border border-sand/40 p-3"
      style={{ top: position.top, left: position.left, width: position.width }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-sand/30">
        <div className="text-xs font-bold text-charcoal truncate">
          {isAr ? field.label_ar : field.label_en}
        </div>
        <button
          onClick={() => { onChange(undefined); onClose(); }}
          className="text-[11px] text-charcoal/50 hover:text-copper"
        >
          {t('adhoc.clear')}
        </button>
      </div>

      {kind === 'values' && (
        <ValuesPicker
          field={field}
          value={value?.kind === 'values' ? value.values : []}
          onChange={(values) => onChange(values.length ? { kind: 'values', values } : undefined)}
          isAr={isAr}
          recordsByModel={records}
          users={users}
        />
      )}
      {kind === 'checkbox' && (
        <CheckboxPicker
          value={value?.kind === 'checkbox' ? value.value : null}
          onChange={(v) => onChange(v ? { kind: 'checkbox', value: v } : undefined)}
        />
      )}
      {kind === 'date_range' && (
        <DateRangePicker
          value={value?.kind === 'date_range' ? { from: value.from, to: value.to } : {}}
          onChange={(v) => {
            if (!v.from && !v.to) onChange(undefined);
            else onChange({ kind: 'date_range', from: v.from, to: v.to });
          }}
        />
      )}
      {kind === 'number_range' && (
        <NumberRangePicker
          value={value?.kind === 'number_range' ? { min: value.min, max: value.max } : {}}
          onChange={(v) => {
            if (v.min == null && v.max == null) onChange(undefined);
            else onChange({ kind: 'number_range', min: v.min, max: v.max });
          }}
        />
      )}
      {kind === 'contains' && (
        <ContainsPicker
          value={value?.kind === 'contains' ? value.query : ''}
          onChange={(q) => onChange(q.trim() ? { kind: 'contains', query: q } : undefined)}
          placeholder={isAr ? field.label_ar : field.label_en}
        />
      )}
    </div>,
    document.body,
  );
}

function ValuesPicker({
  field,
  value,
  onChange,
  isAr,
  recordsByModel,
  users,
}: {
  field: ModelField;
  value: string[];
  onChange: (values: string[]) => void;
  isAr: boolean;
  recordsByModel: Record<string, import('@/types').AppRecord[]>;
  users: import('@/types').User[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    if (field.type === 'lookup' && field.lookup_model_id && field.lookup_display_field) {
      const recs = recordsByModel[field.lookup_model_id] ?? [];
      return recs.map((r) => ({
        value: r.id,
        label: String(r.data[field.lookup_display_field!] ?? r.id.slice(0, 8)),
      }));
    }
    if (field.type === 'assignee') {
      const roleIds = field.assignee_role_ids ?? [];
      const eligible = users.filter((u) => {
        if (!u.is_active) return false;
        if (roleIds.length === 0) return true;
        return u.role_assignments.some((ra) => roleIds.includes(ra.role_id));
      });
      return eligible.map((u) => ({ value: u.id, label: isAr ? u.name_ar : u.name_en }));
    }
    return (field.options ?? []).map((o) => ({
      value: o.value,
      label: isAr ? o.label_ar : o.label_en,
    }));
  }, [field, recordsByModel, users, isAr]);

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  return (
    <div>
      {options.length > 6 && (
        <div className="relative mb-2">
          <Search size={12} className="absolute start-2 top-1/2 -translate-y-1/2 text-charcoal/30" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search')}
            className="form-input text-xs py-1.5 ps-7 w-full"
          />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto space-y-0.5">
        {filtered.length === 0 && (
          <div className="text-xs text-charcoal/40 py-2 text-center">{t('common.no_results')}</div>
        )}
        {filtered.map((opt) => {
          const checked = value.includes(opt.value);
          return (
            <label
              key={opt.value}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer ${checked ? 'bg-copper/[0.06] text-charcoal' : 'hover:bg-cream text-charcoal/80'}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(opt.value)}
                className="w-3.5 h-3.5 rounded border-sand text-copper focus:ring-copper/30"
              />
              <span className="truncate flex-1">{opt.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function CheckboxPicker({
  value,
  onChange,
}: {
  value: 'true' | 'false' | null;
  onChange: (v: 'true' | 'false' | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1.5">
      {(['true', 'false'] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(value === v ? null : v)}
          className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${
            value === v
              ? 'border-copper/40 bg-copper/[0.08] text-copper font-bold'
              : 'border-sand/40 text-charcoal/70 hover:border-copper/30'
          }`}
        >
          {v === 'true' ? t('common.yes') : t('common.no')}
        </button>
      ))}
    </div>
  );
}

function DateRangePicker({
  value,
  onChange,
}: {
  value: { from?: string; to?: string };
  onChange: (v: { from?: string; to?: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">{t('adhoc.from')}</label>
        <input
          type="date"
          value={value.from ?? ''}
          onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
          className="form-input text-xs py-1.5 w-full"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">{t('adhoc.to')}</label>
        <input
          type="date"
          value={value.to ?? ''}
          onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
          className="form-input text-xs py-1.5 w-full"
        />
      </div>
    </div>
  );
}

function NumberRangePicker({
  value,
  onChange,
}: {
  value: { min?: number; max?: number };
  onChange: (v: { min?: number; max?: number }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">{t('adhoc.min')}</label>
        <input
          type="number"
          value={value.min ?? ''}
          onChange={(e) => onChange({ ...value, min: e.target.value === '' ? undefined : Number(e.target.value) })}
          className="form-input text-xs py-1.5 w-full"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">{t('adhoc.max')}</label>
        <input
          type="number"
          value={value.max ?? ''}
          onChange={(e) => onChange({ ...value, max: e.target.value === '' ? undefined : Number(e.target.value) })}
          className="form-input text-xs py-1.5 w-full"
        />
      </div>
    </div>
  );
}

function ContainsPicker({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-[10px] font-bold text-charcoal/50 mb-0.5">{t('adhoc.contains')}</label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="form-input text-sm py-1.5 pe-7 w-full"
          autoFocus
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute end-2 top-1/2 -translate-y-1/2 text-charcoal/30 hover:text-charcoal"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
