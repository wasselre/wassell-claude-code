import { authHeader } from '@/pages/GeoGrade/lib/shared';

/** An API error carrying the HTTP status (409 ⇒ reload, anything else ⇒ toast). */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** JSON call with the caller's bearer token. Throws HttpError on a non-2xx or an empty body. */
export async function callJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
  });
  // A non-JSON body (e.g. a platform 504 page) is reported through the status below.
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new HttpError(res.status, body?.error ?? `HTTP ${res.status}`);
  if (!body) throw new HttpError(res.status, 'empty response');
  return body;
}
