import { forwardRef, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Filter, Plus, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import FieldFilterPopover from './FieldFilterPopover';
import {
  getAdhocFilterableFields,
  isAdhocActive,
  summarizeAdhoc,
  type AdhocFieldFilter,
  type AdhocFilterState,
} from '@/lib/adhocFilterUtils';
import type { AppModel, ModelField } from '@/types';

interface AdvancedFilterPanelProps {
  model: AppModel;
  state: AdhocFilterState;
  onChange: (next: AdhocFilterState) => void;
  /** localStorage key used to persist collapsed/expanded between visits. */
  collapseKey: string;
  /** Initial collapsed state when no localStorage entry exists yet. Defaults
   * to true (collapsed) so every module opens with the filter tucked away;
   * the user's per-model expand/collapse choice is still remembered after
   * the first toggle. */
  defaultCollapsed?: boolean;
}

/**
 * Collapsible panel above the toolbar with one chip per filterable field.
 * Click a chip to open a type-aware popover (select, date range, number range, text).
 * Active chips show a summary + clear (X) button.
 */
export default function AdvancedFilterPanel({
  model,
  state,
  onChange,
  collapseKey,
  defaultCollapsed = true,
}: AdvancedFilterPanelProps) {
  const { t } = useTranslation();
  const { language, records, users, models } = useAppStore();
  const isAr = language === 'ar';

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(collapseKey);
      if (stored === '1') return true;
      if (stored === '0') return false;
      return defaultCollapsed;
    } catch {
      return defaultCollapsed;
    }
  });
  const [openFieldId, setOpenFieldId] = useState<string | null>(null);
  const anchorsRef = useRef<Record<string, HTMLButtonElement | null>>({});

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(collapseKey, next ? '1' : '0'); } catch { /* ignore */ }
  };

  // All filterable entries (skip field types with no useful filter input).
  // Mirrored values — scalar `mirror` fields, mirrored sections, and
  // section_mirror fields — are surfaced alongside the model's own fields so
  // users can filter by them too. See getAdhocFilterableFields.
  const filterableFields = useMemo(
    () => getAdhocFilterableFields(model, models),
    [model, models],
  );

  const activeCount = useMemo(
    () => Object.values(state).filter(isAdhocActive).length,
    [state],
  );

  const updateFilter = (fieldId: string, next: AdhocFieldFilter | undefined) => {
    const n = { ...state };
    if (!next || !isAdhocActive(next)) delete n[fieldId];
    else n[fieldId] = next;
    onChange(n);
  };

  const clearAll = () => onChange({});

  const openField = filterableFields.find((e) => e.field.id === openFieldId)?.field ?? null;

  return (
    <div className="mb-4 rounded-xl border border-sand/40 bg-white/50">
      {/* Header (clickable to collapse/expand) */}
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center justify-between px-4 py-2.5 text-charcoal hover:bg-cream/30 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-2">
          <Filter size={15} className="text-copper" />
          <span className="text-sm font-bold">{t('adhoc.title')}</span>
          {activeCount > 0 && (
            <span className="text-[11px] bg-copper text-white px-1.5 py-0.5 rounded-full font-bold min-w-5 text-center">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && !collapsed && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); clearAll(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); clearAll(); }
              }}
              className="text-[11px] text-charcoal/50 hover:text-copper font-bold px-2 py-1 rounded hover:bg-cream cursor-pointer"
            >
              {t('adhoc.clear_all')}
            </span>
          )}
          {collapsed ? <ChevronDown size={16} className="text-charcoal/40" /> : <ChevronUp size={16} className="text-charcoal/40" />}
        </div>
      </button>

      {/* Body — grid of chips */}
      {!collapsed && (
        <div className="px-4 pb-4 pt-1">
          {filterableFields.length === 0 ? (
            <p className="text-xs text-charcoal/40 py-2 text-center">{t('adhoc.no_filterable_fields')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {filterableFields.map(({ field }) => (
                <FieldChip
                  key={field.id}
                  ref={(el) => { anchorsRef.current[field.id] = el; }}
                  field={field}
                  isAr={isAr}
                  filter={state[field.id]}
                  recordsByModel={records}
                  users={users}
                  onClick={() => setOpenFieldId(openFieldId === field.id ? null : field.id)}
                  onClear={() => updateFilter(field.id, undefined)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {openField && (
        <FieldFilterPopover
          anchorEl={anchorsRef.current[openField.id] ?? null}
          field={openField}
          value={state[openField.id]}
          onChange={(next) => updateFilter(openField.id, next)}
          onClose={() => setOpenFieldId(null)}
        />
      )}
    </div>
  );
}

interface FieldChipProps {
  field: ModelField;
  isAr: boolean;
  filter: AdhocFieldFilter | undefined;
  recordsByModel: Record<string, import('@/types').AppRecord[]>;
  users: import('@/types').User[];
  onClick: () => void;
  onClear: () => void;
}

const FieldChip = forwardRef<HTMLButtonElement, FieldChipProps>(function FieldChip(
  { field, isAr, filter, recordsByModel, users, onClick, onClear },
  ref,
) {
    const label = isAr ? field.label_ar : field.label_en;
    const active = isAdhocActive(filter);
    const summary = active && filter
      ? summarizeAdhoc(
          filter,
          field,
          isAr,
          field.lookup_model_id
            ? { records: recordsByModel[field.lookup_model_id] ?? [], displayField: field.lookup_display_field ?? null }
            : undefined,
          users,
        )
      : '';

    return (
      <div className="relative">
        <button
          ref={ref}
          onClick={onClick}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm transition-colors text-start ${
            active
              ? 'border-copper/40 bg-copper/[0.06] text-charcoal'
              : 'border-dashed border-sand/50 bg-transparent text-charcoal/50 hover:border-copper/30 hover:text-charcoal'
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {!active && <Plus size={12} className="text-copper/70 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className={`text-[11px] ${active ? 'text-charcoal/50 font-normal' : 'text-charcoal/40'} truncate`}>
                {label}
              </div>
              {active && <div className="text-sm font-bold text-copper truncate">{summary || label}</div>}
            </div>
          </div>
          {active && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClear(); }
              }}
              className="p-0.5 rounded-full hover:bg-copper/10 text-copper shrink-0 cursor-pointer"
              aria-label="clear"
            >
              <X size={12} />
            </span>
          )}
        </button>
      </div>
    );
  });
