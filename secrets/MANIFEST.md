# Encrypted secrets bundle — inventory

`secrets/wassel-secrets.enc` is AES-256-CBC (PBKDF2, 600k iterations).
This file lists WHAT is inside it. **Values are never recorded here.**

Regenerate both with `bash scripts/secrets/seal.sh`. Do not hand-edit.

## Files in the bundle

| Restored to | Source |
|---|---|
| `<repo root>/.env` | working tree |
| `<repo root>/.env.local` | working tree |
| `<repo root>/.deploy-secrets.local` | working tree |
| `$HOME/.fly/config.yml` | home directory |

## Variable names carried

### `.env`

- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_URL`

### `.env.local`

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_WASSEL_SKILL_ID`
- `APIFY_API_TOKEN`
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_ROUTINE_TOKEN`
- `CLAUDE_ROUTINE_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `HABERCHAT_TOKEN`
- `HABERCHAT_WEBHOOK_SECRET`
- `HATIF_CLIENT_ID`
- `HATIF_CLIENT_SECRET`
- `HATIF_DEFAULT_CHANNEL_ID`
- `HATIF_WEBHOOK_SECRET`
- `NX_DAEMON`
- `PASEET_CONTEXT_ID`
- `PASEET_EMAIL`
- `PASEET_PASSWORD`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `TURBO_CACHE`
- `TURBO_DOWNLOAD_LOCAL_ENABLED`
- `TURBO_REMOTE_ONLY`
- `TURBO_RUN_SUMMARY`
- `VERCEL`
- `VERCEL_ENV`
- `VERCEL_GIT_COMMIT_AUTHOR_LOGIN`
- `VERCEL_GIT_COMMIT_AUTHOR_NAME`
- `VERCEL_GIT_COMMIT_MESSAGE`
- `VERCEL_GIT_COMMIT_REF`
- `VERCEL_GIT_COMMIT_SHA`
- `VERCEL_GIT_PREVIOUS_SHA`
- `VERCEL_GIT_PROVIDER`
- `VERCEL_GIT_PULL_REQUEST_ID`
- `VERCEL_GIT_REPO_ID`
- `VERCEL_GIT_REPO_OWNER`
- `VERCEL_GIT_REPO_SLUG`
- `VERCEL_OIDC_TOKEN`
- `VERCEL_TARGET_ENV`
- `VERCEL_URL`
- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_URL`
- `VITE_TLDRAW_LICENSE_KEY`
- `YOUTUBE_DATA_API_KEY`

### `.deploy-secrets.local`

- `ANTHROPIC_API_KEY`
- `CRON_SECRET`
- `REPORTS_RUNNER_SECRET`

### `.fly/config.yml`

- (non-dotenv file — structure not enumerated)

