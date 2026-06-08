import { useState, useMemo, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Send, Loader2, User, UserCheck, Phone as PhoneIcon, MessageSquare, Pencil, AlertCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { normalizePhone } from '@/lib/phone';
import { resolveClientLink, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import PhoneInput from '@/pages/Records/components/PhoneInput';
import ClientPicker, { type PickedClient, resolveClientSlugs, recordToPickedClient } from './ClientPicker';
import TemplatePickerModal from './TemplatePickerModal';

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
export default function StartChatModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const waDevices = useAppStore((s) => s.waDevices);
  const startNewChat = useAppStore((s) => s.startNewChat);
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

  const [mode, setMode] = useState<Mode>('client');
  const [manualPhone, setManualPhone] = useState<string | undefined>(undefined); // E.164 from PhoneInput
  const [client, setClient] = useState<PickedClient | null>(null);
  const [body, setBody] = useState('');
  const [deviceId, setDeviceId] = useState<string>(defaultDevice?.device_id ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend || !normalizedRecipient) return;
    setSending(true);
    setError(null);
    try {
      const result = await startNewChat({
        phone: normalizedRecipient,
        body: body.trim(),
        deviceId: deviceId || undefined,
        // Explicit client selection links the conversation directly; manual
        // entry leaves linking to the phone-match heuristic in startNewChat.
        clientRecordId: mode === 'client' ? client?.recordId : undefined,
      });
      onClose();
      navigate(`/model/chats/${result.recordId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
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
              <button type="button" onClick={onClose} disabled={sending} className="btn-secondary">
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="submit" disabled={!canSend} className="btn-primary inline-flex items-center gap-1.5">
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {isAr ? 'إرسال' : 'Send'}
              </button>
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
