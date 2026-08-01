TASK: Write ONE new file: docs/marketing-reference/tools/render-refs.mjs — a Puppeteer script that renders the approved design mockup and produces per-sub-state reference crops. Write the file only; do NOT run it, do NOT npm install (the caller does both).

CONTEXT — the source of truth is docs/marketing-reference/source/marketing-os-ar.html: a single HTML fragment (NO <head>/<body> wrapper) containing 51 <section class="screen" id="sNN"> blocks (NN = 1..46, 48..52). Each desktop screen has one .frame-wrap > .frame (the app surface). Mobile screens have .phones > .phone; inside each .phone: .ph-notch and .ph-stat are fake device chrome, .ph-scr is the actual app screen surface, .ph-cap/.ph-cap-box are caption boxes outside the app surface. Sections also contain .cap (title block) and .notes (rationale) which are NOT app surface. The stylesheet is embedded in the fragment via <style> blocks. Theme: dark styles are under @media(prefers-color-scheme:dark) with a :root:not([data-theme="light"]) guard — so emulating prefers-color-scheme selects the theme.

The file docs/marketing-reference/tools/shoot-legacy.mjs is an earlier version of this pipeline — READ IT and reuse its proven techniques:
- The fragment has no </head>, so injection must PREPEND: html = '<meta charset="utf-8">' + inject + src
- Inject the Google Fonts Amiri + Noto Naskh Arabic link, plus CSS: .frame-wrap{overflow:visible !important} .phones{flex-wrap:wrap !important;overflow:visible !important} .toc{display:none !important}
- Write the composed page to a temp html file next to the script and page.goto(pathToFileURL(...)) — never data: URLs (regex-mangling heredoc issues killed a previous attempt)
- After goto: await page.evaluate(() => document.fonts.ready) then ~800ms settle

REQUIRED BEHAVIOR of render-refs.mjs:

1. Paths are resolved relative to the script location (use fileURLToPath(import.meta.url)); outputs go to the SIBLING directories ../full-pages, ../reference-crops, and index file ../frames-index.json. mkdirSync recursive all of them.
2. Viewport: width 1460, height 1000, deviceScaleFactor 1 (DPR 1 — crops will be compared 1:1 against app screenshots).
3. Two passes: theme 'dark' (emulateMediaFeatures prefers-color-scheme dark) and theme 'light' (prefers-color-scheme light). Optional CLI arg --theme=dark|light limits to one pass; default both.
4. Per pass, for every section.screen (in document order):
   - screen number = numeric part of the section id (s12 -> 12), zero-pad to 2 for filenames.
   - title = textContent of .cap h2 (trimmed), or empty.
   - Full section render: sec.scrollIntoView, screenshot the section element -> ../full-pages/s<NN>-<theme>.jpg (JPEG quality 80).
   - Crops (PNG, lossless):
     a. every .frame element in the section -> key "main" for the first, "main2", "main3"... for any additional -> ../reference-crops/s<NN>-<key>-<theme>.png
     b. every .phone element -> inside it, prefer the .ph-scr element as the crop target; if a .phone has NO .ph-scr, crop the .phone itself and record "chrome":true for that frame in the index. Keys "phone1", "phone2"... in document order. NOTE: if a .phone contains MULTIPLE .ph-scr elements, crop each as its own sub-frame keyed "phone1a", "phone1b"...
   - Before each element screenshot call el.scrollIntoView() and wait 100ms; use el.screenshot() (element bounding box).
5. Build ../frames-index.json: { generated_at, source: "marketing-os-ar.html", themes: [...], screens: [ { n, id, title, frames: [ { key, kind: "desktop"|"phone", file_dark, file_light, width, height, chrome? } ] } ] } — width/height from the dark-pass boundingBox (rounded). Merge the two passes into one index (light pass fills file_light; if only one theme was run, leave the other field null).
6. Console-log one line per screen: `s12 نظرة عامة frames=1` style progress, and a final summary line with total crop count. Any element whose boundingBox is null must THROW (loud failure, no silent skip).
7. Import puppeteer plainly (import puppeteer from 'puppeteer') — the tools dir will have its own package.json/node_modules (caller handles).

Also write docs/marketing-reference/tools/package.json: { "name":"mos-reference-tools", "private":true, "type":"module", "dependencies": { "puppeteer":"^23", "pixelmatch":"^6", "pngjs":"^7" } }

Code style: plain modern JS (no TypeScript), small helpers, comments only where a decision isn't obvious from the code. When done print exactly: RENDER-REFS WRITTEN.
