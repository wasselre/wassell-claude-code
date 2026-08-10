/**
 * Canonical URL resolution for marketing-library assets.
 *
 * The library holds TWO shapes of asset and this hook is the one place that
 * knows the difference:
 *
 *   LEGACY  — `url` (and usually `thumb_url`) point at a public object in the
 *             `marketing-assets` bucket under `mos/`. Returned VERBATIM; no
 *             signing request is ever made for these. Every asset in
 *             production today is this shape, so this hook is inert for them.
 *
 *   CANONICAL — no `url`, only `file_id` → a row in `files` whose bytes live in
 *             the PRIVATE `wassel-files` bucket. These need a short-lived
 *             signed URL, minted in batches through the existing
 *             `/api/files/sign-view-urls` endpoint (RLS-filtered server-side:
 *             ids the caller may not view are simply absent from the map).
 *
 * Deliberately NOT a new signing subsystem — `signViewUrls` already batches,
 * already gates on RLS, and already caps at 200 ids per request.
 *
 * Signed URLs carry a 5-minute TTL (`VIEW_URL_TTL_SECONDS` in api/_lib/files.ts).
 * We re-sign a minute early so a URL handed to an <img> is never already dead.
 * Consumers that stream (video/audio) must LATCH the first URL they get — see
 * `useLatchedUrl` below — because swapping a media element's `src` restarts
 * playback from zero.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { signViewUrls } from '@/lib/files/client';
import type { MosAsset } from '@/lib/marketingOS/client';

/** Matches MAX_BATCH in api/files/sign-view-urls.ts — larger batches are silently truncated there. */
const SIGN_BATCH = 200;

/** Signed-view TTL is 5 min (VIEW_URL_TTL_SECONDS); refresh a minute early. */
const REFRESH_MS = 4 * 60 * 1000;

/** The minimum an asset must carry to be resolvable at all. */
type ResolvableAsset = Pick<MosAsset, 'file_id' | 'url' | 'thumb_url' | 'kind'> & {
  mime_type?: string | null;
};

export interface AssetUrlResolver {
  /** The full-size/original URL for an asset, or null when it cannot be resolved. */
  urlFor: (asset: ResolvableAsset | null | undefined) => string | null;
  /** A thumbnail URL, or null when the asset has no renderable thumbnail. */
  thumbFor: (asset: ResolvableAsset | null | undefined) => string | null;
  /** True while a signing round-trip is in flight. */
  loading: boolean;
  /** The real signing error, surfaced so callers can render it. Null when fine. */
  error: string | null;
  /** Re-run signing now (for a visible "retry" affordance). */
  retry: () => void;
}

/** Canonical assets are the ones with bytes in `files` and no legacy public URL. */
export function needsSigning(
  a: ResolvableAsset | null | undefined,
): a is ResolvableAsset & { file_id: string } {
  return Boolean(a && a.file_id && !a.url);
}

/** Whether a canonical asset can be rendered directly as an <img> thumbnail. */
export function isImageAsset(a: ResolvableAsset): boolean {
  const mime = (a.mime_type ?? '').toLowerCase();
  if (mime) return mime.startsWith('image/');
  return a.kind === 'photo' || a.kind === 'design';
}

/**
 * The de-duplicated, SORTED file ids a list of assets needs signed.
 *
 * Sorted so the caller can join it into an effect key that is stable under
 * re-ordering: a list that merely got re-sorted upstream must not trigger a
 * fresh round of signing requests.
 */
export function requiredFileIds(
  assets: ReadonlyArray<ResolvableAsset | null | undefined>,
): string[] {
  const out = new Set<string>();
  for (const a of assets) if (needsSigning(a)) out.add(a.file_id);
  return Array.from(out).sort();
}

/** The full-size URL: legacy stored URL verbatim, else the signed one. */
export function resolveAssetUrl(
  asset: ResolvableAsset | null | undefined,
  signed: Readonly<Record<string, string>>,
): string | null {
  if (!asset) return null;
  if (asset.url) return asset.url; // legacy — verbatim, never signed
  if (asset.file_id) return signed[asset.file_id] ?? null;
  return null;
}

