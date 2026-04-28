// One-shot setup helper: drives an existing Browserbase session to
// paseet.ai/ar/login so the user can complete the manual login step
// (entering creds + solving reCAPTCHA) via Browserbase's Live View.
// Once they finish, the session's cookies persist in the attached
// Browserbase Context, and that context can then be reused by every
// future automation run with no login attempts.
//
// Run:
//   BROWSERBASE_API_KEY=... \
//   BB_SESSION_ID=406175ee-... \
//   node scripts/paseet-context-setup.mjs

import { chromium } from 'playwright-core';

const { BROWSERBASE_API_KEY, BB_SESSION_ID } = process.env;
if (!BROWSERBASE_API_KEY || !BB_SESSION_ID) {
  console.error('Set BROWSERBASE_API_KEY and BB_SESSION_ID');
  process.exit(1);
}

async function getSession() {
  const res = await fetch(`https://api.browserbase.com/v1/sessions/${BB_SESSION_ID}`, {
    headers: { 'X-BB-API-Key': BROWSERBASE_API_KEY },
  });
  if (!res.ok) throw new Error(`get session: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const session = await getSession();
  console.log('Connecting to session', session.id);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  console.log('Navigating to https://paseet.ai/ar/login ...');
  await page.goto('https://paseet.ai/ar/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Loaded:', page.url());

  // Don't disconnect the browser — Browserbase keepAlive holds the session,
  // and we want it open so the user can interact via Live View.
  console.log('\nSession is parked at the login page.');
  console.log('Open the Live View in Browserbase dashboard and log in manually.');
  console.log('Live view URL:', `https://www.browserbase.com/sessions/${session.id}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
