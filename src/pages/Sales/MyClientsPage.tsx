import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Users, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import type { AppModel } from '@/types';
import {
  resolveClientView,
  fieldBySlug,
  type ClientView,
  type ClientViewCtx,
} from '@/pages/Clients/lib/clientView';
import { useClientWhatsApp } from '@/pages/Clients/lib/useClientWhatsApp';
import { isRetiredClient } from '@/lib/clients/retirement';
import { indexClientFollowups } from './lib/myWork';
import { buildRelatedCountsIndex, enrichClients, type SalesClient } from './lib/salesClients';
import {
  buildLastInteractionIndex,
  inInteractionWindow,
  type InteractionWindow,
  type LastInteraction,
} from './lib/lastInteraction';
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

interface FilterOption {
  value: string;
  label: string;
}

function fieldOptions(model: AppModel | null, slug: string, isAr: boolean): FilterOption[] {
  const f = fieldBySlug(model, slug);
  return (f?.options ?? []).map((o) => ({ value: o.value, label: (isAr ? o.label_ar : o.label_en) || o.value }));
}

const NO_REP = '__none__';

const WINDOWS: { key: InteractionWindow; ar: string; en: string }[] = [
  { key: 'all', ar: 'الكل', en: 'All' },
  { key: 'today', ar: 'اليوم', en: 'Today' },
  { key: 'yesterday', ar: 'أمس', en: 'Yesterday' },
  { key: 'week', ar: 'آخر ٧ أيام', en: 'Last 7 days' },
  { key: 'none', ar: 'لم نتواصل بعد', en: 'Never contacted' },
];

