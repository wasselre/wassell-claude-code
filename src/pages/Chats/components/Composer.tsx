import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Loader2, Paperclip, X, Image as ImageIcon, FileText, Video, Mic, MessageSquare, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { uploadFile, listScheduledMessages, cancelScheduledMessage } from '@/lib/haberchat/client';
import {
  loadDraftText, saveDraftText,
  loadDraftTemplateMeta, saveDraftTemplateMeta,
  loadDraftFile, saveDraftFile, clearDraftFile, clearDraft,
} from '../lib/drafts';
import { sendProjectImageMessages } from '@/lib/projectMessageImages';
import TemplatePickerModal from './TemplatePickerModal';
import SchedulePopover, { formatScheduleTime } from './SchedulePopover';
import type { ChatMessage, ScheduledChatMessage } from '@/types';

/**
 * Composer — textarea + attach + templates + send. Supports two kinds
 * of attachments:
 *   • Local file (from the paperclip / file picker). Uploaded on Send.
 *   • Pre-uploaded (from a template). Already has a Haberchat fileId,
 *     no re-upload at send time.
 * Both are mutually exclusive (picking from one path clears the other).
 */

type LocalAttachment = { kind: 'local'; file: File };
type TemplateAttachment = {
  kind: 'template';
  fileId: string;
  mime: string | null;
  size: number | null;
  filename: string | null;
  mediaKind: string | null;
};
type Attachment = LocalAttachment | TemplateAttachment;

