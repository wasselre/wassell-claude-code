import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Send, Loader2, Paperclip, FolderOpen, X } from 'lucide-react';
import { uploadImage } from '@/lib/imageUpload';
import { signViewUrl } from '@/lib/files/client';
import DriveBrowserModal, {
  type DrivePickerResult,
} from '@/pages/Files/components/DriveBrowserModal';
import type { ChatAspectRatio, AttachmentSource } from '@/lib/imageChat/client';
import BrandPresetDropdown from './BrandPresetDropdown';
import PromptLibraryButton from './PromptLibraryButton';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ComposerAttachment {
  /** What `<img src>` renders. For legacy items this is the same as `value`.
   *  For Files-System items it's a short-lived signed URL. */
  url: string;
  /** What gets sent to the server. For Files-System items this is the raw
   *  `files.id` UUID — the server resolves it to a fresh URL on receipt,
   *  so we don't have to worry about the signed URL expiring. */
  value: string;
  name: string;
  source: AttachmentSource;
}

/** A preset/snippet `images` field value is either a legacy public URL
 *  (string starts with http) or a Files-System `files.id` UUID. */
function looksLikeFileId(s: string): boolean {
  return UUID_RE.test(s);
}

async function resolveImageFieldValue(
  raw: string,
  source: AttachmentSource,
): Promise<ComposerAttachment | null> {
  if (looksLikeFileId(raw)) {
    try {
      const { url, original_name } = await signViewUrl(raw);
      return { url, value: raw, name: original_name || basename(url), source };
    } catch {
      // signViewUrl already toasts the failure; just drop the attachment so
      // the composer stays usable.
      return null;
    }
  }
  return { url: raw, value: raw, name: basename(raw), source };
}

interface Props {
  disabled: boolean;
  initialAspectRatio: ChatAspectRatio;
  initialPresetId: string | null;
  onSend: (params: {
    prompt: string;
    attachmentUrls: string[];
    attachmentSources: AttachmentSource[];
    aspectRatio: ChatAspectRatio;
    numVariations: number;
    presetId: string | null;
  }) => void;
}

const ASPECTS: ReadonlyArray<{ key: ChatAspectRatio; iconBox: string }> = [
  { key: '1:1', iconBox: 'w-4 h-4' },
  { key: '9:16', iconBox: 'w-3 h-4' },
  { key: '16:9', iconBox: 'w-4 h-3' },
  { key: '4:3', iconBox: 'w-4 h-3' },
  { key: '3:4', iconBox: 'w-3 h-4' },
];

/**
 * Higgsfield-style composer pinned to the bottom of the active
 * Image Chats thread. Controls (top to bottom):
 *
 *   - Attachment row: thumbnails of images about to be sent this
 *     turn. User uploads + preset/snippet auto-attaches all live
 *     here; each one is removable independently. Preset/snippet
 *     thumbs get a ✦ badge so you can tell at a glance what comes
 *     from where.
 *   - Textarea: the user prompt. Auto-grows. ⌘/Ctrl+Enter sends.
 *   - Controls row: aspect-ratio chips • Brand preset dropdown •
 *     1/4 variations toggle • Prompt library • Paperclip • Send.
 *
 * The composer owns its own state — when the user picks a preset
 * the preset's `images` field is pulled from the store and added
 * to `attachments` (marked source: 'preset'). Same for snippets.
 * Removing a preset-auto-attached image is fine; the preset is
 * still in effect for prompt-text purposes.
 */
