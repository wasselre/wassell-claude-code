import { useAppStore } from '@/stores/appStore';
import { Filter, X } from 'lucide-react';
import { DATE_PRESETS, refField, hasActiveFilters, type GlobalFilterState, type GlobalFilterValue } from '../lib/globalFilters';
import type { AppModel, DashboardFilter } from '@/types';
import type { DateFilterMode } from '@/lib/analytics/types';

interface Props {
  filters: DashboardFilter[] | undefined;
  state: GlobalFilterState;
  onChange: (next: GlobalFilterState) => void;
  models: AppModel[];
}

/**
 * The dashboard-level filter bar (used on the editor + public view). Renders one
 * control per dashboard filter; changes flow up via onChange. Each widget then
 * composes these into its query per its filter_behavior (see globalFilters.ts).
 */
export default function DashboardFilterBar({ filters, state, onChange, models }: Props) {
  const language = useAppStore((s) => s.language);
  const users = useAppStore((s) => s.users);
  const isAr = language === 'ar';

  if (!filters || filters.length === 0) return null;

  const setVal = (id: string, val: GlobalFilterValue | undefined) => onChange({ ...state, [id]: val });

  const selectOptions = (f: DashboardFilter): { value: string; label: string }[] => {
    const fld = refField(f, models);
    if (!fld) return [];
    if (fld.type === 'dropdown' || fld.type === 'multiselect' || fld.type === 'section_selector') {
      return (fld.options ?? []).map((o) => ({ value: o.value, label: isAr ? o.label_ar : o.label_en }));
    }
    if (fld.type === 'assignee') {
      return (users ?? []).map((u) => ({ value: u.id, label: (isAr ? u.name_ar : u.name_en) || u.name_en || u.name_ar || u.id }));
    }
    return [];
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-sand/60 bg-white/50 px-3 py-2">
      <Filter size={14} className="text-charcoal/40" />
      {filters.map((f) => {
        const label = isAr ? f.label_ar : f.label_en;
        const val = state[f.id];
        if (f.control === 'date_range') {
          const mode = val?.kind === 'date' ? val.mode : '';
          return (
            <label key={f.id} className="flex items-center gap-1.5 text-xs">
              <span className="font-bold text-charcoal/70">{label}</span>
              <select
                value={mode}
                onChange={(e) => setVal(f.id, e.target.value ? { kind: 'date', mode: e.target.value as DateFilterMode } : undefined)}
                className="form-input bg-white py-1 text-xs"
              >
                <option value="">{isAr ? 'كل الوقت' : 'All time'}</option>
                {DATE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{isAr ? p.ar : p.en}</option>
                ))}
              </select>
            </label>
          );
        }
        if (f.control === 'search') {
          const text = val?.kind === 'search' ? val.text : '';
          return (
            <label key={f.id} className="flex items-center gap-1.5 text-xs">
              <span className="font-bold text-charcoal/70">{label}</span>
              <input
                value={text}
                onChange={(e) => setVal(f.id, e.target.value ? { kind: 'search', text: e.target.value } : undefined)}
                placeholder="…"
                className="form-input bg-white py-1 text-xs"
              />
            </label>
          );
        }
        // select → toggle chips
        const selected = val?.kind === 'select' ? val.values : [];
        const opts = selectOptions(f);
        const toggle = (v: string) => {
          const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
          setVal(f.id, next.length ? { kind: 'select', values: next } : undefined);
        };
        return (
          <div key={f.id} className="flex items-center gap-1.5 text-xs">
            <span className="font-bold text-charcoal/70">{label}</span>
            <div className="flex flex-wrap gap-1">
              {opts.length === 0 && <span className="text-charcoal/30">—</span>}
              {opts.map((o) => (
                <button
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  className={`rounded-full border px-2 py-0.5 ${selected.includes(o.value) ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal/70 hover:border-copper/50'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {hasActiveFilters(state) && (
        <button onClick={() => onChange({})} className="ms-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-charcoal/50 hover:text-red-500">
          <X size={12} /> {isAr ? 'مسح الكل' : 'Clear all'}
        </button>
      )}
    </div>
  );
}
