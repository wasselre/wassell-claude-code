// Logged-in probe of paseet.ai/ar/chat — inspect the chat input + send button
// + figure out how a response is rendered (table? markdown? streamed?). Used
// to design the selectors the production /api/research-project will rely on.
//
// Run: PASEET_EMAIL=... PASEET_PASSWORD=... \
//      BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... \
//      node scripts/probe-paseet-chat.mjs

import { chromium } from 'playwright-core';

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  PASEET_EMAIL,
  PASEET_PASSWORD,
} = process.env;

if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID || !PASEET_EMAIL || !PASEET_PASSWORD) {
  console.error('Missing env: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, PASEET_EMAIL, PASEET_PASSWORD');
  process.exit(1);
}

async function main() {
  const sessionRes = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': BROWSERBASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: BROWSERBASE_PROJECT_ID }),
  });
  const session = await sessionRes.json();
  console.log('Session:', session.id);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 1. Login
  console.log('\n--- Login ---');
  await page.goto('https://paseet.ai/ar/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', PASEET_EMAIL);
  await page.fill('input[type="password"]', PASEET_PASSWORD);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 });
  } catch (e) {
    console.log('Did not navigate away from /login. Body head:', (await page.evaluate(() => document.body.innerText.slice(0, 400))));
    await browser.close();
    return;
  }
  console.log('Logged in. URL:', page.url());

  // 2. Go to chat
  console.log('\n--- Chat page ---');
  await page.goto('https://paseet.ai/ar/chat', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('Chat URL:', page.url());

  const inputProbe = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label'),
      contenteditable: el.getAttribute('contenteditable'),
      visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
    }));
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => ({
      text: (b.textContent || '').trim().slice(0, 40),
      ariaLabel: b.getAttribute('aria-label'),
      type: b.getAttribute('type'),
      disabled: b.disabled,
      hasIcon: !!b.querySelector('svg'),
    })).filter((b) => b.text || b.ariaLabel || b.hasIcon).slice(0, 20);
    return { inputs, buttons, bodyHead: document.body.innerText.slice(0, 600) };
  });
  console.log('Input/button probe:', JSON.stringify(inputProbe, null, 2));

  // 3. Send a small test message
  console.log('\n--- Sending test prompt ---');
  const inputSel = 'textarea, [contenteditable="true"]';
  const inputEl = await page.$(inputSel);
  if (!inputEl) {
    console.log('No chat input found.');
    await browser.close();
    return;
  }
  await inputEl.click();
  await inputEl.type('عطني عدد المطاعم في الرياض بكلمة وحدة فقط');
  await page.waitForTimeout(500);

  // Try Enter first
  await page.keyboard.press('Enter');
  console.log('Pressed Enter. Waiting for response to render...');

  // Wait for new content to appear
  const initialText = await page.evaluate(() => document.body.innerText.length);
  let finalText = initialText;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => document.body.innerText.length);
    if (t > initialText && t === finalText) break; // settled
    finalText = t;
  }

  const responseProbe = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
      rows: t.querySelectorAll('tr').length,
      headers: Array.from(t.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')).map((c) => (c.textContent || '').trim()).slice(0, 12),
    }));
    return {
      bodyTail: document.body.innerText.slice(-1500),
      tables,
    };
  });
  console.log('After response:', JSON.stringify(responseProbe, null, 2));

  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
