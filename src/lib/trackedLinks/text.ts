/**
 * Tracked-link message text — PURE, shared by the server send path
 * (api/_lib/trackedLinks.ts) and the rep composer, so both put the links in a
 * message the same way.
 */

/** A line that carries the old website project link, or an earlier tracked link. */
const OLD_LINK_LINE = /^.*(wassel\.re\/(?:en\/)?project\?id=|\/v\/[A-Za-z0-9]{8,}).*$/gm;

/** A tracked-link token inside a message body (…/v/<token>[/section]). */
export const TRACKED_LINK_RE = /\/v\/([A-Za-z0-9]{8,32})(?:\/(photos|videos|brochure|units|location))?/;

/** The message with its website link (and any earlier tracked links) replaced by `block`. */
export function replaceLinksInMessage(body: string, block: string): string {
  const cleaned = body.replace(OLD_LINK_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  return block ? (cleaned ? `${cleaned}\n\n${block}` : block) : cleaned;
}

/** The tracked-link token a message carries, if any. */
export function trackedTokenIn(body: string | null | undefined): string | null {
  const m = body ? TRACKED_LINK_RE.exec(body) : null;
  return m?.[1] ?? null;
}
