import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { enablePush, getPushState } from '@/lib/push/client';

/**
 * Auto-enable device push shortly after login (2026-08-31).
 *
 * Why this exists: the owner-targeted WhatsApp push pipeline works, but a push
 * only reaches a device that has opted in — and most reps never visited
 * /profile to turn it on, so their alerts were silently dropped
 * (`push_outbox.status='no_devices'`). This closes that gap by asking on its
 * own instead of waiting for the rep.
 *
 * The browser constraint we can't dodge: `Notification.requestPermission()` only
 * shows from a real user gesture (silently rejected otherwise, and hard-required
 * on Safari/iOS). So rather than fire on mount, we arm a ONE-TIME listener and
 * enable on the rep's first click/keypress after login — automatic from their
 * point of view, permitted by the browser.
 *
 * Runs at most once per device (a localStorage flag). We only ever engage from
 * the `default` state — never re-prompt someone who chose "deny" (that stays
 * `denied` and is excluded), never nag someone already subscribed (`granted`),
 * and never touch iOS-not-installed / unsupported. Those still enable/repair via
 * /profile (NotificationSettings) and the boot-time ensurePushSubscription
 * self-heal.
 */
const AUTO_PROMPT_KEY = 'wassell_push_auto_prompted';

export default function PushAutoPrompt() {
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';

  useEffect(() => {
    if (!currentUserId) return undefined;

    // Only the "supported, never asked" state is auto-promptable.
    if (getPushState() !== 'default') return undefined;

    try {
      if (localStorage.getItem(AUTO_PROMPT_KEY) === '1') return undefined;
    } catch {
      // localStorage unavailable (private mode) — proceed without the guard;
      // worst case we ask again next session, never more than once per gesture.
    }

    let done = false;
    const arm = (): void => {
      if (done) return;
      done = true;
      try {
        localStorage.setItem(AUTO_PROMPT_KEY, '1');
      } catch {
        // non-fatal — see above.
      }
      cleanup();
      void enablePush(currentUserId).then((res) => {
        if (res.ok) {
          addToast(
            isAr ? 'تم تفعيل إشعارات واتساب على هذا الجهاز.' : 'WhatsApp notifications are on for this device.',
            'success',
          );
        }
        // A denial / dismissal is intentionally silent — no nag. The rep can
        // still turn it on later from their profile.
      });
    };

    const cleanup = (): void => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };

    // `once` isn't enough on its own — two events could both be armed before the
    // first fires — so the `done` guard is the real gate; `once` just tidies up.
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return cleanup;
  }, [currentUserId, addToast, isAr]);

  return null;
}
