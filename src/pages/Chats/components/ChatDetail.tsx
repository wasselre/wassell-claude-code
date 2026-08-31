import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MessageCircle, Phone, Hash, Star, User, UserPlus, UserCheck, Check, CheckCheck, RotateCcw, Loader2, ListChecks, Megaphone, NotebookPen, Bot, Contact, MoreVertical, LayoutGrid, X, CalendarPlus, MapPin, ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import type { AppRecord } from '@/types';
import { matchRecordByPhone, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import { useIsMobile, useIsWideScreen } from '@/hooks/useIsMobile';
// Heavy, only-when-opened overlays are lazy-loaded so the chats chunk stays
// lean — the Project Finder (Google Maps), the client 360 cockpit, the
// projects/units browser and the record form load on demand, not with the
// conversation.
const ClientOptionsModal = lazy(() => import('@/components/clients/ClientOptionsModal'));
const ProjectsUnitsBrowser = lazy(() => import('./ProjectsUnitsBrowser'));
const ClientDetailPage = lazy(() => import('@/pages/Clients/ClientDetailPage'));
const RecordFormModal = lazy(() => import('@/pages/Records/components/RecordFormModal'));
import MessageThread from './MessageThread';
import Composer from './Composer';
import CompleteWhatsAppFollowupModal from './CompleteWhatsAppFollowupModal';
import LeadIntakeModal from './LeadIntakeModal';
import ContactIntakeModal from './ContactIntakeModal';
import LogInteractionModal from './LogInteractionModal';
import NotifyOfficerModal from './NotifyOfficerModal';
import QuickAppointmentModal from '@/pages/Followups/components/QuickAppointmentModal';
import QuickVisitModal from '@/pages/Followups/components/QuickVisitModal';
import StudyJobCard from './StudyJobCard';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import { buildDetailedClientPrefChips, buildGeoNameMap, type ClientPrefDetailChip } from '../lib/prefChips';
import { resolveChatDisplayName } from '../lib/chatDisplayName';
import { resolveConversationIdentity, conversationIdentityMessage } from '../lib/conversationIdentity';

/** Full-screen spinner shown while a lazy overlay chunk loads. */
function OverlayFallback() {
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-charcoal/20">
      <Loader2 size={24} className="animate-spin text-copper" />
    </div>
  );
}

/** First id from a scalar or array id field. */
function firstId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Right-pane conversation detail. Embedded inside ChatsSplitPage.
 * Renders the conversation header, scrolling thread, and composer in a
 * full-height flex column so the thread scrolls independently.
 */
