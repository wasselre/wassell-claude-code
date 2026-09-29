/**
 * Tiny page-local toast for the broker portal. The public page never boots the
 * CRM store (see App.tsx isSelfContainedPublicPath), so it cannot use the app's
 * toast system; `flash()` publishes, `<FlashHost/>` (in BrokerPortalPage) renders.
 */

export type FlashKind = 'ok' | 'error';
export interface FlashMsg { id: number; text: string; kind: FlashKind }

type Listener = (m: FlashMsg) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function flash(text: string, kind: FlashKind = 'ok'): void {
  const msg = { id: ++seq, text, kind };
  for (const l of listeners) l(msg);
}

export function onFlash(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
