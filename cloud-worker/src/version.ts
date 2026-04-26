/**
 * Bumped on meaningful behavior changes to the cloud worker — gets written
 * to `daemon_status.version` on every heartbeat so the app can see what's
 * running. Phase numbers track the rebuild plan in docs/prd/presentations.md.
 */
export const WORKER_VERSION = '0.4.0-phase3';
