// One-off probe: drive a Browserbase Chromium session at paseet.ai/ar
// and report the page's title, current URL, and the visible login affordances.
// Goal is to figure out what auth Paseet uses (Google OAuth? username+password?
// magic link?) before we wire creds into the edge route.
//
// Run: node scripts/probe-paseet.mjs

import { chromium } from 'playwright-core';

const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
if (!BB_API_KEY || !BB_PROJECT_ID) {
  console.error('Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID');
  process.exit(1);
}

async function createSession() {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'X-BB-API-Key': BB_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId: BB_PROJECT_ID }),
  });
  if (!res.ok) {
    throw new Error(`Browserbase session create failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log('Creating Browserbase session...');
  const session = await createSession();
  console.log('Session:', session.id, '— connecting via Playwright...');

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());

  console.log('Navigating to paseet.ai/ar ...');
  await page.goto('https://paseet.ai/ar', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const url = page.url();
  const title = await page.title();
  console.log('After load — url:', url, 'title:', title);

  // Look for common login affordances using only native DOM selectors
  const probes = await page.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a, button')).map((el) => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 60),
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
    })).filter((x) => x.text).slice(0, 30);
    return {
      hasGoogleProvider: !!document.querySelector('[data-provider="google"], [aria-label*="Google"], [aria-label*="جوجل"]'),
      hasEmailField: !!document.querySelector('input[type="email"], input[name="email"], input[autocomplete="email"]'),
      hasPasswordField: !!document.querySelector('input[type="password"]'),
      hasOtpField: !!document.querySelector('input[autocomplete*="one-time"], input[name*="otp"], input[name*="code"]'),
      hasMagicLinkText: /magic|enter your email|سيتم إرسال/i.test(document.body.innerText.slice(0, 5000)),
      bodyTextHead: document.body.innerText.slice(0, 800),
      links: allLinks,
    };
  });
  console.log('\n=== Page probes ===');
  console.log(JSON.stringify(probes, null, 2));

  // Try clicking a sign-in / login button if present
  const signInButton = await page.$('button:has-text("تسجيل الدخول"), button:has-text("Sign in"), button:has-text("Login"), a:has-text("تسجيل الدخول"), a:has-text("Sign in")');
  if (signInButton) {
    console.log('\nFound sign-in affordance, clicking...');
    await signInButton.click();
    await page.waitForTimeout(3000);
    const url2 = page.url();
    console.log('After click — url:', url2);
    const probes2 = await page.evaluate(() => ({
      url: window.location.href,
      hasGoogleSignIn: !!document.querySelector('[data-provider="google"], [aria-label*="Google" i]'),
      hasEmailField: !!document.querySelector('input[type="email"], input[name="email"]'),
      hasPasswordField: !!document.querySelector('input[type="password"]'),
      bodyTextHead: document.body.innerText.slice(0, 500),
      visibleInputs: Array.from(document.querySelectorAll('input')).map((el) => ({
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
      })),
    }));
    console.log('\n=== After sign-in click ===');
    console.log(JSON.stringify(probes2, null, 2));
  } else {
    console.log('\nNo obvious sign-in affordance found on landing page.');
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
