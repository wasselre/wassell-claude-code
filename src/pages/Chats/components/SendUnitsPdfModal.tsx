import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Clock, Download, Loader2, Send } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { sendPdfToChat, downloadPdf } from '@/lib/projects/sendPdfToChat';
import SchedulePopover, { formatScheduleTime } from '@/pages/Chats/components/SchedulePopover';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Conversation to send into. */
  chatWid: string;
  /** Resolved recipient (from the chat's linked client). */
  clientName?: string | null;
  clientPhone?: string | null;
  /** Language-parameterized what's-being-sent text + document builders — the
      rep picks the PDF language in this dialog, independent of the app UI
      language. */
  titleFor: (isAr: boolean) => string;
  subtitleFor: (isAr: boolean) => string;
  filenameFor: (isAr: boolean) => string;
  captionFor: (isAr: boolean) => string;
  /** Lazily produce the PDF bytes for a language; memoized per language. */
  buildFor: (isAr: boolean) => Promise<Blob>;
}

/**
 * Confirm + send a client-side-generated PDF (a units table or a single-unit
 * sheet) to the conversation's customer over WhatsApp. The PDF is generated on
 * demand (Send or Download) and cached, so a Download-then-Send doesn't rebuild
 * it. `sendPdfToChat` resolves the recipient phone + send-from device from the
 * chat record, so this dialog carries no device picker.
 */
export default function SendUnitsPdfModal({
  open,
  onClose,
  chatWid,
  clientName,
  clientPhone,
  titleFor,
  subtitleFor,
  filenameFor,
  captionFor,
  buildFor,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  // `isAr` stays the APP UI language (dialog chrome + L()); `docLang` is the
  // language the PDF itself is built in — the rep chooses it below.
  const appIsAr = isAr;
  const [docLang, setDocLang] = useState<'ar' | 'en'>(appIsAr ? 'ar' : 'en');
  const docAr = docLang === 'ar';

  const [caption, setCaption] = useState(() => captionFor(appIsAr));
  const captionEdited = useRef(false);
  const [busy, setBusy] = useState<'send' | 'download' | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const blobCache = useRef<Record<'ar' | 'en', Blob | null>>({ ar: null, en: null });

  const L = (ar: string, en: string) => (isAr ? ar : en);

  const ensureBlob = useCallback(async (): Promise<Blob> => {
    const cached = blobCache.current[docLang];
    if (cached) return cached;
    const b = await buildFor(docAr);
    blobCache.current[docLang] = b;
    return b;
  }, [buildFor, docLang, docAr]);

  const changeDocLang = (next: 'ar' | 'en') => {
    if (next === docLang || busy) return;
    setDocLang(next);
    if (!captionEdited.current) setCaption(captionFor(next === 'ar'));
  };

  const canSend = !!clientPhone && busy === null;

  const handleDownload = async () => {
    if (busy) return;
    setBusy('download');
    try {
      const filename = filenameFor(docAr);
      downloadPdf(await ensureBlob(), filename);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleSend = (deliverAt?: string) => {
    if (!canSend) return;
    setShowSchedule(false);
    // Close the popup IMMEDIATELY — the whole build+upload+send runs in the
    // BACKGROUND. Building the PDF (html2canvas + jsPDF, plus signing/fetching
    // a plan image for a unit sheet) and the gateway upload take several
    // seconds; the user should never wait in this dialog for that. The PDF
    // build is self-contained (rasterizeToPdf renders into its own detached
    // container on document.body), so it survives this modal unmounting.
    // Progress + failures surface globally via the job center + toasts.
    const cap = caption;
    const filename = filenameFor(docAr);
    onClose();
    void (async () => {
      try {
        const blob = await ensureBlob();
        const res = await sendPdfToChat(chatWid, blob, filename, cap, { deliverAt });
        if (res.ok) {
          addToast(
            deliverAt
              ? L(`تمت جدولة الملف — سيُرسل ${formatScheduleTime(deliverAt, true)}`, `Scheduled — will send ${formatScheduleTime(deliverAt, false)}`)
              : L('تم إرسال الملف إلى العميل', 'Sent to the client'),
            'success',
          );
        }
        // On failure sendPdfToChat already toasted.
      } catch (err) {
        // Build failure, or scheduled-path identity failure — surface it.
        addToast(err instanceof Error ? err.message : String(err), 'error');
      }
    })();
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={titleFor(docAr)}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="secondary" disabled={busy !== null} onClick={onClose}>
            {L('إلغاء', 'Cancel')}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void handleDownload()}>
            {busy === 'download' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {L('تنزيل', 'Download')}
          </Button>
          <div className="relative">
            <Button
              variant="secondary"
              disabled={!canSend}
              onClick={() => setShowSchedule((v) => !v)}
              title={L('جدولة الإرسال لوقت لاحق', 'Schedule for later')}
            >
              <Clock size={16} />
              {L('جدولة', 'Schedule')}
            </Button>
            {showSchedule && (
              <SchedulePopover
                isAr={isAr}
                onClose={() => setShowSchedule(false)}
                onConfirm={(iso) => void handleSend(iso)}
              />
            )}
          </div>
          <Button variant="primary" disabled={!canSend} onClick={() => void handleSend()}>
            {busy === 'send' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {L('إرسال للعميل', 'Send to client')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* PDF language — the rep picks Arabic or English for the document,
            independent of the app UI language. */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-charcoal/50">{L('لغة الملف', 'PDF language')}</span>
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
          <div className="text-sm font-bold text-charcoal truncate" title={titleFor(docAr)}>{titleFor(docAr)}</div>
          <div className="text-xs text-charcoal/55">{subtitleFor(docAr)}</div>
        </div>

        {/* Recipient */}
        <div>
          <div className="text-xs font-bold text-charcoal/50 mb-1">{L('المستلم', 'Recipient')}</div>
          {clientPhone ? (
            <div className="bg-cream rounded-xl px-3 py-2.5 border border-sand/30">
              <div className="font-bold text-charcoal text-sm">{clientName ?? '—'}</div>
              <div className="text-sm text-charcoal/60" dir="ltr">{clientPhone}</div>
            </div>
          ) : (
            <div className="flex items-start gap-2 bg-amber-50 text-amber-700 rounded-xl px-3 py-2.5 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{L('لا يوجد رقم للعميل في هذه المحادثة — يمكنك التنزيل فقط', 'This conversation has no client phone — you can only download')}</span>
            </div>
          )}
        </div>

        {/* Caption */}
        <div>
          <label className="text-xs font-bold text-charcoal/50 mb-1 block">{L('نص المرافقة', 'Caption')}</label>
          <textarea
            value={caption}
            onChange={(e) => { captionEdited.current = true; setCaption(e.target.value); }}
            rows={3}
            className="form-input w-full resize-none"
          />
        </div>
      </div>
    </Modal>
  );
}
