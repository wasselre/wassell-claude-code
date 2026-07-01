import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, ChevronRight, Plus, Search, X } from 'lucide-react';
import type { FieldOption, FieldOptionGroup } from '@/types';

interface MultiSelectProps {
  options: FieldOption[];
  groups?: FieldOptionGroup[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  compact?: boolean;
  /**
   * When provided, the menu shows a "Create: '<query>'" row whenever the user
   * types a query that doesn't match any existing option. The callback is
   * responsible for persisting the new option (e.g. appending to the model
   * schema) and must return the new option's `value` so this component can add
   * it to the current selection. When set, the search input is always shown
   * regardless of option count so the user can always type to create.
   */
  onCreateOption?: (label: string) => string;
}

export default function MultiSelect({ options, groups, value, onChange, placeholder, compact, onCreateOption }: MultiSelectProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Only expose a search box when there are enough options to make it useful —
  // matches the threshold used in the Advanced Filter panel. When inline-create
  // is enabled we always show the search so the user can type a new value.
  const showSearch = options.length > 6 || !!onCreateOption;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Reset the query whenever the menu closes so the next open starts fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Auto-focus the search input when the menu opens so the user can type immediately.
  useEffect(() => {
    if (open && showSearch) searchInputRef.current?.focus();
  }, [open, showSearch]);

  const toggleValue = (v: string) => {
    if (value.includes(v)) {
      onChange(value.filter((x) => x !== v));
    } else {
      onChange([...value, v]);
    }
  };

  const removeValue = (v: string) => {
    onChange(value.filter((x) => x !== v));
  };

  // Map each selected value to its option definition. Values with NO matching
  // option (e.g. imported multiselect data whose option catalog was never
  // populated — market_listings `features` has 603 distinct scraped values and
  // an empty `options` array) still render as a plain chip using the raw value
  // as its label. Never silently drop a stored value: showing the raw text is
  // always more correct than hiding data the user has.
  const selectedItems: FieldOption[] = value.map(
    (v) => options.find((o) => o.value === v) ?? { id: v, value: v, label_ar: v, label_en: v },
  );

  // Case-insensitive match against both labels so the user can type in either language.
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label_ar.toLowerCase().includes(q) ||
        o.label_en.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Partition filtered options by group (same logic as DropdownSelect). Groups
  // with no options are hidden so dead headers don't clutter the menu.
  const { ungrouped, groupedEntries } = useMemo(() => {
    const validGroups = groups ?? [];
    const validIds = new Set(validGroups.map((g) => g.id));
    const ung: FieldOption[] = [];
    const byGroup = new Map<string, FieldOption[]>();
    for (const g of validGroups) byGroup.set(g.id, []);
    for (const o of filteredOptions) {
      if (o.group_id && validIds.has(o.group_id)) byGroup.get(o.group_id)!.push(o);
      else ung.push(o);
    }
    const entries = validGroups
      .map((g) => ({ group: g, opts: byGroup.get(g.id) ?? [] }))
      .filter((e) => e.opts.length > 0);
    return { ungrouped: ung, groupedEntries: entries };
  }, [filteredOptions, groups]);

  const hasGroups = groupedEntries.length > 0;

  // While searching, force every surviving group open so matches are visible —
  // otherwise a match inside a collapsed group is silently hidden.
  const isGroupExpanded = (id: string) => !!query.trim() || expandedGroups.has(id);

  // On open, auto-expand any group that contains a currently-selected value so
  // the user can see their picks at a glance.
  useEffect(() => {
    if (!open || !hasGroups) return;
    const selectedGroupIds = new Set<string>();
    for (const v of value) {
      const opt = options.find((o) => o.value === v);
      if (opt?.group_id) selectedGroupIds.add(opt.group_id);
    }
    if (selectedGroupIds.size === 0) return;
    setExpandedGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of selectedGroupIds) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [open, hasGroups, value, options]);

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Inline-create: if the user typed a value that doesn't exactly match any
  // existing option label (ar or en, case-insensitive), offer a copper "Create"
  // row at the bottom of the menu. Clicking it delegates to the parent which
  // persists the option and returns its new `value` slug, which we append to
  // the current selection. The menu stays open — matching the existing pick
  // behavior — so the user can keep adding more.
  const trimmedQuery = query.trim();
  const canCreate =
    !!onCreateOption &&
    trimmedQuery.length > 0 &&
    !options.some(
      (o) =>
        o.label_ar.toLowerCase() === trimmedQuery.toLowerCase() ||
        o.label_en.toLowerCase() === trimmedQuery.toLowerCase(),
    );

  const handleCreate = () => {
    if (!canCreate || !onCreateOption) return;
    const newValue = onCreateOption(trimmedQuery);
    onChange([...value, newValue]);
    setQuery('');
    searchInputRef.current?.focus();
  };

  const renderOption = (opt: FieldOption, indent = false) => {
    const checked = value.includes(opt.value);
    return (
      <button
        key={opt.id}
        type="button"
        onClick={() => toggleValue(opt.value)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-cream transition-colors text-sm ${
          checked ? 'bg-copper/5' : ''
        } ${indent ? 'ps-6' : ''}`}
      >
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="w-3.5 h-3.5 rounded border-sand text-copper focus:ring-0 pointer-events-none"
        />
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.color ?? '#6B7280' }} />
        <span className="truncate">{isAr ? opt.label_ar : opt.label_en}</span>
      </button>
    );
  };

  return (
    <div ref={ref} className="relative">
      {/* Selected pills */}
      {selectedItems.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedItems.map((opt) => {
            if (!opt) return null;
            return (
              <span
                key={opt.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
                style={{ backgroundColor: `${opt.color ?? '#6B7280'}20`, color: opt.color ?? '#6B7280' }}
              >
                {isAr ? opt.label_ar : opt.label_en}
                <button type="button" onClick={() => removeValue(opt.value)} className="hover:opacity-70">
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`form-input flex items-center justify-between gap-2 text-start ${compact ? 'text-sm py-1 px-2' : ''}`}
      >
        <span className="text-charcoal/30 text-sm">
          {selectedItems.length === 0 ? (placeholder ?? '—') : `${selectedItems.length} selected`}
        </span>
        <ChevronDown size={16} className={`text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg animate-[fadeIn_0.1s_ease] overflow-hidden">
          {showSearch && (
            <div className="border-b border-sand/20 p-2">
              <div className="relative">
                <Search size={12} className="absolute start-2 top-1/2 -translate-y-1/2 text-charcoal/30" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('common.search')}
                  className="form-input text-xs py-1.5 ps-7 w-full"
                />
              </div>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {ungrouped.map((opt) => renderOption(opt))}
            {hasGroups && groupedEntries.map(({ group, opts }) => {
              const expanded = isGroupExpanded(group.id);
              const selectedInGroup = opts.filter((o) => value.includes(o.value)).length;
              return (
                <div key={group.id} className="border-t border-sand/20 first:border-t-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="w-full flex items-center gap-1.5 px-3 py-2 text-start hover:bg-sand/10 transition-colors text-[12px] font-bold text-charcoal/60"
                  >
                    {expanded
                      ? <ChevronDown size={12} className="text-charcoal/40" />
                      : <ChevronRight size={12} className="text-charcoal/40 rtl:rotate-180" />}
                    <span className="flex-1 truncate">{isAr ? group.label_ar : group.label_en}</span>
                    <span className="text-[10px] text-charcoal/30 font-normal">
                      {selectedInGroup > 0 ? `${selectedInGroup}/${opts.length}` : opts.length}
                    </span>
                  </button>
                  {expanded && opts.map((opt) => renderOption(opt, true))}
                </div>
              );
            })}
            {options.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-xs text-charcoal/30 text-center">—</div>
            )}
            {options.length > 0 && filteredOptions.length === 0 && !canCreate && (
              <div className="px-3 py-3 text-xs text-charcoal/30 text-center">
                {t('common.no_results')}
              </div>
            )}
            {canCreate && (
              <button
                type="button"
                onClick={handleCreate}
                className={`w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm flex items-center gap-2 text-copper font-bold ${ungrouped.length > 0 || hasGroups ? 'border-t border-sand/50' : ''}`}
              >
                <Plus size={14} />
                {isAr ? `إنشاء: "${trimmedQuery}"` : `Create: "${trimmedQuery}"`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
