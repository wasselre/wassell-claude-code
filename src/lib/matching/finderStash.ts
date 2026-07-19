/**
 * Crash/refresh safety net for the Project Finder's UNSAVED selection.
 *
 * A finder session lives entirely in memory: the search results and the set of
 * cards the rep ticked. Anything that reloads the tab — the forced stale-build
 * update, an accidental F5, a browser crash — used to throw all of it away
 * (live report 2026-07-19: "if the app refreshes and I have not saved,
 * everything gets lost", with 95 options selected).
 *
 * We do NOT try to persist the whole result set (thousands of matches, megabytes
 * of facts). We persist the thing that is actually WORK: the exact save-payloads
 * of the SELECTED options. On the next finder open for that client we offer to
 * save or discard them — one click, no re-search, nothing lost.
 *
 * localStorage (not sessionStorage): a forced reload keeps the tab, but a crash
 * or a "reopen closed tab" does not, and the rep's selection should survive both.
 * Guarded per the silent-failure rules: quota/parse failures are logged and the
 * stash degrades to "no stash" — it can never break the finder.
 */

import type { SaveOptionInput } from './clientOptions';

const KEY_PREFIX = 'wassell_finder_stash:';
/** Stashes older than this are ignored + swept (a stale selection is noise). */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap so one enormous selection can't blow the localStorage budget. */
const MAX_ITEMS = 500;

export interface FinderStash {
  clientId: string;
  savedAt: number;
  /** Ready-to-save payloads (clientId is supplied at save time). */
  items: Omit<SaveOptionInput, 'clientId'>[];
}

const keyFor = (clientId: string): string => `${KEY_PREFIX}${clientId}`;

/** Persist the current selection. An empty selection CLEARS the stash. */
export function saveFinderStash(clientId: string, items: Omit<SaveOptionInput, 'clientId'>[]): void {
  if (!clientId) return;
  if (items.length === 0) { clearFinderStash(clientId); return; }
  const stash: FinderStash = { clientId, savedAt: Date.now(), items: items.slice(0, MAX_ITEMS) };
  try {
    localStorage.setItem(keyFor(clientId), JSON.stringify(stash));
  } catch (e) {
    // QuotaExceededError is the realistic case (a huge selection). The finder
    // keeps working; the rep just loses the refresh safety net for this one.
    console.error('[finderStash] could not persist the selection:', e);
  }
}

/** The stash for this client, or null when absent / expired / malformed. */
export function loadFinderStash(clientId: string): FinderStash | null {
  if (!clientId) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(clientId));
  } catch (e) {
    console.error('[finderStash] could not read the stash:', e);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FinderStash;
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > TTL_MS) {
      clearFinderStash(clientId);
      return null;
    }
    return parsed;
  } catch (e) {
    // Corrupt entry — drop it rather than letting it resurface every open.
    console.error('[finderStash] malformed stash, dropping it:', e);
    clearFinderStash(clientId);
    return null;
  }
}

export function clearFinderStash(clientId: string): void {
  if (!clientId) return;
  try {
    localStorage.removeItem(keyFor(clientId));
  } catch (e) {
    console.error('[finderStash] could not clear the stash:', e);
  }
}
