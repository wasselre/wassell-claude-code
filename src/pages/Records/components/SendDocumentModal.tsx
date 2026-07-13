import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock, Loader2, Send } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { normalizePhone } from '@/lib/phone';
import { recordTitle } from '@/lib/documents/links';
import { sendDocumentToCustomer } from '@/lib/documents/sendDocument';
import SchedulePopover, { formatScheduleTime } from '@/pages/Chats/components/SchedulePopover';

interface Props {
  open: boolean;
  onClose: () => void;
  fileId: string;
  fileName: string;
  modelId: string;
  recordId: string;
}

/** Pull a single linked-record id out of a lookup / unit_picker value. */
function asLinkId(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = asLinkId(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand = o.id ?? o.recordId ?? o.record_id;
    return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
  }
  return null;
}

/**
 * Confirm + send a generated PDF to the record's customer over WhatsApp.
 * Resolves the recipient (client name + canonical phone) and the WhatsApp
 * device before sending — blocks (never silently fails) when the client has no
 * valid phone or no active device exists.
 */
export default function SendDocumentModal({ open, onClose, fileId, fileName, modelId, recordId }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const waDevices = useAppStore((s) => s.waDevices);
  const addToast = useAppStore((s) => s.addToast);

  // Resolve the client from the source record's client lookup.
  const { clientName, clientPhone } = useMemo(() => {
    const sourceRecord = (records[modelId] ?? []).find((r) => r.id === recordId);
    const clientId = asLinkId(sourceRecord?.data.client_id);
    const clientsModel = models.find((m) => m.name === 'clients');
    const clientRecord = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) : undefined;
    return {
      clientName: clientRecord ? recordTitle(clientsModel, clientRecord, isAr) : null,
      clientPhone: clientRecord ? normalizePhone(String(clientRecord.data.phone_number ?? '')) : null,
    };
  }, [models, records, modelId, recordId, isAr]);

  const activeDevices = useMemo(() => waDevices.filter((d) => d.is_active), [waDevices]);
  const defaultDeviceId = activeDevices.find((d) => d.is_default)?.device_id ?? activeDevices[0]?.device_id ?? '';
  const [deviceId, setDeviceId] = useState(defaultDeviceId);
  const [caption, setCaption] = useState(t('doc.send.caption_default'));
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const effectiveDevice = deviceId || defaultDeviceId;
  const canSend = !!clientPhone && !!effectiveDevice && !busy;

  const deviceLabel = (d: (typeof activeDevices)[number]) =>
    (isAr ? d.friendly_name_ar : d.friendly_name_en) || d.phone;

  /** Send now (no arg) or schedule (future ISO — Haberchat's delivery queue). */
  const handleSend = async (deliverAt?: string) => {
    if (!canSend) return;
    setBusy(true);
    setShowSchedule(false);
    try {
      await sendDocumentToCustomer({ fileId, recordId, deviceId: effectiveDevice, caption: caption.trim(), deliverAt });
      addToast(
        deliverAt
          ? (isAr
              ? `تمت جدولة المستند — سيرسل ${formatScheduleTime(deliverAt, true)}`
              : `Document scheduled — will send ${formatScheduleTime(deliverAt, false)}`)
          : t('doc.send.success'),
        'success',
      );
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t('doc.send.title')}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* Schedule — same document + caption, delivered later from
              Haberchat's queue. */}
          <div className="relative">
            <Button
              variant="secondary"
              disabled={!canSend}
              onClick={() => setShowSchedule((v) => !v)}
              title={isAr ? 'جدولة الإرسال لوقت لاحق' : 'Schedule for later'}
            >
              <Clock size={16} />
              {isAr ? 'جدولة' : 'Schedule'}
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
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {t('doc.send.send')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* The document being sent */}
        <div className="text-sm text-charcoal/70 truncate" title={fileName}>
          {fileName}
        </div>

        {/* Recipient */}
        <div>
          <div className="text-xs font-bold text-charcoal/50 mb-1">{t('doc.send.recipient')}</div>
          {clientPhone ? (
            <div className="bg-cream rounded-xl px-3 py-2.5 border border-sand/30">
              <div className="font-bold text-charcoal text-sm">{clientName ?? '—'}</div>
              <div className="text-sm text-charcoal/60" dir="ltr">
                {clientPhone}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 bg-amber-50 text-amber-700 rounded-xl px-3 py-2.5 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{clientName === null ? t('doc.send.no_client') : t('doc.send.no_phone')}</span>
            </div>
          )}
        </div>

        {/* Send-from device */}
        <div>
          <div className="text-xs font-bold text-charcoal/50 mb-1">{t('doc.send.send_from')}</div>
          {activeDevices.length === 0 ? (
            <div className="flex items-start gap-2 bg-amber-50 text-amber-700 rounded-xl px-3 py-2.5 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{t('doc.send.no_device')}</span>
            </div>
          ) : activeDevices.length === 1 ? (
            <div className="text-sm text-charcoal/70">
              {deviceLabel(activeDevices[0]!)} <span dir="ltr">({activeDevices[0]!.phone})</span>
            </div>
          ) : (
            <select
              value={effectiveDevice}
              onChange={(e) => setDeviceId(e.target.value)}
              className="form-input w-full"
            >
              {activeDevices.map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {deviceLabel(d)} ({d.phone})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Caption */}
        <div>
          <label className="text-xs font-bold text-charcoal/50 mb-1 block">{t('doc.send.caption_label')}</label>
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
