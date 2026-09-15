import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, Download, FileText, Loader2, MessageSquareText, Send } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { sendPdfToChat, downloadPdf } from '@/lib/projects/sendPdfToChat';

/**
 * Send a project's PAYMENT PLANS to the conversation's customer — as a branded
 * **PDF** or as a **text message**. The rep picks which, and the document /
 * message language, independent of the app UI language.
 *
 * Both halves reuse the paths that already exist: the PDF goes through
 * `sendPdfToChat` (upload straight to storage → `sendChatMessage` as a
 * `document`, which resolves the recipient phone + send-from device from the
 * chat record), and the text goes through the store's `sendChatMessage` exactly
 * like a typed reply — optimistic bubble, per-conversation send lane, and the
 * store's own failed-bubble + toast on error.
 *
 * With no conversation in context (`chatWid` null — the project page, a record
 * form) the dialog still Downloads the PDF and Copies the text; only the Send
 * buttons are unavailable, and it says why.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Conversation to send into, or null → download/copy only. */
  chatWid?: string | null;
  clientName?: string | null;
  clientPhone?: string | null;
  /** Shown under the dialog title. */
  projectName: string;
  /** How many plans — for the "what's being sent" line. */
  planCount: number;
  /** Language-parameterized builders; the PDF blob is memoized per language. */
  buildPdfFor: (isAr: boolean) => Promise<Blob>;
  filenameFor: (isAr: boolean) => string;
  /** The ready-to-send text version of the same plans. */
  messageFor: (isAr: boolean) => string;
  /** Caption that rides with the PDF. */
  captionFor: (isAr: boolean) => string;
}

type Mode = 'pdf' | 'text';

