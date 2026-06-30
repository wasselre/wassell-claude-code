import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Loader2, Paperclip, X, Image as ImageIcon, FileText, Video, Mic, MessageSquare } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { uploadFile } from '@/lib/haberchat/client';
import { sendProjectImageMessages } from '@/lib/projectMessageImages';
import TemplatePickerModal from './TemplatePickerModal';
import type { ChatMessage } from '@/types';

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

  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // Project templates carry a gallery of CRM image file ids that ride along as
  // their own image messages after the text/single-media send. Set when a
  // project template is picked; cleared on send or when a local file replaces it.
  const [projectImageFileIds, setProjectImageFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 6 * 24;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  const canSend =
    (text.trim().length > 0 || attachment !== null || projectImageFileIds.length > 0) && !sending && !disabled;

  const kindForLocalFile = (file: File): ChatMessage['kind'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'document';
  };

  const doSend = async () => {
    if (!canSend) return;
    const body = text.trim();
    const att = attachment;
    const projectImages = projectImageFileIds;
    setSending(true);
    setText('');
    setAttachment(null);
    setProjectImageFileIds([]);
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
        });
      } else if (body) {
        await sendChatMessage(chatWid, { body });
      }
      // Project gallery rides along as its own image messages after the text.
      if (projectImages.length > 0) {
        await sendProjectImageMessages(chatWid, projectImages);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (att) addToast(msg, 'error');
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
        {attachment && <AttachmentChip attachment={attachment} isAr={isAr} onRemove={() => setAttachment(null)} />}

        {projectImageFileIds.length > 0 && (
          <div className="flex items-center gap-2 bg-copper/5 border border-copper/20 rounded-lg px-2 py-1.5">
            <div className="w-7 h-7 rounded-lg bg-copper/10 flex items-center justify-center shrink-0">
              <ImageIcon size={14} className="text-copper" />
            </div>
            <div className="flex-1 min-w-0 text-xs text-charcoal/70">
              {isAr
                ? `سترسل ${projectImageFileIds.length} صورة للمشروع بعد الرسالة`
                : `${projectImageFileIds.length} project image${projectImageFileIds.length === 1 ? '' : 's'} will be sent after the message`}
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
    </>
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
  return (
    <div className="flex items-center gap-2 bg-cream/60 rounded-lg px-2 py-1.5">
      <div className="w-7 h-7 rounded-lg bg-charcoal/5 flex items-center justify-center shrink-0">
        <Icon size={14} className="text-charcoal/60" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-charcoal truncate">{name}</div>
        <div className="text-[10px] text-charcoal/50">
          {sizeBytes != null ? `${(sizeBytes / 1024).toFixed(0)} KB` : ''}
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
  );
}

function attachmentMeta(att: Attachment): { name: string; sizeBytes: number | null; mime: string | null } {
  if (att.kind === 'local') {
    return { name: att.file.name, sizeBytes: att.file.size, mime: att.file.type };
  }
  return { name: att.filename ?? 'attachment', sizeBytes: att.size, mime: att.mime };
}
