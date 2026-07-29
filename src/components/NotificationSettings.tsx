/**
 * Per-device push notification control, shown on /profile.
 *
 * Per-DEVICE is the important word: a rep who enables this on their iPhone has
 * not enabled it on their laptop, because a push subscription belongs to one
 * browser on one machine. The copy says so, otherwise "I already turned it on"
 * turns into a support conversation.
 *
 * On iOS the button cannot be replaced by an automatic prompt — permission has
 * to be requested from a real user gesture — and push is only delivered once
 * the app has been added to the Home Screen. Both states get their own
 * explanation rather than a generic "not supported".
 */
import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2, Share, Smartphone } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  disablePush,
  enablePush,
  getPushState,
  isDeviceSubscribed,
  type PushState,
} from '@/lib/push/client';

export default function NotificationSettings() {
  const { language, addToast, currentUserId } = useAppStore();
  const isAr = language === 'ar';

  const [state, setState] = useState<PushState>('unsupported');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = getPushState();
      const sub = await isDeviceSubscribed();
      if (cancelled) return;
      setState(s);
      setSubscribed(sub);
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = async () => {
    setBusy(true);
    try {
      const result = await enablePush(currentUserId);
      setState(result.state);
      if (result.ok) {
        setSubscribed(true);
        addToast(isAr ? 'تم تفعيل الإشعارات على هذا الجهاز' : 'Notifications enabled on this device', 'success');
      } else {
        // Surface the reason — a silent no-op here is indistinguishable from
        // success and the rep would sit waiting for alerts that never come.
        addToast(
          (isAr ? 'تعذّر تفعيل الإشعارات: ' : 'Could not enable notifications: ') + (result.error ?? ''),
          'error',
        );
        console.error('[push] enable failed:', result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await disablePush();
      setSubscribed(false);
      addToast(isAr ? 'تم إيقاف الإشعارات على هذا الجهاز' : 'Notifications disabled on this device', 'info');
    } catch (err) {
      addToast(isAr ? 'تعذّر إيقاف الإشعارات' : 'Could not disable notifications', 'error');
      console.error('[push] disable failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const title = isAr ? 'الإشعارات' : 'Notifications';
  const explainer = isAr
    ? 'تنبيهات فورية عند وصول عميل جديد أو رد أحد العملاء — حتى والتطبيق مغلق.'
    : 'Instant alerts when a new lead arrives or a customer replies — even with the app closed.';

  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wider text-charcoal/50 font-bold mb-1">
        {title}
      </div>
      <p className="text-xs text-charcoal/60 mb-3">{explainer}</p>

      {!checked && <Loader2 size={16} className="animate-spin text-charcoal/40" />}

      {checked && state === 'needs-install' && (
        <div className="flex items-start gap-2 text-sm text-charcoal/80">
          <Share size={16} className="mt-0.5 shrink-0 text-copper" />
          <div>
            <div className="font-bold">
              {isAr ? 'أضف التطبيق إلى الشاشة الرئيسية أولاً' : 'Add the app to your Home Screen first'}
            </div>
            <div className="text-xs text-charcoal/60 mt-1">
              {isAr
                ? 'في متصفح Safari: زر المشاركة ← «إضافة إلى الشاشة الرئيسية». ثم افتح التطبيق من الأيقونة وفعّل الإشعارات من هنا. لا يعمل هذا في متصفح Chrome على الآيفون.'
                : 'In Safari: Share → "Add to Home Screen". Then open the app from the icon and enable notifications here. This does not work in Chrome on iPhone.'}
            </div>
          </div>
        </div>
      )}

      {checked && state === 'unconfigured' && (
        <div className="text-sm text-charcoal/60">
          {isAr ? 'الإشعارات غير مهيأة في هذه النسخة.' : 'Push is not configured in this build.'}
        </div>
      )}

      {checked && state === 'unsupported' && (
        <div className="flex items-start gap-2 text-sm text-charcoal/60">
          <Smartphone size={16} className="mt-0.5 shrink-0" />
          <span>
            {isAr
              ? 'هذا المتصفح لا يدعم الإشعارات.'
              : 'This browser does not support push notifications.'}
          </span>
        </div>
      )}

      {checked && state === 'denied' && (
        <div className="text-sm text-charcoal/80">
          <div className="font-bold">{isAr ? 'الإشعارات محظورة' : 'Notifications are blocked'}</div>
          <div className="text-xs text-charcoal/60 mt-1">
            {isAr
              ? 'تم رفض الإذن سابقاً. لا يمكن طلبه مرة أخرى من داخل التطبيق — فعّله من إعدادات الجهاز: الإعدادات ← الإشعارات ← وصل.'
              : 'Permission was denied earlier and cannot be re-requested from inside the app. Enable it in device settings: Settings → Notifications → وصل.'}
          </div>
        </div>
      )}

      {checked && (state === 'default' || state === 'granted') && (
        <div className="flex items-center gap-3 flex-wrap">
          {subscribed ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm text-charcoal/80">
                <Bell size={15} className="text-copper" />
                {isAr ? 'مفعّلة على هذا الجهاز' : 'Enabled on this device'}
              </span>
              <Button variant="secondary" onClick={handleDisable} disabled={busy}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                <BellOff size={14} />
                {isAr ? 'إيقاف' : 'Turn off'}
              </Button>
            </>
          ) : (
            <Button onClick={handleEnable} disabled={busy || !currentUserId}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
              {isAr ? 'تفعيل الإشعارات على هذا الجهاز' : 'Enable on this device'}
            </Button>
          )}
        </div>
      )}

      {checked && (state === 'default' || state === 'granted' || state === 'denied') && (
        <p className="text-[11px] text-charcoal/45 mt-3">
          {isAr
            ? 'الإعداد خاص بكل جهاز على حدة — فعّله على كل جهاز تريد أن تصلك عليه التنبيهات.'
            : 'This setting is per device — enable it on each device you want alerts on.'}
        </p>
      )}
    </div>
  );
}