export default function ChatDetail({ recordId }: { recordId: string }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // On a wide screen the client-options / Project-Finder panel DOCKS beside the
  // conversation (split view) instead of covering it; below `lg` there isn't
  // room, so it falls back to the full-screen modal.
  const isWide = useIsWideScreen();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const markChatAsRead = useAppStore((s) => s.markChatAsRead);
  const patchChat = useAppStore((s) => s.patchChat);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const record = useMemo(() => {
    if (!chatsModel) return null;
    return (records[chatsModel.id] ?? []).find((r) => r.id === recordId) ?? null;
  }, [chatsModel, records, recordId]);

  // ── Conversation identity ─────────────────────────────────────────
  // ONE explicit answer to "can this conversation be sent on, and with what?".
  // The composer is gated on it (and takes it by value), so a send can never
  // be dispatched against a half-resolved conversation — the race that made
  // messages vanish on freshly-created chats. See ../lib/conversationIdentity.
  const waDevices = useAppStore((s) => s.waDevices);
  const waDevicesLive = useAppStore((s) => s.waDevicesLive);
  const waDevicesLoaded = useAppStore((s) => s.waDevicesLoaded);
  const identity = useMemo(
    () =>
      resolveConversationIdentity({
        recordId,
        chatsModel,
        chatRecords: chatsModel ? records[chatsModel.id] ?? [] : [],
        waDevices,
        waDevicesLive,
        devicesLoaded: waDevicesLoaded,
      }),
    [recordId, chatsModel, records, waDevices, waDevicesLive, waDevicesLoaded],
  );

  const data = record?.data as Record<string, unknown> | undefined;
  const chatWid = (data?.wid as string | undefined) ?? null;
  // `name` is resolved AFTER matchedContact below — a saved contact's name wins
  // over the WhatsApp push name. Declared here only for reading convenience.
  const phone = (data?.phone as string | null | undefined) ?? null;
  const kind = (data?.kind as string | null | undefined) ?? 'user';
  const status = (data?.status as string | null | undefined) ?? 'active';
  const lastMessageAt = (data?.last_message_at as string | null | undefined) ?? null;
  const storedClientLinkId = (data?.client_link as string | null | undefined) ?? null;
  // AI takeover for THIS conversation (set from the header toggle). While on,
  // the agent answers every inbound message regardless of global policy.
  const aiManaged = (data?.ai_managed as boolean | undefined) === true;

  // Look up the linked client. Prefer an explicit stored `client_link` (an
  // admin may have linked to someone other than the phone owner), but FALL
  // BACK to a live phone match — the same digits match used for contacts /
  // advertisers below — so an existing client always resolves even when
  // `client_link` was never persisted or got reverted by a record refetch
  // (the "existing client shows as new, flickers in then out" bug). Everything
  // downstream keys off the resolved id, so the linked-client header, the
  // client URL, and the active WhatsApp follow-up all light up from the live
  // match too. `records.clients` is already in the store — no round-trip.
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const linkedClient = useMemo<AppRecord | null>(() => {
    if (!clientsModel) return null;
    const clientRecords = records[clientsModel.id] ?? [];
    if (storedClientLinkId) {
      const stored = clientRecords.find((r) => r.id === storedClientLinkId);
      if (stored) return stored;
    }
    if (!phone) return null;
    return matchRecordByPhone(phone, clientRecords, phoneFieldSlugs(clientsModel));
  }, [clientsModel, records, storedClientLinkId, phone]);
  const clientLinkId = linkedClient?.id ?? null;
  const linkedClientData = linkedClient ? (linkedClient.data as Record<string, unknown>) : null;
  const linkedClientName =
    (linkedClientData?.client_name as string | null | undefined) ??
    (linkedClientData?.name as string | null | undefined) ??
    null;

  // Detailed preference chips for the linked client (unit type, budget,
  // bedrooms, area, location, direction, amenities, …). Same source data as
  // the list-pane chips, just the full set.
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);
  const prefChips = useMemo<ClientPrefDetailChip[]>(
    () => (linkedClientData ? buildDetailedClientPrefChips(linkedClientData, clientsModel, geoNames, isAr) : []),
    [linkedClientData, clientsModel, geoNames, isAr],
  );
  // The linked client's preferred projects (multi-lookup → array of project ids),
  // used to prefill the "Notify officer" project picker when there's exactly one.
  const preferredProjectIds = useMemo<string[]>(() => {
    const pp = linkedClientData?.preferred_projects;
    if (!Array.isArray(pp)) return [];
    return pp
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : ''))
      .filter(Boolean);
  }, [linkedClientData]);


  // Advertiser whose phone matches this chat — computed live (nothing is
  // stored on the chat), so a fresh REGA lookup links instantly. The model
  // refs are lifted so we have their ids for the in-chat record popups below.
  const advertisersModel = useMemo(() => models.find((m) => m.name === 'advertisers') ?? null, [models]);
  const contactsModel = useMemo(() => models.find((m) => m.name === 'contacts') ?? null, [models]);
  const matchedAdvertiser = useMemo(() => {
    if (!advertisersModel || !phone) return null;
    return matchRecordByPhone(phone, records[advertisersModel.id] ?? [], phoneFieldSlugs(advertisersModel));
  }, [advertisersModel, records, phone]);
  const matchedAdvertiserName = matchedAdvertiser
    ? ((matchedAdvertiser.data as Record<string, unknown>).name as string | null) ?? null
    : null;

  // Address-book contact whose phone matches this chat — computed live exactly
  // like the advertiser above, so a contact saved from this header links
  // instantly and a deleted one unlinks on its own. Nothing is stored on the
  // chat record.
  const matchedContact = useMemo(() => {
    if (!contactsModel || !phone) return null;
    return matchRecordByPhone(phone, records[contactsModel.id] ?? [], phoneFieldSlugs(contactsModel));
  }, [contactsModel, records, phone]);
  // Our own name for this number (client, else contact) wins over the WhatsApp
  // push name — see resolveChatDisplayName.
  const name = resolveChatDisplayName(data, matchedContact, linkedClient);

  // Client-options popup (options list + embedded Project Finder).
  const [showClientOptions, setShowClientOptions] = useState(false);
  // How the client-options surface opens: DOCKED beside the chat (split view)
  // or as a full-screen MODAL. Persisted + switchable both ways, so the split
  // is a choice, never forced. (Only honoured on a wide screen; below xl the
  // modal is always used.)
  const [optionsView, setOptionsView] = useState<'dock' | 'modal'>(() => {
    try {
      return localStorage.getItem('wassell_chat_options_view') === 'modal' ? 'modal' : 'dock';
    } catch {
      return 'dock';
    }
  });
  const chooseOptionsView = (v: 'dock' | 'modal') => {
    setOptionsView(v);
    try {
      localStorage.setItem('wassell_chat_options_view', v);
    } catch {
      /* private mode — remembering the preference is best-effort, not fatal */
    }
  };
  // Collapse the conversation's top section (CRM actions, meta, preference
  // chips, study card) so the thread owns the height — especially useful in
  // split view where the chat column is narrow. Persisted; desktop-only effect.
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('wassell_chat_header_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleHeaderCollapsed = () =>
    setHeaderCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('wassell_chat_header_collapsed', next ? '1' : '0');
      } catch {
        /* non-fatal */
      }
      return next;
    });
  // Mobile-only: the CRM actions live in a bottom sheet (keeps the header
  // compact so the thread owns the screen), and conversation-state actions
  // (status / Done / Reopen) live in a ⋯ overflow menu.
  const [showCrmSheet, setShowCrmSheet] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  // "Complete WhatsApp Follow-Up" popup (shown when Done/Resolve is clicked and
  // an active WhatsApp follow-up exists for the linked client).
  const [showCompleteFollowup, setShowCompleteFollowup] = useState(false);
  // Assisted lead capture (unlinked chat → propose + approve a client).
  const [showLeadIntake, setShowLeadIntake] = useState(false);
  // Address-book capture (unlinked chat → save just a name + number).
  const [showContactIntake, setShowContactIntake] = useState(false);
  // "Log an interaction" — record an off-task call/visit result.
  const [showLogInteraction, setShowLogInteraction] = useState(false);
  // Book an appointment / record a visit straight from the conversation — the
  // same Quick modals the Follow-up Workspace uses, minus a source follow-up.
  const [showBookAppointment, setShowBookAppointment] = useState(false);
  const [showRecordVisit, setShowRecordVisit] = useState(false);
  // Notify the project's officer FROM THE OPS LINE that a customer wants to visit.
  const [showNotifyOfficer, setShowNotifyOfficer] = useState(false);
  // In-chat record popup for a matched CONTACT / ADVERTISER (a plain record with
  // no bespoke page). Opening it never navigates away — RecordFormModal overlay
  // with an "Open full page" escape hatch.
  const [recordPopup, setRecordPopup] = useState<
    { modelId: string; recordId: string; href: string } | null
  >(null);
  // The linked CLIENT opens the full 360 cockpit as an overlay over the chat
  // (the purpose-built page, not the generic form).
  const [showClient360, setShowClient360] = useState(false);
  // Projects & Units browser — its overlay lives HERE (not inside the sheet), so
  // closing the mobile action sheet can't unmount it before it opens.
  const [showProjectsBrowser, setShowProjectsBrowser] = useState(false);

  // The linked client's active WhatsApp follow-up (open/in_progress). Resolving
  // the chat should complete THIS task through the normal follow-up path rather
  // than silently closing the conversation. Prefer the task linked to this exact
  // chat (completed_by_chat_id); else the most recently created open one.
  const followupsModel = useMemo(() => models.find((m) => m.name === 'followups') ?? null, [models]);
  const activeWaFollowup = useMemo(() => {
    if (!followupsModel || !clientLinkId) return null;
    const rows = (records[followupsModel.id] ?? []).filter((r) => {
      const d = r.data as Record<string, unknown>;
      if (firstId(d.client_id) !== clientLinkId) return false;
      if (readFollowupType(d) !== 'whatsapp_follow_up') return false;
      const st = (typeof d.followup_status === 'string' && d.followup_status) ? d.followup_status : 'open';
      return st === 'open' || st === 'in_progress';
    });
    if (rows.length === 0) return null;
    const linked = rows.find((r) => (r.data as Record<string, unknown>).completed_by_chat_id === recordId);
    if (linked) return linked;
    return rows.slice().sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
  }, [followupsModel, records, clientLinkId, recordId]);

  // Resolve-or-prompt: closing a chat with an active WhatsApp follow-up opens
  // the completion popup instead of silently resolving. Reopen / archive and
  // chats with no active follow-up take the direct patchChat path.
  const requestStatusChange = async (next: 'active' | 'resolved' | 'archived') => {
    if (next === 'resolved' && activeWaFollowup) {
      setShowCompleteFollowup(true);
      return;
    }
    await patchChat(chatWid ?? '', { status: next });
  };

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  // Zero out unread_count whenever we open this chat — and again whenever a
  // new message lands while it stays open (the Realtime bump increments the
  // badge even though the user is looking right at the thread). newestMessageId
  // changes on every arrival, so this effect re-fires and re-clears.
  const newestMessageId = useAppStore((s) => {
    if (!chatWid) return null;
    const msgs = s.chatMessages[chatWid];
    return msgs && msgs.length > 0 ? msgs[msgs.length - 1]?.id ?? null : null;
  });
  useEffect(() => {
    if (chatWid) markChatAsRead(chatWid);
  }, [chatWid, newestMessageId, markChatAsRead]);

  if (!record) {
    return (
      <div className="flex items-center justify-center flex-1 text-charcoal/50">
        <div className="text-center">
          <MessageCircle size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">
            {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
          </p>
          <p className="text-xs text-charcoal/40 mt-1">
            {isAr
              ? 'قد تكون قد حُذفت أو لم تتم مزامنتها بعد.'
              : 'It may have been removed or not synced yet.'}
          </p>
        </div>
      </div>
    );
  }

  // Open a record as an IN-CHAT popup instead of navigating away. The linked
  // MOBILE-ONLY: opening a record stays in the chat as an overlay (client → the
  // full 360 cockpit; contact / advertiser → the generic record overlay). On
  // the LAPTOP we keep the original behaviour — the client opens in a new tab
  // and contact / advertiser navigate to their record page — so desktop is
  // unchanged from before.
  const openClientProfile = clientLinkId
    ? isMobile
      ? () => setShowClient360(true)
      : () => window.open(`/model/clients/${clientLinkId}`, '_blank', 'noopener')
    : null;
  const openContactRecord =
    matchedContact && contactsModel
      ? isMobile
        ? () => setRecordPopup({ modelId: contactsModel.id, recordId: matchedContact.id, href: `/model/contacts/${matchedContact.id}` })
        : () => navigate(`/model/contacts/${matchedContact.id}`)
      : null;
  const openAdvertiserRecord =
    matchedAdvertiser && advertisersModel
      ? isMobile
        ? () => setRecordPopup({ modelId: advertisersModel.id, recordId: matchedAdvertiser.id, href: `/model/advertisers/${matchedAdvertiser.id}` })
        : () => navigate(`/model/advertisers/${matchedAdvertiser.id}`)
      : null;

  // Props shared by the CRM-actions cluster, rendered inline on desktop and
  // inside the mobile bottom sheet — ONE source of truth, no duplicated markup.
  const crmActionProps = {
    isAr,
    matchedContact,
    matchedAdvertiser,
    matchedAdvertiserName,
    recordId,
    aiManaged,
    onOpenProjectsBrowser: () => setShowProjectsBrowser(true),
    onOpenClient: openClientProfile,
    onOpenContact: openContactRecord,
    onOpenAdvertiser: openAdvertiserRecord,
    // Toggle so the header button also CLOSES the docked split panel (on the
    // modal path it can only be clicked while closed, so toggling is harmless).
    onClientOptions: () => setShowClientOptions((v) => !v),
    onLogInteraction: () => setShowLogInteraction(true),
    onBookAppointment: () => setShowBookAppointment(true),
    onRecordVisit: () => setShowRecordVisit(true),
    onNotifyOfficer: () => setShowNotifyOfficer(true),
    onLeadIntake: () => setShowLeadIntake(true),
    onContactIntake: () => setShowContactIntake(true),
  };

  // Whether the client-options panel should dock beside the chat right now:
  // asked for, has a client, wide enough, AND the user's choice is "dock".
  const dockOptions = showClientOptions && !!clientLinkId && isWide && optionsView === 'dock';
  // The header-collapse only takes effect on desktop (the mobile header is
  // already a slim bar with the CRM actions in a sheet), so a choice made on a
  // laptop can't blank the mobile header via the shared localStorage flag.
  const collapsedHeader = headerCollapsed && !isMobile;

  return (
    <div className="flex h-full min-h-0 bg-white">
    {/* Conversation column — shrinks to make room when the client-options /
        Project-Finder panel docks beside it (split view), so the rep keeps
        reading the chat while working the options. */}
    <div className="flex flex-1 min-w-0 flex-col h-full min-h-0">
      {/* Header — compact messaging-style bar. On mobile the heavy CRM stack and
          the Done button move OUT of the bar (into the ⋯ menu + the CRM sheet)
          so the thread owns the screen; desktop keeps the full inline header. */}
      <div className="safe-top px-3 py-2 md:px-4 md:py-3 border-b border-sand/20 shrink-0 flex items-start gap-2.5 md:gap-3">
        {/* Back (mobile only — desktop shows split view) */}
        <button
          onClick={() => navigate('/model/chats')}
          className="md:hidden -ms-1 mt-0.5 p-1.5 rounded-lg text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
          aria-label={isAr ? 'رجوع' : 'Back'}
        >
          <BackIcon size={20} />
        </button>
        {openClientProfile ? (
          <button
            onClick={openClientProfile}
            className="w-10 h-10 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0 font-semibold hover:bg-copper/20 transition-colors"
            title={isAr ? 'عرض ملف العميل' : 'View client profile'}
          >
            {(name.trim().charAt(0) || '#').toUpperCase()}
          </button>
        ) : (
          <div className="w-10 h-10 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0 font-semibold">
            {(name.trim().charAt(0) || '#').toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {openClientProfile ? (
              <button
                onClick={openClientProfile}
                className="text-base font-bold text-chocolate truncate hover:text-copper transition-colors text-start"
                title={isAr ? 'عرض ملف العميل' : 'View client profile'}
              >
                {name}
              </button>
            ) : (
              <h1 className="text-base font-bold text-chocolate truncate">{name}</h1>
            )}
            <StatusPicker
              chatWid={chatWid}
              status={status}
              isAr={isAr}
              onChange={requestStatusChange}
            />
          </div>
          {phone && (
            <p className="text-xs text-charcoal/60 mt-0.5 font-mono" dir="ltr">
              <Phone size={10} className="inline me-1" />
              {phone}
            </p>
          )}
          {/* Kind / last-message meta — desktop only; it's noise on a phone.
              Hidden when the header is collapsed to focus the chat. */}
          {!collapsedHeader && (
            <div className="hidden md:flex items-center gap-3 mt-1 text-[11px] text-charcoal/50 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Hash size={10} />
                {kindLabel(kind, isAr)}
              </span>
              {lastMessageAt && (
                <span>
                  {isAr ? 'آخر رسالة: ' : 'Last: '}
                  {formatDateTime(lastMessageAt, isAr)}
                </span>
              )}
            </div>
          )}
          {/* CRM actions inline — DESKTOP ONLY. On mobile these live in the
              bottom sheet opened from the header's grid button. Hidden when the
              header is collapsed (re-clicking the chevron brings them back). */}
          {!collapsedHeader && (
            <CrmActions
              {...crmActionProps}
              layout="inline"
              className="hidden md:flex items-center gap-2 mt-1.5 text-xs flex-wrap"
            />
          )}
          {/* Client preference chips — the full preference picture (unit type,
              budget, bedrooms, area, location, direction, amenities, notes…).
              On mobile: a single horizontally-scrollable row so a long list never
              pushes the thread down. Desktop: wraps as before. */}
          {prefChips.length > 0 && !collapsedHeader && (
            <div className="flex items-center gap-1 mt-2 flex-nowrap overflow-x-auto md:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {prefChips.map((chip) => (
                <span
                  key={chip.key}
                  className={`shrink-0 md:shrink text-[10px] font-medium px-1.5 py-0.5 rounded truncate max-w-[240px] ${DETAIL_CHIP_STYLES[chip.kind]}`}
                  title={chip.title ?? chip.text}
                >
                  {chip.text}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Desktop-only: collapse the header's client section so the thread
            gets the height (handy in split view). */}
        <button
          onClick={toggleHeaderCollapsed}
          className="hidden md:inline-flex self-start shrink-0 items-center justify-center rounded-lg p-1.5 text-charcoal/50 hover:text-copper hover:bg-cream transition-colors"
          title={
            collapsedHeader
              ? (isAr ? 'إظهار معلومات العميل والإجراءات' : 'Show client info & actions')
              : (isAr ? 'إخفاء القسم العلوي لعرض المحادثة فقط' : 'Hide the top section — show only the chat')
          }
          aria-pressed={collapsedHeader}
        >
          {collapsedHeader ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>

        {/* Desktop trailing action: Done / Reopen. */}
        <DoneButton
          chatWid={chatWid}
          status={status}
          isAr={isAr}
          onChange={requestStatusChange}
          className="hidden md:inline-flex"
        />

        {/* Mobile trailing cluster: call · CRM sheet · ⋯ overflow. */}
        <div className="md:hidden flex items-center gap-0.5 shrink-0 self-center">
          {phone && (
            <a
              href={`tel:${phone}`}
              className="p-2 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
              aria-label={isAr ? 'اتصال' : 'Call'}
              title={isAr ? 'اتصال هاتفي' : 'Phone call'}
            >
              <Phone size={18} />
            </a>
          )}
          <button
            onClick={() => setShowCrmSheet(true)}
            className="p-2 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
            aria-label={isAr ? 'إجراءات العميل' : 'CRM actions'}
            title={isAr ? 'إجراءات العميل والمشاريع' : 'Client & project actions'}
          >
            <LayoutGrid size={18} />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowOverflow((v) => !v)}
              className="p-2 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
              aria-label={isAr ? 'المزيد' : 'More'}
              aria-haspopup="menu"
              aria-expanded={showOverflow}
            >
              <MoreVertical size={18} />
            </button>
            {showOverflow && (
              <OverflowMenu
                isAr={isAr}
                status={status}
                chatWid={chatWid}
                onStatusChange={requestStatusChange}
                onClose={() => setShowOverflow(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* App-triggered client study (claude_jobs) — button + status/review
          strip. Client-linked chats only: a study is a client deliverable.
          Hidden when the header is collapsed (desktop focus-the-chat mode). */}
      {clientLinkId && !collapsedHeader && <StudyJobCard chatRecordId={recordId} />}

      {/* Thread — full-bleed scroll area on mobile, framed card on desktop
          (MessageThread drops its own card chrome below md). */}
      <div className="flex-1 min-h-0 overflow-hidden px-0 pt-0 md:px-3 md:pt-3">
        <MessageThread chatWid={chatWid ?? ''} />
      </div>

      {/* Composer — mounted ONLY once the conversation identity is resolved.
          Until then the rep sees why, instead of an enabled box whose sends
          would be rejected on the way out (see conversationIdentity.ts).
          Edge-to-edge and pinned at the bottom on mobile; inset on desktop. */}
      <div className="px-0 pb-0 md:px-3 md:pb-3 shrink-0 safe-bottom md:pb-3">
        {identity.status === 'ready' ? (
          <Composer identity={identity} />
        ) : (
          <div className="flex items-center justify-center gap-2 p-4 text-xs text-charcoal/60 border-t border-sand/20 md:border md:rounded-2xl md:mt-3">
            {identity.status === 'loading' && (
              <Loader2 size={14} className="animate-spin text-charcoal/40" />
            )}
            <span className="text-center">{conversationIdentityMessage(identity, isAr)}</span>
          </div>
        )}
      </div>

      {/* Mobile CRM actions bottom sheet — the same CrmActions cluster, tucked
          out of the header. Tapping any action closes the sheet first. */}
      {showCrmSheet && (
        <MobileActionSheet
          title={isAr ? 'إجراءات العميل والمشاريع' : 'Client & project actions'}
          isAr={isAr}
          onClose={() => setShowCrmSheet(false)}
        >
          <CrmActions
            {...crmActionProps}
            layout="sheet"
            close={() => setShowCrmSheet(false)}
            className="flex flex-wrap gap-2"
          />
        </MobileActionSheet>
      )}

      {/* Linked CLIENT → the full 360 cockpit as an overlay over the chat (never
          a page nav). Rendered below the Modal tier (z-40) so its own create
          follow-up / appointment modals (z-50) stack above it. */}
      {showClient360 && clientLinkId &&
        createPortal(
          <div className="fixed inset-0 z-40 overflow-y-auto bg-cream" dir={isAr ? 'rtl' : 'ltr'}>
            <button
              onClick={() => setShowClient360(false)}
              className="fixed end-3 top-3 z-[41] rounded-full bg-white/90 p-2 text-charcoal/70 shadow-md transition-colors hover:text-copper"
              aria-label={isAr ? 'إغلاق' : 'Close'}
            >
              <X size={18} />
            </button>
            <Suspense fallback={<div className="flex items-center justify-center py-24"><Loader2 size={24} className="animate-spin text-copper" /></div>}>
              <ClientDetailPage clientId={clientLinkId} onClose={() => setShowClient360(false)} />
            </Suspense>
          </div>,
          document.body,
        )}

      {/* Projects & Units browser — its own fixed overlay, mounted here so the
          mobile action sheet closing can never unmount it mid-open. */}
      {showProjectsBrowser && (
        <Suspense fallback={<OverlayFallback />}>
          <ProjectsUnitsBrowser clientId={clientLinkId} chatWid={chatWid} onClose={() => setShowProjectsBrowser(false)} />
        </Suspense>
      )}

      {/* In-chat record popup — a matched CONTACT / ADVERTISER (no bespoke page)
          opened as an overlay, with an "Open full page" escape hatch. */}
      {recordPopup && (
        <Suspense fallback={<OverlayFallback />}>
          <RecordFormModal
            modelId={recordPopup.modelId}
            recordId={recordPopup.recordId}
            openInPageHref={recordPopup.href}
            onClose={() => setRecordPopup(null)}
          />
        </Suspense>
      )}

      {/* Client-options popup — the client's saved options with the Project
          Finder embedded, without leaving the conversation. Shown as the
          full-screen MODAL when the screen is too narrow to split OR the user
          chose full-screen. On a wide screen with the "dock" choice it renders
          as the docked side panel after this column (below). The header's
          Split/Full-screen button switches between the two and remembers it. */}
      {showClientOptions && clientLinkId && (!isWide || optionsView === 'modal') && (
        <Suspense fallback={<OverlayFallback />}>
          <ClientOptionsModal
            clientId={clientLinkId}
            onClose={() => setShowClientOptions(false)}
            onToggleLayout={isWide ? () => chooseOptionsView('dock') : undefined}
          />
        </Suspense>
      )}

      {/* Assisted lead capture — approve a proposed client from this chat,
          then pick the first follow-up channel (call now vs WhatsApp). */}
      {showLeadIntake && !clientLinkId && (
        <LeadIntakeModal
          phone={phone ?? ''}
          suggestedName={name !== '—' ? name : ''}
          lastInboundAt={(data?.last_message_flow === 'in' ? lastMessageAt : null)}
          onClose={() => setShowLeadIntake(false)}
        />
      )}

      {/* Address-book capture — name + number only, no sales machinery. */}
      {showContactIntake && !clientLinkId && (
        <ContactIntakeModal
          phone={phone ?? ''}
          suggestedName={name !== '—' ? name : ''}
          onClose={() => setShowContactIntake(false)}
        />
      )}

      {/* Log an interaction — record an off-task call/visit result; defaults
          to completing the client's current open task. */}
      {showLogInteraction && clientLinkId && (
        <LogInteractionModal
          clientId={clientLinkId}
          clientName={linkedClientName ?? name}
          chatRecordId={recordId}
          onClose={() => setShowLogInteraction(false)}
        />
      )}

      {/* Book an appointment — the Workspace's Quick modal, sans source
          follow-up. Fires the appointment workflows via saveRecord. */}
      {showBookAppointment && (
        <QuickAppointmentModal
          clientId={clientLinkId}
          phone={phone}
          salesRep={currentUserId}
          followupId={activeWaFollowup?.id ?? null}
          onClose={() => setShowBookAppointment(false)}
          onSaved={() => setShowBookAppointment(false)}
        />
      )}

      {/* Record a visit — the Workspace's Quick modal, sans source follow-up.
          Fires the Visit → After-Visit workflow via saveRecord. */}
      {showRecordVisit && (
        <QuickVisitModal
          clientId={clientLinkId}
          clientName={linkedClientName ?? name}
          phone={phone}
          salesRep={currentUserId}
          followupId={activeWaFollowup?.id ?? null}
          onClose={() => setShowRecordVisit(false)}
        />
      )}

      {/* Notify project officer — sends a visit heads-up to the project's
          officer FROM THE OPS LINE (never sales). Officer resolved server-side. */}
      {showNotifyOfficer && (
        <NotifyOfficerModal
          clientId={clientLinkId}
          clientName={linkedClientName ?? name}
          clientPhone={phone}
          preferredProjectIds={preferredProjectIds}
          onClose={() => setShowNotifyOfficer(false)}
        />
      )}

      {/* Complete WhatsApp Follow-Up — records the outcome on the existing
          follow-up (workflow moves the client), then resolves the chat. */}
      {showCompleteFollowup && activeWaFollowup && followupsModel && (
        <CompleteWhatsAppFollowupModal
          followup={activeWaFollowup}
          followupModel={followupsModel}
          chatRecordId={recordId}
          clientId={clientLinkId}
          clientStage={(linkedClientData?.client_stage as string | undefined) ?? null}
          clientStatus={(linkedClientData?.client_status as string | undefined) ?? null}
          phone={phone}
          onResolveChat={() => patchChat(chatWid ?? '', { status: 'resolved' })}
          onOpenChat={() => setShowCompleteFollowup(false)}
          onClose={() => setShowCompleteFollowup(false)}
        />
      )}
    </div>{/* /conversation column */}

    {/* Docked client-options / Project-Finder panel — wide screen only. Splits
        the pane so the conversation stays visible beside the options and the
        finder. Narrower screens use the full-screen modal above instead. */}
    {dockOptions && (
      <div className="flex h-full min-h-0 w-[400px] 2xl:w-[500px] shrink-0 flex-col border-s border-sand/20">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Loader2 size={20} className="animate-spin text-copper" />
            </div>
          }
        >
          <ClientOptionsModal
            variant="docked"
            clientId={clientLinkId!}
            onClose={() => setShowClientOptions(false)}
            onToggleLayout={() => chooseOptionsView('modal')}
          />
        </Suspense>
      </div>
    )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Chip tint per preference kind — same palette family as the list-pane chips. */
const DETAIL_CHIP_STYLES: Record<ClientPrefDetailChip['kind'], string> = {
  unit_type: 'bg-copper/10 text-copper',
  budget: 'bg-gold/20 text-chocolate',
  bedrooms: 'bg-copper/10 text-copper',
  area: 'bg-gold/20 text-chocolate',
  location: 'bg-charcoal/5 text-charcoal/70',
  distance: 'bg-charcoal/5 text-charcoal/70',
  direction: 'bg-charcoal/5 text-charcoal/70',
  amenities: 'bg-copper/10 text-copper',
  objective: 'bg-gold/20 text-chocolate',
  setting: 'bg-charcoal/5 text-charcoal/70',
  notes: 'bg-cream text-charcoal/70',
};

/**
 * The CRM action cluster for a conversation — Projects/Units browser, the
 * linked-client / advertiser / contact links, Client options, Log interaction,
 * AI handover, and (for an unlinked chat) Add-as-client / Add-contact.
 *
 * ONE definition, two placements: rendered inline in the header on desktop
 * (`layout="inline"`) and inside the mobile bottom sheet (`layout="sheet"`,
 * roomier tap targets). `close` is passed only in the sheet, so tapping an
 * action dismisses the sheet before its modal/drawer/nav takes over.
 */
function CrmActions({
  isAr,
  matchedContact,
  matchedAdvertiser,
  matchedAdvertiserName,
  recordId,
  aiManaged,
  onOpenProjectsBrowser,
  onOpenClient,
  onOpenContact,
  onOpenAdvertiser,
  onClientOptions,
  onLogInteraction,
  onBookAppointment,
  onRecordVisit,
  onNotifyOfficer,
  onLeadIntake,
  onContactIntake,
  layout,
  className = '',
  close,
}: {
  isAr: boolean;
  matchedContact: AppRecord | null;
  matchedAdvertiser: AppRecord | null;
  matchedAdvertiserName: string | null;
  recordId: string;
  aiManaged: boolean;
  onOpenProjectsBrowser: () => void;
  onOpenClient: (() => void) | null;
  onOpenContact: (() => void) | null;
  onOpenAdvertiser: (() => void) | null;
  onClientOptions: () => void;
  onLogInteraction: () => void;
  onBookAppointment: () => void;
  onRecordVisit: () => void;
  onNotifyOfficer: () => void;
  onLeadIntake: () => void;
  onContactIntake: () => void;
  layout: 'inline' | 'sheet';
  className?: string;
  close?: () => void;
}) {
  const big = layout === 'sheet';
  const pad = big ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5';
  // Every tap closes the sheet first (no-op on desktop), then runs the action.
  const run = (fn: () => void) => () => {
    close?.();
    fn();
  };

  return (
    <div className={className}>
      {/* Projects & Units — the browser overlay lives in ChatDetail (not here),
          so tapping this closes the sheet first, then opens it. (Rendering the
          overlay inside the sheet meant the sheet-close unmounted it before it
          could appear — the "nothing happens" bug.) */}
      <button
        onClick={run(onOpenProjectsBrowser)}
        className={`inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 ${pad} font-medium text-copper transition-colors hover:bg-copper/10`}
        title={isAr ? 'تصفح المشاريع والوحدات دون مغادرة المحادثة' : 'Browse projects & units without leaving the conversation'}
      >
        <LayoutGrid size={12} />
        {isAr ? 'المشاريع والوحدات' : 'Projects & units'}
      </button>
      {matchedContact && onOpenContact && (
        <button
          onClick={run(onOpenContact)}
          className={`inline-flex items-center gap-1.5 rounded-full bg-charcoal/8 ${pad} font-medium text-charcoal transition-colors hover:bg-charcoal/15`}
          title={isAr ? 'عرض بطاقة جهة الاتصال' : 'View contact record'}
        >
          <Contact size={12} />
          {isAr ? 'جهة اتصال' : 'Contact'}
        </button>
      )}
      {matchedAdvertiser && onOpenAdvertiser && (
        <button
          onClick={run(onOpenAdvertiser)}
          className={`inline-flex items-center gap-1.5 rounded-full bg-gold/20 ${pad} font-medium text-chocolate transition-colors hover:bg-gold/30`}
          title={isAr ? 'عرض بطاقة المعلن' : 'View advertiser record'}
        >
          <Megaphone size={12} />
          <span className="truncate max-w-[220px]">
            {isAr ? 'معلن: ' : 'Advertiser: '}
            {matchedAdvertiserName ?? (isAr ? 'عرض البطاقة' : 'open record')}
          </span>
        </button>
      )}
      {onOpenClient ? (
        <>
          <button
            onClick={run(onOpenClient)}
            className={`inline-flex items-center gap-1.5 font-medium text-copper hover:text-terracotta ${big ? 'rounded-full bg-copper/5 ' + pad : ''}`}
            title={isAr ? 'عرض ملف العميل' : 'View client profile'}
          >
            <User size={12} />
            {isAr ? 'عميل مرتبط' : 'Linked client'}
          </button>
          <button
            onClick={run(onClientOptions)}
            className={`inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 ${pad} font-medium text-copper transition-colors hover:bg-copper/10`}
            title={isAr ? 'عرض خيارات العميل والبحث عن المزيد' : 'View client options & find more'}
          >
            <ListChecks size={12} />
            {isAr ? 'خيارات العميل' : 'Client options'}
          </button>
          <button
            onClick={run(onLogInteraction)}
            className={`inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 ${pad} font-medium text-[#8a6a2f] transition-colors hover:bg-gold/20`}
            title={isAr ? 'تسجيل مكالمة أو تواصل خارج المهام' : 'Log a call or other interaction'}
          >
            <NotebookPen size={12} />
            {isAr ? 'تسجيل تواصل' : 'Log interaction'}
          </button>
          <button
            onClick={run(onBookAppointment)}
            className={`inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 ${pad} font-medium text-copper transition-colors hover:bg-copper/10`}
            title={isAr ? 'حجز موعد لهذا العميل' : 'Book an appointment for this client'}
          >
            <CalendarPlus size={12} />
            {isAr ? 'حجز موعد' : 'Book appointment'}
          </button>
          <button
            onClick={run(onRecordVisit)}
            className={`inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 ${pad} font-medium text-copper transition-colors hover:bg-copper/10`}
            title={isAr ? 'تسجيل زيارة قام بها العميل' : 'Record a visit this client made'}
          >
            <MapPin size={12} />
            {isAr ? 'تسجيل زيارة' : 'Record a visit'}
          </button>
          <button
            onClick={run(onNotifyOfficer)}
            className={`inline-flex items-center gap-1 rounded-full border border-terracotta/40 bg-terracotta/5 ${pad} font-medium text-terracotta transition-colors hover:bg-terracotta/10`}
            title={isAr ? 'إشعار مسؤول المشروع من رقم العمليات' : 'Notify the project officer from the ops number'}
          >
            <UserCheck size={12} />
            {isAr ? 'إشعار المسؤول' : 'Notify officer'}
          </button>
          {/* AI handover is a self-contained toggle (a fetch, no overlay) — it
              stays mounted in the sheet so its busy spinner + result toast show;
              the rep closes the sheet via its own X. */}
          <AiHandoverButton chatRecordId={recordId} aiManaged={aiManaged} isAr={isAr} />
        </>
      ) : (
        <>
          <button
            onClick={run(onLeadIntake)}
            className={`inline-flex items-center gap-1.5 rounded-full border border-copper/40 bg-copper/10 ${pad} font-medium text-copper transition-colors hover:bg-copper/20`}
            title={isAr ? 'إنشاء عميل من هذا الرقم وبدء المتابعة' : 'Create a client from this phone and start the follow-up'}
          >
            <UserPlus size={12} />
            {isAr ? 'إضافة كعميل' : 'Add as a client'}
          </button>
          {!matchedContact && (
            <button
              onClick={run(onContactIntake)}
              className={`inline-flex items-center gap-1.5 rounded-full border border-charcoal/25 bg-charcoal/5 ${pad} font-medium text-charcoal transition-colors hover:bg-charcoal/10`}
              title={
                isAr
                  ? 'حفظ الاسم والرقم فقط — بدون إنشاء عميل أو مهمة متابعة'
                  : 'Save just the name and number — no client, no follow-up task'
              }
            >
              <Contact size={12} />
              {isAr ? 'إضافة جهة اتصال جديدة' : 'Add a new contact'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Mobile-only bottom sheet. Slides up from the bottom edge; closes on backdrop
 * tap (the `e.target === e.currentTarget` check, same as ClientOptionsModal) or
 * Escape. Portalled to <body> so it escapes the chat's overflow-hidden column.
 */
function MobileActionSheet({
  title,
  isAr,
  onClose,
  children,
}: {
  title: string;
  isAr: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[55] flex items-end bg-charcoal/40 md:hidden"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="w-full max-h-[85vh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl safe-bottom animate-[slideIn_0.16s_ease-out]">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-sand/30 bg-white px-4 py-3">
          <h3 className="text-sm font-bold text-chocolate">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-copper hover:bg-cream transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Mobile ⋯ overflow menu — the conversation-STATE actions that used to be the
 * permanent «إنهاء المحادثة» button: Done / Reopen, plus Archive. Reuses the
 * detail's `requestStatusChange`, so a resolve with an active WhatsApp follow-up
 * still routes through the completion popup.
 */
function OverflowMenu({
  isAr,
  status,
  chatWid,
  onStatusChange,
  onClose,
}: {
  isAr: boolean;
  status: string;
  chatWid: string | null;
  onStatusChange: (status: 'active' | 'resolved' | 'archived') => Promise<void>;
  onClose: () => void;
}) {
  const closed = status === 'resolved' || status === 'archived';
  const pick = (next: 'active' | 'resolved' | 'archived') => () => {
    onClose();
    void onStatusChange(next);
  };
  const rowCls =
    'w-full px-3 py-2 text-start text-xs flex items-center gap-2 transition-colors hover:bg-cream/60 disabled:opacity-50';

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute end-0 top-full mt-1 z-50 min-w-[190px] rounded-xl border border-sand/30 bg-white py-1 shadow-lg">
        <button onClick={pick(closed ? 'active' : 'resolved')} disabled={!chatWid} className={rowCls}>
          {closed ? <RotateCcw size={13} className="text-charcoal/50" /> : <CheckCheck size={13} className="text-copper" />}
          {closed ? (isAr ? 'إعادة فتح المحادثة' : 'Reopen conversation') : (isAr ? 'إنهاء المحادثة' : 'End conversation')}
        </button>
        {status !== 'archived' && (
          <button onClick={pick('archived')} disabled={!chatWid} className={rowCls}>
            <Check size={13} className="text-charcoal/40" />
            {isAr ? 'أرشفة' : 'Archive'}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * One-click close for a finished conversation. Sets status 'resolved'
 * (what the list's Open/Closed filter reads); on an already-closed chat
 * it flips to a subtle Reopen. Same optimistic patchChat path as the
 * status pill — the store toasts + reverts on failure.
 */
function DoneButton({
  chatWid,
  status,
  isAr,
  onChange,
  className = '',
}: {
  chatWid: string | null;
  status: string;
  isAr: boolean;
  onChange: (status: 'active' | 'resolved') => Promise<void>;
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  const closed = status === 'resolved' || status === 'archived';

  const act = async () => {
    if (!chatWid || saving) return;
    setSaving(true);
    try {
      await onChange(closed ? 'active' : 'resolved');
    } catch {
      // store toasts + reverts; nothing more to do here.
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={() => void act()}
      disabled={!chatWid || saving}
      className={`self-start shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${className} ${
        closed
          ? 'border border-sand text-charcoal/60 hover:text-copper hover:border-copper/40 bg-white'
          : 'bg-copper text-white hover:bg-terracotta'
      }`}
      title={
        closed
          ? (isAr ? 'إعادة فتح المحادثة' : 'Reopen this conversation')
          : (isAr ? 'إغلاق المحادثة — تظهر ضمن «مغلقة»' : 'Close this conversation — moves to “Closed”')
      }
    >
      {saving ? (
        <Loader2 size={13} className="animate-spin" />
      ) : closed ? (
        <RotateCcw size={13} />
      ) : (
        <CheckCheck size={13} />
      )}
      {closed ? (isAr ? 'إعادة فتح' : 'Reopen') : (isAr ? 'إنهاء المحادثة' : 'Done')}
    </button>
  );
}

/** Editable status pill — click to cycle through active / resolved /
 *  archived via a small menu. Optimistic; toasts + reverts on failure. */
function StatusPicker({
  chatWid,
  status,
  isAr,
  onChange,
}: {
  chatWid: string | null;
  status: string;
  isAr: boolean;
  onChange: (status: 'active' | 'resolved' | 'archived') => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<'active' | 'resolved' | 'archived' | null>(null);
  const color = statusColor(status);
  const options: Array<'active' | 'resolved' | 'archived'> = ['active', 'resolved', 'archived'];

  const pick = async (next: 'active' | 'resolved' | 'archived') => {
    if (!chatWid || next === status || saving) return;
    setSaving(next);
    try {
      await onChange(next);
    } catch {
      // store toasts + reverts; we just close the menu.
    } finally {
      setSaving(null);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!chatWid || saving != null}
        className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full hover:brightness-95 disabled:opacity-60"
        style={{ backgroundColor: `${color}14`, color }}
      >
        {saving ? <Loader2 size={10} className="animate-spin" /> : null}
        {statusLabel(status, isAr)}
      </button>
      {open && (
        <>
          {/* Click-outside overlay */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full start-0 mt-1 z-50 bg-white rounded-lg shadow-lg border border-sand/20 py-1 min-w-[140px]">
            {options.map((opt) => {
              const c = statusColor(opt);
              const isCurrent = opt === status;
              return (
                <button
                  key={opt}
                  onClick={() => pick(opt)}
                  disabled={isCurrent || saving != null}
                  className={`w-full px-3 py-1.5 text-start text-xs flex items-center gap-2 transition-colors ${
                    isCurrent ? 'bg-charcoal/5' : 'hover:bg-cream/60'
                  }`}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: c }}
                  />
                  <span className="flex-1">{statusLabel(opt, isAr)}</span>
                  {isCurrent && <Check size={12} className="text-charcoal/40" />}
                  {saving === opt && <Loader2 size={12} className="animate-spin text-charcoal/40" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * AI TAKEOVER TOGGLE for this conversation.
 *
 * On = the agent owns the chat and answers every inbound message until a human
 * turns it off; the global policy (schedule, automatic-reply switch, reply cap)
 * does not apply, because a person explicitly assigned this conversation.
 * Off = back to the humans.
 *
 * The state is `data.ai_managed` on the chat record, so it reads from the store
 * and stays in sync across the list and the thread without a extra fetch.
 */
function AiHandoverButton({
  chatRecordId, aiManaged, isAr,
}: { chatRecordId: string; aiManaged: boolean; isAr: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !aiManaged;
    setBusy(true);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const res = await fetch('/api/whatsapp/ai-handover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ chat_record_id: chatRecordId, enabled: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast(
          isAr ? `تعذر التغيير: ${body?.error ?? res.status}` : `Failed: ${body?.error ?? res.status}`,
          'error',
        );
        return;
      }
      addToast(
        next
          ? (isAr
              ? 'المساعد الذكي يدير هذه المحادثة الآن — سيرد على كل رسالة حتى توقفه'
              : 'The AI agent now manages this conversation until you stop it')
          : (isAr
              ? 'تم إيقاف المساعد — المحادثة رجعت للفريق'
              : 'Agent stopped — the conversation is back with the team'),
        'success',
      );
    } catch (err) {
      addToast(isAr ? `خطأ: ${String(err)}` : `Error: ${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={() => void toggle()}
      disabled={busy}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition-colors disabled:opacity-50 ${
        aiManaged
          ? 'border-green-500/50 bg-green-500/15 text-green-700 hover:bg-green-500/25'
          : 'border-copper/40 bg-copper/10 text-copper hover:bg-copper/20'
      }`}
      title={
        aiManaged
          ? (isAr ? 'إيقاف المساعد وإرجاع المحادثة للفريق' : 'Stop the agent and hand the chat back')
          : (isAr ? 'تسليم المحادثة للمساعد الذكي' : 'Hand this conversation to the AI agent')
      }
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />}
      {aiManaged
        ? (isAr ? 'المساعد يدير المحادثة — إيقاف' : 'AI managing — stop')
        : (isAr ? 'تسليم للمساعد الذكي' : 'Hand to AI')}
    </button>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return '#22c55e';
    case 'resolved': return '#6b7280';
    case 'archived': return '#9ca3af';
    default: return '#6b7280';
  }
}

function statusLabel(status: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    active: { ar: 'نشط', en: 'Active' },
    resolved: { ar: 'تم الحل', en: 'Resolved' },
    archived: { ar: 'مؤرشف', en: 'Archived' },
  };
  const entry = map[status];
  if (!entry) return status;
  return isAr ? entry.ar : entry.en;
}

function kindLabel(kind: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    user: { ar: 'محادثة فردية', en: 'Direct chat' },
    group: { ar: 'مجموعة', en: 'Group' },
    channel: { ar: 'قناة', en: 'Channel' },
  };
  const entry = map[kind];
  if (!entry) return kind;
  return isAr ? entry.ar : entry.en;
}

function formatDateTime(iso: string, isAr: boolean): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return iso;
  }
}

// Used by ChatsSplitPage for the no-selection placeholder pane.
export function ChatDetailEmptyPane({ isAr }: { isAr: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center text-charcoal/40">
      <div className="text-center">
        <MessageCircle size={40} className="mx-auto mb-3 opacity-30" />
        <p className="font-medium">
          {isAr ? 'اختر محادثة من القائمة' : 'Select a conversation'}
        </p>
        <p className="text-xs text-charcoal/40 mt-1">
          <Star size={12} className="inline me-1 opacity-40" />
          {isAr ? 'الرسائل الواردة تظهر فوراً دون تحديث.' : 'New messages arrive live without refresh.'}
        </p>
      </div>
    </div>
  );
}
