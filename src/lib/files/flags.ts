/**
 * Feature flags for the Phase 3 Files batches.
 *
 * Every batch in this phase ships behind its own flag because every batch has
 * its own rollback boundary — B5's is "the flag returns the folder-first page",
 * B6's is "hide the panel; links already written stay valid and keep syncing".
 * One shared flag would mean rolling back B6 also rolls back B5, which is not
 * what either boundary says.
 *
 * Three sources, most specific first:
 *   1. a URL parameter — takes effect immediately AND is remembered, so one
 *      person can turn a batch on or off without a deploy. This is what makes
 *      a rollback instant rather than a build away.
 *   2. localStorage, from a previous use of (1).
 *   3. a Vite env var — the global default, set per environment.
 *
 * Default OFF everywhere.
 */

/**
 * Resolve one flag. Exported so each batch's flag reads identically; a batch
 * that hand-rolls its own precedence is a batch whose rollback behaves
 * differently from the others under pressure.
 */
export function readFileFlag(
  urlParam: string,
  storageKey: string,
  envValue: string | undefined,
  search?: string,
): boolean {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(search ?? window.location.search);
    const override = params.get(urlParam);
    if (override === '1' || override === '0') {
      try {
        window.localStorage.setItem(storageKey, override);
      } catch (err) {
        // Private mode / quota. The override still applies to THIS page load;
        // it just will not survive a reload. Worth a console line, never worth
        // failing the route that decides which page to render.
        console.warn(`[files] could not persist the ${urlParam} override`, err);
      }
      return override === '1';
    }
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === '1' || stored === '0') return stored === '1';
    } catch (err) {
      console.warn(`[files] could not read the ${urlParam} override`, err);
    }
  }
  return envValue === '1';
}

/**
 * Phase 3 · B6 — the unified Files panel on a record form.
 *
 * OFF returns the record form to exactly what it renders today: the Phase 1
 * "Linked documents" list. Links already written stay valid and keep syncing
 * either way, because they live in `document_links` and Phase 2 converges them
 * regardless of which panel is on screen.
 */
export function recordFilesEnabled(search?: string): boolean {
  return readFileFlag(
    'recordfiles',
    'wassell_record_files',
    import.meta.env.VITE_FEATURE_RECORD_FILES as string | undefined,
    search,
  );
}
