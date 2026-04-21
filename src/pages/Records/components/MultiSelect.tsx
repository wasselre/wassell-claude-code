import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { FieldOption, FieldOptionGroup } from '@/types';

interface MultiSelectProps {
  options: FieldOption[];
  groups?: FieldOptionGroup[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

export default function MultiSelect({ options, groups, value, onChange, placeholder }: MultiSelectProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

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

  const selectedOptions = value.map((v) => options.find((o) => o.value === v)).filter(Boolean);

  // Partition by group (same logic as DropdownSelect). Groups with no options
  // are hidden so dead headers don't clutter the menu.
  const { ungrouped, groupedEntries } = useMemo(() => {
    const validGroups = groups ?? [];
    const validIds = new Set(validGroups.map((g) => g.id));
    const ung: FieldOption[] = [];
    const byGroup = new Map<string, FieldOption[]>();
    for (const g of validGroups) byGroup.set(g.id, []);
    for (const o of options) {
      if (o.group_id && validIds.has(o.group_id)) byGroup.get(o.group_id)!.push(o);
      else ung.push(o);
    }
    const entries = validGroups
      .map((g) => ({ group: g, opts: byGroup.get(g.id) ?? [] }))
      .filter((e) => e.opts.length > 0);
    return { ungrouped: ung, groupedEntries: entries };
  }, [options, groups]);

  const hasGroups = groupedEntries.length > 0;

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
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedOptions.map((opt) => {
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
        className="form-input flex items-center justify-between gap-2 text-start"
      >
        <span className="text-charcoal/30 text-sm">
          {selectedOptions.length === 0 ? (placeholder ?? '—') : `${selectedOptions.length} selected`}
        </span>
        <ChevronDown size={16} className={`text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg max-h-64 overflow-y-auto animate-[fadeIn_0.1s_ease]">
          {ungrouped.map((opt) => renderOption(opt))}
          {hasGroups && groupedEntries.map(({ group, opts }) => {
            const expanded = expandedGroups.has(group.id);
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
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-charcoal/30 text-center">—</div>
          )}
        </div>
      )}
    </div>
  );
}
