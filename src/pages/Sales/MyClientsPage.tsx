import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import {
  resolveClientView,
  fieldBySlug,
  type ClientView,
  type ClientViewCtx,
} from '@/pages/Clients/lib/clientView';
import {
  EMPTY_FILTERS,
  clientMatchesFilters,
  filtersAreEmpty,
  type ClientFilters,
} from '@/pages/Clients/lib/clientFilters';
import ClientsFilterBar, { type FilterOption, type FilterOptionSources } from '@/pages/Clients/components/ClientsFilterBar';
import { useClientWhatsApp } from '@/pages/Clients/lib/useClientWhatsApp';
import { indexClientFollowups } from './lib/myWork';
import {
  buildRelatedCountsIndex,
  enrichClients,
  matchesSalesTab,
  computeTabCounts,
  SALES_TAB_ORDER,
  SALES_TAB_LABELS,
  type SalesClient,
  type SalesClientTab,
} from './lib/salesClients';
import MyClientCard from './components/MyClientCard';

/** Read an assignee field's user id (scalar, array, or { user_id } shapes). */
function ownerIdOf(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = ownerIdOf(x);
      if (id) return id;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const id = o.user_id ?? o.id;
    return typeof id === 'string' && id ? id : null;
  }
  return typeof v === 'string' && v ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * My Clients — the sales rep's own book of business. Reps see clients they own;
 * managers/admins see everyone and can filter by rep. Tabs slice the list by
 * sales situation (interested / serious / active / late / unqualified).
 */
