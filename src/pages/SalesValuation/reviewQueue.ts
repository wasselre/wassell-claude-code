// Ephemeral "review playlist" shared between the Sales Valuation queue and the
// single-review screen. When a manager opens a review from the queue we freeze
// the queue's CURRENT ordered list of review ids here, so the review screen can
// offer Prev / Next navigation and auto-advance on save WITHOUT re-deriving the
// queue (which would shift indices the moment a saved review drops out of its
// filter). Purely navigation state — never data — so it lives in sessionStorage
// and is safe to lose.

const KEY = 'sv_review_queue';

/** Freeze the ordered review ids the user is navigating (called from the queue). */
export function setReviewQueue(ids: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // sessionStorage write can throw (private mode / quota). This is ephemeral
    // nav state only — losing it just disables Prev/Next, never data. Safe to ignore.
  }
}

/** Read the frozen review-id playlist (empty when opened via direct URL). */
export function getReviewQueue(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // Corrupt/absent JSON in ephemeral nav state — return no playlist (Prev/Next
    // simply hidden). Not a data path, nothing to surface.
    return [];
  }
}
