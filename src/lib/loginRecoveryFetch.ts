/**
 * Self-heal an expired login (2026-10-04).
 *
 * supabase-js renews the access token on a timer it sets from the LAPTOP's
 * clock. When that clock is behind, the browser believes an expired token is
 * still fresh and never renews it; the server then refuses every request with
 * 401 "JWT expired". A user saw a page of red "Server sync failed … JWT
 * expired" toasts while her session was valid server-side: it had last been
 * renewed hours earlier and the browser never asked again.
 *
 * So the SERVER's answer is trusted over the local clock: a 401 whose body says
 * the JWT expired triggers one renewal (shared by every request that hits it at
 * the same moment) and ONE retry of that request with the new token. Auth
 * endpoints are never retried, and a failed renewal returns the original 401 so
 * the existing error reporting still fires.
 */
export type RenewAccessToken = () => Promise<string | null>;

/** Wraps `renew` so concurrent callers share one in-flight renewal. */
export function shareRenewal(renew: RenewAccessToken): RenewAccessToken {
  let inFlight: Promise<string | null> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = renew().finally(() => {
        // Let the next expiry (an hour later) start a fresh renewal.
        setTimeout(() => { inFlight = null; }, 0);
      });
    }
    return inFlight;
  };
}

export function makeLoginRecoveryFetch(
  renew: RenewAccessToken,
  baseFetch: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await baseFetch(input, init);
    if (res.status !== 401) return res;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/auth/v1/')) return res;
    const body = await res.clone().text();
    if (!/jwt expired/i.test(body)) return res;
    const token = await renew();
    if (!token) return res;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    return baseFetch(input, { ...init, headers });
  };
}
