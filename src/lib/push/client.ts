/**
 * Web Push registration for the installed iOS app.
 *
 * iOS constraints that shape all of this — none are true on desktop:
 *
 *  1. Push works ONLY when the app has been added to the Home Screen and is
 *     running standalone. In a normal Safari tab `PushManager` may not exist
 *     at all, so "unsupported" and "not installed yet" are different answers
 *     and the UI has to tell them apart.
 *  2. `Notification.requestPermission()` must be called from a real user
 *     gesture. An automatic prompt on load is silently rejected — which is why
 *     there is a button rather than a useEffect.
 *  3. Requires iOS 16.4+.
 *
 * The subscription row is written straight to Supabase rather than through an
 * endpoint: RLS binds `user_id` to the caller's JWT (see the push_subs_own_*
 * policies), so the database — not this file — guarantees a device can only be
 * registered to the person signed in on it.
 */
import { supabase } from '@/lib/supabase';

/** VAPID public key. Safe to ship — it is the public half of the pair. */
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

// Local record of "this device's user asked for push". Set on enable, cleared
// on disable. It is what lets `ensurePushSubscription` re-register a rotated /
// expired subscription on app open WITHOUT re-enabling push for someone who
// deliberately turned it off. (Browsers rotate push subscriptions every few
// days; without re-registering, the stored endpoint goes dead and delivery
// silently stops — the "worked then stopped after a few days" bug.)
const PUSH_INTENT_KEY = 'wassell_push_enabled';
function setPushIntent(on: boolean): void {
  try {
    if (on) localStorage.setItem(PUSH_INTENT_KEY, '1');
    else localStorage.removeItem(PUSH_INTENT_KEY);
  } catch {
    // localStorage unavailable (private mode / iOS quirk) — non-fatal; the
    // re-subscribe path just won't self-heal, exactly the pre-fix behaviour.
  }
}
function hasPushIntent(): boolean {
  try {
    return localStorage.getItem(PUSH_INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

export type PushState =
  | 'unsupported'      // browser has no push at all
  | 'needs-install'    // iOS Safari tab — must Add to Home Screen first
  | 'unconfigured'     // no VAPID key in the build
  | 'default'          // supported, never asked
  | 'granted'
  | 'denied';

/** True when running as an installed Home Screen app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS predates the standard and only exposes this non-standard flag.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function getPushState(): PushState {
  if (!VAPID_PUBLIC_KEY) return 'unconfigured';
  const hasApi =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  if (!hasApi) {
    // On iOS the push APIs are hidden until the app is installed, so a missing
    // PushManager there means "not installed yet", not "never possible".
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  // Desktop browsers expose the APIs in a tab, but iOS still refuses to
  // deliver unless installed — so ask for installation before permission.
  if (isIos() && !isStandalone()) return 'needs-install';

  return Notification.permission as PushState;
}

/** base64url → Uint8Array, the format PushManager wants for the VAPID key. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export interface EnableResult {
  ok: boolean;
  state: PushState;
  error?: string;
}

/**
 * Ask for permission and register this device. MUST be called from a click
 * handler — see constraint 2 above.
 */
export async function enablePush(currentUserId: string | null): Promise<EnableResult> {
  const state = getPushState();
  if (state !== 'default' && state !== 'granted') {
    return { ok: false, state, error: `cannot enable from state "${state}"` };
  }
  if (!supabase) return { ok: false, state, error: 'Supabase not configured' };
  if (!currentUserId) return { ok: false, state, error: 'not signed in' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, state: permission as PushState, error: 'permission not granted' };
  }

  const registration = await registerServiceWorker();
  if (!registration) return { ok: false, state, error: 'service worker registration failed' };
  // A just-registered worker may still be installing; subscribing before it is
  // active throws.
  await navigator.serviceWorker.ready;

  // Reuse an existing subscription when there is one — re-subscribing on the
  // same device returns the same endpoint anyway, and this avoids a needless
  // key rotation.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required to be true by every browser; a silent push is not allowed.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
    }));

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, state: 'granted', error: 'subscription missing endpoint or keys' };
  }

  const { data: session } = await supabase.auth.getSession();
  const authUid = session.session?.user?.id;
  if (!authUid) return { ok: false, state: 'granted', error: 'no auth session' };

  // onConflict on endpoint: the same device re-enabling refreshes its keys
  // instead of accumulating duplicate rows that would each get a copy of
  // every notification.
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: currentUserId,
      auth_uid: authUid,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
      failure_count: 0,
    },
    { onConflict: 'endpoint' },
  );

  if (error) return { ok: false, state: 'granted', error: error.message };
  // Remember the user WANTS push on this device, so a later rotation re-registers.
  setPushIntent(true);
  return { ok: true, state: 'granted' };
}

/**
 * Re-register this device's subscription on app open, if the user previously
 * enabled push here. Idempotent and gesture-free (permission is already
 * granted, so `subscribe()` needs no user gesture). Heals the "worked then
 * stopped after a few days" case: push services rotate/expire subscriptions,
 * and without re-subscribing the DB keeps a dead endpoint the worker eventually
 * prunes. Re-subscribing refreshes the endpoint + keys and resets failure_count
 * so a device that is actually fine stops being treated as dead.
 *
 * Guarded by the local intent flag so it NEVER re-enables push for someone who
 * turned it off (disablePush clears the flag).
 */
export async function ensurePushSubscription(currentUserId: string | null): Promise<boolean> {
  if (!supabase || !currentUserId) return false;
  if (getPushState() !== 'granted') return false;  // permission revoked / needs-install / unsupported
  if (!VAPID_PUBLIC_KEY) return false;

  try {
    const registration = await registerServiceWorker();
    if (!registration) return false;
    await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    // Re-register only when the user actually wants push here: either they
    // enabled it (intent flag) OR a live subscription is already present. The
    // latter backfills the flag for devices subscribed BEFORE this self-heal
    // existed, so they start self-healing too. A device with neither is left
    // alone — we never create a subscription unprompted.
    if (!hasPushIntent()) {
      if (!existing) return false;
      setPushIntent(true);
    }

    // Use the existing subscription if the browser still has one; otherwise the
    // old one was rotated/expired away — make a fresh one.
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      }));

    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    const { data: session } = await supabase.auth.getSession();
    const authUid = session.session?.user?.id;
    if (!authUid) return false;

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: currentUserId,
        auth_uid: authUid,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent.slice(0, 300),
        failure_count: 0,
      },
      { onConflict: 'endpoint' },
    );
    if (error) {
      console.error('[push] ensurePushSubscription upsert failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    // Never let a background re-subscribe break app boot.
    console.error('[push] ensurePushSubscription error:', err);
    return false;
  }
}

/** Unregister this device. Leaves permission alone — the OS owns that. */
export async function disablePush(): Promise<void> {
  // Clear intent FIRST so a concurrent boot re-subscribe can't race it back on.
  setPushIntent(false);
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  // Delete AFTER unsubscribing: if the row were removed first and the
  // unsubscribe then failed, the push service would keep delivering to an
  // endpoint we no longer have any record of.
  if (supabase) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

/** Whether THIS device already has a live subscription. */
export async function isDeviceSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return !!(await registration?.pushManager.getSubscription());
}
