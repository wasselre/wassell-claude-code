import { useState, useMemo, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Send, Loader2, User, UserCheck, Phone as PhoneIcon, MessageSquare, Pencil, AlertCircle, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { normalizePhone } from '@/lib/phone';
import { sendProjectImageMessages } from '@/lib/projectMessageImages';
import { resolveClientLink, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import PhoneInput from '@/pages/Records/components/PhoneInput';
import Button from '@/components/ui/Button';
import ClientPicker, { type PickedClient, resolveClientSlugs, recordToPickedClient } from './ClientPicker';
import TemplatePickerModal from './TemplatePickerModal';
import SchedulePopover, { formatScheduleTime } from './SchedulePopover';

type Mode = 'client' | 'manual';

/**
 * "Start new chat" modal — triggered from the ChatList header. Two recipient
 * modes:
 *   • Existing client — search the Clients model (advanced search reusing the
 *     records-table engine), pick one, and the phone auto-fills (locked). The
 *     chosen client is linked to the new conversation directly.
 *   • Manual number — enter a country code + number (reuses PhoneInput).
 *
 * The message can be free text, a template, or a template the user edits. The
 * template picker inserts into the textarea (never auto-sends); the textarea
 * is always the source of truth. We POST the first message through the proxy
 * (which creates the conversation on Haberchat as a side-effect) and navigate
 * to the new chat detail.
 */
export default function StartChatModal({
  onClose,
  initialClient,
  initialPhone,
  initialBody,
  initialImageFileIds,
  onSent,
}: {
  onClose: () => void;
  /** Pre-select a client (opens in "existing client" mode, conversation linked). */
  initialClient?: PickedClient | null;
  /** Pre-fill a manual number when no client is supplied. */
  initialPhone?: string;
  /**
   * Pre-fill the first-message composer (e.g. a project's WhatsApp template,
   * surfaced from the Suggested Projects card). The textarea stays the source of
   * truth — the user can still edit before sending.
   */
  initialBody?: string;
  /**
   * CRM file ids of a linked project's gallery (project message templates).
   * After the first text message creates the conversation, each image is sent
   * as its own WhatsApp image message into it.
   */
  initialImageFileIds?: string[];
  /**
   * Called after the first message is sent with the new chat's record id. When
   * provided, the modal hands the conversation back to the caller INSTEAD of
   * navigating to the chats page — used by the Follow-up Workspace to open the
   * thread in a popup and keep the rep on the follow-up record.
   */
  onSent?: (recordId: string) => void;
}) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const waDevices = useAppStore((s) => s.waDevices);
  const startNewChat = useAppStore((s) => s.startNewChat);
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const activeDevices = useMemo(() => waDevices.filter((d) => d.is_active), [waDevices]);
  const defaultDevice = activeDevices.find((d) => d.is_default) ?? activeDevices[0] ?? null;

  // Clients data for the manual-entry "matches a client" hint. Scoped to what
  // the user may see (same as the picker), and the slug resolution + matcher
  // are shared with the picker / startNewChat so the hint can never disagree
  // with the link that actually gets written.
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);
  const scopedClients = useApplyViewScope(clientsModel, clientsModel ? (records[clientsModel.id] ?? []) : []);
  const clientSlugs = useMemo(() => resolveClientSlugs(clientsModel), [clientsModel]);
  const phoneSlugs = useMemo(() => phoneFieldSlugs(clientsModel), [clientsModel]);

  // Pre-connect when opened from elsewhere (e.g. the Follow-up Workspace's
  // WhatsApp button): a supplied client opens in 'client' mode already linked;
  // otherwise a supplied phone opens 'manual' mode pre-filled.
  const [mode, setMode] = useState<Mode>(initialClient ? 'client' : initialPhone ? 'manual' : 'client');
  const [manualPhone, setManualPhone] = useState<string | undefined>(
    () => (!initialClient && initialPhone ? normalizePhone(initialPhone) ?? undefined : undefined),
  ); // E.164 from PhoneInput
  const [client, setClient] = useState<PickedClient | null>(initialClient ?? null);
  const [body, setBody] = useState(initialBody ?? '');
  const [deviceId, setDeviceId] = useState<string>(defaultDevice?.device_id ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Resolve + validate the recipient phone for the current mode. Client mode
  // takes the auto-filled (locked) phone; manual mode takes the PhoneInput
  // value. Both run through the shared normalizePhone so validation matches
  // what actually gets sent.
  const recipientRaw = mode === 'client' ? (client?.phone ?? null) : (manualPhone ?? null);
  const normalizedRecipient = normalizePhone(recipientRaw ?? '');

  // If the manually-typed number matches an existing client, surface a chip so
  // the user can switch to that client (locked card) instead of messaging a
  // bare number. Uses the same digits-only matcher startNewChat uses to
  // auto-link, so the suggestion and the eventual link always agree.
  const manualMatch = useMemo<PickedClient | null>(() => {
    if (mode !== 'manual' || !normalizedRecipient) return null;
    const id = resolveClientLink(normalizedRecipient, scopedClients, phoneSlugs);
    if (!id) return null;
    const rec = scopedClients.find((c) => c.id === id);
    return rec ? recordToPickedClient(rec, clientSlugs, isAr) : null;
  }, [mode, normalizedRecipient, scopedClients, phoneSlugs, clientSlugs, isAr]);

  // A client was picked but has no usable phone on its record — block + explain
  // rather than letting Send look enabled and then fail.
  const clientMissingPhone = mode === 'client' && !!client && !normalizedRecipient;

  const messageOk = body.trim().length > 0;
  const recipientOk = !!normalizedRecipient;
  const canSend = recipientOk && messageOk && !sending;

  // Template insertion rules: empty textarea → insert directly; non-empty →
  // append below existing text (blank line between), never overwrite.
  const insertTemplate = (templateBody: string) => {
    if (!templateBody) {
      setShowTemplates(false);
      return;
    }
    setBody((prev) => (prev.trim() === '' ? templateBody : `${prev.trimEnd()}\n\n${templateBody}`));
    setShowTemplates(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const switchMode = (next: Mode) => {
    if (next === mode || sending) return;
    setMode(next);
    setError(null);
    // Clear the other mode's recipient so a stale value can't be sent.
    if (next === 'client') setManualPhone(undefined);
    else setClient(null);
  };

  /** Send now (no arg) or schedule (future ISO datetime — the message waits
   *  in Haberchat's delivery queue; the conversation still opens now). */
  const doSend = async (deliverAt?: string) => {
    if (!canSend || !normalizedRecipient) return;
    setSending(true);
    setShowSchedule(false);
    setError(null);
    try {
      const result = await startNewChat({
        phone: normalizedRecipient,
        body: body.trim(),
        deviceId: deviceId || undefined,
        // Explicit client selection links the conversation directly; manual
        // entry leaves linking to the phone-match heuristic in startNewChat.
        clientRecordId: mode === 'client' ? client?.recordId : undefined,
        deliverAt,
      });
      // Send the project gallery (if any) into the just-created conversation —
      // each image as its own WhatsApp message after the first text message
      // (scheduled sends stagger them after the text's delivery time).
      // NOT awaited: the modal closes right after the text message and the
      // media fan-out continues in the BACKGROUND (a beforeunload guard in
      // sendProjectImageMessages protects against closing the tab mid-send;
      // failures toast from inside the fan-out).
      // chatWid mirrors startNewChat's derivation from the canonical E.164.
      const galleryCount = initialImageFileIds?.length ?? 0;
      if (initialImageFileIds && galleryCount > 0) {
        const chatWid = `${normalizedRecipient.slice(1)}@c.us`;
        void sendProjectImageMessages(chatWid, initialImageFileIds, { deliverAt }).then(({ sent, failed }) => {
          if (sent > 0 && failed === 0) {
            addToast(
              deliverAt
                ? (isAr ? `تمت جدولة ${sent} من الوسائط` : `${sent} media message(s) scheduled`)
                : (isAr ? `أُرسلت ${sent} من الوسائط` : `${sent} media message(s) sent`),
              'success',
            );
          }
        });
      }
      if (deliverAt) {
        addToast(
          isAr
            ? `تمت الجدولة — سترسل ${formatScheduleTime(deliverAt, true)}`
            : `Scheduled — will send ${formatScheduleTime(deliverAt, false)}`,
          'success',
        );
      } else if (galleryCount > 0) {
        addToast(
          isAr
            ? `تُرسل ${galleryCount} من الوسائط في الخلفية — تابع عملك`
            : `Sending ${galleryCount} media message(s) in the background — keep working`,
          'info',
        );
      }
      if (onSent) {
        // Caller (e.g. the Follow-up Workspace) takes over — it closes this
        // modal and shows the thread in a popup, no navigation.
        onSent(result.recordId);
      } else {
        onClose();
        navigate(`/model/chats/${result.recordId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void doSend();
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget && !sending) onClose();
        }}
      >
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
            <h2 className="text-base font-bold text-chocolate flex-1">
              {isAr ? 'محادثة جديدة' : 'New conversation'}
            </h2>
            <button
              onClick={onClose}
              disabled={sending}
              className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
              aria-label={isAr ? 'إغلاق' : 'Close'}
            >
              <X size={16} />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
            {/* Recipient mode toggle */}
            <div className="flex rounded-lg bg-cream/60 p-1 text-sm">
              <button
                type="button"
                onClick={() => switchMode('client')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md font-medium transition-colors ${
                  mode === 'client' ? 'bg-white shadow-sm text-copper' : 'text-charcoal/60 hover:text-charcoal'
                }`}
              >
                <User size={14} />
                {isAr ? 'عميل موجود' : 'Existing client'}
              </button>
              <button
                type="button"
                onClick={() => switchMode('manual')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md font-medium transition-colors ${
                  mode === 'manual' ? 'bg-white shadow-sm text-copper' : 'text-charcoal/60 hover:text-charcoal'
                }`}
              >
                <PhoneIcon size={14} />
                {isAr ? 'رقم يدوي' : 'Manual number'}
              </button>
            </div>

            {/* Recipient input */}
            {mode === 'client' ? (
              client ? (
                <div className="flex items-center gap-2.5 bg-cream/50 rounded-lg px-3 py-2.5">
                  <div className="w-9 h-9 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0">
                    <User size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {client.code && (
                        <span className="font-mono font-bold text-copper text-xs" dir="ltr">
                          {client.code}
                        </span>
                      )}
                      <span className="font-semibold text-sm text-charcoal truncate">{client.name}</span>
                    </div>
                    <div className="text-xs text-charcoal/55 font-mono mt-0.5" dir="ltr">
                      {client.phone ?? (isAr ? 'لا يوجد رقم' : 'no phone')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setClient(null)}
                    disabled={sending}
                    className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-white transition-colors shrink-0"
                  >
                    <Pencil size={12} />
                    {isAr ? 'تغيير' : 'Change'}
                  </button>
                </div>
              ) : (
                <ClientPicker onPick={setClient} />
              )
            ) : (
              <div>
                <label className="block text-xs font-medium text-charcoal/70 mb-1">
                  {isAr ? 'رقم الواتساب' : 'WhatsApp phone number'}
                </label>
                <PhoneInput
                  value={manualPhone}
                  onChange={setManualPhone}
                  placeholder={isAr ? '5XX XXX XXX' : '5XX XXX XXX'}
                />
                <p className="text-[11px] text-charcoal/40 mt-1">
                  {isAr
                    ? 'اختر رمز الدولة وأدخل الرقم — يُدمجان قبل الإرسال.'
                    : 'Pick the country code and enter the number — they are combined before sending.'}
                </p>
                {manualMatch && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setMode('client');
                      setManualPhone(undefined);
                      setClient(manualMatch);
                    }}
                    className="mt-2 w-full flex items-center gap-2 text-xs text-copper bg-copper/5 hover:bg-copper/10 border border-copper/30 rounded-lg px-3 py-2 transition-colors text-start"
                  >
                    <UserCheck size={14} className="shrink-0" />
                    <span className="flex-1 min-w-0">
                      {isAr ? 'يطابق عميلًا مسجلًا: ' : 'Matches a saved client: '}
                      {manualMatch.code && (
                        <span className="font-mono font-bold" dir="ltr">
                          {manualMatch.code}{' '}
                        </span>
                      )}
                      <span className="font-semibold">{manualMatch.name}</span>
                      {' — '}
                      {isAr ? 'استخدام هذا العميل؟' : 'use this client?'}
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Client picked but no phone on record */}
            {clientMissingPhone && (
              <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>
                  {isAr
                    ? 'هذا العميل ليس لديه رقم جوال صالح. أضف رقمًا في بطاقة العميل أو استخدم «رقم يدوي».'
                    : 'This client has no valid phone number. Add one on the client record, or use “Manual number”.'}
                </span>
              </div>
            )}

            {/* Device picker (only if >1 active) */}
            {activeDevices.length > 1 && (
              <div>
                <label className="block text-xs font-medium text-charcoal/70 mb-1">
                  {isAr ? 'الإرسال من' : 'Send from'}
                </label>
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  className="form-input w-full text-sm"
                  disabled={sending}
                >
                  {activeDevices.map((d) => {
                    const label = (isAr ? d.friendly_name_ar : d.friendly_name_en) ?? d.phone;
                    return (
                      <option key={d.device_id} value={d.device_id}>
                        {label} — {d.phone}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Message */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-charcoal/70">
                  {isAr ? 'الرسالة الأولى' : 'First message'}
                </label>
                <button
                  type="button"
                  onClick={() => setShowTemplates(true)}
                  disabled={sending}
                  className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream transition-colors disabled:opacity-50"
                >
                  <MessageSquare size={13} />
                  {isAr ? 'إدراج قالب' : 'Insert template'}
                </button>
              </div>
              <textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={isAr ? 'اكتب الرسالة، أو أدرج قالبًا ثم عدّله…' : 'Type a message, or insert a template then edit it…'}
                rows={4}
                className="form-input w-full text-sm resize-none"
                disabled={sending}
                dir="auto"
              />
            </div>

            {error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Footer */}
            <div className="flex gap-2 justify-end pt-1">
              <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              {/* Schedule — same composed message, delivered later from
                  Haberchat's queue. The conversation still opens now. */}
              <div className="relative">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canSend}
                  onClick={() => setShowSchedule((v) => !v)}
                  title={isAr ? 'جدولة الإرسال لوقت لاحق' : 'Schedule for later'}
                >
                  <Clock size={14} />
                  {isAr ? 'جدولة' : 'Schedule'}
                </Button>
                {showSchedule && (
                  <SchedulePopover
                    isAr={isAr}
                    onClose={() => setShowSchedule(false)}
                    onConfirm={(iso) => void doSend(iso)}
                  />
                )}
              </div>
              <Button type="submit" variant="primary" disabled={!canSend}>
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {isAr ? 'إرسال' : 'Send'}
              </Button>
            </div>
          </form>
        </div>
      </div>

      {/* Template picker — rendered after the dialog so it stacks above it.
          Inserts the chosen template's text into the composer (text-only for
          a brand-new chat); the user can edit before sending. */}
      {showTemplates && (
        <TemplatePickerModal
          currentLanguage={isAr ? 'ar' : 'en'}
          onClose={() => setShowTemplates(false)}
          onPick={(picked) => insertTemplate(picked.body)}
        />
      )}
    </>
  );
}
