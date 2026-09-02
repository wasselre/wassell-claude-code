import { useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Archive, SlidersHorizontal, Users } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import RecordListPage from '@/pages/Records/RecordListPage';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  resolveClientView,
  fieldBySlug,
  isGenericMode,
  type ClientView,
  type ClientViewCtx,
} from './lib/clientView';
import {
  EMPTY_FILTERS,
  computeKpis,
  filterClients,
  compareByUrgency,
  filtersAreEmpty,
  type ClientFilters,
  type ClientListView,
} from './lib/clientFilters';
import ClientsKpiBar, { type KpiKey } from './components/ClientsKpiBar';
import ClientsFilterBar, { type FilterOption, type FilterOptionSources } from './components/ClientsFilterBar';
import ClientsTable from './components/ClientsTable';

const VIEW_TABS: { key: ClientListView; label_ar: string; label_en: string }[] = [
  { key: 'queue', label_ar: 'قائمة المبيعات', label_en: 'Sales Queue' },
  { key: 'all', label_ar: 'كل العملاء', label_en: 'All Clients' },
  { key: 'at_risk', label_ar: 'في خطر', label_en: 'At Risk' },
  { key: 'closed_lost', label_ar: 'مغلق / خاسر', label_en: 'Closed / Lost' },
];

/** Custom Clients experience — KPI cockpit + filters + sales-prioritized list. */
export default function ClientsListPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';

  // Escape hatch: ?generic=1 → the original generic table/export view.
  const generic = isGenericMode(searchParams);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);

  const translationVersion = useRecordTranslationVersion();
  const ctx: ClientViewCtx = useMemo(
    () => ({ models, records, users, language, translate: getEntityFieldText }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, records, users, language, translationVersion],
  );

  const allViews: ClientView[] = useMemo(() => {
    if (!clientsModel) return [];
    return (records[clientsModel.id] ?? []).map((r) => resolveClientView(r, ctx));
  }, [clientsModel, records, ctx]);

  // Retired clients are hidden by default (a client is retired when dormant /
  // pre-Aug-2026, and un-retires automatically the moment they message us).
  // The toggle lets an admin see them for oversight.
  const [showRetired, setShowRetired] = useState(false);
  const retiredCount = useMemo(() => allViews.filter((v) => v.isRetired).length, [allViews]);
  const views = useMemo(
    () => (showRetired ? allViews : allViews.filter((v) => !v.isRetired)),
    [allViews, showRetired],
  );

  const [view, setView] = useState<ClientListView>('queue');
  const [filters, setFilters] = useState<ClientFilters>(EMPTY_FILTERS);

  const now = Date.now();
  const kpis = useMemo(() => computeKpis(views, now), [views, now]);

  const filtered = useMemo(() => {
    const out = filterClients(views, view, filters, now);
    if (view === 'queue') out.sort((a, b) => compareByUrgency(a, b, now));
    else out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', isAr ? 'ar' : 'en'));
    return out;
  }, [views, view, filters, now, isAr]);

  const options: FilterOptionSources = useMemo(() => {
    const toOpts = (slug: string): FilterOption[] => {
      const f = fieldBySlug(clientsModel, slug);
      return (f?.options ?? []).map((o) => ({ value: o.value, label: (isAr ? o.label_ar : o.label_en) || o.value }));
    };
    const uniqStrings = (vals: (string | null)[]): FilterOption[] => {
      const set = new Set<string>();
      vals.forEach((v) => v && set.add(v));
      return [...set].sort((a, b) => a.localeCompare(b, isAr ? 'ar' : 'en')).map((v) => ({ value: v, label: v }));
    };
    // Referenced lookups only — keeps the dropdowns short and relevant.
    const projMap = new Map<string, string>();
    const listMap = new Map<string, string>();
    views.forEach((v) => {
      v.preferredProjects.forEach((p) => projMap.set(p.id, p.name ?? p.id));
      v.preferredMarketListings.forEach((l) => listMap.set(l.id, l.name ?? l.id));
    });
    const fromMap = (m: Map<string, string>): FilterOption[] =>
      [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], isAr ? 'ar' : 'en')).map(([value, label]) => ({ value, label }));

    return {
      owners: users
        .map((u) => ({ value: u.id, label: (isAr ? u.name_ar : u.name_en) || u.email }))
        .sort((a, b) => a.label.localeCompare(b.label, isAr ? 'ar' : 'en')),
      stages: toOpts('client_stage'),
      statuses: toOpts('client_status'),
      nextActions: toOpts('next_action_type'),
      lifecycles: toOpts('lifecycle_health'),
      unitTypes: toOpts('preferred_unit_type'),
      cities: uniqStrings(views.map((v) => v.preferredCity)),
      districts: uniqStrings(views.flatMap((v) => (v.preferredDistrict ? v.preferredDistrict.split('، ') : []))),
      projects: fromMap(projMap),
      listings: fromMap(listMap),
    };
  }, [clientsModel, users, views, isAr]);

  if (generic) return <RecordListPage />;
  if (!clientsModel) {
    return <div className="p-6 text-terracotta">{isAr ? 'نموذج العملاء غير موجود' : 'Clients model not found'}</div>;
  }

  const activeKpi: KpiKey | null = filters.overdueOnly
    ? 'overdue'
    : filters.noNextActionOnly
      ? 'noNextAction'
      : filters.minVisitRating !== null
        ? 'withVisitRating'
        : view === 'at_risk'
          ? 'atRisk'
          : filters.segment === 'open'
            ? 'open'
            : filters.segment === 'closed'
              ? 'closedWon'
              : filters.segment === 'lost'
                ? 'lostUnqualified'
                : view === 'all' && filtersAreEmpty(filters)
                  ? 'total'
                  : null;

  const onKpi = (key: KpiKey) => {
    const base = { ...EMPTY_FILTERS };
    switch (key) {
      case 'total':
        setFilters(base);
        setView('all');
        break;
      case 'open':
        setFilters({ ...base, segment: 'open' });
        setView('all');
        break;
      case 'overdue':
        setFilters({ ...base, overdueOnly: true });
        setView('all');
        break;
      case 'noNextAction':
        setFilters({ ...base, noNextActionOnly: true });
        setView('all');
        break;
      case 'closedWon':
        setFilters({ ...base, segment: 'closed' });
        setView('all');
        break;
      case 'lostUnqualified':
        setFilters({ ...base, segment: 'lost' });
        setView('all');
        break;
      case 'atRisk':
        setFilters(base);
        setView('at_risk');
        break;
      case 'withVisitRating':
        setFilters({ ...base, minVisitRating: 1 });
        setView('all');
        break;
    }
  };

  const returnTo = '/model/clients';

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-chocolate">
          <Users size={22} className="text-copper" />
          {isAr ? 'العملاء' : 'Clients'}
          <span className="text-sm font-semibold text-charcoal/40">({views.length})</span>
        </h1>
        <div className="flex items-center gap-3">
          {retiredCount > 0 && (
            <button
              type="button"
              onClick={() => setShowRetired((s) => !s)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                showRetired ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream'
              }`}
              title={isAr ? 'إظهار / إخفاء العملاء المتقاعدين' : 'Show / hide retired clients'}
            >
              <Archive size={15} />
              {showRetired
                ? isAr ? 'إخفاء المتقاعدين' : 'Hide retired'
                : isAr ? `إظهار المتقاعدين (${retiredCount})` : `Show retired (${retiredCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate('/model/clients?generic=1')}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-copper hover:underline"
          >
            <SlidersHorizontal size={15} /> {isAr ? 'العرض العام' : 'Generic view'}
          </button>
        </div>
      </div>

      <ClientsKpiBar kpis={kpis} isAr={isAr} activeKey={activeKpi} onSelect={onKpi} />

      {/* View tabs */}
      <div className="flex flex-wrap gap-1 border-b border-sand/40">
        {VIEW_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-bold transition ${
              view === t.key ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
            }`}
          >
            {isAr ? t.label_ar : t.label_en}
          </button>
        ))}
      </div>

      <ClientsFilterBar
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        onReset={() => setFilters(EMPTY_FILTERS)}
        options={options}
        isAr={isAr}
        hasActiveFilters={!filtersAreEmpty(filters)}
      />

      <div className="flex items-center justify-between text-xs text-charcoal/50">
        <span>
          {isAr ? `عرض ${filtered.length} من ${views.length}` : `Showing ${filtered.length} of ${views.length}`}
        </span>
      </div>

      <ClientsTable views={filtered} isAr={isAr} returnTo={returnTo} now={now} />
    </div>
  );
}
