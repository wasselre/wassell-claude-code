/**
 * Audit Log page (admin-only). Lists every mutation on users / profiles /
 * roles, newest first. Filterable by entity type and free-text search on
 * the actor email + entity label. Loads directly from the `audit_log`
 * table — RLS already restricts reads to admins so the query returns
 * nothing for non-admins (the route guard also bounces them).
 *
 * Pagination: simple "Load more" button; pageSize=100. Fine for the
 * current scale (audit grows ~50 rows/month for a small CRM); revisit
 * with a virtual list if it ever passes a few thousand rows.
 *
 * The page does NOT show full before/after JSON inline — it'd be too
 * dense. A row click expands to show the diff. Plain values only; we
 * pretty-print but don't try to be smart about JSON shapes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { ChevronDown, ChevronRight, Loader2, Search, ScrollText } from 'lucide-react';

interface AuditRow {
  id: number;
  actor_auth_uid: string | null;
  actor_email: string | null;
  entity_type: 'user' | 'profile' | 'role';
  entity_id: string;
  entity_label: string | null;
  action: 'created' | 'updated' | 'deleted' | 'deactivated' | 'activated';
  before: unknown;
  after: unknown;
  at: string;
}

const PAGE_SIZE = 100;

export default function AuditLogPage() {
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<'all' | 'user' | 'profile' | 'role'>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Initial load + reload when filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      if (!supabase) {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
        return;
      }
      let q = supabase
        .from('audit_log')
        .select('*')
        .order('at', { ascending: false })
        .range(0, PAGE_SIZE - 1);
      if (filter !== 'all') q = q.eq('entity_type', filter);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        addToast(error.message, 'error');
        setRows([]);
      } else {
        const fetched = (data ?? []) as AuditRow[];
        setRows(fetched);
        setHasMore(fetched.length === PAGE_SIZE);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, addToast]);

  const handleLoadMore = async () => {
    if (!supabase || loading) return;
    setLoading(true);
    let q = supabase
      .from('audit_log')
      .select('*')
      .order('at', { ascending: false })
      .range(rows.length, rows.length + PAGE_SIZE - 1);
    if (filter !== 'all') q = q.eq('entity_type', filter);
    const { data, error } = await q;
    if (error) {
      addToast(error.message, 'error');
    } else {
      const fetched = (data ?? []) as AuditRow[];
      setRows([...rows, ...fetched]);
      setHasMore(fetched.length === PAGE_SIZE);
    }
    setLoading(false);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.actor_email ?? '').toLowerCase().includes(q) ||
      (r.entity_label ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  const toggleExpand = (id: number) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ScrollText size={22} className="text-copper" />
        <h1 className="text-xl font-bold text-chocolate">
          {isAr ? 'سجل المراجعة' : 'Audit Log'}
        </h1>
      </div>

      {/* Filter row */}
      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {(['all', 'user', 'profile', 'role'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                filter === k
                  ? 'bg-copper text-white'
                  : 'bg-sand/15 text-charcoal hover:bg-sand/25'
              }`}
            >
              {k === 'all'
                ? isAr ? 'الكل' : 'All'
                : k === 'user'
                ? isAr ? 'المستخدمون' : 'Users'
                : k === 'profile'
                ? isAr ? 'الملفات' : 'Profiles'
                : isAr ? 'الأدوار' : 'Roles'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search size={14} className="text-charcoal/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isAr ? 'بحث (بريد المستخدم أو اسم الكيان)' : 'Search (actor email / entity)'}
            className="form-input text-sm flex-1"
          />
        </div>
      </div>

      {/* List */}
      <div className="card overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-copper" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-charcoal/40 text-sm">
            {isAr ? 'لا توجد سجلات' : 'No entries yet'}
          </div>
        ) : (
          <div className="divide-y divide-sand/20">
            {filtered.map((row) => (
              <AuditRow
                key={row.id}
                row={row}
                isAr={isAr}
                expanded={expanded.has(row.id)}
                onToggle={() => toggleExpand(row.id)}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="border-t border-sand/20 p-3 flex justify-center">
            <button
              onClick={() => void handleLoadMore()}
              className="text-sm text-copper hover:text-terracotta font-bold"
              disabled={loading}
            >
              {loading
                ? isAr ? 'جاري التحميل…' : 'Loading…'
                : isAr ? 'تحميل المزيد' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditRow({
  row,
  isAr,
  expanded,
  onToggle,
}: {
  row: AuditRow;
  isAr: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const date = new Date(row.at);
  const when = date.toLocaleString(isAr ? 'ar-SA' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const actionColor = (() => {
    switch (row.action) {
      case 'created':
      case 'activated':
        return 'text-green-700 bg-green-50 border-green-200';
      case 'deleted':
      case 'deactivated':
        return 'text-red-700 bg-red-50 border-red-200';
      default:
        return 'text-blue-700 bg-blue-50 border-blue-200';
    }
  })();
  const actionLabel = (() => {
    if (!isAr) return row.action;
    switch (row.action) {
      case 'created': return 'إنشاء';
      case 'updated': return 'تعديل';
      case 'deleted': return 'حذف';
      case 'deactivated': return 'تعطيل';
      case 'activated': return 'تفعيل';
    }
  })();
  const entityLabel = (() => {
    if (!isAr) return row.entity_type;
    switch (row.entity_type) {
      case 'user': return 'مستخدم';
      case 'profile': return 'ملف';
      case 'role': return 'دور';
    }
  })();

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full text-start px-4 py-3 hover:bg-cream/50 flex items-center gap-3"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className={`text-[10px] font-bold uppercase border rounded px-1.5 py-0.5 ${actionColor}`}>
          {actionLabel}
        </span>
        <span className="text-[11px] text-charcoal/50 font-bold">{entityLabel}</span>
        <span className="text-sm text-charcoal flex-1 truncate">
          {row.entity_label || row.entity_id}
        </span>
        <span className="text-xs text-charcoal/60 hidden sm:inline">{row.actor_email ?? '—'}</span>
        <span className="text-xs text-charcoal/40">{when}</span>
      </button>
      {expanded && (
        <div className="px-12 pb-3 space-y-2">
          <DiffBlock label={isAr ? 'قبل' : 'Before'} value={row.before} />
          <DiffBlock label={isAr ? 'بعد' : 'After'} value={row.after} />
        </div>
      )}
    </div>
  );
}

function DiffBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-charcoal/50 mb-1">
        {label}
      </div>
      <pre className="text-[11px] bg-sand/5 border border-sand/20 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
