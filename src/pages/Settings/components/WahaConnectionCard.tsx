import { useCallback, useEffect, useRef, useState } from 'react';
import { QrCode, RefreshCw, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { getWahaSessionState, restartWahaSession, getWahaQrBlob, type WahaSessionState } from '@/lib/waha/client';

/**
 * Admin card: live WAHA session status + in-app re-pairing.
 *
 * States and what the admin sees:
 *   WORKING       → green pill + connected number; a Restart button for the
 *                   rare "connected but misbehaving" case.
 *   FAILED/STOPPED→ red pill + a "Re-pair (QR)" button that restarts the
 *                   session and rolls straight into the QR flow.
 *   SCAN_QR_CODE  → the QR image, auto-refreshed every 15s (WAHA rotates the
 *                   code ~20s and drops the session ~60s after each attempt —
 *                   the card restarts + refetches transparently on expiry).
 *   STARTING      → spinner pill.
 *
 * Polling: 5s while a pairing attempt is active, 20s when idle. The QR blob
 * is fetched with the auth header (the endpoint is admin-only), so a plain
 * <img src> can't be used — object URLs are created and revoked here.
 */
export default function WahaConnectionCard({ session, label, phone }: { session: string; label?: string; phone?: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [state, setState] = useState<WahaSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const qrUrlRef = useRef<string | null>(null);
  const wasWorkingRef = useRef<boolean | null>(null);

  const setQr = useCallback((url: string | null) => {
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    qrUrlRef.current = url;
    setQrUrl(url);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await getWahaSessionState(session);
      setState(st);
      setError(null);
      // Announce transitions into/out of WORKING once (not on first load).
      if (wasWorkingRef.current !== null && wasWorkingRef.current !== (st.status === 'WORKING')) {
        addToast(
          st.status === 'WORKING'
            ? (useAppStore.getState().language === 'ar' ? 'تم الاتصال بواتساب بنجاح' : 'WhatsApp connected')
            : (useAppStore.getState().language === 'ar' ? 'انقطع اتصال واتساب' : 'WhatsApp disconnected'),
          st.status === 'WORKING' ? 'success' : 'error',
        );
      }
      wasWorkingRef.current = st.status === 'WORKING';
      return st;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error('[WahaConnectionCard] status fetch failed:', err);
      return null;
    }
  }, [session, addToast]);

  const refreshQr = useCallback(async () => {
    try {
      const blob = await getWahaQrBlob(session);
      setQr(URL.createObjectURL(blob));
    } catch (err) {
      // Expected when the session collapsed mid-pairing (WAHA 422s the QR
      // endpoint outside SCAN_QR_CODE) — the pairing loop below restarts it.
      console.error('[WahaConnectionCard] QR fetch failed:', err);
      setQr(null);
    }
  }, [session, setQr]);

  // Status poll: fast while pairing, slow when idle.
  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), pairing ? 5000 : 20000);
    return () => clearInterval(id);
  }, [refreshStatus, pairing]);

  // Pairing loop: keep a scannable QR on screen until WORKING.
  // WAHA drops the session to FAILED ~60s after each unscanned QR window, so
  // on FAILED we restart and keep going; the QR itself refreshes every 15s.
  useEffect(() => {
    if (!pairing) {
      setQr(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const st = await refreshStatus();
      if (cancelled || !st) return;
      if (st.status === 'WORKING') {
        setPairing(false);
        return;
      }
      if (st.status === 'SCAN_QR_CODE') {
        await refreshQr();
      } else if (st.status === 'FAILED' || st.status === 'STOPPED') {
        setQr(null);
        try {
          await restartWahaSession(session);
        } catch (err) {
          console.error('[WahaConnectionCard] auto-restart during pairing failed:', err);
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pairing, refreshStatus, refreshQr, session, setQr]);

  // Revoke the last object URL on unmount.
  useEffect(() => () => { if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current); }, []);

  const startPairing = async () => {
    setBusy(true);
    try {
      await restartWahaSession(session);
      setPairing(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
      console.error('[WahaConnectionCard] restart failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const restartConnected = async () => {
    // Restarting a WORKING session briefly disconnects it; if the stored login
    // is invalid it will land on SCAN_QR_CODE and need a re-scan.
    const ok = window.confirm(
      isAr
        ? 'إعادة التشغيل تقطع الاتصال لثوانٍ، وقد تتطلب إعادة مسح رمز QR إذا كان الربط منتهياً. متابعة؟'
        : 'Restarting briefly disconnects the session and may require re-scanning the QR if the login expired. Continue?',
    );
    if (!ok) return;
    setBusy(true);
    try {
      await restartWahaSession(session);
      setPairing(true); // rolls into the QR flow automatically if needed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
      console.error('[WahaConnectionCard] restart failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? null;
  const working = status === 'WORKING';
  const scanning = pairing && status === 'SCAN_QR_CODE' && !!qrUrl;

  return (
    <div className="card p-5 mb-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${working ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
          {working ? <Wifi size={20} className="text-green-600" /> : <WifiOff size={20} className="text-red-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-charcoal">
              {label
                ? (isAr ? `اتصال واتساب — ${label}` : `WhatsApp — ${label}`)
                : (isAr ? 'اتصال واتساب (الخادم)' : 'WhatsApp Connection (server)')}
            </h3>
            <StatusPill status={status} error={error} isAr={isAr} />
          </div>
          <p className="text-xs text-charcoal/50 mt-1">
            {working && state?.me
              ? (isAr
                  ? `متصل كـ ${state.me.pushName ?? ''} (${state.me.id.replace('@c.us', '')})`
                  : `Connected as ${state.me.pushName ?? ''} (${state.me.id.replace('@c.us', '')})`)
              : phone
                ? (isAr
                    ? `${phone} — إذا فشل الإرسال برسالة 422، الجلسة منقطعة، أعد الإقران من هنا.`
                    : `${phone} — if sends fail with a 422, the session dropped; re-pair from here.`)
                : isAr
                  ? 'إذا فشل الإرسال برسالة 422، الجلسة منقطعة — أعد الإقران من هنا.'
                  : 'If sends fail with a 422, the session dropped — re-pair from here.'}
          </p>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          {working ? (
            <Button variant="secondary" onClick={restartConnected} disabled={busy} className="!text-xs">
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
              {isAr ? 'إعادة تشغيل' : 'Restart'}
            </Button>
          ) : pairing ? (
            <Button variant="secondary" onClick={() => setPairing(false)} disabled={busy} className="!text-xs">
              {isAr ? 'إيقاف الإقران' : 'Stop pairing'}
            </Button>
          ) : (
            <Button onClick={startPairing} disabled={busy || !status} className="!text-xs">
              <QrCode size={14} />
              {isAr ? 'إعادة الإقران (QR)' : 'Re-pair (QR)'}
            </Button>
          )}
        </div>
      </div>

      {pairing && (
        <div className="mt-4 flex flex-col sm:flex-row items-center gap-4 rounded-xl bg-cream/60 p-4">
          <div className="w-48 h-48 rounded-lg bg-white flex items-center justify-center shrink-0 border border-sand">
            {scanning ? (
              <img src={qrUrl ?? undefined} alt="WhatsApp QR" className="w-44 h-44" />
            ) : (
              <Loader2 size={28} className="animate-spin text-charcoal/30" />
            )}
          </div>
          <div className="text-sm text-charcoal/70 space-y-1.5">
            <p className="font-bold text-charcoal">
              {isAr ? 'اربط الجهاز من هاتف الشركة:' : 'Pair from the company phone:'}
            </p>
            <p>{isAr ? '١. افتح واتساب ← الإعدادات ← الأجهزة المرتبطة' : '1. WhatsApp → Settings → Linked devices'}</p>
            <p>{isAr ? '٢. اضغط «ربط جهاز»' : '2. Tap “Link a device”'}</p>
            <p>{isAr ? '٣. امسح الرمز — يتجدد تلقائياً كل ١٥ ثانية' : '3. Scan the code — it auto-refreshes every 15s'}</p>
            <p className="text-xs text-charcoal/45">
              {isAr
                ? 'اترك هذه الصفحة مفتوحة حتى تتحول الحالة إلى «متصل».'
                : 'Keep this page open until the status turns “Connected”.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, error, isAr }: { status: string | null; error: string | null; isAr: boolean }) {
  let color = '#6b7280';
  let label = isAr ? 'جارٍ التحقق…' : 'Checking…';
  if (error) {
    color = '#ef4444';
    label = isAr ? 'تعذر الوصول للخادم' : 'Server unreachable';
  } else if (status === 'WORKING') {
    color = '#22c55e';
    label = isAr ? 'متصل' : 'Connected';
  } else if (status === 'SCAN_QR_CODE') {
    color = '#f59e0b';
    label = isAr ? 'بانتظار مسح QR' : 'Waiting for QR scan';
  } else if (status === 'STARTING') {
    color = '#f59e0b';
    label = isAr ? 'جارٍ التشغيل…' : 'Starting…';
  } else if (status === 'FAILED' || status === 'STOPPED') {
    color = '#ef4444';
    label = isAr ? 'منقطع' : 'Disconnected';
  } else if (status) {
    label = status;
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ backgroundColor: `${color}14`, color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
