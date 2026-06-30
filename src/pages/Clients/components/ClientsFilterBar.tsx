import { Search, X } from 'lucide-react';
import type { ClientFilters, LifecycleSegment } from '../lib/clientFilters';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterOptionSources {
  owners: FilterOption[];
  stages: FilterOption[];
  statuses: FilterOption[];
  nextActions: FilterOption[];
  lifecycles: FilterOption[];
  unitTypes: FilterOption[];
  cities: FilterOption[];
  districts: FilterOption[];
  projects: FilterOption[];
  listings: FilterOption[];
}

interface ClientsFilterBarProps {
  filters: ClientFilters;
  onChange: (patch: Partial<ClientFilters>) => void;
  onReset: () => void;
  options: FilterOptionSources;
  isAr: boolean;
  hasActiveFilters: boolean;
  /** Hide the Owner / Sales-rep dropdown (e.g. a rep's self-scoped list). */
  hideOwner?: boolean;
}

function Select({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder: string;
  options: FilterOption[];
}) {
  return (
    <select
      className="form-input !py-1.5 text-sm"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The Clients list filter row. Selects are populated from the live schema. */
export default function ClientsFilterBar({ filters, onChange, onReset, options, isAr, hasActiveFilters, hideOwner }: ClientsFilterBarProps) {
  const segments: { value: LifecycleSegment; label: string }[] = [
    { value: 'all', label: isAr ? 'الكل' : 'All' },
    { value: 'open', label: isAr ? 'مفتوح' : 'Open' },
    { value: 'lost', label: isAr ? 'خاسر' : 'Lost' },
    { value: 'closed', label: isAr ? 'مغلق' : 'Closed' },
  ];

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-charcoal/40 start-3" />
          <input
            type="text"
            className="form-input !py-1.5 ps-9 text-sm"
            placeholder={isAr ? 'بحث بالاسم أو رقم الجوال…' : 'Search name or phone…'}
            value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </div>

        {/* Lifecycle segment toggle */}
        <div className="inline-flex overflow-hidden rounded-lg border border-sand/40">
          {segments.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange({ segment: s.value })}
              className={`px-3 py-1.5 text-sm font-semibold transition ${
                filters.segment === s.value ? 'bg-copper text-white' : 'bg-white text-charcoal/70 hover:bg-cream'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-terracotta hover:bg-terracotta/10"
          >
            <X size={14} /> {isAr ? 'مسح' : 'Clear'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {!hideOwner && (
          <Select value={filters.ownerId} onChange={(v) => onChange({ ownerId: v })} placeholder={isAr ? 'مستشار المبيعات' : 'Sales Consultant'} options={options.owners} />
        )}
        <Select value={filters.lifecycleHealth} onChange={(v) => onChange({ lifecycleHealth: v })} placeholder={isAr ? 'صحة الدورة' : 'Health'} options={options.lifecycles} />
        <Select value={filters.stage} onChange={(v) => onChange({ stage: v })} placeholder={isAr ? 'المرحلة' : 'Stage'} options={options.stages} />
        <Select value={filters.status} onChange={(v) => onChange({ status: v })} placeholder={isAr ? 'الحالة' : 'Status'} options={options.statuses} />
        <Select value={filters.nextActionType} onChange={(v) => onChange({ nextActionType: v })} placeholder={isAr ? 'الإجراء التالي' : 'Next action'} options={options.nextActions} />
        <Select value={filters.preferredUnitType} onChange={(v) => onChange({ preferredUnitType: v })} placeholder={isAr ? 'نوع الوحدة' : 'Unit type'} options={options.unitTypes} />
        {options.cities.length > 0 && (
          <Select value={filters.city} onChange={(v) => onChange({ city: v })} placeholder={isAr ? 'المدينة' : 'City'} options={options.cities} />
        )}
        {options.districts.length > 0 && (
          <Select value={filters.district} onChange={(v) => onChange({ district: v })} placeholder={isAr ? 'الحي' : 'District'} options={options.districts} />
        )}
        <Select value={filters.preferredProjectId} onChange={(v) => onChange({ preferredProjectId: v })} placeholder={isAr ? 'مشروع مفضل' : 'Preferred project'} options={options.projects} />
        <Select value={filters.preferredMarketListingId} onChange={(v) => onChange({ preferredMarketListingId: v })} placeholder={isAr ? 'إعلان سوق مفضل' : 'Preferred listing'} options={options.listings} />
        <Select
          value={filters.minVisitRating !== null ? String(filters.minVisitRating) : null}
          onChange={(v) => onChange({ minVisitRating: v ? Number(v) : null })}
          placeholder={isAr ? 'تقييم الزيارة' : 'Visit rating'}
          options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: isAr ? `${n}+ نجوم` : `${n}+ stars` }))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="inline-flex items-center gap-2 font-semibold text-charcoal/70">
          <input type="checkbox" checked={filters.overdueOnly} onChange={(e) => onChange({ overdueOnly: e.target.checked })} className="accent-[#B5462F]" />
          {isAr ? 'المتأخرون فقط' : 'Overdue only'}
        </label>
        <label className="inline-flex items-center gap-2 font-semibold text-charcoal/70">
          <input type="checkbox" checked={filters.noNextActionOnly} onChange={(e) => onChange({ noNextActionOnly: e.target.checked })} className="accent-[#C09B5F]" />
          {isAr ? 'بلا إجراء تالٍ فقط' : 'No next action only'}
        </label>
      </div>
    </div>
  );
}
