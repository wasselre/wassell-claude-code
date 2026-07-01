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
  // Image Chats v2 — the worker now also drains the generation_jobs (image)
  // queue and calls fal.ai. imageGen.ts reads FAL_KEY (+ optional FAL_BASE_URL
  // / FAL_CHAT_MODEL_ID / FAL_CHAT_GPT_IMAGE_2_MODEL_ID) straight from
  // process.env; we require FAL_KEY here so the worker fails fast at boot
  // instead of dying on the first image job. Set FAL_KEY='stub' for offline/CI
  // (imageGen returns canned picsum URLs). NEW secret on the Fly app.
  'FAL_KEY',
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
  /** LibreOffice binary for office→PDF preview conversion. Default 'soffice'
   *  (installed in the Docker image). Override for local dev, e.g. on Windows:
   *  SOFFICE_BIN="C:\Program Files\LibreOffice\program\soffice.exe". */
  SOFFICE_BIN: string;
  /** Ghostscript binary for PDF compression (pdf_compress_jobs queue).
   *  Default 'gs' (installed in the Docker image). Override for local dev,
   *  e.g. on Windows: GS_BIN="C:\Program Files\gs\gs10\bin\gswin64c.exe". */
  GS_BIN: string;
  /** Base URL of the app (Vercel) the worker POSTs scheduled-report runs to.
   *  Default https://app.wassel.re. */
  APP_URL: string;
  /** Shared secret for POST /api/internal/run-report. When UNSET the worker's
   *  scheduled-reports loop self-disables (so the worker boots fine before the
   *  Scheduled Reports feature is enabled). Set it to turn reports on. */
  REPORTS_RUNNER_SECRET: string | null;
  /** Shared secret for POST /api/internal/run-workflow-job (server-authoritative
   *  workflow runner). When UNSET the worker's workflow loop self-disables, so
   *  the worker boots fine while the feature is inert. Set it (matching the
   *  Vercel prod env) to turn the workflow queue on. */
  WORKFLOW_RUNNER_SECRET: string | null;
  /** LOCAL PROOF MODE: when '1', the worker registers ONLY the workflow loop
   *  (skips deck/image/preview/compress/document/migration/reports/conflict),
   *  so the real worker code can be run locally against a preview endpoint
   *  without claiming live jobs from the OTHER shared-prod queues. Default
   *  (absent) = all loops, unchanged. MUST NEVER be set on the prod Fly worker. */
  WORKFLOW_PROOF_ONLY: boolean;
  /** Browserbase creds for the REGA advertiser-phone lookup (rega_lookup_jobs).
   *  When EITHER is UNSET the worker's rega loop self-disables (boots fine before
   *  the feature is enabled). Set BOTH via `fly secrets set` to turn it on. The
   *  browser runs remotely on Browserbase (playwright-core is a CDP client only,
   *  no local Chromium). */
  BROWSERBASE_API_KEY: string | null;
  BROWSERBASE_PROJECT_ID: string | null;
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
    SOFFICE_BIN: process.env.SOFFICE_BIN ?? 'soffice',
    GS_BIN: process.env.GS_BIN ?? 'gs',
    APP_URL: process.env.APP_URL ?? 'https://app.wassel.re',
    REPORTS_RUNNER_SECRET: process.env.REPORTS_RUNNER_SECRET ?? null,
    WORKFLOW_RUNNER_SECRET: process.env.WORKFLOW_RUNNER_SECRET ?? null,
    WORKFLOW_PROOF_ONLY: process.env.WORKFLOW_PROOF_ONLY === '1',
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY ?? null,
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID ?? null,
  };
}
