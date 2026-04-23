import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, RefreshCw, Search, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import StartChatModal from './StartChatModal';
import type { AppRecord } from '@/types';

/**
 * Left-pane conversation list. Embedded inside ChatsSplitPage.
 * Rows are sorted by last_message_at desc. Selecting a row updates the
 * URL — the split page's right pane picks up the new recordId and swaps
 * the detail view.
 */
export default function ChatList({ selectedRecordId }: { selectedRecordId: string | null }) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const waDevices = useAppStore((s) => s.waDevices);
  const loadChatsFromHaberchat = useAppStore((s) => s.loadChatsFromHaberchat);

  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [showStartModal, setShowStartModal] = useState(false);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const chatRecords = chatsModel ? (records[chatsModel.id] ?? []) : [];

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

  const deviceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of waDevices) {
      map.set(d.device_id, (isAr ? d.friendly_name_ar : d.friendly_name_en) ?? d.phone);
    }
    return map;
  }, [waDevices, isAr]);
  const showDeviceBadges = waDevices.filter((d) => d.is_active).length > 1;

  return (
    <>
    {showStartModal && <StartChatModal onClose={() => setShowStartModal(false)} />}
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-sand/20 shrink-0">
        <MessageCircle size={18} className="text-copper" />
        <h2 className="font-bold text-chocolate flex-1">
          {isAr ? 'المحادثات' : 'Chats'}
          {chatRecords.length > 0 && (
            <span className="ms-2 text-xs font-normal text-charcoal/50">
              {chatRecords.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => setShowStartModal(true)}
          className="p-1.5 rounded-lg text-charcoal/50 hover:text-copper hover:bg-cream transition-colors"
          aria-label={isAr ? 'محادثة جديدة' : 'New chat'}
          title={isAr ? 'محادثة جديدة' : 'New chat'}
        >
          <Plus size={16} />
        </button>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 rounded-lg text-charcoal/50 hover:text-copper hover:bg-cream transition-colors"
          aria-label={isAr ? 'تحديث' : 'Refresh'}
          title={isAr ? 'تحديث' : 'Refresh'}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 shrink-0 border-b border-sand/10">
        <div className="relative">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'بحث...' : 'Search…'}
            className="w-full bg-cream/60 border-0 rounded-lg text-sm py-1.5 ps-8 pe-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
            dir={isAr ? 'rtl' : 'ltr'}
          />
        </div>
      </div>

      {/* List (scrollable) */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {visible.length === 0 && (
          <div className="p-8 text-center text-xs text-charcoal/40">
            {search
              ? (isAr ? 'لا توجد نتائج' : 'No matches')
              : (isAr ? 'لا توجد محادثات بعد' : 'No conversations yet')}
          </div>
        )}
        {visible.map((record) => (
          <ChatRow
            key={record.id}
            record={record}
            isAr={isAr}
            selected={record.id === selectedRecordId}
            deviceLabel={
              showDeviceBadges
                ? deviceLabels.get((record.data as Record<string, unknown>).device_id as string) ?? null
                : null
            }
            onClick={() => navigate(`/model/chats/${record.id}`)}
          />
        ))}
      </div>
    </div>
    </>
  );
}

// ─── Row ───────────────────────────────────────────────────────────

function ChatRow({
  record,
  isAr,
  selected,
  deviceLabel,
  onClick,
}: {
  record: AppRecord;
  isAr: boolean;
  selected: boolean;
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
      className={`w-full px-3 py-2.5 flex items-start gap-2.5 text-start transition-colors border-b border-sand/10 ${
        selected
          ? 'bg-copper/10'
          : unread > 0
            ? 'bg-cream/40 hover:bg-cream'
            : 'hover:bg-cream/50'
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white font-semibold text-sm ${
          unread > 0 ? 'bg-copper' : 'bg-charcoal/30'
        }`}
      >
        {avatarLetter}
      </div>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3
            className={`truncate text-sm ${
              unread > 0 ? 'font-bold text-chocolate' : 'font-semibold text-charcoal'
            }`}
          >
            {name}
          </h3>
          <span className="ms-auto text-[10px] text-charcoal/50 shrink-0" dir="ltr">
            {lastAt ? formatRelative(lastAt, isAr) : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <p
            className={`text-xs truncate flex-1 ${
              unread > 0 ? 'text-charcoal font-medium' : 'text-charcoal/55'
            }`}
          >
            {preview ?? (phone && phone !== name ? phone : '')}
          </p>
          {unread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-copper text-white text-[10px] font-bold px-1.5 shrink-0">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
        {(status === 'resolved' || status === 'archived' || deviceLabel) && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {status === 'resolved' && (
              <span className="text-[9px] font-medium text-charcoal/50 px-1.5 py-0.5 rounded bg-charcoal/5">
                {isAr ? 'محلول' : 'Resolved'}
              </span>
            )}
            {status === 'archived' && (
              <span className="text-[9px] font-medium text-charcoal/50 px-1.5 py-0.5 rounded bg-charcoal/5">
                {isAr ? 'مؤرشف' : 'Archived'}
              </span>
            )}
            {deviceLabel && (
              <span className="text-[9px] font-medium text-copper/80 px-1.5 py-0.5 rounded bg-copper/10 truncate max-w-[100px]">
                {deviceLabel}
              </span>
            )}
          </div>
        )}
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
    if (isYesterday) return isAr ? 'أمس' : 'Yest';
    return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
      day: 'numeric',
      month: 'short',
    }).format(d);
  } catch {
    return '';
  }
}