export default function MyClientsPage() {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const language = useAppStore((s) => s.language);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const initialized = useAppStore((s) => s.initialized);
  const isManager = useIsAdmin();
  const isAr = language === 'ar';

  const { openWhatsApp, whatsAppModals } = useClientWhatsApp();

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const ctx: ClientViewCtx = useMemo(() => ({ models, records, users, language }), [models, records, users, language]);

  const [tab, setTab] = useState<SalesClientTab>('all');
  const [filters, setFilters] = useState<ClientFilters>(EMPTY_FILTERS);

  const now = Date.now();

  // Scope the raw client records: managers see all, reps see only their own.
  const scopedRecords = useMemo(() => {
    if (!clientsModel) return [];
    const all = records[clientsModel.id] ?? [];
    if (isManager) return all;
    return all.filter((r) => ownerIdOf((r.data as Record<string, unknown>).client_owner) === currentUserId);
  }, [clientsModel, records, isManager, currentUserId]);

  // Resolve + enrich into SalesClients (views + related counts + follow-up summary).
  const sales: SalesClient[] = useMemo(() => {
    if (!clientsModel) return [];
    const views: ClientView[] = scopedRecords.map((r) => resolveClientView(r, ctx));
    const codeById = new Map(scopedRecords.map((r) => [r.id, str((r.data as Record<string, unknown>).client_id)]));
    const relatedIndex = buildRelatedCountsIndex(models, records, clientsModel.id);
    const followupsModel = models.find((m) => m.name === 'followups');
    const followups = followupsModel ? records[followupsModel.id] ?? [] : [];
    const followupIndex = indexClientFollowups(followups, now);
    return enrichClients(views, relatedIndex, followupIndex, codeById);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsModel, scopedRecords, ctx, models, records]);

  // Apply the field filters (search / stage / status / preferences / rep / …),
  // THEN compute per-tab counts so the badges reflect the current filter context.
  const fieldFiltered = useMemo(
    () => sales.filter((sc) => clientMatchesFilters(sc.view, filters, now)),
    [sales, filters, now],
  );
  const tabCounts = useMemo(() => computeTabCounts(fieldFiltered), [fieldFiltered]);

  const visible = useMemo(() => {
    const list = fieldFiltered.filter((sc) => matchesSalesTab(sc, tab));
    // Overdue first, then by soonest scheduled follow-up, then name.
    return list.sort((a, b) => {
      if (a.followup.late !== b.followup.late) return a.followup.late ? -1 : 1;
      const an = a.followup.next?.scheduledISO ? Date.parse(a.followup.next.scheduledISO) : Infinity;
      const bn = b.followup.next?.scheduledISO ? Date.parse(b.followup.next.scheduledISO) : Infinity;
      if (an !== bn) return an - bn;
      return (a.view.name ?? '').localeCompare(b.view.name ?? '', isAr ? 'ar' : 'en');
    });
  }, [fieldFiltered, tab, isAr]);

  // Filter dropdown sources, derived from the scoped set.
  const options: FilterOptionSources = useMemo(() => {
    const toOpts = (slug: string): FilterOption[] => {
      const f = fieldBySlug(clientsModel, slug);
      return (f?.options ?? []).map((o) => ({ value: o.value, label: (isAr ? o.label_ar : o.label_en) || o.value }));
    };
    const uniq = (vals: (string | null)[]): FilterOption[] => {
      const set = new Set<string>();
      vals.forEach((v) => v && set.add(v));
      return [...set].sort((a, b) => a.localeCompare(b, isAr ? 'ar' : 'en')).map((v) => ({ value: v, label: v }));
    };
    const projMap = new Map<string, string>();
    const listMap = new Map<string, string>();
    sales.forEach((sc) => {
      sc.view.preferredProjects.forEach((p) => projMap.set(p.id, p.name ?? p.id));
      sc.view.preferredMarketListings.forEach((l) => listMap.set(l.id, l.name ?? l.id));
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
      cities: uniq(sales.map((sc) => sc.view.preferredCity)),
      districts: uniq(sales.flatMap((sc) => (sc.view.preferredDistrict ? sc.view.preferredDistrict.split('، ') : []))),
      projects: fromMap(projMap),
      listings: fromMap(listMap),
    };
  }, [clientsModel, users, sales, isAr]);

  if (!initialized) {
    return <div className="p-6 text-sm text-charcoal/50">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  }
  if (!clientsModel) {
    return <div className="p-6 text-terracotta">{isAr ? 'نموذج العملاء غير موجود' : 'Clients model not found'}</div>;
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      {whatsAppModals}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-chocolate">
          <Users size={22} className="text-copper" />
          {isAr ? 'عملائي' : 'My Clients'}
          <span className="text-sm font-semibold text-charcoal/40">({sales.length})</span>
        </h1>
        {isManager && (
          <span className="text-xs font-semibold text-charcoal/50">
            {isAr ? 'عرض المدير — كل العملاء' : 'Manager view — all clients'}
          </span>
        )}
      </div>

      {/* View tabs */}
      <div className="flex flex-wrap gap-1 border-b border-sand/40">
        {SALES_TAB_ORDER.map((t) => {
          const label = isAr ? SALES_TAB_LABELS[t].ar : SALES_TAB_LABELS[t].en;
          const n = t === 'all' ? tabCounts.all : tabCounts[t];
          const danger = t === 'late';
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-bold transition ${
                tab === t ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
              }`}
            >
              {label}
              {n > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${danger ? 'bg-terracotta text-white' : 'bg-sand/60 text-charcoal'}`}>
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ClientsFilterBar
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        onReset={() => setFilters(EMPTY_FILTERS)}
        options={options}
        isAr={isAr}
        hasActiveFilters={!filtersAreEmpty(filters)}
        hideOwner={!isManager}
      />

      <div className="flex items-center justify-between text-xs text-charcoal/50">
        <span>{isAr ? `عرض ${visible.length} من ${sales.length}` : `Showing ${visible.length} of ${sales.length}`}</span>
      </div>

      {sales.length === 0 ? (
        <div className="card p-10 text-center text-sm text-charcoal/50">
          {isAr ? 'لا يوجد عملاء مسندون إليك بعد.' : 'No clients are assigned to you yet.'}
        </div>
      ) : visible.length === 0 ? (
        <div className="card p-10 text-center text-sm text-charcoal/50">
          {isAr ? 'لا يوجد عملاء مطابقون في هذا العرض.' : 'No clients match this view.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((sc) => (
            <MyClientCard
              key={sc.view.id}
              sc={sc}
              isAr={isAr}
              now={now}
              returnTo="/sales/my-clients"
              onOpen={(id) => navigate(`/model/clients/${id}`)}
              onWhatsApp={openWhatsApp}
            />
          ))}
        </div>
      )}
    </div>
  );
}
