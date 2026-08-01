// Render each of the 52 mockup screens to a JPEG — dark theme, real fonts.
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';

const src = readFileSync('../marketing-os-ar.html', 'utf-8');

// The artifact page blocks external fonts; a local file does not. Inject the
// real Amiri + Noto Naskh so the renders match the intended typography, and
// un-clip the horizontally-scrolling strips (phones row, wide frames) so the
// screenshots show EVERYTHING, not just what fit the scroll viewport.
const inject = `
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap" rel="stylesheet">
<style>
  .frame-wrap{overflow:visible !important}
  .phones{flex-wrap:wrap !important;overflow:visible !important}
  .toc{display:none !important}
</style>`;
// The artifact source has no <head> (the platform wraps it at publish time),
// so injection must PREPEND — browsers hoist the link/style fine.
const html = '<meta charset="utf-8">' + inject + src;
writeFileSync('render-page.html', html);

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1460, height: 1000, deviceScaleFactor: 1.5 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.goto(pathToFileURL('render-page.html').href, { waitUntil: 'networkidle0', timeout: 90000 });
await page.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 800));

mkdirSync('shots', { recursive: true });
const sections = await page.$$('section.screen');
console.log('sections found:', sections.length);

let i = 0;
for (const sec of sections) {
  i += 1;
  const title = await sec.$eval('h2', (el) => el.textContent.trim()).catch(() => 'screen');
  await sec.scrollIntoView();
  await new Promise((r) => setTimeout(r, 120));
  const name = 'shots/' + String(i).padStart(2, '0') + '.jpg';
  await sec.screenshot({ path: name, type: 'jpeg', quality: 85 });
  console.log(name, '—', title);
}
await browser.close();
