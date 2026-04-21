import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import type { FieldOption, FieldOptionGroup } from '@/types';

interface DropdownSelectProps {
  options: FieldOption[];
  groups?: FieldOptionGroup[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function DropdownSelect({ options, groups, value, onChange, placeholder }: DropdownSelectProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  // Groups are collapsed by default — the user clicks a section header to open it.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  // Partition options by group. Options whose group_id matches a known group
  // go under that group; everything else renders as ungrouped at the top.
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
    // Hide groups that ended up empty so users don't see dead headers.
    const entries = validGroups
      .map((g) => ({ group: g, opts: byGroup.get(g.id) ?? [] }))
      .filter((e) => e.opts.length > 0);
    return { ungrouped: ung, groupedEntries: entries };
  }, [options, groups]);

  const hasGroups = groupedEntries.length > 0;

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

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
        className="form-input flex items-center justify-between gap-2 text-start"
      >
        {selected ? (
          <Badge label={isAr ? selected.label_ar : selected.label_en} color={selected.color} />
        ) : (
          <span className="text-charcoal/30">{placeholder ?? '—'}</span>
        )}
        <ChevronDown size={16} className={`text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg max-h-64 overflow-y-auto animate-[fadeIn_0.1s_ease]">
          {ungrouped.map((opt) => renderOption(opt))}
          {hasGroups && groupedEntries.map(({ group, opts }) => {
            const expanded = expandedGroups.has(group.id);
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
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-charcoal/30 text-center">—</div>
          )}
        </div>
      )}
    </div>
  );
}
