import { useEffect, useState } from 'react';
import { signViewUrls } from '@/lib/files/client';
import { isFileIdValue } from '@/pages/Records/components/useFileRowMap';

// Process-lifetime cache: files.id → signed view URL. Project images are
// immutable per id, so a single cache across all cards/heroes avoids re-signing.
const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function resolveOne(ref: string): Promise<string | null> {
  if (urlCache.has(ref)) return urlCache.get(ref)!;
  const p = signViewUrls([ref])
    .then((m) => {
      const u = m[ref] ?? null;
      if (u) urlCache.set(ref, u);
      return u;
    })
    .catch((e) => {
      console.error('[useSignedImage] failed to sign view url', e);
      return null;
    })
    .finally(() => { inflight.delete(ref); });
  inflight.set(ref, p);
  return p;
}

/**
 * Resolve an image field value to a renderable URL:
 *   - http(s) value → passthrough
 *   - files.id UUID → short-lived signed view URL (batched/cached)
 *   - anything else / unviewable → null (caller shows a placeholder)
 */
export function useSignedImage(ref: string | null | undefined): string | null {
  const initial = ref && /^https?:\/\//i.test(ref) ? ref : ref && urlCache.get(ref) ? urlCache.get(ref)! : null;
  const [url, setUrl] = useState<string | null>(initial);

  useEffect(() => {
    let alive = true;
    if (!ref) { setUrl(null); return; }
    if (/^https?:\/\//i.test(ref)) { setUrl(ref); return; }
    if (urlCache.has(ref)) { setUrl(urlCache.get(ref)!); return; }
    if (!isFileIdValue(ref)) { setUrl(null); return; }
    setUrl(null);
    (inflight.get(ref) ?? resolveOne(ref)).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [ref]);

  return url;
}
