import { config as loadDotenv } from 'dotenv';

// `override: true` because some shells (and the Claude Code harness) export
// empty `ANTHROPIC_API_KEY` / similar vars by default. dotenv's default is
// "don't overwrite already-set vars", which leaves the empty string in place
// and our `requireEnv` then fails. The .env file is the authoritative source
// for this worker's secrets.
loadDotenv({ override: true });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `[cloud-worker] missing required env var ${name}. Copy cloud-worker/.env.example to cloud-worker/.env (local dev) or set it as a deploy-platform secret (production).`,
    );
  }
  return v.trim();
}

function parseInt_(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[cloud-worker] env var ${name} must be a positive integer; got: ${raw}`);
  }
  return n;
}

export interface WorkerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  anthropicApiKey: string;
  /** OAuth credentials for Google Drive uploads. Three values must all be
   *  present for the drive_upload tool to work: the OAuth client ID + secret
   *  (set once when you create the OAuth client in Google Cloud) and the
   *  refresh token (captured by `npm run oauth-init` — that's a one-time
   *  browser flow). Returns null if any of the three are missing — the
   *  worker still boots; only Drive-using runs fail. */
  googleDriveOAuth: GoogleDriveOAuth | null;
  /** Google Drive folder ID where new decks land. Optional — when missing,
   *  uploads land in the root of the OAuth user's Drive. */
  googleDriveParentFolderId: string | null;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  jobTimeoutSeconds: number;
}

export interface GoogleDriveOAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function loadOAuth(): GoogleDriveOAuth | null {
  const id = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const secret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  const token = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '').trim();
  if (id === '' || secret === '' || token === '') return null;
  return { clientId: id, clientSecret: secret, refreshToken: token };
}

export function loadEnv(): WorkerEnv {
  const folderId = (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID ?? '').trim();
  return {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    googleDriveOAuth: loadOAuth(),
    googleDriveParentFolderId: folderId === '' ? null : folderId,
    pollIntervalMs: parseInt_('POLL_INTERVAL_MS', 5_000),
    heartbeatIntervalMs: parseInt_('HEARTBEAT_INTERVAL_MS', 15_000),
    jobTimeoutSeconds: parseInt_('JOB_TIMEOUT_SECONDS', 1_800),
  };
}
