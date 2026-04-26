// One-time OAuth flow to capture a Google Drive refresh token.
//
// Prerequisites in cloud-worker/.env:
//   GOOGLE_OAUTH_CLIENT_ID=<from Google Cloud Console → Clients>
//   GOOGLE_OAUTH_CLIENT_SECRET=<same place>
//
// Run with:  npm run oauth-init
//
// Flow:
//   1. Starts a tiny HTTP server on http://127.0.0.1:8765 (the OAuth callback).
//   2. Prints a Google sign-in URL — you open it in your browser, sign in,
//      and click "Allow" on the Drive scope.
//   3. Google redirects to 127.0.0.1:8765/callback?code=...
//   4. The script exchanges the code for tokens and writes the refresh
//      token back into cloud-worker/.env as GOOGLE_OAUTH_REFRESH_TOKEN.
//
// One-time only. After this runs successfully, the cloud worker keeps
// refreshing access tokens forever using the stored refresh token.
//
// If you ever revoke the app's access in your Google account, run this
// script again to capture a fresh refresh token.

import { config as loadDotenv } from 'dotenv';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { OAuth2Client } from 'google-auth-library';

loadDotenv({ override: true });

// Google requires loopback redirects to be exact. We pin to 8765 so it
// doesn't change between runs (cleaner than picking a random port). The
// "Desktop app" OAuth client type accepts any 127.0.0.1 port without
// preconfiguration. If you see redirect_uri_mismatch, your OAuth client
// is type "Web application" — switch it to "Desktop app" or add the URL
// below to its Authorized redirect URIs.
const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

// drive.file scope = "files this app created or opened only". Narrow on
// purpose — we don't need read access to the user's whole Drive.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function requireEnv(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (v === '') {
    console.error(`[oauth-init] missing env var ${name}. Set it in cloud-worker/.env first.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');

  const oauth = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token
    scope: SCOPES,
    // Force the consent screen even if the user has approved before, so we
    // always get a refresh_token in the response (Google omits it on
    // re-grants without prompt=consent).
    prompt: 'consent',
  });

  // Wait for the redirect. We use a Promise<string> for the code so the
  // server lifecycle is clear.
  const code = await new Promise<string>((resolvePromise, rejectPromise) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname !== '/callback') {
          res.statusCode = 404;
          res.end('Not found. Expected /callback.');
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) {
          res.end(`OAuth error: ${error}. You can close this tab.`);
          server.close();
          rejectPromise(new Error(`OAuth flow returned error: ${error}`));
          return;
        }
        if (!code) {
          res.end('OAuth flow returned no code. You can close this tab.');
          server.close();
          rejectPromise(new Error('OAuth flow returned no authorization code'));
          return;
        }
        res.end(
          'OK — authorization received. You can close this tab. Check your terminal.',
        );
        server.close();
        resolvePromise(code);
      } catch (err) {
        res.statusCode = 500;
        res.end('Server error');
        server.close();
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.on('error', rejectPromise);
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log('\n[oauth-init] callback server listening on', REDIRECT_URI);
      console.log('\n[oauth-init] Open this URL in your browser, sign in, and click Allow:\n');
      console.log(authUrl);
      console.log('\n[oauth-init] Waiting for the redirect…');
    });
  });

  console.log('\n[oauth-init] code received; exchanging for tokens…');
  const { tokens } = await oauth.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      '\n[oauth-init] No refresh_token returned. Most likely cause: this app already has consent in your Google account from a previous run, and Google only emits refresh_tokens on the FIRST consent.\n\n' +
        'Fix: go to https://myaccount.google.com/permissions, find this app, and remove access. Then re-run `npm run oauth-init`.',
    );
    process.exit(2);
  }

  await writeRefreshTokenToEnv(tokens.refresh_token);

  console.log('\n[oauth-init] ✅ Refresh token written to cloud-worker/.env as GOOGLE_OAUTH_REFRESH_TOKEN.');
  console.log('[oauth-init] You can now run `npm start` — drive_upload will work.');
}

async function writeRefreshTokenToEnv(token: string): Promise<void> {
  const envPath = resolve('.env');
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    // .env doesn't exist — start blank.
  }

  const lines = content.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith('GOOGLE_OAUTH_REFRESH_TOKEN=')) {
      found = true;
      return `GOOGLE_OAUTH_REFRESH_TOKEN=${token}`;
    }
    return line;
  });
  if (!found) {
    // Drop a blank line first if the file doesn't already end with one.
    if (updated.length > 0 && updated[updated.length - 1] !== '') {
      updated.push('');
    }
    updated.push(`GOOGLE_OAUTH_REFRESH_TOKEN=${token}`);
  }
  await fs.writeFile(envPath, updated.join('\n'));
}

void main().catch((err: unknown) => {
  console.error(`\n[oauth-init] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
