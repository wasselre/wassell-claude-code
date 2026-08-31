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
  /** What's being sent — shown in the dialog. */
  title: string;
  subtitle: string;
  filename: string;
  defaultCaption: string;
  /** Lazily produce the PDF bytes; memoized once generated. */
  build: () => Promise<Blob>;
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
  title,
  subtitle,
  filename,
  defaultCaption,
  build,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [caption, setCaption] = useState(defaultCaption);
  const [busy, setBusy] = useState<'send' | 'download' | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const blobRef = useRef<Blob | null>(null);

  const L = (ar: string, en: string) => (isAr ? ar : en);

  const ensureBlob = useCallback(async (): Promise<Blob> => {
    if (blobRef.current) return blobRef.current;
    const b = await build();
    blobRef.current = b;
    return b;
  }, [build]);

  const canSend = !!clientPhone && busy === null;

  const handleDownload = async () => {
    if (busy) return;
    setBusy('download');
    try {
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
      title={title}
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
        {/* What's being sent */}
        <div>
          <div className="text-sm font-bold text-charcoal truncate" title={title}>{title}</div>
          <div className="text-xs text-charcoal/55">{subtitle}</div>
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
            onChange={(e) => setCaption(e.target.value)}
            rows={3}
            className="form-input w-full resize-none"
          />
        </div>
      </div>
    </Modal>
  );
}
