import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MessageCircle, Phone, Hash, Star, User, UserPlus, Check, CheckCheck, RotateCcw, Loader2, ListChecks } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import ClientOptionsModal from '@/components/clients/ClientOptionsModal';
import MessageThread from './MessageThread';
import Composer from './Composer';
import { buildDetailedClientPrefChips, buildGeoNameMap, type ClientPrefDetailChip } from '../lib/prefChips';

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

  // Client-options popup (options list + embedded Project Finder).
  const [showClientOptions, setShowClientOptions] = useState(false);

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  // Zero out unread_count whenever we open this chat.
  useEffect(() => {
    if (chatWid) markChatAsRead(chatWid);
  }, [chatWid, markChatAsRead]);

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
              onChange={(next) => patchChat(chatWid ?? '', { status: next })}
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
              in a new tab or offers to create a new one from this phone. */}
          <div className="flex items-center gap-2 mt-1.5 text-xs flex-wrap">
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
              </>
            ) : (
              <button
                onClick={() => navigate('/model/clients/new')}
                className="inline-flex items-center gap-1.5 text-charcoal/60 hover:text-copper"
                title={isAr ? 'إنشاء عميل جديد من هذا الرقم' : 'Create a client from this phone'}
              >
                <UserPlus size={12} />
                {isAr ? 'لا يوجد عميل مرتبط — إنشاء' : 'No linked client — create'}
              </button>
            )}
          </div>
          {/* Client preference chips — the full preference picture (unit type,
              budget, bedrooms, area, location, direction, amenities, notes…).
              Preferences only; chat labels/tags deliberately don't render here. */}
          {prefChips.length > 0 && (
            <div className="flex items-center gap-1 mt-2 flex-wrap">
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
          )}
        </div>

        {/* Done / Reopen — one click closes the finished conversation. */}
        <DoneButton
          chatWid={chatWid}
          status={status}
          isAr={isAr}
          onChange={(next) => patchChat(chatWid ?? '', { status: next })}
        />
      </div>

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
