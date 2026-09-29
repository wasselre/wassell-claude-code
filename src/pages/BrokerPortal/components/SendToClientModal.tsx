/**
 * "Send the project to your client" — the broker types the client's mobile and
 * Wassel's sales line sends the project message + brochure + photos (server
 * side, rate-limited; see api/broker-portal-send.ts). The same sheet offers the
 * do-it-yourself path: copy the exact message, download the brochure.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Download, Loader2, Send, X } from 'lucide-react';
import { fetchProjectMessage, sendProjectToClient, type PortalFile } from '../lib/api';
import { makeT, type TKey } from '../lib/i18n';
import { copyText } from './Media';

const BROKER_KEY = 'wassel_broker_portal_identity';

function loadIdentity(): { name: string; phone: string } {
  try {
    const raw = window.localStorage.getItem(BROKER_KEY);
    if (!raw) return { name: '', phone: '' };
    const v = JSON.parse(raw) as { name?: unknown; phone?: unknown };
    return { name: typeof v.name === 'string' ? v.name : '', phone: typeof v.phone === 'string' ? v.phone : '' };
  } catch (e) {
    // Private mode / blocked storage: the broker just types their name again.
    console.error('[broker-portal] identity read failed:', e);
    return { name: '', phone: '' };
  }
}

function saveIdentity(name: string, phone: string): void {
  try {
    window.localStorage.setItem(BROKER_KEY, JSON.stringify({ name, phone }));
  } catch (e) {
    console.error('[broker-portal] identity save failed:', e);
  }
}

const REASONS: Record<string, TKey> = {
  invalid_phone: 'err_invalid_phone',
  invalid_broker_phone: 'err_invalid_broker_phone',
  broker_name_required: 'err_broker_name_required',
  already_sent: 'err_already_sent',
  phone_limit: 'err_phone_limit',
  daily_cap: 'err_daily_cap',
  rate_limited: 'err_rate_limited',
  sending_disabled: 'err_sending_disabled',
};

export default function SendToClientModal({
  token, projectId, projectName, isAr, canSend, brochures, onClose,
}: {
  token: string;
  projectId: string;
  projectName: string;
  isAr: boolean;
  canSend: boolean;
  brochures: PortalFile[];
  onClose: () => void;
}) {
  const t = makeT(isAr);
  const ident = loadIdentity();
  const [clientPhone, setClientPhone] = useState('');
  const [clientName, setClientName] = useState('');
  const [brokerName, setBrokerName] = useState(ident.name);
  const [brokerPhone, setBrokerPhone] = useState(ident.phone);
  const [phase, setPhase] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ar: string; en: string } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchProjectMessage(token, projectId)
      .then((r) => { if (!cancelled) setMessage(r.message); })
      .catch((e: Error) => {
        console.error('[broker-portal] message preview failed:', e.message);
        if (!cancelled) setMessage(null);
      });
    return () => { cancelled = true; };
  }, [token, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError(null);
    if (brokerName.trim().length < 2) { setError(t('err_broker_name_required')); return; }
    setPhase('sending');
    try {
      const r = await sendProjectToClient(token, {
        projectId, clientPhone, clientName, brokerName: brokerName.trim(), brokerPhone, lang: isAr ? 'ar' : 'en',
      });
      if (r.ok) {
        saveIdentity(brokerName.trim(), brokerPhone.trim());
        setPhase('sent');
        return;
      }
      setError(t(REASONS[r.reason ?? ''] ?? 'err_generic'));
    } catch (e) {
      console.error('[broker-portal] send failed:', e);
      setError(t('err_generic'));
    }
    setPhase('form');
  };

  const text = message ? (isAr ? message.ar : message.en) || message.ar : '';
  const input = 'w-full h-11 rounded-xl border border-sand bg-white px-3 text-sm text-charcoal focus:outline-none focus:border-copper';

  return (
    <div className="fixed inset-0 z-[75] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-cream-light rounded-t-3xl sm:rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 bg-white/95 backdrop-blur border-b border-sand/40">
          <div className="min-w-0">
            <div className="text-xs text-charcoal/50 truncate">{projectName}</div>
            <div className="text-lg font-bold text-chocolate">{t('sendToClient')}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close')} className="p-2 rounded-lg hover:bg-cream"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {canSend && phase !== 'sent' && (
            <form
              className="space-y-3"
              onSubmit={(e) => { e.preventDefault(); void submit(); }}
            >
              <p className="text-sm text-charcoal/70 leading-7">{t('sendIntro')}</p>
              <label className="block">
                <span className="text-xs font-bold text-charcoal/60">{t('clientPhone')}</span>
                <input className={input} dir="ltr" inputMode="tel" autoComplete="off" placeholder="05XXXXXXXX" required
                  value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-charcoal/60">{t('clientName')}</span>
                <input className={input} value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={80} />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-bold text-charcoal/60">{t('brokerName')}</span>
                  <input className={input} value={brokerName} onChange={(e) => setBrokerName(e.target.value)} maxLength={80} required />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-charcoal/60">{t('brokerPhone')}</span>
                  <input className={input} dir="ltr" inputMode="tel" placeholder="05XXXXXXXX" value={brokerPhone} onChange={(e) => setBrokerPhone(e.target.value)} />
                </label>
              </div>
              {error && <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{error}</div>}
              <button
                type="submit"
                disabled={phase === 'sending'}
                className="w-full h-12 rounded-xl bg-[#25D366] text-white font-bold inline-flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-60"
              >
                {phase === 'sending' ? <><Loader2 size={18} className="animate-spin" /> {t('sending')}</> : <><Send size={18} /> {t('send')}</>}
              </button>
            </form>
          )}

          {phase === 'sent' && (
            <div className="text-center rounded-2xl bg-white border border-emerald-200 p-6">
              <CheckCircle2 size={40} className="mx-auto text-emerald-600" />
              <div className="mt-2 text-lg font-bold text-chocolate">{t('sentTitle')}</div>
              <p className="mt-1 text-sm text-charcoal/70 leading-7">{t('sentBody')}</p>
              <button
                type="button"
                onClick={() => { setClientPhone(''); setClientName(''); setPhase('form'); }}
                className="mt-4 px-4 py-2 rounded-xl border border-sand text-sm font-bold text-charcoal hover:border-copper"
              >
                {t('sendAnother')}
              </button>
            </div>
          )}

          {!canSend && <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">{t('err_sending_disabled')}</div>}

          <div className="space-y-3">
            <div className="text-xs font-bold text-charcoal/50">{t('orYourself')}</div>
            {message === undefined && <div className="flex justify-center py-4"><Loader2 className="animate-spin text-copper" /></div>}
            {text && (
              <div className="rounded-xl bg-white border border-sand/50">
                <pre className="p-3 text-xs text-charcoal leading-6 whitespace-pre-wrap font-[inherit] max-h-56 overflow-y-auto" dir={isAr ? 'rtl' : 'ltr'}>{text}</pre>
                <div className="px-3 pb-3">
                  <button type="button" onClick={() => void copyText(text, t('messageCopied'), t('copyFailed'))}
                    className="w-full h-10 rounded-lg bg-chocolate text-white text-sm font-bold inline-flex items-center justify-center gap-2 hover:opacity-90">
                    <Copy size={16} /> {t('copyMessage')}
                  </button>
                </div>
              </div>
            )}
            {brochures.filter((b) => b.download).map((b) => (
              <a key={b.id} href={b.download ?? undefined}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white border border-sand/50 text-sm text-charcoal hover:border-copper">
                <Download size={16} className="text-copper shrink-0" />
                <span className="truncate">{t('downloadBrochure')} — {b.name}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
