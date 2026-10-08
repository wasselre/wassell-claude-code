/**
 * Is this error the AI PROVIDER being unavailable — not something wrong with
 * the item being processed?
 *
 * Why it matters (incident 2026-10-08): the Anthropic credit ran out for ~4
 * hours. The automation cron records a failed follow-up draft / officer check
 * as DONE on purpose, so a chat that breaks every time is not re-billed every
 * 5 minutes — but an outage is not a broken chat. 6 follow-up rounds and 4
 * officer checks were closed for good by an empty balance, and would never
 * have been retried. Callers use this to leave the item open and stop for the
 * tick instead: the next tick retries, so an outage costs one failed call per
 * section per 5 minutes and nothing is lost.
 *
 * Deliberately narrow — only failures that say nothing about the input:
 * exhausted credit / billing, overload, rate limit, provider 5xx, network.
 * A 400 for a bad request stays a per-item failure.
 */
const OUTAGE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504, 529]);
const OUTAGE_TEXT = /credit balance is too low|insufficient[_ ]?(balance|quota|credits?)|billing|overloaded|rate[_ ]?limit|too many requests|service unavailable|bad gateway|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network error/i;

export function isProviderOutage(err: unknown): boolean {
  if (!err) return false;
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status?: unknown }).status) : NaN;
  if (Number.isFinite(status) && OUTAGE_STATUS.has(status)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (OUTAGE_TEXT.test(msg)) return true;
  // «… 529 {"type":"error","error":{"type":"overloaded_error"…» — the status
  // can arrive only inside the message once an error has been re-wrapped.
  return /(^|\D)(429|5\d\d)\s*\{"type":"error"/.test(msg);
}
