import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { ModelField, AppModel, AppRecord, LocationLevel } from '@/types';
import { adhocKindFor, type AdhocFieldFilter } from '@/lib/adhocFilterUtils';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { filterEligibleAssignees } from '@/lib/assigneeEligibility';

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
  const { language, records, users, models } = useAppStore();
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
          mode={value?.kind === 'values' ? (value.mode ?? 'is') : 'is'}
          onChange={(values, mode) =>
            onChange(values.length ? { kind: 'values', values, mode } : undefined)
          }
          isAr={isAr}
          recordsByModel={records}
          allModels={models}
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
      {kind === 'location' && (
        <LocationPicker
          field={field}
          value={value?.kind === 'location' ? value.levels : {}}
          onChange={(levels) => {
            const any = Object.values(levels).some((ids) => ids.length > 0);
            onChange(any ? { kind: 'location', levels } : undefined);
          }}
          isAr={isAr}
          recordsByModel={records}
          allModels={models}
        />
      )}
    </div>,
    document.body,
  );
}

function ValuesPicker({
  field,
  value,
  mode,
  onChange,
  isAr,
  recordsByModel,
  allModels,
  users,
}: {
  field: ModelField;
  value: string[];
  mode: 'is' | 'is_not';
  onChange: (values: string[], mode: 'is' | 'is_not') => void;
  isAr: boolean;
  recordsByModel: Record<string, import('@/types').AppRecord[]>;
  allModels: AppModel[];
  users: import('@/types').User[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    if (field.type === 'lookup' && field.lookup_model_id && field.lookup_display_field) {
      const recs = recordsByModel[field.lookup_model_id] ?? [];
      const targetModel = allModels.find((m) => m.id === field.lookup_model_id);
      return recs.map((r) => ({
        value: r.id,
        label: String(
          resolveLookupDisplayValue(r, field.lookup_display_field!, {
            targetModel,
            allModels,
            allRecords: recordsByModel,
          }) ?? r.id.slice(0, 8),
        ),
      }));
    }
    if (field.type === 'assignee') {
      const eligible = filterEligibleAssignees(field, users);
      return eligible.map((u) => ({ value: u.id, label: isAr ? u.name_ar : u.name_en }));
    }
    return (field.options ?? []).map((o) => ({
      value: o.value,
      label: isAr ? o.label_ar : o.label_en,
    }));
  }, [field, recordsByModel, allModels, users, isAr]);

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v], mode);
  };

  return (
    <div>
      <div className="flex gap-1 mb-2 p-0.5 bg-cream/60 rounded-lg">
        {(['is', 'is_not'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onChange(value, m)}
            className={`flex-1 px-2 py-1 rounded-md text-[11px] font-bold transition-colors ${
              mode === m
                ? 'bg-white text-copper shadow-sm'
                : 'text-charcoal/50 hover:text-charcoal'
            }`}
          >
            {t(m === 'is' ? 'adhoc.is' : 'adhoc.is_not')}
          </button>
        ))}
      </div>
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

const LOCATION_LEVEL_LABELS: Record<string, { ar: string; en: string }> = {
  country: { ar: 'الدولة', en: 'Country' },
  region: { ar: 'المنطقة', en: 'Region' },
  city: { ar: 'المدينة', en: 'City' },
  district: { ar: 'الحي', en: 'District' },
};

/**
 * Multi-select cascade filter for a `location` field. Steps through the field's
 * levels (region → city → district); each level is a searchable checkbox list.
 * Children are filtered to the picked parent ids when a parent is selected, else
 * all candidates show (searchable, capped). Selections are OR within a level and
 * AND across levels — matching `evaluateAdhoc`'s 'location' case.
 */
