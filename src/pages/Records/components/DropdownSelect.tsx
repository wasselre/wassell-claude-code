import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import type { FieldOption, FieldOptionGroup } from '@/types';

interface DropdownSelectProps {
  options: FieldOption[];
  groups?: FieldOptionGroup[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
  /**
   * When provided, the menu shows a "Create: '<query>'" row whenever the user
   * types a query that doesn't match any existing option. The callback is
   * responsible for persisting the new option (e.g. appending to the model
   * schema) and must return the new option's `value` so this component can
   * select it. When set, the search input is always shown regardless of option
   * count so the user can always type to create.
   */
  onCreateOption?: (label: string) => string;
}

export default function DropdownSelect({ options, groups, value, onChange, placeholder, compact, onCreateOption }: DropdownSelectProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Groups are collapsed by default — the user clicks a section header to open it.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  // Only expose a search box when there are enough options to make it useful —
  // matches the threshold used in the Advanced Filter panel. When inline-create
  // is enabled we always show the search so the user can type a new value.
  const showSearch = options.length > 6 || !!onCreateOption;

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

  // Partition filtered options by group. Options whose group_id matches a known
  // group go under that group; everything else renders as ungrouped at the top.
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
    // Hide groups that ended up empty so users don't see dead headers.
    const entries = validGroups
      .map((g) => ({ group: g, opts: byGroup.get(g.id) ?? [] }))
      .filter((e) => e.opts.length > 0);
    return { ungrouped: ung, groupedEntries: entries };
  }, [filteredOptions, groups]);

  const hasGroups = groupedEntries.length > 0;

  // While the user is searching, force every surviving group open so the matches
  // are actually visible — otherwise a match inside a collapsed group is silently
  // hidden and the dropdown looks empty.
  const isGroupExpanded = (id: string) => !!query.trim() || expandedGroups.has(id);

  // Auto-expand the group that contains the currently selected option so the
  // user sees it highlighted when they reopen the dropdown.
  useEffect(() => {
    if (!selected?.group_id) return;
    setExpandedGroups((prev) => {
      if (prev.has(selected.group_id!)) return prev;
      const next = new Set(prev);
      next.add(selected.group_id!);
      return next;
    });
  }, [selected?.group_id]);

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
  // persists the option and returns its new `value` slug for selection.
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
    onChange(newValue);
    setOpen(false);
  };

  const renderOption = (opt: FieldOption, indent = false) => (
    <button
      key={opt.id}
      type="button"
      onClick={() => {
        onChange(opt.value);
        setOpen(false);
      }}
      className={`w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-cream transition-colors text-sm ${
        opt.value === value ? 'bg-copper/5' : ''
      } ${indent ? 'ps-6' : ''}`}
    >
      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: opt.color ?? '#6B7280' }} />
      <span className="truncate">{isAr ? opt.label_ar : opt.label_en}</span>
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`form-input flex items-center justify-between gap-2 text-start ${compact ? 'text-sm py-1 px-2' : ''}`}
      >
        {selected ? (
          <Badge label={isAr ? selected.label_ar : selected.label_en} color={selected.color} />
        ) : (
          <span className="text-charcoal/30">{placeholder ?? '—'}</span>
        )}
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
                    <span className="text-[10px] text-charcoal/30 font-normal">{opts.length}</span>
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