export default function Composer({
  disabled,
  initialAspectRatio,
  initialPresetId,
  onSend,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [aspectRatio, setAspectRatio] = useState<ChatAspectRatio>(initialAspectRatio);
  const [numVariations, setNumVariations] = useState<1 | 4>(1);
  const [presetId, setPresetId] = useState<string | null>(initialPresetId);
  const [uploading, setUploading] = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Look up presets / snippets from the store for both the dropdown and
  // the picker. Image arrays come straight from `record.data.images`.
  const presetsModel = useMemo(
    () => models.find((m) => m.name === 'image_presets'),
    [models],
  );
  const presetRecords = presetsModel ? (recordsByModel[presetsModel.id] ?? []) : [];

  const snippetsModel = useMemo(
    () => models.find((m) => m.name === 'prompt_snippets'),
    [models],
  );
  const snippetRecords = snippetsModel ? (recordsByModel[snippetsModel.id] ?? []) : [];

  // When the picked preset changes, swap its auto-attached images:
  // strip out any existing preset-source attachments and append the
  // new preset's images (if any). User + snippet attachments are
  // preserved exactly as the user left them.
  //
  // Preset `images` field values come from the new Files System (raw
  // `files.id` UUIDs) — they need to be signed before we can show
  // a thumbnail, and the original ID is what we send to the server.
  useEffect(() => {
    let cancelled = false;
    setAttachments((prev) => prev.filter((a) => a.source !== 'preset'));
    if (!presetId) return;
    const preset = presetRecords.find((r) => r.id === presetId);
    if (!preset) return;
    const presetImages = Array.isArray(preset.data.images)
      ? (preset.data.images as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (presetImages.length === 0) return;
    void Promise.all(presetImages.map((v) => resolveImageFieldValue(v, 'preset'))).then((resolved) => {
      if (cancelled) return;
      const fresh = resolved.filter((a): a is ComposerAttachment => a !== null);
      setAttachments((prev) => [...prev.filter((a) => a.source !== 'preset'), ...fresh]);
    });
    return () => {
      cancelled = true;
    };
    // intentionally only react to presetId — presetRecords identity
    // changes constantly via store updates; we don't want to keep
    // re-merging on every keystroke elsewhere in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId]);

  // Auto-grow the textarea up to 6 lines.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    const max = 6 * 24;
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [prompt]);

  function handlePickSnippet(snippetId: string) {
    const snippet = snippetRecords.find((r) => r.id === snippetId);
    if (!snippet) return;
    const text = (snippet.data.text as string | undefined) ?? '';
    if (text) {
      setPrompt((cur) => (cur.trim() ? `${cur.trim()}\n\n${text}` : text));
    }
    const imgs = Array.isArray(snippet.data.images)
      ? (snippet.data.images as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (imgs.length > 0) {
      void Promise.all(imgs.map((v) => resolveImageFieldValue(v, 'snippet'))).then((resolved) => {
        const fresh = resolved.filter((a): a is ComposerAttachment => a !== null);
        if (fresh.length > 0) setAttachments((prev) => [...prev, ...fresh]);
      });
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) {
          addToast(
            isAr ? `${file.name} يتجاوز ١٠ ميجابايت` : `${file.name} exceeds 10 MB`,
            'error',
          );
          continue;
        }
        try {
          const url = await uploadImage(file, 'image-chats/uploads');
          setAttachments((prev) => [
            ...prev,
            { url, value: url, name: file.name, source: 'user' },
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addToast(
            isAr ? `فشل رفع ${file.name}: ${msg}` : `Upload of ${file.name} failed: ${msg}`,
            'error',
          );
        }
      }
    } finally {
      setUploading(false);
    }
  }

  /**
   * "From Files" picker — invoked by the FolderOpen button next to the
   * Paperclip. Lets the user pick existing images from the user's Drive
   * (`/files` page) instead of uploading from their device.
   *
   * Each picked file's UUID is fed through `resolveImageFieldValue` so
   * the attachment carries `{ url: signedURL, value: fileId }` — same
   * shape as preset/snippet image refs. The server-side `api/image-chat/send`
   * endpoint then permission-checks the file id and copies the bytes into
   * `marketing-assets/image-chats/preset-copies/` so the chat history
   * carries a non-expiring URL going forward (no broken thumbnails).
   */
  async function handlePickFromDrive(result: DrivePickerResult) {
    if (result.kind !== 'files' || result.files.length === 0) return;
    setUploading(true);
    try {
      const resolved = await Promise.all(
        result.files.map((f) => resolveImageFieldValue(f.id, 'user')),
      );
      const fresh = resolved.filter((a): a is ComposerAttachment => a !== null);
      if (fresh.length > 0) setAttachments((prev) => [...prev, ...fresh]);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleSend() {
    if (disabled || uploading) return;
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend({
      prompt: trimmed,
      attachmentUrls: attachments.map((a) => a.value),
      attachmentSources: attachments.map((a) => a.source),
      aspectRatio,
      numVariations,
      presetId,
    });
    // Optimistic reset. Server is the source of truth for history.
    setPrompt('');
    // Strip user/snippet attachments; keep preset auto-attaches in place
    // so the next turn carries the same brand context without re-picking.
    setAttachments((prev) => prev.filter((a) => a.source === 'preset'));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘+Enter / Ctrl+Enter sends. Plain Enter inserts a newline so the
    // user can write multi-line prompts without surprise sends.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  const canSend = !disabled && !uploading && (prompt.trim().length > 0 || attachments.length > 0);

  return (
    <div className="border-t border-sand/20 bg-cream/30 p-3 space-y-2">
      {/* Attachment row */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att, idx) => (
            <div
              key={`${att.url}-${idx}`}
              className="relative w-16 h-16 rounded-lg overflow-hidden border border-sand/40 bg-white shrink-0"
            >
              <img src={att.url} alt="" className="w-full h-full object-cover" />
              {(att.source === 'preset' || att.source === 'snippet') && (
                <span className="absolute top-0.5 start-0.5 text-[9px] font-bold bg-copper text-white rounded px-1 py-px shadow-sm">
                  ✦
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(idx)}
                className="absolute top-0.5 end-0.5 p-0.5 rounded-full bg-charcoal/70 text-white hover:bg-charcoal transition-colors"
                aria-label={isAr ? 'إزالة' : 'Remove'}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea + library button */}
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={2}
          placeholder={
            isAr
              ? 'صف ما تريد إنشاءه أو تعديله...'
              : 'Describe what you want to create or edit…'
          }
          className="flex-1 resize-none rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none px-3 py-2 text-sm bg-white disabled:bg-cream"
        />
        <PromptLibraryButton snippets={snippetRecords} onPick={handlePickSnippet} />
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Aspect ratio chips */}
        <div className="flex items-center gap-1 rounded-lg border border-sand/40 bg-white p-0.5">
          {ASPECTS.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setAspectRatio(a.key)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                aspectRatio === a.key
                  ? 'bg-copper text-white'
                  : 'text-charcoal/70 hover:bg-cream'
              }`}
              title={a.key}
            >
              <span
                className={`${a.iconBox} border-2 ${
                  aspectRatio === a.key ? 'border-white' : 'border-current'
                } rounded-sm`}
                aria-hidden
              />
              <span dir="ltr">{a.key}</span>
            </button>
          ))}
        </div>

        {/* Brand preset dropdown */}
        <BrandPresetDropdown
          presets={presetRecords}
          value={presetId}
          onChange={setPresetId}
        />

        {/* Variations toggle */}
        <div className="flex items-center rounded-lg border border-sand/40 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setNumVariations(1)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              numVariations === 1 ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'
            }`}
          >
            1
          </button>
          <button
            type="button"
            onClick={() => setNumVariations(4)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              numVariations === 4 ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'
            }`}
          >
            4
          </button>
        </div>

        <div className="flex-1" />

        {/* From Files — pick existing images from the user's Drive (/files) */}
        <button
          type="button"
          onClick={() => setDrivePickerOpen(true)}
          disabled={disabled || uploading}
          className={`inline-flex items-center justify-center w-9 h-9 rounded-lg border border-sand/40 bg-white hover:bg-cream transition-colors ${
            disabled || uploading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          title={isAr ? 'اختيار من الملفات' : 'Pick from Files'}
          aria-label={isAr ? 'اختيار من الملفات' : 'Pick from Files'}
        >
          <FolderOpen size={16} className="text-charcoal/70" />
        </button>

        {/* Paperclip — file upload */}
        <label
          className={`inline-flex items-center justify-center w-9 h-9 rounded-lg border border-sand/40 bg-white hover:bg-cream cursor-pointer transition-colors ${
            disabled || uploading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          title={isAr ? 'إرفاق صورة' : 'Attach image'}
        >
          {uploading ? (
            <Loader2 size={16} className="animate-spin text-copper" />
          ) : (
            <Paperclip size={16} className="text-charcoal/70" />
          )}
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            disabled={disabled || uploading}
            onChange={(e) => {
              void handleFileSelect(e.target.files);
              e.target.value = '';
            }}
            className="sr-only"
          />
        </label>

        {/* Send */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          aria-label={isAr ? 'إرسال' : 'Send'}
        >
          {disabled ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          <span>{isAr ? 'إرسال' : 'Send'}</span>
        </button>
      </div>

      {/* Files-Drive picker — opened by the FolderOpen button */}
      <DriveBrowserModal
        open={drivePickerOpen}
        mode="pick-files"
        acceptMime="image/png,image/jpeg,image/webp"
        onClose={() => setDrivePickerOpen(false)}
        onSelect={(result) => void handlePickFromDrive(result)}
      />
    </div>
  );
}

function basename(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    return parts[parts.length - 1] ?? 'image';
  } catch {
    return 'image';
  }
}