/** The thumbnail URL, or null when the asset has none to show. */
export function resolveAssetThumb(
  asset: ResolvableAsset | null | undefined,
  signed: Readonly<Record<string, string>>,
): string | null {
  if (!asset) return null;
  if (asset.thumb_url) return asset.thumb_url; // legacy — verbatim
  // A legacy asset with no stored thumb has no thumbnail (video/PDF today);
  // keep that exactly as it is rather than inventing one.
  if (asset.url) return null;
  if (asset.file_id && isImageAsset(asset)) return signed[asset.file_id] ?? null;
  return null;
}

/**
 * Resolve display URLs for a list of assets.
 *
 * The effect keys off a SORTED STRING of the file ids that actually need
 * signing — not the array identity — so a parent re-render that rebuilds the
 * array (filtering, sorting, a new fetch returning equal data) does not fire a
 * fresh round of signing requests.
 */
export function useAssetUrls(assets: ReadonlyArray<ResolvableAsset | null | undefined>): AssetUrlResolver {
  const [signed, setSigned] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the refresh timer and by retry() to force a re-sign. */
  const [round, setRound] = useState(0);

  // Recomputed every render (cheap: one pass + a sort), but only its VALUE
  // feeds the effect — so identity churn upstream costs nothing.
  const idsKey = requiredFileIds(assets).join(',');

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    if (ids.length === 0) {
      // Nothing canonical on screen — drop any stale signed URLs rather than
      // holding dead strings for the lifetime of the page.
      setSigned((cur) => (Object.keys(cur).length === 0 ? cur : {}));
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const merged: Record<string, string> = {};
        for (let i = 0; i < ids.length; i += SIGN_BATCH) {
          const batch = ids.slice(i, i + SIGN_BATCH);
          const urls = await signViewUrls(batch);
          Object.assign(merged, urls);
        }
        if (cancelled) return;
        setSigned(merged);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Fail loudly: keep the real message for the UI and the console. A
        // blank thumbnail with a silent console line is exactly the failure
        // mode this repo has been bitten by (see CLAUDE.md "Silent Failures").
        const message = e instanceof Error ? e.message : String(e);
        console.error('[marketing] signing library asset URLs failed', e);
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idsKey, round]);

  // Re-sign before the 5-minute TTL lapses, but only while something on screen
  // actually needs a signed URL — an all-legacy page schedules no timers.
  useEffect(() => {
    if (idsKey === '') return;
    const t = setInterval(() => setRound((r) => r + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, [idsKey]);

  const urlFor = useCallback(
    (asset: ResolvableAsset | null | undefined) => resolveAssetUrl(asset, signed),
    [signed],
  );

  const thumbFor = useCallback(
    (asset: ResolvableAsset | null | undefined) => resolveAssetThumb(asset, signed),
    [signed],
  );

  const retry = useCallback(() => setRound((r) => r + 1), []);

  return { urlFor, thumbFor, loading, error, retry };
}

/**
 * Hold the FIRST non-empty URL for a streaming media element.
 *
 * `useAssetUrls` re-signs every four minutes. Feeding a fresh `src` to a
 * playing <video>/<audio> reloads it and drops the user back to 00:00, so the
 * media branches latch instead. The latch resets when the underlying asset
 * changes (a different `key`), and `reset()` lets an `onError` handler take the
 * newest URL after a genuine expiry.
 *
 * Known Phase-0 limitation: a signed URL dies after 5 minutes, so SEEKING in a
 * file-backed clip that has been open longer issues a range request the token
 * no longer covers. Already-buffered playback is unaffected. The durable fix
 * (longer media TTL or a streaming proxy) belongs to the delivery phase, not
 * here — every asset in production today is legacy/public and never signs.
 */
export function useLatchedUrl(url: string | null, key: string | null): {
  url: string | null;
  reset: () => void;
} {
  const [latched, setLatched] = useState<string | null>(null);
  const keyRef = useRef<string | null>(key);

  if (keyRef.current !== key) {
    keyRef.current = key;
    if (latched !== null) setLatched(null);
  }

  useEffect(() => {
    if (latched === null && url) setLatched(url);
  }, [latched, url]);

  const reset = useCallback(() => setLatched(null), []);
  return { url: latched ?? url, reset };
}
