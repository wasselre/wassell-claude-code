import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Loader2, Paperclip, X, Image as ImageIcon, FileText, Video, Mic } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { uploadFile } from '@/lib/haberchat/client';
import type { ChatMessage } from '@/types';

/**
 * Message composer: textarea + attach + send button. Enter sends,
 * Shift+Enter newline. Attach opens a native file picker; the chosen
 * file shows as a removable chip above the composer. When Send fires
 * with an attachment, we upload it through the proxy first, then
 * sendChatMessage with the returned mediaFileId.
 */
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

  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  const canSend = (text.trim().length > 0 || attachment !== null) && !sending && !disabled;

  const kindForAttachment = (file: File): ChatMessage['kind'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'document';
  };

  const doSend = async () => {
    if (!canSend) return;
    const body = text.trim();
    const file = attachment;
    setSending(true);
    // Clear inputs optimistically so the user can keep typing. On error
    // we toast — the text/file don't come back (matches WhatsApp desktop).
    setText('');
    setAttachment(null);
    try {
      if (file) {
        // Upload first — blocking. A spinner on the send button tells
        // the user we're waiting for the upload to finish.
        const uploaded = await uploadFile(file);
        await sendChatMessage(chatWid, {
          body: body || undefined,
          mediaFileId: uploaded.fileId,
          mediaCaption: body || undefined,
          kind: kindForAttachment(file),
          mediaMime: uploaded.mime ?? file.type,
          mediaSize: uploaded.size ?? file.size,
        });
      } else {
        await sendChatMessage(chatWid, { body });
      }
    } catch (err) {
      // sendChatMessage toasts its own errors. Upload errors surface here.
      const msg = err instanceof Error ? err.message : String(err);
      if (file) addToast(msg, 'error');
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
    // Haberchat plan caps — 10 MB is the most generous tier. We warn but
    // let the upload attempt proceed; the proxy returns a real error if
    // the plan is lower.
    if (f.size > 10 * 1024 * 1024) {
      addToast(isAr ? 'حجم الملف أكبر من 10 ميغابايت' : 'File is larger than 10 MB', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setAttachment(f);
    textareaRef.current?.focus();
  };

  return (
    <div className="card p-3 mt-3 flex flex-col gap-2">
      {/* Attachment preview chip */}
      {attachment && (
        <AttachmentChip
          file={attachment}
          isAr={isAr}
          onRemove={() => {
            setAttachment(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
      )}

      <div className="flex items-end gap-2">
        {/* Attach */}
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
        <button
          onClick={doSend}
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
  );
}

function AttachmentChip({
  file,
  isAr,
  onRemove,
}: {
  file: File;
  isAr: boolean;
  onRemove: () => void;
}) {
  const Icon = file.type.startsWith('image/')
    ? ImageIcon
    : file.type.startsWith('video/')
      ? Video
      : file.type.startsWith('audio/')
        ? Mic
        : FileText;
  return (
    <div className="flex items-center gap-2 bg-cream/60 rounded-lg px-2 py-1.5">
      <div className="w-7 h-7 rounded-lg bg-charcoal/5 flex items-center justify-center shrink-0">
        <Icon size={14} className="text-charcoal/60" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-charcoal truncate">{file.name}</div>
        <div className="text-[10px] text-charcoal/50">
          {(file.size / 1024).toFixed(0)} KB
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
  );
}