export default function SendPaymentPlansModal({
  open,
  onClose,
  chatWid,
  clientName,
  clientPhone,
  projectName,
  planCount,
  buildPdfFor,
  filenameFor,
  messageFor,
  captionFor,
}: Props) {
  const appIsAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);

  const L = (ar: string, en: string) => (appIsAr ? ar : en);

  const [mode, setMode] = useState<Mode>('pdf');
  const [docLang, setDocLang] = useState<'ar' | 'en'>(appIsAr ? 'ar' : 'en');
  const docAr = docLang === 'ar';

  const [caption, setCaption] = useState(() => captionFor(appIsAr));
  const captionEdited = useRef(false);
  const [body, setBody] = useState(() => messageFor(appIsAr));
  const bodyEdited = useRef(false);

  const [busy, setBusy] = useState<'send' | 'download' | null>(null);
  const [copied, setCopied] = useState(false);
  const blobCache = useRef<Record<'ar' | 'en', Blob | null>>({ ar: null, en: null });

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const ensureBlob = useCallback(async (): Promise<Blob> => {
    const cached = blobCache.current[docLang];
    if (cached) return cached;
    const b = await buildPdfFor(docAr);
    blobCache.current[docLang] = b;
    return b;
  }, [buildPdfFor, docLang, docAr]);

  const changeDocLang = (next: 'ar' | 'en') => {
    if (next === docLang || busy) return;
    setDocLang(next);
    // Regenerate the untouched texts in the new language; never clobber an edit.
    if (!captionEdited.current) setCaption(captionFor(next === 'ar'));
    if (!bodyEdited.current) setBody(messageFor(next === 'ar'));
  };

  const canSend = !!chatWid && !!clientPhone && busy === null && (mode === 'pdf' || body.trim().length > 0);

  const handleDownload = async () => {
    if (busy) return;
    setBusy('download');
    try {
      downloadPdf(await ensureBlob(), filenameFor(docAr));
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch (err) {
      // Clipboard can be blocked (permissions / insecure context) — say so
      // rather than leaving the rep wondering whether the copy worked.
      console.error('[SendPaymentPlansModal] clipboard write failed', err);
      addToast(L('تعذّر النسخ — حدّد النص وانسخه يدويًا', 'Copy failed — select the text and copy it manually'), 'error');
    }
  };

  const handleSendPdf = () => {
    if (!canSend || !chatWid) return;
    // Close IMMEDIATELY — the build + upload + send runs in the BACKGROUND
    // (html2canvas + jsPDF take several seconds and the build is self-contained,
    // so it survives this modal unmounting). Progress and failures surface via
    // the job center + toasts. Same posture as SendUnitsPdfModal.
    const cap = caption;
    const filename = filenameFor(docAr);
    onClose();
    void (async () => {
      try {
        const blob = await ensureBlob();
        const res = await sendPdfToChat(chatWid, blob, filename, cap);
        if (res.ok) addToast(L('تم إرسال خطط السداد إلى العميل', 'Payment plans sent to the client'), 'success');
        // On failure sendPdfToChat already toasted.
      } catch (err) {
        addToast(err instanceof Error ? err.message : String(err), 'error');
      }
    })();
  };

  const handleSendText = async () => {
    if (!canSend || !chatWid) return;
    setBusy('send');
    try {
      await sendChatMessage(chatWid, { body: body.trim() });
      addToast(L('تم إرسال خطط السداد إلى العميل', 'Payment plans sent to the client'), 'success');
      onClose();
    } catch (err) {
      // sendChatMessage normally reports its own failure (failed bubble +
      // toast); this covers the pre-bubble throws (identity not resolved).
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SendPaymentPlansModal] send text failed', err);
      addToast(L(`تعذّر إرسال الرسالة — ${msg}`, `Couldn't send the message — ${msg}`), 'error');
    } finally {
      setBusy(null);
    }
  };

  const tab = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors ${
      active ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'
    }`;

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={L('إرسال خطط السداد', 'Send payment plans')}
      maxWidth="max-w-lg"
      footer={
        <>
          <Button variant="secondary" disabled={busy !== null} onClick={onClose}>
            {L('إلغاء', 'Cancel')}
          </Button>
          {mode === 'pdf' ? (
            <Button variant="secondary" disabled={busy !== null} onClick={() => void handleDownload()}>
              {busy === 'download' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {L('تنزيل', 'Download')}
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy !== null} onClick={() => void handleCopy()}>
              <Copy size={16} />
              {copied ? L('تم النسخ', 'Copied') : L('نسخ', 'Copy')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!canSend}
            onClick={() => (mode === 'pdf' ? handleSendPdf() : void handleSendText())}
          >
            {busy === 'send' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {L('إرسال للعميل', 'Send to client')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* PDF or text */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-bold text-charcoal/50">{L('طريقة الإرسال', 'Send as')}</span>
          <div className="inline-flex rounded-lg border border-sand/40 overflow-hidden">
            <button type="button" disabled={busy !== null} onClick={() => setMode('pdf')} className={tab(mode === 'pdf')}>
              <FileText size={13} /> {L('ملف PDF', 'PDF file')}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => setMode('text')} className={tab(mode === 'text')}>
              <MessageSquareText size={13} /> {L('رسالة نصية', 'Text message')}
            </button>
          </div>
        </div>

        {/* Language of the document / message */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-charcoal/50">{mode === 'pdf' ? L('لغة الملف', 'PDF language') : L('لغة الرسالة', 'Message language')}</span>
          <div className="inline-flex rounded-lg border border-sand/40 overflow-hidden">
            <button type="button" disabled={busy !== null} onClick={() => changeDocLang('ar')}
              className={`px-3 py-1 text-xs font-semibold transition-colors ${docAr ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'}`}>
              {L('العربية', 'Arabic')}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => changeDocLang('en')}
              className={`px-3 py-1 text-xs font-semibold transition-colors ${!docAr ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'}`}>
              {L('الإنجليزية', 'English')}
            </button>
          </div>
        </div>

        {/* What's being sent */}
        <div>
          <div className="text-sm font-bold text-charcoal truncate" title={projectName}>{projectName}</div>
          <div className="text-xs text-charcoal/55">
            {docAr ? `${planCount} خطة سداد` : `${planCount} payment plan${planCount === 1 ? '' : 's'}`}
          </div>
        </div>

        {/* Recipient */}
        <div>
          <div className="text-xs font-bold text-charcoal/50 mb-1">{L('المستلم', 'Recipient')}</div>
          {chatWid && clientPhone ? (
            <div className="bg-cream rounded-xl px-3 py-2.5 border border-sand/30">
              <div className="font-bold text-charcoal text-sm">{clientName ?? '—'}</div>
              <div className="text-sm text-charcoal/60" dir="ltr">{clientPhone}</div>
            </div>
          ) : (
            <div className="flex items-start gap-2 bg-amber-50 text-amber-700 rounded-xl px-3 py-2.5 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>
                {L('لا توجد محادثة عميل هنا — يمكنك التنزيل أو النسخ فقط',
                   'No client conversation here — you can only download or copy')}
              </span>
            </div>
          )}
        </div>

        {/* Caption (PDF) or the message body (text) */}
        {mode === 'pdf' ? (
          <div>
            <label className="text-xs font-bold text-charcoal/50 mb-1 block">{L('نص المرافقة', 'Caption')}</label>
            <textarea
              value={caption}
              onChange={(e) => { captionEdited.current = true; setCaption(e.target.value); }}
              rows={2}
              dir="auto"
              className="form-input w-full resize-none"
            />
          </div>
        ) : (
          <div>
            <label className="text-xs font-bold text-charcoal/50 mb-1 block">{L('الرسالة', 'Message')}</label>
            <textarea
              value={body}
              onChange={(e) => { bodyEdited.current = true; setBody(e.target.value); }}
              rows={12}
              dir="auto"
              className="form-input w-full resize-none text-sm leading-relaxed"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
