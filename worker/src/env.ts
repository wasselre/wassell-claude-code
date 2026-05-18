/**
 * Strict env loader for the deck worker.
 *
 * Fail fast at startup if anything required is missing — better than
 * dying mid-job with an obscure undefined-deref. Optional vars get
 * sensible defaults that match the values in fly.toml.
 */

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_WASSEL_SKILL_ID',
] as const;

export interface WorkerEnv {
  /** Supabase project URL (e.g. https://xxx.supabase.co). */
  SUPABASE_URL: string;
  /** Service role key — bypasses RLS. NEVER expose to the browser. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Anthropic API key. */
  ANTHROPIC_API_KEY: string;
  /** Uploaded wassel-general-ppt skill id (sk_xxx) — composition primitives. */
  ANTHROPIC_WASSEL_SKILL_ID: string;
  /** Optional wassel-deck-review skill id — auto-patch QA gate. When unset,
   *  the worker skips the review pass and ships the raw build. */
  ANTHROPIC_WASSEL_REVIEW_SKILL_ID: string | null;
  /** HTTP port for /healthz + /wake. Fly.io health check hits this. */
  PORT: number;
  /** Identifies this worker in deck_jobs.worker_id. Defaults to the Fly
   *  machine id (provided automatically inside Fly) or a local-* string
   *  when running outside Fly. */
  WORKER_ID: string;
  /** How often to poll deck_jobs when idle. */
  POLL_INTERVAL_MS: number;
  /** How often to invoke deck_jobs_watchdog() to sweep stale jobs. */
  WATCHDOG_INTERVAL_MS: number;
}

export function loadEnv(): WorkerEnv {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[worker] FATAL: missing required env vars: ${missing.join(', ')}`);
    console.error('[worker] Set them via `fly secrets set KEY=value` (prod) or `.env` (local).');
    process.exit(1);
  }
  return {
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    ANTHROPIC_WASSEL_SKILL_ID: process.env.ANTHROPIC_WASSEL_SKILL_ID!,
    ANTHROPIC_WASSEL_REVIEW_SKILL_ID: process.env.ANTHROPIC_WASSEL_REVIEW_SKILL_ID ?? null,
    PORT: parseInt(process.env.PORT ?? '8080', 10),
    WORKER_ID:
      process.env.FLY_MACHINE_ID ??
      process.env.WORKER_ID ??
      `local-${process.pid}-${Date.now()}`,
    POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS ?? '3000', 10),
    WATCHDOG_INTERVAL_MS: parseInt(process.env.WATCHDOG_INTERVAL_MS ?? '300000', 10),
  };
}
