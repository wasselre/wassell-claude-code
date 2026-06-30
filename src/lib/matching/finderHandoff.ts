/**
 * In-memory hand-off from the Follow-up Workspace to the full-page Suggested
 * Projects finder (`/model/followups/:id/projects`). The workspace holds the
 * rep's UNSAVED preference draft in React state; when the rep opens the finder
 * page we stash that draft here (keyed by follow-up id) so the page matches
 * against exactly what was on screen — even before Save. On a cold load of the
 * finder URL (no hand-off) the page falls back to the saved client data.
 *
 * Deliberately a module singleton, not persisted: it only needs to survive the
 * same-tab client-side navigation between the two routes.
 */

export interface FinderHandoff {
  followupId: string;
  prefDraft: Record<string, unknown>;
  followupDraft: Record<string, unknown>;
  projectName: string | null;
}

let current: FinderHandoff | null = null;

export function setFinderHandoff(h: FinderHandoff): void {
  current = h;
}

/** Returns the hand-off only if it's for THIS follow-up (else null). */
export function getFinderHandoff(followupId: string): FinderHandoff | null {
  return current && current.followupId === followupId ? current : null;
}

export function clearFinderHandoff(): void {
  current = null;
}
