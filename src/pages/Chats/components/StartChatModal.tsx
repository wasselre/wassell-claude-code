import { useState, useMemo, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Send, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * "Start new chat" modal — triggered from the ChatList header. The user
 * types a phone number and an opening message; we POST it through the
 * proxy (which creates the conversation on Haberchat's side as a
 * side-effect of the first send) and navigate to the new chat detail.
 *
 * A device picker appears only when more than one WhatsApp number is
 * active — single-device accounts silently use the default.
 */
export default function StartChatModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const waDevices = useAppStore((s) => s.waDevices);
  const startNewChat = useAppStore((s) => s.startNewChat);

  const activeDevices = useMemo(() => waDevices.filter((d) => d.is_active), [waDevices]);
  const defaultDevice = activeDevices.find((d) => d.is_default) ?? activeDevices[0] ?? null;

  const [phone, setPhone] = useState('');
  const [body, setBody] = useState('');
  const [deviceId, setDeviceId] = useState<string>(defaultDevice?.device_id ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = phone.replace(/\D/g, '').length >= 7 && body.trim().length > 0 && !sending;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const result = await startNewChat({
        phone: phone.trim(),
        body: body.trim(),
        deviceId: deviceId || undefined,
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
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20">
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
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Device picker (only if >1 active) */}
          {activeDevices.length > 1 && (
            <div>
              <label className="block text-xs font-medium text-charcoal/70 mb-1">
                {isAr ? 'الإرسال من' : 'Send from'}
              </label>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="input w-full text-sm"
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

          {/* Phone */}
          <div>
            <label className="block text-xs font-medium text-charcoal/70 mb-1">
              {isAr ? 'رقم الواتساب' : 'WhatsApp phone number'}
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+966 5XX XXX XXX"
              dir="ltr"
              className="input w-full text-sm font-mono"
              disabled={sending}
              autoFocus
            />
            <p className="text-[11px] text-charcoal/40 mt-1">
              {isAr
                ? 'أدخل الرقم بأي تنسيق — سنتعامل مع مفتاح الدولة تلقائياً.'
                : 'Any format works — country code +966 is assumed for local numbers.'}
            </p>
          </div>

          {/* Body */}
          <div>
            <label className="block text-xs font-medium text-charcoal/70 mb-1">
              {isAr ? 'الرسالة الأولى' : 'First message'}
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={isAr ? 'اكتب الرسالة...' : 'Type the opening message…'}
              rows={3}
              className="input w-full text-sm resize-none"
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
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="btn-secondary"
            >
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={!canSend}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {isAr ? 'إرسال' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
