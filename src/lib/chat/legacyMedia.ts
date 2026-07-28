/**
 * Attachments from the retired Haberchat provider.
 *
 * Haberchat's account is gone: the file endpoint answers
 * `403 "Forbidden access. The API token provided is invalid"` for every id
 * (verified against production on 2026-07-28). The bytes are not fetchable by
 * us and no re-subscription is planned, so a Haberchat-era attachment is
 * permanently unavailable — not slow, not retryable, gone.
 *
 * 565 message rows across 74 conversations still point at one. They were
 * invisible while the threads themselves rendered empty; once the history came
 * back (WA-14) each one produced a doomed round-trip and a red error box
 * quoting a raw gateway 404 at the rep.
 *
 * Recognising them by SHAPE lets us say so honestly without asking a dead
 * service first. A Haberchat file id is a bare 24-character hex ObjectId; every
 * WAHA ref carries a `wt_` / `wf_` / `wm_` prefix, so the two cannot collide.
 */

const HABERCHAT_OBJECT_ID = /^[0-9a-f]{24}$/i;

export function isLegacyHaberchatRef(fileId: string | null | undefined): boolean {
  return typeof fileId === 'string' && HABERCHAT_OBJECT_ID.test(fileId);
}
