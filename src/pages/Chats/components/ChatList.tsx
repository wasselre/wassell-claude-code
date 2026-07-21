import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, RefreshCw, Search, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import StartChatModal from './StartChatModal';
import { buildClientPrefChips, buildGeoNameMap, isClosedChat, type ClientPrefChip } from '../lib/prefChips';
import { matchRecordByPhone, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import type { AppRecord } from '@/types';

/**
 * Left-pane conversation list. Embedded inside ChatsSplitPage.
 * Rows are sorted by last_message_at desc. Selecting a row updates the
 * URL — the split page's right pane picks up the new recordId and swaps
 * the detail view.
 *
 * Tabs split the inbox by who's on the other end: All / Clients (linked to a
 * live clients record) / Advertisers (phone matches an `advertisers` record —
 * computed live, so a fresh REGA lookup links its chat instantly) / Other
 * (developers, offices, unknown numbers…). The Clients tab adds an Open /
 * Closed filter (a chat is closed by the Done button in the detail header,
 * or archived) and each client row carries preference chips
 * (unit type · area · location).
 */

type ChatTab = 'all' | 'clients' | 'advertisers' | 'other';
type ClientFilter = 'open' | 'waiting' | 'closed';

// `/model/chats` and `/model/chats/:recordId` are separate route entries, so
// opening a chat REMOUNTS this component. Keep the last chosen tab/filter at
// module scope so the list doesn't snap back to "All / Open" on every click.
let lastTab: ChatTab = 'all';
let lastClientFilter: ClientFilter = 'open';

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
  const [tab, setTabState] = useState<ChatTab>(lastTab);
  const [clientFilter, setClientFilterState] = useState<ClientFilter>(lastClientFilter);
  const setTab = (t: ChatTab) => { lastTab = t; setTabState(t); };
  const setClientFilter = (f: ClientFilter) => { lastClientFilter = f; setClientFilterState(f); };

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const advertisersModel = useMemo(() => models.find((m) => m.name === 'advertisers') ?? null, [models]);
  const chatRecords = chatsModel ? (records[chatsModel.id] ?? []) : [];
  const clientRecords = clientsModel ? (records[clientsModel.id] ?? []) : [];
  const advertiserRecords = advertisersModel ? (records[advertisersModel.id] ?? []) : [];

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

  const clientsById = useMemo(() => {
    const map = new Map<string, AppRecord>();
    for (const c of clientRecords) map.set(c.id, c);
    return map;
  }, [clientRecords]);

  /** The linked LIVE client for a chat (a dangling client_link counts as none). */
  const clientOf = useCallback((chat: AppRecord): AppRecord | null => {
    const link = (chat.data as Record<string, unknown>).client_link;
    return typeof link === 'string' && link ? clientsById.get(link) ?? null : null;
  }, [clientsById]);

  // chat id → matched advertiser record, computed live by phone (same
  // digits-suffix match as the client linker). Nothing is stored on the
  // chat, so a freshly-created advertiser (REGA lookup) links instantly
  // and a deleted one unlinks on its own.
  const advertiserByChatId = useMemo(() => {
    const map = new Map<string, AppRecord>();
    const slugs = phoneFieldSlugs(advertisersModel);
    if (advertiserRecords.length === 0 || slugs.length === 0) return map;
    for (const chat of chatRecords) {
      const phone = (chat.data as Record<string, unknown>).phone as string | null | undefined;
      const match = matchRecordByPhone(phone, advertiserRecords, slugs);
      if (match) map.set(chat.id, match);
    }
    return map;
  }, [chatRecords, advertiserRecords, advertisersModel]);

  /** The advertiser whose phone matches this chat's phone (or null). */
  const advertiserOf = useCallback(
    (chat: AppRecord): AppRecord | null => advertiserByChatId.get(chat.id) ?? null,
    [advertiserByChatId],
  );

  // id → display name for districts + cities (location-chip resolution).
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);

  // Search first (spans the linked client's name too), then sort — tab counts
  // are computed on this set so the numbers always match what's listed.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? chatRecords.filter((r) => {
          const d = r.data as Record<string, unknown>;
          const name = (d.name as string | null) ?? '';
          const phone = (d.phone as string | null) ?? '';
          const preview = (d.last_message_preview as string | null) ?? '';
          const client = clientOf(r);
          const clientName = client ? String((client.data as Record<string, unknown>).client_name ?? '') : '';
          const advertiser = advertiserOf(r);
          const advertiserName = advertiser ? String((advertiser.data as Record<string, unknown>).name ?? '') : '';
          return (
            name.toLowerCase().includes(q) ||
            phone.toLowerCase().includes(q) ||
            preview.toLowerCase().includes(q) ||
            clientName.toLowerCase().includes(q) ||
            advertiserName.toLowerCase().includes(q)
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
  }, [chatRecords, search, clientOf, advertiserOf]);

  const clientChats = useMemo(() => searched.filter((r) => clientOf(r) !== null), [searched, clientOf]);

  // Clients whose WhatsApp follow-up is parked WAITING on the customer
  // (message_sent_waiting_response). Derived, never stored on the chat: the
  // chat files under «بانتظار الرد» while the ball is with the customer and
  // pops back to Open the moment the inbound reconciler flips the task.
  // (2026-07-21 — sales-process improvement plan, Workstream C.)
  const waitingClientIds = useMemo(() => {
    const followupsModel = models.find((m) => m.name === 'followups');
    const followups = followupsModel ? (records[followupsModel.id] ?? []) : [];
    const out = new Set<string>();
    for (const r of followups) {
      const d = r.data as Record<string, unknown>;
      const status = typeof d.followup_status === 'string' && d.followup_status ? d.followup_status : 'open';
      if (['completed', 'cancelled', 'skipped'].includes(status)) continue;
      if (d.whatsapp_state !== 'message_sent_waiting_response') continue;
      const clientId = Array.isArray(d.client_id) ? d.client_id[0] : d.client_id;
      if (typeof clientId === 'string' && clientId) out.add(clientId);
    }
    return out;
  }, [models, records]);

  /** Open-but-parked: the linked client's task is waiting on the customer. */
  const isWaitingChat = useCallback((chat: AppRecord): boolean => {
    if (isClosedChat(chat.data as Record<string, unknown>)) return false;
    const client = clientOf(chat);
    return client !== null && waitingClientIds.has(client.id);
  }, [clientOf, waitingClientIds]);
  const advertiserChats = useMemo(
    () => searched.filter((r) => advertiserOf(r) !== null),
    [searched, advertiserOf],
  );
  // A chat can be both a client and an advertiser, so tab counts overlap
  // by design — "Other" is strictly neither.
  const otherChats = useMemo(
    () => searched.filter((r) => clientOf(r) === null && advertiserOf(r) === null),
    [searched, clientOf, advertiserOf],
  );

  const visible = useMemo(() => {
    if (tab === 'advertisers') return advertiserChats;
    if (tab === 'other') return otherChats;
    if (tab !== 'clients') return searched;
    if (clientFilter === 'closed') return clientChats.filter((r) => isClosedChat(r.data as Record<string, unknown>));
    if (clientFilter === 'waiting') return clientChats.filter((r) => isWaitingChat(r));
    // Open = needs us: not closed and not parked with the customer.
    return clientChats.filter((r) => !isClosedChat(r.data as Record<string, unknown>) && !isWaitingChat(r));
  }, [searched, clientChats, advertiserChats, otherChats, tab, clientFilter, isWaitingChat]);

  const deviceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of waDevices) {
      map.set(d.device_id, (isAr ? d.friendly_name_ar : d.friendly_name_en) ?? d.phone);
    }
    return map;
  }, [waDevices, isAr]);
  const showDeviceBadges = waDevices.filter((d) => d.is_active).length > 1;

  const tabs: { id: ChatTab; label: string; count: number }[] = [
    { id: 'all', label: isAr ? 'الكل' : 'All', count: searched.length },
    { id: 'clients', label: isAr ? 'العملاء' : 'Clients', count: clientChats.length },
    { id: 'advertisers', label: isAr ? 'المعلنون' : 'Advertisers', count: advertiserChats.length },
    { id: 'other', label: isAr ? 'أخرى' : 'Other', count: otherChats.length },
  ];

  const closedCount = useMemo(
    () => clientChats.filter((r) => isClosedChat(r.data as Record<string, unknown>)).length,
    [clientChats],
  );
  const waitingCount = useMemo(
    () => clientChats.filter((r) => isWaitingChat(r)).length,
    [clientChats, isWaitingChat],
  );
  const clientFilters: { id: ClientFilter; label: string; count: number }[] = [
    { id: 'open', label: isAr ? 'مفتوحة' : 'Open', count: clientChats.length - closedCount - waitingCount },
    { id: 'waiting', label: isAr ? 'بانتظار الرد' : 'Waiting for reply', count: waitingCount },
    { id: 'closed', label: isAr ? 'مغلقة' : 'Closed', count: closedCount },
  ];

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

      {/* Tabs: All / Clients / Advertisers / Other */}
      <div className="flex items-center gap-1 px-3 py-2 shrink-0 border-b border-sand/10">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 text-xs font-semibold rounded-lg py-1.5 px-2 transition-colors ${
              tab === t.id
                ? 'bg-copper text-white'
                : 'bg-cream/60 text-charcoal/60 hover:bg-cream hover:text-charcoal'
            }`}
          >
            {t.label}
            <span className={`ms-1 text-[10px] font-normal ${tab === t.id ? 'text-white/80' : 'text-charcoal/40'}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Open / Closed filter (Clients tab only) */}
      {tab === 'clients' && (
        <div className="flex items-center gap-1 px-3 py-1.5 shrink-0 border-b border-sand/10">
          {clientFilters.map((f) => (
            <button
              key={f.id}
              onClick={() => setClientFilter(f.id)}
              className={`text-[11px] font-medium rounded-full px-2.5 py-1 whitespace-nowrap transition-colors ${
                clientFilter === f.id
                  ? 'bg-copper/15 text-copper font-semibold'
                  : 'text-charcoal/50 hover:bg-cream hover:text-charcoal'
              }`}
            >
              {f.label}
              <span className={`ms-1 text-[10px] font-normal ${clientFilter === f.id ? 'text-copper/70' : 'text-charcoal/40'}`}>
                {f.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* List (scrollable) */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {visible.length === 0 && (
          <div className="p-8 text-center text-xs text-charcoal/40">
            {search || tab !== 'all'
              ? (isAr ? 'لا توجد نتائج' : 'No matches')
              : (isAr ? 'لا توجد محادثات بعد' : 'No conversations yet')}
          </div>
        )}
        {visible.map((record) => {
          const client = clientOf(record);
          const advertiser = advertiserOf(record);
          return (
            <ChatRow
              key={record.id}
              record={record}
              isAr={isAr}
              selected={record.id === selectedRecordId}
              advertiserName={
                advertiser
                  ? ((advertiser.data as Record<string, unknown>).name as string | null) ?? null
                  : null
              }
              prefChips={
                client
                  ? buildClientPrefChips(client.data as Record<string, unknown>, clientsModel, geoNames, isAr)
                  : []
              }
              deviceLabel={
                showDeviceBadges
                  ? deviceLabels.get((record.data as Record<string, unknown>).device_id as string) ?? null
                  : null
              }
              onClick={() => navigate(`/model/chats/${record.id}`)}
            />
          );
        })}
      </div>
    </div>
    </>
  );
}

// ─── Row ───────────────────────────────────────────────────────────

const CHIP_STYLES: Record<ClientPrefChip['kind'], string> = {
  unit_type: 'bg-copper/10 text-copper',
  area: 'bg-gold/20 text-chocolate',
  location: 'bg-charcoal/5 text-charcoal/70',
};

function ChatRow({
  record,
  isAr,
  selected,
  deviceLabel,
  advertiserName,
  prefChips,
  onClick,
}: {
  record: AppRecord;
  isAr: boolean;
  selected: boolean;
  deviceLabel: string | null;
  advertiserName: string | null;
  prefChips: ClientPrefChip[];
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
        {(status === 'resolved' || status === 'archived' || deviceLabel || advertiserName || prefChips.length > 0) && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {advertiserName && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-gold/20 text-chocolate truncate max-w-[180px]"
                title={advertiserName}
              >
                {isAr ? 'معلن · ' : 'Advertiser · '}
                {advertiserName}
              </span>
            )}
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
            {prefChips.map((chip) => (
              <span
                key={chip.key}
                className={`text-[9px] font-medium px-1.5 py-0.5 rounded truncate max-w-[160px] ${CHIP_STYLES[chip.kind]}`}
                title={chip.text}
              >
                {chip.text}
              </span>
            ))}
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
