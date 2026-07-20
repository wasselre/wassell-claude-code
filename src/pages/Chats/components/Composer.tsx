import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Loader2, Paperclip, X, Image as ImageIcon, FileText, Video, Mic, MessageSquare, Clock, Play, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { uploadFile, listScheduledMessages, cancelScheduledMessage } from '@/lib/haberchat/client';
import {
  loadDraftText, saveDraftText,
  loadDraftTemplateMeta, saveDraftTemplateMeta,
  loadDraftFiles, saveDraftFiles, clearDraft,
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
  // A template attachment (single, pre-uploaded) and locally-picked FILES
  // (0..N) are mutually exclusive — picking one path clears the other.
  const [templateAtt, setTemplateAtt] = useState<TemplateAttachment | null>(() => {
    const meta = loadDraftTemplateMeta(chatWid);
    return meta ? { kind: 'template', ...meta } : null;
  });
  const [localFiles, setLocalFiles] = useState<File[]>([]);
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
    setTemplateAtt(meta ? { kind: 'template', ...meta } : null);
    setLocalFiles([]);
    let cancelled = false;
    // Locally-picked files live in IndexedDB (async). Only apply them if no
    // template attachment claimed the slot and we're still on this chat.
    void loadDraftFiles(chatWid).then((files) => {
      if (cancelled || files.length === 0 || meta) return;
      setLocalFiles(files);
    });
    return () => { cancelled = true; };
  }, [chatWid]);

  // Persist the text as it's typed (debounced — one write per pause, not per
  // keystroke).
  useEffect(() => {
    const t = setTimeout(() => saveDraftText(chatWid, text), 300);
    return () => clearTimeout(t);
  }, [chatWid, text]);

  // Persist attachments whenever they change. A template attachment is just a
  // reference in localStorage; local files go to IndexedDB.
  useEffect(() => {
    if (templateAtt) {
      const { kind: _k, ...meta } = templateAtt;
      saveDraftTemplateMeta(chatWid, meta);
    } else {
      saveDraftTemplateMeta(chatWid, null);
    }
  }, [chatWid, templateAtt]);

  useEffect(() => {
    void saveDraftFiles(chatWid, localFiles);
  }, [chatWid, localFiles]);

  const canSend =
    (text.trim().length > 0 || localFiles.length > 0 || templateAtt !== null || projectImageFileIds.length > 0) &&
    !sending && !disabled;

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
    const files = localFiles;
    const tmpl = templateAtt;
    const projectImages = projectImageFileIds;
    setSending(true);
    setShowSchedule(false);
    setText('');
    setLocalFiles([]);
    setTemplateAtt(null);
    setProjectImageFileIds([]);
    // The message is on its way — drop the stored draft so it can't come back
    // on the next visit. (The state resets above race the persistence effects,
    // so clear the stores explicitly rather than relying on them.)
    void clearDraft(chatWid);
    try {
      if (files.length > 0) {
        // Multiple files: the FIRST carries the text as its caption (like a
        // WhatsApp album caption); it's awaited so recipient/device errors
        // surface in place. The REST fan out in the BACKGROUND so the composer
        // frees up immediately — each uploaded then sent, in order.
        const first = files[0]!;
        const up0 = await uploadFile(first);
        await sendChatMessage(chatWid, {
          body: body || undefined,
          mediaFileId: up0.fileId,
          mediaCaption: body || undefined,
          kind: kindForLocalFile(first),
          mediaMime: up0.mime ?? first.type,
          mediaSize: up0.size ?? first.size,
          deliverAt,
        });
        const rest = files.slice(1);
        if (rest.length > 0) {
          void (async () => {
            for (let i = 0; i < rest.length; i++) {
              const f = rest[i]!;
              try {
                const up = await uploadFile(f);
                // Immediate sends go out now (order preserved by sequential
                // await); scheduled sends stagger +10s each so the queue keeps
                // order (queue order within the same second isn't guaranteed).
                const at = deliverAt
                  ? new Date(new Date(deliverAt).getTime() + (i + 1) * 10_000).toISOString()
                  : undefined;
                await sendChatMessage(chatWid, {
                  mediaFileId: up.fileId,
                  kind: kindForLocalFile(f),
                  mediaMime: up.mime ?? f.type,
                  mediaSize: up.size ?? f.size,
                  deliverAt: at,
                });
              } catch (e) {
                addToast(
                  isAr ? `تعذّر إرسال ${f.name}` : `Failed to send ${f.name}`,
                  'error',
                );
                console.error('[composer] fan-out send failed:', e);
              }
            }
            if (deliverAt) setScheduledRefreshKey((k) => k + 1);
          })();
          addToast(
            isAr
              ? `تُرسل ${rest.length} ملفات إضافية في الخلفية`
              : `Sending ${rest.length} more file(s) in the background`,
            'info',
          );
        }
      } else if (tmpl) {
        // Reuse the template's pre-uploaded file — no upload needed.
        const kind = (tmpl.mediaKind as ChatMessage['kind']) || 'document';
        await sendChatMessage(chatWid, {
          body: body || undefined,
          mediaFileId: tmpl.fileId,
          mediaCaption: body || undefined,
          kind,
          mediaMime: tmpl.mime,
          mediaSize: tmpl.size,
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
      if (files.length > 0 || tmpl || deliverAt) addToast(msg, 'error');
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
    const picked = Array.from(e.target.files ?? []);
    // Reset the input so re-picking the SAME file(s) fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (picked.length === 0) return;
    const ok = picked.filter((f) => f.size <= 10 * 1024 * 1024);
    const tooBig = picked.length - ok.length;
    if (tooBig > 0) {
      addToast(
        isAr ? `تم تجاهل ${tooBig} ملف أكبر من 10 ميغابايت` : `${tooBig} file(s) over 10 MB were skipped`,
        'error',
      );
    }
    if (ok.length === 0) return;
    // APPEND so the user can build up a set across several picks.
    setLocalFiles((prev) => [...prev, ...ok]);
    setTemplateAtt(null);          // a local file replaces a template attachment
    setProjectImageFileIds([]);    // …and its ride-along gallery
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
    setLocalFiles([]); // a template replaces any locally-picked files
    if (picked.mediaFileId) {
      setTemplateAtt({
        kind: 'template',
        fileId: picked.mediaFileId,
        mime: picked.mediaMime,
        size: picked.mediaSize,
        filename: picked.mediaFilename,
        mediaKind: picked.mediaKind,
      });
    } else {
      setTemplateAtt(null);
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

        {templateAtt && (
          <AttachmentChip attachment={templateAtt} isAr={isAr} onRemove={() => setTemplateAtt(null)} />
        )}
        {localFiles.length > 0 && (
          <AttachmentTray
            files={localFiles}
            isAr={isAr}
            onRemove={(i) => setLocalFiles((prev) => prev.filter((_, j) => j !== i))}
          />
        )}

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
            multiple
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
              localFiles.length > 0 || templateAtt
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

/**
 * Compact WhatsApp-style attachment tray: local files render as a row of small
 * square thumbnails side by side (not one big card each). Clicking a thumbnail
 * opens a full preview lightbox; the little × on each removes just that file.
 */
function AttachmentTray({
  files,
  isAr,
  onRemove,
}: {
  files: File[];
  isAr: boolean;
  onRemove: (index: number) => void;
}) {
  // One object URL per file, revoked as the set changes / on unmount so large
  // videos don't leak. Keyed by identity+size so re-picks don't churn URLs.
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const tileKind = (f: File): 'image' | 'video' | 'audio' | 'document' => {
    if (f.type.startsWith('image/')) return 'image';
    if (f.type.startsWith('video/')) return 'video';
    if (f.type.startsWith('audio/')) return 'audio';
    return 'document';
  };

  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f, i) => {
        const kind = tileKind(f);
        const previewable = kind === 'image' || kind === 'video' || kind === 'audio';
        return (
          <div key={`${f.name}-${f.size}-${i}`} className="relative group">
            <button
              type="button"
              onClick={() => previewable && setLightboxIndex(i)}
              className={`w-16 h-16 rounded-lg border border-sand/50 overflow-hidden bg-charcoal/5 flex items-center justify-center ${previewable ? 'cursor-zoom-in' : 'cursor-default'}`}
              title={f.name}
              aria-label={f.name}
            >
              {kind === 'image' && (
                <img src={urls[i]} alt={f.name} className="w-full h-full object-cover" />
              )}
              {kind === 'video' && (
                <div className="relative w-full h-full">
                  {/* muted video acts as a poster frame; the icon marks it playable */}
                  <video src={urls[i]} muted className="w-full h-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                    <Play size={18} className="text-white" fill="currentColor" />
                  </div>
                </div>
              )}
              {kind === 'audio' && <Mic size={20} className="text-charcoal/60" />}
              {kind === 'document' && (
                <div className="flex flex-col items-center gap-0.5 px-1">
                  <FileText size={18} className="text-charcoal/60" />
                  <span className="text-[8px] text-charcoal/50 truncate max-w-[56px]">{f.name}</span>
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-charcoal text-white shadow flex items-center justify-center opacity-90 hover:bg-red-600 transition-colors"
              aria-label={isAr ? `إزالة ${f.name}` : `Remove ${f.name}`}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}

      {lightboxIndex !== null && (
        <AttachmentLightbox
          files={files}
          urls={urls}
          index={lightboxIndex}
          isAr={isAr}
          onIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/** Full-screen preview of one attachment, with prev/next across the set. */
function AttachmentLightbox({
  files,
  urls,
  index,
  isAr,
  onIndex,
  onClose,
}: {
  files: File[];
  urls: string[];
  index: number;
  isAr: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const f = files[index];
  const url = urls[index];
  const many = files.length > 1;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onIndex((index + 1) % files.length);
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + files.length) % files.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, files.length, onIndex, onClose]);

  if (!f || !url) return null;
  const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document';

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 end-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
        aria-label={isAr ? 'إغلاق' : 'Close'}
      >
        <X size={20} />
      </button>

      {many && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + files.length) % files.length); }}
            className="absolute start-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
            aria-label={isAr ? 'السابق' : 'Previous'}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % files.length); }}
            className="absolute end-16 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
            aria-label={isAr ? 'التالي' : 'Next'}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div className="max-w-[90vw] max-h-[85vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {kind === 'image' && <img src={url} alt={f.name} className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg" />}
        {kind === 'video' && <video src={url} controls autoPlay className="max-w-[90vw] max-h-[80vh] rounded-lg bg-black" />}
        {kind === 'audio' && <audio src={url} controls autoPlay className="w-[80vw] max-w-md" />}
        {kind === 'document' && (
          <div className="bg-white rounded-lg p-8 flex flex-col items-center gap-2">
            <FileText size={40} className="text-charcoal/60" />
            <span className="text-sm text-charcoal">{f.name}</span>
          </div>
        )}
        <div className="text-white/70 text-xs">
          {f.name}
          {many && <span className="ms-2">· {index + 1}/{files.length}</span>}
        </div>
      </div>
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
