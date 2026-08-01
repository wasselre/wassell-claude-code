// Render the approved Marketing OS mockup to per-theme full-page JPEGs and
// per-sub-state reference-crop PNGs, plus a frames-index.json manifest.
// Crops are DPR 1 so they can be compared 1:1 against live app screenshots.
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const refDir = join(toolsDir, '..');
const srcPath = join(refDir, 'source', 'marketing-os-ar.html');
const fullDir = join(refDir, 'full-pages');
const cropDir = join(refDir, 'reference-crops');
const indexPath = join(refDir, 'frames-index.json');
const tmpPage = join(toolsDir, 'render-page.html');

const themeArg = process.argv.find((a) => a.startsWith('--theme='));
const themes = themeArg ? [themeArg.split('=')[1]] : ['dark', 'light'];
for (const t of themes) {
  if (t !== 'dark' && t !== 'light') throw new Error(`unknown --theme=${t}`);
}

const src = readFileSync(srcPath, 'utf-8');

// The fragment has no <head> (the platform wraps it at publish time), so
// injection must PREPEND — browsers hoist the link/style fine. The artifact
// page blocks external fonts; a local file does not, so inject the real
// Amiri + Noto Naskh. Un-clip the scrolling strips so crops capture the
// whole surface, not just what fit the viewport.
const inject = `
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap" rel="stylesheet">
<style>
  .frame-wrap{overflow:visible !important}
  .phones{flex-wrap:wrap !important;overflow:visible !important}
  .toc{display:none !important}
</style>`;
writeFileSync(tmpPage, '<meta charset="utf-8">' + inject + src);

mkdirSync(fullDir, { recursive: true });
mkdirSync(cropDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// Expand a section into its crop targets: desktop .frame(s) first, then
// phones. A phone crops its .ph-scr app surface (skipping fake device
// chrome + captions); a phone with no .ph-scr is cropped whole and flagged.
async function collectTargets(sec) {
  const targets = [];
  const frames = await sec.$$('.frame');
  frames.forEach((el, i) =>
    targets.push({ el, key: i === 0 ? 'main' : `main${i + 1}`, kind: 'desktop' }),
  );
  const phones = await sec.$$('.phone');
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let p = 0;
  for (const ph of phones) {
    p += 1;
    const scrs = await ph.$$('.ph-scr');
    if (scrs.length === 0) {
      targets.push({ el: ph, key: `phone${p}`, kind: 'phone', chrome: true });
    } else if (scrs.length === 1) {
      targets.push({ el: scrs[0], key: `phone${p}`, kind: 'phone' });
    } else {
      scrs.forEach((el, j) =>
        targets.push({ el, key: `phone${p}${letters[j]}`, kind: 'phone' }),
      );
    }
  }
  return targets;
}

async function shotEl(el, path, opts) {
  await el.scrollIntoView();
  await sleep(100);
  const bb = await el.boundingBox();
  if (!bb) throw new Error(`null boundingBox for ${path} — element not rendered`);
  await el.screenshot({ path, ...opts });
  return bb;
}

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1460, height: 1000, deviceScaleFactor: 1 });

const passResults = {}; // theme -> [{ n, id, title, frames: [...] }]
let totalCrops = 0;

for (const theme of themes) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.goto(pathToFileURL(tmpPage).href, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(800);

  const sections = await page.$$('section.screen');
  const results = [];

  for (const sec of sections) {
    const id = await sec.evaluate((el) => el.id);
    // Only numbered app screens — the mockup also has an id="cover" section.
    if (!/^s\d+$/.test(id)) continue;
    const n = parseInt(id.replace(/\D/g, ''), 10);
    const NN = pad2(n);
    const title = await sec.evaluate((el) => {
      const h = el.querySelector('.cap h2');
      return h ? h.textContent.trim() : '';
    });

    await shotEl(sec, join(fullDir, `s${NN}-${theme}.jpg`), { type: 'jpeg', quality: 80 });

    const targets = await collectTargets(sec);
    const frames = [];
    for (const t of targets) {
      const file = `s${NN}-${t.key}-${theme}.png`;
      const bb = await shotEl(t.el, join(cropDir, file), { type: 'png' });
      frames.push({
        key: t.key,
        kind: t.kind,
        file: `reference-crops/${file}`,
        width: Math.round(bb.width),
        height: Math.round(bb.height),
        ...(t.chrome ? { chrome: true } : {}),
      });
      totalCrops += 1;
    }
    results.push({ n, id, title, frames });
    console.log(`s${NN} ${title} frames=${frames.length}`);
  }
  passResults[theme] = results;
}

await browser.close();

// Merge passes into one index: dark supplies width/height + file_dark,
// light fills file_light on the same frame keys (same document, same order).
const screens = new Map();
for (const theme of themes) {
  for (const s of passResults[theme]) {
    let e = screens.get(s.id);
    if (!e) {
      e = { n: s.n, id: s.id, title: s.title, frames: new Map() };
      screens.set(s.id, e);
    }
    for (const f of s.frames) {
      let fe = e.frames.get(f.key);
      if (!fe) {
        fe = {
          key: f.key,
          kind: f.kind,
          file_dark: null,
          file_light: null,
          width: f.width,
          height: f.height,
          ...(f.chrome ? { chrome: true } : {}),
        };
        e.frames.set(f.key, fe);
      }
      fe[`file_${theme}`] = f.file;
      if (theme === 'dark') {
        fe.width = f.width;
        fe.height = f.height;
      }
    }
  }
}

const index = {
  generated_at: new Date().toISOString(),
  source: 'marketing-os-ar.html',
  themes,
  screens: [...screens.values()].map((e) => ({ ...e, frames: [...e.frames.values()] })),
};
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

console.log(`done: ${index.screens.length} screens, ${totalCrops} crops, index -> frames-index.json`);