/**
 * Clients — one plain list of every client (operator, 2026-10-05: the segment
 * tabs and the long filter bar were not used). Filters: stage, status, sales
 * rep, and «last contact» (today / yesterday / 7 days / never) — the newest
 * moment we were in touch on any channel (a completed follow-up, a WhatsApp
 * message, a phone call). Sorted by last contact, newest first. Reps see their
 * own clients; managers see everyone and can pick a rep.
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
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const { openWhatsApp, whatsAppModals } = useClientWhatsApp();

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const ctx: ClientViewCtx = useMemo(() => ({ models, records, users, language }), [models, records, users, language]);

  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [status, setStatus] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [win, setWin] = useState<InteractionWindow>('all');

  const now = Date.now();

  // Retired clients are left out — they come back only if they message us
  // again. Reps only ever see their own book.
  const scopedRecords = useMemo(() => {
    if (!clientsModel) return [];
    const all = (records[clientsModel.id] ?? []).filter((r) => !isRetiredClient(r));
    if (isManager) return all;
    return all.filter((r) => ownerIdOf((r.data as Record<string, unknown>).client_owner) === currentUserId);
  }, [clientsModel, records, isManager, currentUserId]);

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

  const lastByClient: Map<string, LastInteraction> = useMemo(
    () => (clientsModel ? buildLastInteractionIndex(models, records, clientsModel.id) : new Map()),
    [clientsModel, models, records],
  );

  const ownerById = useMemo(
    () => new Map(scopedRecords.map((r) => [r.id, ownerIdOf((r.data as Record<string, unknown>).client_owner)])),
    [scopedRecords],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = sales.filter((sc) => {
      const v = sc.view;
      if (stage && v.stage !== stage) return false;
      if (status && v.status !== status) return false;
      if (ownerId === NO_REP && ownerById.get(v.id)) return false;
      if (ownerId && ownerId !== NO_REP && ownerById.get(v.id) !== ownerId) return false;
      if (!inInteractionWindow(lastByClient.get(v.id), win, now)) return false;
      if (q) {
        const hay = [v.name, v.phone, sc.code].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Newest contact first; never-contacted at the bottom, by name.
    const at = (sc: SalesClient) => {
      const li = lastByClient.get(sc.view.id);
      return li ? Date.parse(li.at) : null;
    };
    return list.sort((a, b) => {
      const ta = at(a);
      const tb = at(b);
      if (ta !== tb) {
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      }
      return (a.view.name ?? '').localeCompare(b.view.name ?? '', isAr ? 'ar' : 'en');
    });
    // `now` is read fresh each render; re-sorting on every tick is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, search, stage, status, ownerId, win, lastByClient, ownerById, isAr]);

  const stageOptions = useMemo(() => fieldOptions(clientsModel, 'client_stage', isAr), [clientsModel, isAr]);
  const statusOptions = useMemo(() => fieldOptions(clientsModel, 'client_status', isAr), [clientsModel, isAr]);
  const ownerOptions: FilterOption[] = useMemo(() => {
    const owners = new Set([...ownerById.values()].filter((x): x is string => Boolean(x)));
    return users
      .filter((u) => owners.has(u.id))
      .map((u) => ({ value: u.id, label: (isAr ? u.name_ar : u.name_en) || u.email }))
      .sort((a, b) => a.label.localeCompare(b.label, isAr ? 'ar' : 'en'));
  }, [users, ownerById, isAr]);

  const hasFilters = Boolean(search || stage || status || ownerId || win !== 'all');
  const reset = () => {
    setSearch('');
    setStage('');
    setStatus('');
    setOwnerId('');
    setWin('all');
  };

  if (!initialized) {
    return <div className="p-6 text-sm text-charcoal/50">{L('جارٍ التحميل…', 'Loading…')}</div>;
  }
  if (!clientsModel) {
    return <div className="p-6 text-terracotta">{L('نموذج العملاء غير موجود', 'Clients model not found')}</div>;
  }

  const select = 'input h-9 min-w-[9rem] py-0 text-sm';

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      {whatsAppModals}
      <h1 className="flex items-center gap-2 text-xl font-extrabold text-chocolate">
        <Users size={22} className="text-copper" />
        {isManager ? L('العملاء', 'Clients') : L('عملائي', 'My Clients')}
        <span className="text-sm font-semibold text-charcoal/40">({sales.length})</span>
      </h1>

      {/* Last contact */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-charcoal/55">{L('آخر تفاعل:', 'Last contact:')}</span>
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => setWin(w.key)}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition ${
              win === w.key ? 'border-copper bg-copper text-white' : 'border-sand bg-white text-charcoal/65 hover:border-copper/60'
            }`}
          >
            {isAr ? w.ar : w.en}
          </button>
        ))}
      </div>

      {/* Search + stage / status / rep */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={15} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-charcoal/35" />
          <input
            className="input h-9 w-full py-0 ps-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={L('ابحث بالاسم أو الجوال أو الرقم', 'Search by name, phone or number')}
          />
        </div>
        <select className={select} value={stage} onChange={(e) => setStage(e.target.value)} aria-label={L('المرحلة', 'Stage')}>
          <option value="">{L('كل المراحل', 'All stages')}</option>
          {stageOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select className={select} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={L('الحالة', 'Status')}>
          <option value="">{L('كل الحالات', 'All statuses')}</option>
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {isManager && (
          <select className={select} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label={L('مسؤول المبيعات', 'Sales rep')}>
            <option value="">{L('كل مسؤولي المبيعات', 'All sales reps')}</option>
            {ownerOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            <option value={NO_REP}>{L('بدون مسؤول', 'No rep')}</option>
          </select>
        )}
        {hasFilters && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-charcoal/60 hover:text-terracotta"
          >
            <X size={13} /> {L('مسح', 'Clear')}
          </button>
        )}
      </div>

      <div className="text-xs text-charcoal/50">
        {isAr ? `عرض ${visible.length} من ${sales.length}` : `Showing ${visible.length} of ${sales.length}`}
      </div>

      {sales.length === 0 ? (
        <div className="card p-10 text-center text-sm text-charcoal/50">
          {L('لا يوجد عملاء مسندون إليك بعد.', 'No clients are assigned to you yet.')}
        </div>
      ) : visible.length === 0 ? (
        <div className="card p-10 text-center text-sm text-charcoal/50">{L('لا يوجد عملاء مطابقون.', 'No clients match.')}</div>
      ) : (
        <div className="space-y-2">
          {visible.map((sc) => (
            <MyClientCard
              key={sc.view.id}
              sc={sc}
              isAr={isAr}
              now={now}
              returnTo="/sales-workspace/clients"
              onOpen={(id) => navigate(`/model/clients/${id}`)}
              onWhatsApp={openWhatsApp}
              lastInteraction={lastByClient.get(sc.view.id) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