export default function Composer({
  chatWid,
  disabled = false,
}: {
  chatWid: string;
  disabled?: boolean;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);
  const addToast = useAppStore((s) => s.addToast);

  // Draft restore is SYNCHRONOUS for text (lazy initial state) so a saved draft
  // paints on first render — no flash of an empty box before it appears.
  const [text, setText] = useState(() => loadDraftText(chatWid));
  const [attachment, setAttachment] = useState<Attachment | null>(() => {
    const meta = loadDraftTemplateMeta(chatWid);
    return meta ? { kind: 'template', ...meta } : null;
  });
  // Templates can carry images that ride along as their own image messages
  // after the text/single-media send: a project template's gallery (CRM file
  // ids) or a listing template's cleaned photos (public URLs). Set when such
  // a template is picked; cleared on send or when a local file replaces it.
  const [projectImageFileIds, setProjectImageFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  // Bumped after schedule/cancel so the scheduled strip re-fetches.
  const [scheduledRefreshKey, setScheduledRefreshKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Recipient phone + send-from device for this chat — same resolution as
  // appStore.sendChatMessage. Needed to query Haberchat's queue for the
  // scheduled-messages strip.
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const waDevices = useAppStore((s) => s.waDevices);
  const waDevicesLive = useAppStore((s) => s.waDevicesLive);
  const { chatPhone, deviceId } = useMemo(() => {
    const chatsModel = models.find((m) => m.name === 'chats');
    const record = chatsModel
      ? (records[chatsModel.id] ?? []).find((r) => (r.data as Record<string, unknown>).wid === chatWid)
      : undefined;
    const data = (record?.data ?? {}) as Record<string, unknown>;
    const phone = typeof data.phone === 'string' && data.phone ? data.phone : null;
    const recordDeviceId = typeof data.device_id === 'string' && data.device_id ? data.device_id : null;
    // Defensive ?? [] — a failed device load can leave these undefined.
    const resolvedDevice =
      recordDeviceId ??
      (waDevices ?? []).find((d) => d.is_default && d.is_active)?.device_id ??
      (waDevices ?? []).find((d) => d.is_active)?.device_id ??
      (waDevicesLive ?? [])[0]?.id ??
      null;
    return { chatPhone: phone, deviceId: resolvedDevice };
  }, [models, records, waDevices, waDevicesLive, chatWid]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  // ─── Draft persistence ────────────────────────────────────────────
  // Switching conversations: swap in that chat's draft. (The initial state
  // above covers first mount; this covers navigating between chats without a
  // remount.) `chatWid` is intentionally the only dependency — reacting to
  // text/attachment here would clobber what the user is typing.
  useEffect(() => {
    setText(loadDraftText(chatWid));
    const meta = loadDraftTemplateMeta(chatWid);
    setAttachment(meta ? { kind: 'template', ...meta } : null);
    let cancelled = false;
    // A locally-picked file lives in IndexedDB (async). Only apply it if no
    // template attachment claimed the slot and we're still on this chat.
    void loadDraftFile(chatWid).then((file) => {
      if (cancelled || !file || meta) return;
      setAttachment({ kind: 'local', file });
    });
    return () => { cancelled = true; };
  }, [chatWid]);

  // Persist the text as it's typed (debounced — one write per pause, not per
  // keystroke).
  useEffect(() => {
    const t = setTimeout(() => saveDraftText(chatWid, text), 300);
    return () => clearTimeout(t);
  }, [chatWid, text]);

  // Persist the attachment whenever it changes. A local file goes to
  // IndexedDB; a template attachment is just a reference in localStorage.
  useEffect(() => {
    if (!attachment) {
      saveDraftTemplateMeta(chatWid, null);
      void clearDraftFile(chatWid);
      return;
    }
    if (attachment.kind === 'template') {
      const { kind: _k, ...meta } = attachment;
      saveDraftTemplateMeta(chatWid, meta);
      void clearDraftFile(chatWid);
    } else {
      saveDraftTemplateMeta(chatWid, null);
      void saveDraftFile(chatWid, attachment.file);
    }
  }, [chatWid, attachment]);

  const canSend =
    (text.trim().length > 0 || attachment !== null || projectImageFileIds.length > 0) && !sending && !disabled;

  const kindForLocalFile = (file: File): ChatMessage['kind'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'document';
  };

  /**
   * Send now (no arg) or schedule (future ISO datetime). Scheduled sends
   * go to Haberchat's delivery queue — no thread bubble until delivery.
   */
  const doSend = async (deliverAt?: string) => {
    if (!canSend) return;
    const body = text.trim();
    const att = attachment;
    const projectImages = projectImageFileIds;
    setSending(true);
    setShowSchedule(false);
    setText('');
    setAttachment(null);
    setProjectImageFileIds([]);
    // The message is on its way — drop the stored draft so it can't come back
    // on the next visit. (The state resets above race the persistence effects,
    // so clear the stores explicitly rather than relying on them.)
    void clearDraft(chatWid);
    try {
      if (att?.kind === 'local') {
        // Upload first, then send. Spinner on the send button covers the wait.
        const uploaded = await uploadFile(att.file);
        await sendChatMessage(chatWid, {
          body: body || undefined,
          mediaFileId: uploaded.fileId,
          mediaCaption: body || undefined,
          kind: kindForLocalFile(att.file),
          mediaMime: uploaded.mime ?? att.file.type,
          mediaSize: uploaded.size ?? att.file.size,
          deliverAt,
        });
      } else if (att?.kind === 'template') {
        // Reuse the template's pre-uploaded Haberchat file — no upload needed.
        const kind = (att.mediaKind as ChatMessage['kind']) || 'document';
        await sendChatMessage(chatWid, {
          body: body || undefined,
          mediaFileId: att.fileId,
          mediaCaption: body || undefined,
          kind,
          mediaMime: att.mime,
          mediaSize: att.size,
          deliverAt,
        });
      } else if (body) {
        await sendChatMessage(chatWid, { body, deliverAt });
      }
      // Project gallery rides along as its own image messages after the text.
      // Scheduled sends stagger each image a few seconds after the text so
      // the queue delivers them in order. NOT awaited — the composer frees up
      // right after the text send; the fan-out is ONE keepalive request to
      // /api/whatsapp/send-media-batch, so the server completes the sends even
      // if the tab refreshes (failures toast from inside the lib).
      // Immediate sends surface progress as bubbles landing in the thread;
      // scheduled ones re-sync the strip when the fan-out completes.
      if (projectImages.length > 0) {
        void sendProjectImageMessages(chatWid, projectImages, { deliverAt }).then(() => {
          if (deliverAt) setScheduledRefreshKey((k) => k + 1);
        });
        if (!deliverAt) {
          addToast(
            isAr
              ? `تُرسل ${projectImages.length} من الوسائط في الخلفية`
              : `Sending ${projectImages.length} media message(s) in the background`,
            'info',
          );
        }
      }
      if (deliverAt) {
        addToast(
          isAr
            ? `تمت الجدولة — سترسل ${formatScheduleTime(deliverAt, true)}`
            : `Scheduled — will send ${formatScheduleTime(deliverAt, false)}`,
          'success',
        );
        setScheduledRefreshKey((k) => k + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Immediate text sends are toasted by the store; attachment uploads
      // and scheduled sends surface here.
      if (att || deliverAt) addToast(msg, 'error');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      addToast(isAr ? 'حجم الملف أكبر من 10 ميغابايت' : 'File is larger than 10 MB', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setAttachment({ kind: 'local', file: f });
    setProjectImageFileIds([]); // a manually attached file replaces a template gallery
    textareaRef.current?.focus();
  };

  const handleTemplatePicked = (picked: {
    body: string;
    mediaFileId: string | null;
    mediaMime: string | null;
    mediaSize: number | null;
    mediaFilename: string | null;
    mediaKind: string | null;
    imageFileIds: string[];
  }) => {
    // Fill the textarea with the template body; user can edit before
    // sending. If the user already had text, replace — the picker is an
    // explicit action, not an append.
    setText(picked.body);
    if (picked.mediaFileId) {
      setAttachment({
        kind: 'template',
        fileId: picked.mediaFileId,
        mime: picked.mediaMime,
        size: picked.mediaSize,
        filename: picked.mediaFilename,
        mediaKind: picked.mediaKind,
      });
    } else {
      setAttachment(null);
    }
    // Project gallery (if any) sends as separate image messages on Send.
    setProjectImageFileIds(picked.imageFileIds ?? []);
    setShowPicker(false);
    textareaRef.current?.focus();
  };

  return (
    <>
      {showPicker && (
        <TemplatePickerModal
          currentLanguage={isAr ? 'ar' : 'en'}
          onClose={() => setShowPicker(false)}
          onPick={handleTemplatePicked}
        />
      )}

      <div className="card p-3 mt-3 flex flex-col gap-2">
        {/* Scheduled messages waiting in Haberchat's queue for THIS chat. */}
        <ScheduledStrip
          deviceId={deviceId}
          phone={chatPhone}
          refreshKey={scheduledRefreshKey}
          isAr={isAr}
        />

        {attachment && <AttachmentChip attachment={attachment} isAr={isAr} onRemove={() => setAttachment(null)} />}

        {projectImageFileIds.length > 0 && (
          <div className="flex items-center gap-2 bg-copper/5 border border-copper/20 rounded-lg px-2 py-1.5">
            <div className="w-7 h-7 rounded-lg bg-copper/10 flex items-center justify-center shrink-0">
              <ImageIcon size={14} className="text-copper" />
            </div>
            <div className="flex-1 min-w-0 text-xs text-charcoal/70">
              {isAr
                ? `سترسل ${projectImageFileIds.length} صورة بعد الرسالة`
                : `${projectImageFileIds.length} image${projectImageFileIds.length === 1 ? '' : 's'} will be sent after the message`}
            </div>
            <button
              onClick={() => setProjectImageFileIds([])}
              className="p-1 rounded text-charcoal/50 hover:text-red-600 hover:bg-red-50 transition-colors"
              aria-label={isAr ? 'إزالة الصور' : 'Remove images'}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Attach file */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || disabled}
            className="shrink-0 w-9 h-9 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream disabled:text-charcoal/20 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            aria-label={isAr ? 'إرفاق ملف' : 'Attach file'}
            title={isAr ? 'إرفاق ملف' : 'Attach file'}
            type="button"
          >
            <Paperclip size={16} />
          </button>

          {/* Templates */}
          <button
            onClick={() => setShowPicker(true)}
            disabled={sending || disabled}
            className="shrink-0 w-9 h-9 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream disabled:text-charcoal/20 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            aria-label={isAr ? 'قوالب' : 'Templates'}
            title={isAr ? 'قوالب الرسائل' : 'Message templates'}
            type="button"
          >
            <MessageSquare size={16} />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,video/*,audio/*,.pdf,.docx,.xlsx,.pptx,.zip,.txt"
            onChange={onFilePicked}
          />

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              attachment
                ? (isAr ? 'أضف تعليقًا (اختياري)...' : 'Add a caption (optional)…')
                : (isAr ? 'اكتب رسالتك...' : 'Type a message…')
            }
            disabled={sending || disabled}
            rows={1}
            className="flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus:outline-none leading-relaxed"
            dir="auto"
          />
          {/* Schedule — hand the composed message (incl. any gallery, which
              is staggered after the text) to Haberchat's delivery queue. */}
          <div className="relative shrink-0">
            <button
              onClick={() => setShowSchedule((v) => !v)}
              disabled={!canSend}
              className="w-9 h-9 rounded-full text-charcoal/60 hover:text-copper hover:bg-cream disabled:text-charcoal/20 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              aria-label={isAr ? 'جدولة الرسالة' : 'Schedule message'}
              title={isAr ? 'جدولة الإرسال لوقت لاحق' : 'Schedule for later'}
              type="button"
            >
              <Clock size={16} />
            </button>
            {showSchedule && (
              <SchedulePopover
                isAr={isAr}
                onClose={() => setShowSchedule(false)}
                onConfirm={(iso) => void doSend(iso)}
              />
            )}
          </div>

          <button
            onClick={() => void doSend()}
            disabled={!canSend}
            className="shrink-0 w-10 h-10 rounded-full bg-copper text-white hover:bg-terracotta disabled:bg-charcoal/20 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            aria-label={isAr ? 'إرسال' : 'Send'}
            title={isAr ? 'إرسال (Enter)' : 'Send (Enter)'}
            type="button"
          >
            {sending ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Send size={16} className={isAr ? 'rotate-180' : ''} />
            )}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Scheduling ─────────────────────────────────────────────────────

/**
 * Chips for scheduled messages waiting in Haberchat's queue for this chat.
 * Hidden when empty. Each chip shows the delivery time + body preview and
 * cancels with one click (DELETE while still queued).
 */
function ScheduledStrip({
  deviceId,
  phone,
  refreshKey,
  isAr,
}: {
  deviceId: string | null;
  phone: string | null;
  refreshKey: number;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [items, setItems] = useState<ScheduledChatMessage[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelingAll, setCancelingAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    if (!deviceId || !phone) return;
    try {
      const messages = await listScheduledMessages(deviceId, phone);
      if (!signal.cancelled) {
        setItems(messages);
        setLoadFailed(false);
      }
    } catch (err) {
      // Inline (not toast) — this fires on every chat open; a flaky queue
      // read shouldn't spam. Still visible + logged, never silent.
      console.error('[ScheduledStrip] failed to load scheduled messages', err);
      if (!signal.cancelled) setLoadFailed(true);
    }
  }, [deviceId, phone]);

  useEffect(() => {
    const signal = { cancelled: false };
    setItems([]);
    setLoadFailed(false);
    setExpanded(false);
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [load, refreshKey, localRefresh]);

  const cancel = async (id: string) => {
    setCancelingId(id);
    try {
      await cancelScheduledMessage(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
      addToast(isAr ? 'أُلغيت الرسالة المجدولة' : 'Scheduled message canceled', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
      // The queue may have already delivered it — re-sync.
      setLocalRefresh((k) => k + 1);
    } finally {
      setCancelingId(null);
    }
  };

  const cancelAll = async () => {
    if (cancelingAll) return;
    setCancelingAll(true);
    let failed = 0;
    for (const m of items) {
      try {
        await cancelScheduledMessage(m.id);
        setItems((prev) => prev.filter((x) => x.id !== m.id));
      } catch {
        failed++;
      }
    }
    setCancelingAll(false);
    if (failed > 0) {
      addToast(
        isAr ? `تعذّر إلغاء ${failed} من الرسائل المجدولة` : `Couldn't cancel ${failed} scheduled message(s)`,
        'error',
      );
      // Some may have already delivered — re-sync with the queue.
      setLocalRefresh((k) => k + 1);
    } else {
      addToast(isAr ? 'أُلغيت كل الرسائل المجدولة' : 'All scheduled messages canceled', 'success');
    }
  };

  if (loadFailed) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-charcoal/50 bg-cream/50 rounded-lg px-2 py-1.5">
        <Clock size={12} className="shrink-0" />
        <span className="flex-1">
          {isAr ? 'تعذر تحميل الرسائل المجدولة' : 'Couldn’t load scheduled messages'}
        </span>
        <button
          onClick={() => setLocalRefresh((k) => k + 1)}
          className="font-medium text-copper hover:text-terracotta"
          type="button"
        >
          {isAr ? 'إعادة المحاولة' : 'Retry'}
        </button>
      </div>
    );
  }

  if (items.length === 0) return null;

  const chip = (m: ScheduledChatMessage) => (
    <div
      key={m.id}
      className="flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-lg px-2 py-1.5"
    >
      <div className="w-7 h-7 rounded-lg bg-gold/20 flex items-center justify-center shrink-0">
        <Clock size={13} className="text-chocolate" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-bold text-chocolate">
          {isAr ? 'مجدولة — ' : 'Scheduled — '}
          {m.deliverAt ? formatScheduleTime(m.deliverAt, isAr) : (isAr ? 'قريبًا' : 'soon')}
        </div>
        <div className="text-xs text-charcoal/70 truncate">
          {m.hasMedia && (
            <span className="text-charcoal/50 me-1">
              {isAr ? '📎 مرفق' : '📎 attachment'}
            </span>
          )}
          {m.body ?? ''}
        </div>
      </div>
      <button
        onClick={() => void cancel(m.id)}
        disabled={cancelingId === m.id || cancelingAll}
        className="p-1 rounded text-charcoal/50 hover:text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors shrink-0"
        aria-label={isAr ? 'إلغاء الرسالة المجدولة' : 'Cancel scheduled message'}
        title={isAr ? 'إلغاء الجدولة' : 'Cancel'}
        type="button"
      >
        {cancelingId === m.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
      </button>
    </div>
  );

  // Up to 2 queued messages render as full chips. More (e.g. a listing
  // message's photo gallery = 1 text + ~9 media) collapse into ONE compact
  // summary row so the thread stays usable — expandable to a scrollable
  // list, with a cancel-all.
  if (items.length <= 2) {
    return <div className="flex flex-col gap-1">{items.map(chip)}</div>;
  }

  const mediaCount = items.filter((m) => m.hasMedia).length;
  const firstAt = items[0]?.deliverAt ?? null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-lg px-2 py-1.5">
        <div className="w-7 h-7 rounded-lg bg-gold/20 flex items-center justify-center shrink-0">
          <Clock size={13} className="text-chocolate" />
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 text-start"
          type="button"
        >
          <div className="text-[11px] font-bold text-chocolate">
            {isAr ? `${items.length} رسائل مجدولة` : `${items.length} scheduled messages`}
            {mediaCount > 0 && (
              <span className="text-charcoal/50 font-normal ms-1">
                {isAr ? `(منها ${mediaCount} مرفق)` : `(${mediaCount} with media)`}
              </span>
            )}
          </div>
          <div className="text-xs text-charcoal/70 truncate">
            {isAr ? 'أولها ' : 'First '}
            {firstAt ? formatScheduleTime(firstAt, isAr) : (isAr ? 'قريبًا' : 'soon')}
            <span className="text-copper ms-1">{expanded ? (isAr ? '· إخفاء' : '· hide') : (isAr ? '· عرض الكل' : '· show all')}</span>
          </div>
        </button>
        <button
          onClick={() => void cancelAll()}
          disabled={cancelingAll}
          className="shrink-0 text-[11px] font-medium text-charcoal/60 hover:text-red-600 hover:bg-red-50 rounded px-2 py-1 disabled:opacity-50 transition-colors inline-flex items-center gap-1"
          type="button"
        >
          {cancelingAll ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          {isAr ? 'إلغاء الكل' : 'Cancel all'}
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-1 max-h-44 overflow-y-auto pe-0.5">
          {items.map(chip)}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({
  attachment,
  isAr,
  onRemove,
}: {
  attachment: Attachment;
  isAr: boolean;
  onRemove: () => void;
}) {
  const { name, sizeBytes, mime } = attachmentMeta(attachment);
  const Icon = mime?.startsWith('image/')
    ? ImageIcon
    : mime?.startsWith('video/')
      ? Video
      : mime?.startsWith('audio/')
        ? Mic
        : FileText;

  // Preview the ACTUAL bytes before sending, so nobody fires off the wrong
  // photo. Only a locally-picked file has bytes in the browser; a template
  // attachment is a server-side reference and keeps the compact chip.
  const localFile = attachment.kind === 'local' ? attachment.file : null;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!localFile) { setPreviewUrl(null); return; }
    const isPreviewable =
      localFile.type.startsWith('image/') ||
      localFile.type.startsWith('video/') ||
      localFile.type.startsWith('audio/');
    if (!isPreviewable) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(localFile);
    setPreviewUrl(url);
    // Revoke on swap/unmount — object URLs leak the whole file otherwise.
    return () => URL.revokeObjectURL(url);
  }, [localFile]);

  const sizeLabel = sizeBytes != null
    ? sizeBytes >= 1024 * 1024
      ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
      : `${(sizeBytes / 1024).toFixed(0)} KB`
    : '';

  return (
    <div className="bg-cream/60 rounded-lg p-2">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-charcoal/5 flex items-center justify-center shrink-0">
          <Icon size={14} className="text-charcoal/60" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-charcoal truncate">{name}</div>
          <div className="text-[10px] text-charcoal/50">
            {sizeLabel}
            {attachment.kind === 'template' && (
              <span className="ms-1 text-copper">· {isAr ? 'من قالب' : 'from template'}</span>
            )}
          </div>
        </div>
        <button
          onClick={onRemove}
          className="p-1 rounded text-charcoal/50 hover:text-red-600 hover:bg-red-50 transition-colors"
          aria-label={isAr ? 'إزالة المرفق' : 'Remove attachment'}
          type="button"
        >
          <X size={14} />
        </button>
      </div>

      {previewUrl && localFile && (
        <div className="mt-2">
          {localFile.type.startsWith('image/') && (
            <img
              src={previewUrl}
              alt={name}
              className="max-h-40 w-auto max-w-full rounded-lg border border-sand/40 object-contain"
            />
          )}
          {localFile.type.startsWith('video/') && (
            <video
              src={previewUrl}
              controls
              className="max-h-40 w-[260px] max-w-full rounded-lg border border-sand/40 bg-black"
            />
          )}
          {localFile.type.startsWith('audio/') && (
            <audio src={previewUrl} controls className="w-[260px] max-w-full" />
          )}
        </div>
      )}
    </div>
  );
}

function attachmentMeta(att: Attachment): { name: string; sizeBytes: number | null; mime: string | null } {
  if (att.kind === 'local') {
    return { name: att.file.name, sizeBytes: att.file.size, mime: att.file.type };
  }
  return { name: att.filename ?? 'attachment', sizeBytes: att.size, mime: att.mime };
}