function LocationPicker({
  field,
  value,
  onChange,
  isAr,
  recordsByModel,
  allModels,
}: {
  field: ModelField;
  value: Record<string, string[]>;
  onChange: (levels: Record<string, string[]>) => void;
  isAr: boolean;
  recordsByModel: Record<string, AppRecord[]>;
  allModels: AppModel[];
}) {
  const { t } = useTranslation();
  const levels = field.location_levels ?? [];
  const [step, setStep] = useState(() => Math.max(0, levels.length - 1)); // default to the deepest level
  const [query, setQuery] = useState('');

  const selectedAt = (key: string) => value[key] ?? [];

  const levelLabel = (lv: LocationLevel): string => {
    const known = LOCATION_LEVEL_LABELS[lv.key];
    if (known) return isAr ? known.ar : known.en;
    const m = allModels.find((mm) => mm.id === lv.model_id);
    return m ? (isAr ? m.label_ar : m.label_en) : lv.key;
  };

  const nameOf = (lv: LocationLevel, id: string): string => {
    const recs = recordsByModel[lv.model_id] ?? [];
    const rec = recs.find((r) => r.id === id);
    if (!rec) return id.slice(0, 8);
    const m = allModels.find((mm) => mm.id === lv.model_id) ?? null;
    const dv = resolveLookupDisplayValue(rec, lv.display_field, { targetModel: m, allModels, allRecords: recordsByModel });
    return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
  };

  // Resolve the parent-link slug on a child level (config wins, else auto-detect a
  // lookup on the child model pointing at the parent level's model). Mirrors
  // LocationCascadeField's resolution so the same parent gating applies.
  const parentLinkFor = (level: LocationLevel, parent: LocationLevel | null): string | null => {
    if (level.parent_link_field) return level.parent_link_field;
    if (!parent) return null;
    const model = allModels.find((m) => m.id === level.model_id);
    const lf = model?.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.type === 'lookup' && f.lookup_model_id === parent.model_id);
    return lf?.name ?? null;
  };

  const candidates = useMemo(() => {
    const lv = levels[step];
    if (!lv) return [] as { r: AppRecord; name: string }[];
    let recs = recordsByModel[lv.model_id] ?? [];
    if (step > 0) {
      const parent = levels[step - 1]!;
      const plf = parentLinkFor(lv, parent);
      const parentIds = selectedAt(parent.key);
      if (plf && parentIds.length) {
        recs = recs.filter((r) => { const pv = r.data[plf]; return typeof pv === 'string' && parentIds.includes(pv); });
      }
    }
    const q = query.trim().toLowerCase();
    return recs
      .map((r) => ({ r, name: nameOf(lv, r.id) }))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
      .slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, query, recordsByModel, value, levels]);

  const toggle = (key: string, id: string) => {
    const cur = selectedAt(key);
    const nextIds = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const out: Record<string, string[]> = { ...value, [key]: nextIds };
    for (const k of Object.keys(out)) if (!out[k]!.length) delete out[k];
    onChange(out);
  };

  if (levels.length === 0) {
    return <div className="text-xs text-charcoal/40 py-2 text-center">{t('common.no_results')}</div>;
  }

  return (
    <div>
      {/* Level tabs — each shows its selected count */}
      <div className="flex items-center flex-wrap gap-1 mb-2">
        {levels.map((lv, idx) => {
          const count = selectedAt(lv.key).length;
          const active = idx === step;
          return (
            <button
              key={lv.key}
              onClick={() => { setStep(idx); setQuery(''); }}
              className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                active ? 'bg-copper/10 text-copper' : 'text-charcoal/55 hover:bg-cream'
              }`}
            >
              {levelLabel(lv)}{count > 0 ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      <div className="relative mb-2">
        <Search size={12} className="absolute start-2 top-1/2 -translate-y-1/2 text-charcoal/30" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('common.search')}
          className="form-input text-xs py-1.5 ps-7 w-full"
          autoFocus
        />
      </div>

      <div className="max-h-56 overflow-y-auto space-y-0.5">
        {candidates.length === 0 ? (
          <div className="text-xs text-charcoal/40 py-2 text-center">{t('common.no_results')}</div>
        ) : (
          candidates.map(({ r, name }) => {
            const lv = levels[step]!;
            const checked = selectedAt(lv.key).includes(r.id);
            return (
              <label
                key={r.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer ${checked ? 'bg-copper/[0.06] text-charcoal' : 'hover:bg-cream text-charcoal/80'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(lv.key, r.id)}
                  className="w-3.5 h-3.5 rounded border-sand text-copper focus:ring-copper/30"
                />
                <span className="truncate flex-1">{name}</span>
              </label>
            );
          })
        )}
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
