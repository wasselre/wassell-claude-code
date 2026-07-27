import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MessageCircle, Phone, Hash, Star, User, UserPlus, Check, CheckCheck, RotateCcw, Loader2, ListChecks, Megaphone, ChevronDown, NotebookPen, Bot } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { matchRecordByPhone, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import ClientOptionsModal from '@/components/clients/ClientOptionsModal';
import MessageThread from './MessageThread';
import Composer from './Composer';
import CompleteWhatsAppFollowupModal from './CompleteWhatsAppFollowupModal';
import LeadIntakeModal from './LeadIntakeModal';
import LogInteractionModal from './LogInteractionModal';
import StudyJobCard from './StudyJobCard';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import { buildDetailedClientPrefChips, buildGeoNameMap, type ClientPrefDetailChip } from '../lib/prefChips';

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
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const markChatAsRead = useAppStore((s) => s.markChatAsRead);
  const patchChat = useAppStore((s) => s.patchChat);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const record = useMemo(() => {
    if (!chatsModel) return null;
    return (records[chatsModel.id] ?? []).find((r) => r.id === recordId) ?? null;
  }, [chatsModel, records, recordId]);

  const data = record?.data as Record<string, unknown> | undefined;
  const chatWid = (data?.wid as string | undefined) ?? null;
  const name = (data?.name as string | null | undefined) ?? (data?.phone as string | null | undefined) ?? '—';
  const phone = (data?.phone as string | null | undefined) ?? null;
  const kind = (data?.kind as string | null | undefined) ?? 'user';
  const status = (data?.status as string | null | undefined) ?? 'active';
  const lastMessageAt = (data?.last_message_at as string | null | undefined) ?? null;
  const clientLinkId = (data?.client_link as string | null | undefined) ?? null;
  // AI takeover for THIS conversation (set from the header toggle). While on,
  // the agent answers every inbound message regardless of global policy.
  const aiManaged = (data?.ai_managed as boolean | undefined) === true;

  // Look up the linked client (if any) so we can render its name without
  // a round-trip. `records.clients` is already in the store.
  const linkedClient = useAppStore((s) => {
    if (!clientLinkId) return null;
    const clientsModel = s.models.find((m) => m.name === 'clients');
    if (!clientsModel) return null;
    return (s.records[clientsModel.id] ?? []).find((r) => r.id === clientLinkId) ?? null;
  });
  const linkedClientData = linkedClient ? (linkedClient.data as Record<string, unknown>) : null;
  const linkedClientName =
    (linkedClientData?.client_name as string | null | undefined) ??
    (linkedClientData?.name as string | null | undefined) ??
    null;

  // Detailed preference chips for the linked client (unit type, budget,
  // bedrooms, area, location, direction, amenities, …). Same source data as
  // the list-pane chips, just the full set.
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);
  const prefChips = useMemo<ClientPrefDetailChip[]>(
    () => (linkedClientData ? buildDetailedClientPrefChips(linkedClientData, clientsModel, geoNames, isAr) : []),
    [linkedClientData, clientsModel, geoNames, isAr],
  );

  // Full client record in a NEW TAB (explicitly not a modal / same-tab nav).
  const clientRecordUrl = clientLinkId ? `/model/clients/${clientLinkId}` : null;

  // Advertiser whose phone matches this chat — computed live (nothing is
  // stored on the chat), so a fresh REGA lookup links instantly.
  const matchedAdvertiser = useMemo(() => {
    const advertisersModel = models.find((m) => m.name === 'advertisers') ?? null;
    if (!advertisersModel || !phone) return null;
    return matchRecordByPhone(phone, records[advertisersModel.id] ?? [], phoneFieldSlugs(advertisersModel));
  }, [models, records, phone]);
  const matchedAdvertiserName = matchedAdvertiser
    ? ((matchedAdvertiser.data as Record<string, unknown>).name as string | null) ?? null
    : null;

  // Client-options popup (options list + embedded Project Finder).
  const [showClientOptions, setShowClientOptions] = useState(false);
  // Mobile-only: preference chips collapse behind a toggle so a long
  // preference list doesn't shrink the thread. Desktop always shows them.
  const [prefsExpanded, setPrefsExpanded] = useState(false);
  // "Complete WhatsApp Follow-Up" popup (shown when Done/Resolve is clicked and
  // an active WhatsApp follow-up exists for the linked client).
  const [showCompleteFollowup, setShowCompleteFollowup] = useState(false);
  // Assisted lead capture (unlinked chat → propose + approve a client).
  const [showLeadIntake, setShowLeadIntake] = useState(false);
  // "Log an interaction" — record an off-task call/visit result.
  const [showLogInteraction, setShowLogInteraction] = useState(false);

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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-sand/20 shrink-0 flex items-start gap-3">
        {/* Back (mobile only — desktop shows split view) */}
        <button
          onClick={() => navigate('/model/chats')}
          className="md:hidden -ms-1 p-1.5 rounded-lg text-charcoal/60 hover:text-copper hover:bg-cream transition-colors"
          aria-label={isAr ? 'رجوع' : 'Back'}
        >
          <BackIcon size={18} />
        </button>
        {clientRecordUrl ? (
          <a
            href={clientRecordUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-10 h-10 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0 font-semibold hover:bg-copper/20 transition-colors"
            title={isAr ? 'فتح ملف العميل في تبويب جديد' : 'Open client record in a new tab'}
          >
            {(name.trim().charAt(0) || '#').toUpperCase()}
          </a>
        ) : (
          <div className="w-10 h-10 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0 font-semibold">
            {(name.trim().charAt(0) || '#').toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {clientRecordUrl ? (
              <a
                href={clientRecordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base font-bold text-chocolate truncate hover:text-copper transition-colors"
                title={isAr ? 'فتح ملف العميل في تبويب جديد' : 'Open client record in a new tab'}
              >
                {name}
              </a>
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
          <div className="flex items-center gap-3 mt-1 text-[11px] text-charcoal/50 flex-wrap">
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
          {/* Client link row — either opens the matched client's full record
              in a new tab or offers to create a new one from this phone. A
              phone-matched advertiser (REGA lookup) gets its own link
              alongside. */}
          <div className="flex items-center gap-2 mt-1.5 text-xs flex-wrap">
            {matchedAdvertiser && (
              <button
                onClick={() => navigate(`/model/advertisers/${matchedAdvertiser.id}`)}
                className="inline-flex items-center gap-1.5 rounded-full bg-gold/20 px-2 py-0.5 font-medium text-chocolate transition-colors hover:bg-gold/30"
                title={isAr ? 'فتح بطاقة المعلن' : 'Open advertiser record'}
              >
                <Megaphone size={12} />
                <span className="truncate max-w-[220px]">
                  {isAr ? 'معلن: ' : 'Advertiser: '}
                  {matchedAdvertiserName ?? (isAr ? 'عرض البطاقة' : 'open record')}
                </span>
              </button>
            )}
            {clientRecordUrl ? (
              <>
                <a
                  href={clientRecordUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-copper hover:text-terracotta font-medium"
                  title={isAr ? 'فتح ملف العميل في تبويب جديد' : 'Open client record in a new tab'}
                >
                  <User size={12} />
                  <span className="truncate max-w-[220px]">
                    {isAr ? 'عميل مرتبط: ' : 'Linked client: '}
                    {linkedClientName ?? (isAr ? 'عرض البطاقة' : 'open record')}
                  </span>
                </a>
                <button
                  onClick={() => setShowClientOptions(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 px-2 py-0.5 font-medium text-copper transition-colors hover:bg-copper/10"
                  title={isAr ? 'عرض خيارات العميل والبحث عن المزيد' : 'View client options & find more'}
                >
                  <ListChecks size={12} />
                  {isAr ? 'خيارات العميل' : 'Client options'}
                </button>
                <button
                  onClick={() => setShowLogInteraction(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 font-medium text-[#8a6a2f] transition-colors hover:bg-gold/20"
                  title={isAr ? 'تسجيل مكالمة أو تواصل خارج المهام' : 'Log a call or other interaction'}
                >
                  <NotebookPen size={12} />
                  {isAr ? 'تسجيل تواصل' : 'Log interaction'}
                </button>
                <AiHandoverButton chatRecordId={recordId} aiManaged={aiManaged} isAr={isAr} />
              </>
            ) : (
              <button
                onClick={() => setShowLeadIntake(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-copper/40 bg-copper/10 px-2 py-0.5 font-medium text-copper transition-colors hover:bg-copper/20"
                title={isAr ? 'إنشاء عميل من هذا الرقم وبدء المتابعة' : 'Create a client from this phone and start the follow-up'}
              >
                <UserPlus size={12} />
                {isAr ? 'عميل محتمل؟ إنشاء وبدء المتابعة' : 'Potential lead? Create & start follow-up'}
              </button>
            )}
          </div>
          {/* Client preference chips — the full preference picture (unit type,
              budget, bedrooms, area, location, direction, amenities, notes…).
              Preferences only; chat labels/tags deliberately don't render here.
              On mobile they collapse behind a count toggle so a long preference
              list doesn't push the thread off-screen; desktop always shows them. */}
          {prefChips.length > 0 && (
            <>
              <button
                onClick={() => setPrefsExpanded((v) => !v)}
                className="md:hidden mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-charcoal/60 hover:text-copper transition-colors"
                aria-expanded={prefsExpanded}
              >
                <ChevronDown
                  size={12}
                  className={`transition-transform ${prefsExpanded ? 'rotate-180' : ''}`}
                />
                {isAr ? `التفضيلات (${prefChips.length})` : `Preferences (${prefChips.length})`}
              </button>
              <div className={`${prefsExpanded ? 'flex' : 'hidden'} md:flex items-center gap-1 mt-2 flex-wrap`}>
                {prefChips.map((chip) => (
                  <span
                    key={chip.key}
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded truncate max-w-[240px] ${DETAIL_CHIP_STYLES[chip.kind]}`}
                    title={chip.title ?? chip.text}
                  >
                    {chip.text}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Done / Reopen — one click closes the finished conversation. When an
            active WhatsApp follow-up exists, Done opens the completion popup
            (records the outcome on the task) instead of silently resolving. */}
        <DoneButton
          chatWid={chatWid}
          status={status}
          isAr={isAr}
          onChange={requestStatusChange}
        />
      </div>

      {/* App-triggered client study (claude_jobs) — button + status/review
          strip. Client-linked chats only: a study is a client deliverable. */}
      {clientLinkId && <StudyJobCard chatRecordId={recordId} />}

      {/* Thread (scrolls within its own card) */}
      <div className="flex-1 min-h-0 overflow-hidden px-3 pt-3">
        <MessageThread chatWid={chatWid ?? ''} />
      </div>

      {/* Composer */}
      <div className="px-3 pb-3 shrink-0">
        <Composer chatWid={chatWid ?? ''} disabled={kind !== 'user'} />
        {kind !== 'user' && (
          <p className="text-xs text-charcoal/40 mt-1 text-center">
            {isAr
              ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا.'
              : 'Sending to groups and channels is not yet supported.'}
          </p>
        )}
      </div>

      {/* Client-options popup — the client's saved options with the Project
          Finder embedded, without leaving the conversation. */}
      {showClientOptions && clientLinkId && (
        <ClientOptionsModal clientId={clientLinkId} onClose={() => setShowClientOptions(false)} />
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
}: {
  chatWid: string | null;
  status: string;
  isAr: boolean;
  onChange: (status: 'active' | 'resolved') => Promise<void>;
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
      className={`self-start shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${
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
