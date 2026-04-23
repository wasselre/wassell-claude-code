import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, RefreshCw, Search, Star } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';

/**
 * WhatsApp-style conversation list. Replaces the generic RecordListPage
 * for /model/chats — conversations don't read well in a spreadsheet, and
 * the rest of the record-page machinery (saved views, import/export,
 * bulk edit, card builder) isn't meaningful here.
 *
 * Rows sorted by last_message_at desc. Click → detail page.
 */
export default function ChatListPage() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const waDevices = useAppStore((s) => s.waDevices);
  const loadChatsFromHaberchat = useAppStore((s) => s.loadChatsFromHaberchat);

  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const chatRecords = chatsModel ? (records[chatsModel.id] ?? []) : [];

  // Mount refresh + periodic mount on focus (so coming back to the tab
  // after some time pulls the latest list). Realtime handles open-tab
  // updates via the detail page's subscription; the list-page path is
  // mount-driven for simplicity.
  useEffect(() => {
    void (async () => {
      setRefreshing(true);
      try {
        await loadChatsFromHaberchat();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [loadChatsFromHaberchat]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await loadChatsFromHaberchat();
    } finally {
      setRefreshing(false);
    }
  };

  // Filter + sort. Conversations with no last_message_at get pushed to
  // the bottom; ties break on record id for deterministic order.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? chatRecords.filter((r) => {
          const d = r.data as Record<string, unknown>;
          const name = (d.name as string | null) ?? '';
          const phone = (d.phone as string | null) ?? '';
          const preview = (d.last_message_preview as string | null) ?? '';
          return (
            name.toLowerCase().includes(q) ||
            phone.toLowerCase().includes(q) ||
            preview.toLowerCase().includes(q)
          );
        })
      : chatRecords;
    return [...filtered].sort((a, b) => {
      const aAt = ((a.data as Record<string, unknown>).last_message_at as string | null) ?? '';
      const bAt = ((b.data as Record<string, unknown>).last_message_at as string | null) ?? '';
      if (aAt === bAt) return a.id.localeCompare(b.id);
      if (!aAt) return 1;
      if (!bAt) return -1;
      return bAt.localeCompare(aAt);
    });
  }, [chatRecords, search]);

  // Device friendly-name map for the badge we show on multi-device rows.
  const deviceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of waDevices) {
      map.set(d.device_id, (isAr ? d.friendly_name_ar : d.friendly_name_en) ?? d.phone);
    }
    return map;
  }, [waDevices, isAr]);
  const showDeviceBadges = waDevices.filter((d) => d.is_active).length > 1;

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="w-12 h-12 rounded-2xl bg-copper/10 flex items-center justify-center">
          <MessageCircle size={24} className="text-copper" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'المحادثات' : 'Chats'}
          </h1>
          <p className="text-sm text-charcoal/50">
            {chatRecords.length === 0
              ? (isAr ? 'لا توجد محادثات' : 'No conversations yet')
              : isAr
                ? `${chatRecords.length} محادثة`
                : `${chatRecords.length} conversation${chatRecords.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-secondary inline-flex items-center gap-1.5"
          title={isAr ? 'تحديث' : 'Refresh'}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isAr ? 'ابحث في المحادثات...' : 'Search conversations…'}
          className="input w-full ps-9"
          dir={isAr ? 'rtl' : 'ltr'}
        />
      </div>

      {/* Empty state */}
      {visible.length === 0 && (
        <div className="card p-10 text-center">
          <MessageCircle size={32} className="mx-auto mb-3 text-charcoal/20" />
          <p className="text-sm text-charcoal/60 font-medium">
            {search
              ? (isAr ? 'لا توجد نتائج' : 'No matches')
              : (isAr ? 'ستظهر المحادثات هنا عند وصول رسائل جديدة' : 'Conversations will appear here as new messages arrive')}
          </p>
        </div>
      )}

      {/* List */}
      {visible.length > 0 && (
        <div className="card p-0 overflow-hidden divide-y divide-charcoal/5">
          {visible.map((record) => (
            <ChatRow
              key={record.id}
              record={record}
              isAr={isAr}
              deviceLabel={showDeviceBadges ? deviceLabels.get((record.data as Record<string, unknown>).device_id as string) ?? null : null}
              onClick={() => navigate(`/model/chats/${record.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────

function ChatRow({
  record,
  isAr,
  deviceLabel,
  onClick,
}: {
  record: AppRecord;
  isAr: boolean;
  deviceLabel: string | null;
  onClick: () => void;
}) {
  const data = record.data as Record<string, unknown>;
  const name = (data.name as string | null) ?? (data.phone as string | null) ?? '—';
  const phone = (data.phone as string | null) ?? null;
  const preview = (data.last_message_preview as string | null) ?? null;
  const lastAt = (data.last_message_at as string | null) ?? null;
  const unread = typeof data.unread_count === 'number' ? data.unread_count : 0;
  const status = (data.status as string | null) ?? 'active';

  const avatarLetter = (name.trim().charAt(0) || '#').toUpperCase();

  return (
    <button
      onClick={onClick}
      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-cream/40 transition-colors text-start"
    >
      {/* Avatar */}
      <div
        className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-white font-semibold text-base ${
          unread > 0 ? 'bg-copper' : 'bg-charcoal/40'
        }`}
      >
        {avatarLetter}
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className={`font-bold truncate ${unread > 0 ? 'text-chocolate' : 'text-charcoal'}`}>
            {name}
          </h3>
          {status === 'resolved' && (
            <span className="text-[10px] font-medium text-charcoal/50 px-1.5 py-0.5 rounded bg-charcoal/5">
              {isAr ? 'محلول' : 'Resolved'}
            </span>
          )}
          {status === 'archived' && (
            <span className="text-[10px] font-medium text-charcoal/50 px-1.5 py-0.5 rounded bg-charcoal/5">
              {isAr ? 'مؤرشف' : 'Archived'}
            </span>
          )}
          {deviceLabel && (
            <span className="text-[10px] font-medium text-copper/80 px-1.5 py-0.5 rounded bg-copper/10 truncate max-w-[120px]">
              {deviceLabel}
            </span>
          )}
          <span className="ms-auto text-[11px] text-charcoal/50 shrink-0" dir="ltr">
            {lastAt ? formatRelative(lastAt, isAr) : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <p className={`text-sm truncate ${unread > 0 ? 'text-charcoal font-medium' : 'text-charcoal/60'}`}>
            {preview ?? (phone && phone !== name ? phone : '—')}
          </p>
          {unread > 0 && (
            <span className="ms-auto inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-copper text-white text-[10px] font-bold px-1.5 shrink-0">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          {unread === 0 && lastAt && (
            <Star size={12} className="text-charcoal/20 shrink-0 ms-auto opacity-0" />
          )}
        </div>
      </div>
    </button>
  );
}

function formatRelative(iso: string, isAr: boolean): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (sameDay) {
      return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }).format(d);
    }
    if (isYesterday) {
      return isAr ? 'أمس' : 'Yesterday';
    }
    return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
      day: 'numeric',
      month: 'short',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    }).format(d);
  } catch {
    return '';
  }
}
