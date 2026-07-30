/**
 * Marketing OS — the rebuilt marketing module.
 *
 * Design record: the 52-screen review of 2026-07-30. This page is screen 3 (the
 * Content table) plus the create flow; the workspace and the remaining surfaces
 * land on top of the same client.
 *
 * Two things this page deliberately does NOT do, because they are what made the
 * previous module feel slow and stale:
 *   - It never reads the global Zustand record store. It calls one endpoint and
 *     holds its own state, so opening it costs one request rather than a store
 *     rehydrate.
 *   - It never renders a status the user can edit. Stage and current role are
 *     derived server-side from the open task.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import {
  fetchBootstrap,
  fetchContentList,
  isOverdue,
  statusLabel,
  MosContentRow,
  MosContentType,
  MosRole,
  PURPOSE_LABELS,
  ROLE_LABELS,
} from '@/lib/marketingOS/client';
import NewContentModal from './components/NewContentModal';

export default function MarketingOSPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [role, setRole] = useState<MosRole>('viewer');
  const [types, setTypes] = useState<MosContentType[]>([]);
  const [rows, setRows] = useState<MosContentRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (opts.quiet) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [boot, list] = await Promise.all([
          fetchBootstrap(),
          fetchContentList({ limit: 300 }),
        ]);
        setRole(boot.role);
        setTypes(boot.content_types);
        setRows(list.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Filtering is client-side because the whole working set is a few hundred rows
  // and a round trip per keystroke is exactly the latency we are removing.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter && r.content_type_key !== typeFilter) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        (r.ref ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, typeFilter, search]);

  const canCreate = role === 'administrator' || role === 'marketing_manager'
    || role === 'ops_supervisor' || role === 'writer';

  const fmtDate = (v: string | null): string => {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { day: 'numeric', month: 'short' });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{isAr ? 'المحتوى' : 'Content'}</h1>
          <p className="mt-1 text-sm text-charcoal/60">
            {isAr
              ? `${rows.length} عنصرًا · دورك: ${ROLE_LABELS[role].ar}`
              : `${rows.length} items · your role: ${ROLE_LABELS[role].en}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void load({ quiet: true })}
            disabled={refreshing}
            aria-label={isAr ? 'تحديث' : 'Refresh'}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          {canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              {isAr ? 'محتوى جديد' : 'New content'}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}
          {error}
        </div>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTypeFilter(null)}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            typeFilter === null
              ? 'border-copper bg-copper text-white'
              : 'border-sand bg-white text-charcoal'
          }`}
        >
          {isAr ? 'الكل' : 'All'}
        </button>
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTypeFilter(t.key === typeFilter ? null : t.key)}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              typeFilter === t.key
                ? 'border-copper bg-copper text-white'
                : 'border-sand bg-white text-charcoal'
            }`}
          >
            {isAr ? t.label_ar : t.label_en}
          </button>
        ))}
        <div className="ms-auto flex items-center gap-2 rounded-lg border border-sand bg-white px-3 py-1.5">
          <Search className="h-3.5 w-3.5 text-charcoal/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'ابحث بالعنوان أو الرقم' : 'Search title or ref'}
            className="w-48 bg-transparent text-xs outline-none"
          />
        </div>
      </div>

      {/* table */}
      <div className="overflow-hidden rounded-xl border border-sand bg-white">
        {loading ? (
          <div className="p-10 text-center text-sm text-charcoal/50">
            {isAr ? 'جارٍ التحميل…' : 'Loading…'}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-charcoal/60">
              {rows.length === 0
                ? isAr
                  ? 'لا يوجد محتوى بعد. ابدأ بإنشاء أول عنصر.'
                  : 'No content yet. Create the first item.'
                : isAr
                  ? 'لا نتائج مطابقة للتصفية.'
                  : 'Nothing matches this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sand bg-cream/50 text-start text-xs text-charcoal/60">
                  <th className="p-3 text-start font-semibold">{isAr ? 'الرقم' : 'Ref'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'النوع' : 'Type'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'العنوان' : 'Title'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'المرحلة' : 'Stage'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'لدى' : 'With'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'الغرض' : 'Purpose'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'الاستحقاق' : 'Due'}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const late = isOverdue(r);
                  return (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/marketing-management/${r.id}`)}
                      className="cursor-pointer border-b border-sand/50 last:border-0 hover:bg-cream/40"
                    >
                      <td className="p-3 font-mono text-xs text-charcoal/60" dir="ltr">
                        {r.ref ?? '—'}
                      </td>
                      <td className="p-3 text-xs">
                        {isAr ? r.content_type_label_ar : r.content_type_label_en}
                      </td>
                      <td className="p-3 font-semibold">{r.title}</td>
                      <td className="p-3">
                        <span className="rounded bg-cream px-2 py-1 text-xs">
                          {statusLabel(r, isAr)}
                        </span>
                      </td>
                      <td className="p-3 text-xs">
                        {r.owner_role ? (isAr ? ROLE_LABELS[r.owner_role].ar : ROLE_LABELS[r.owner_role].en) : '—'}
                      </td>
                      <td className="p-3 text-xs">
                        {PURPOSE_LABELS[r.purpose]
                          ? isAr
                            ? PURPOSE_LABELS[r.purpose]!.ar
                            : PURPOSE_LABELS[r.purpose]!.en
                          : r.purpose}
                      </td>
                      <td className={`p-3 text-xs ${late ? 'font-bold text-red-700' : 'text-charcoal/60'}`}>
                        {fmtDate(r.current_task_due_at ?? r.due_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <NewContentModal
          types={types}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            setRows((prev) => [item, ...prev]);
            addToast(
              isAr ? `أُنشئ ${item.ref ?? ''} وأُسندت أول مهمة` : `Created ${item.ref ?? ''} — first task assigned`,
              'success',
            );
          }}
        />
      )}
    </div>
  );
}
