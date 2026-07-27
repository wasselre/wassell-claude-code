# -*- coding: utf-8 -*-
"""
Wassel client-study PDF renderer.

Usage:
    python render_study.py <body.html> <out_name_without_ext>

Takes an HTML *body* fragment (the <div class="page"> blocks only — no <html>,
no <head>) and wraps it in the Wassel brand scaffold (cream/copper/chocolate
palette, Amiri, RTL, A4 pages), embeds the full Wassel logo as base64 into
every `{logo}` placeholder, prints to PDF via headless Chrome, and produces a
tall verification screenshot next to it.

The body fragment uses these scaffold classes (all styled here):
    .page      one A4 page (fixed 297mm, overflow hidden — content that doesn't
               fit is CUT, which the verification screenshot will reveal)
    .head      page header: title block + logo  (h1 + p inside .t, then <img>)
    .q         client-question callout (copper right border)
    .verdict   dark chocolate summary/recommendation box (h2 + p, <b> = gold)
    .stats     row of stat cards (.stat > .v value + .l label)
    table      striped white table; th dark; .hl row = copper highlight;
               td.r = bold row label; .num = latin-digit-feature spans
    .bars      horizontal bar chart (.brow > .n label + .track > .fill)
    .duo       two side-by-side .card boxes (h4 + ul)
    .alt       gold-bordered alternative/offer box (h4 + p)
    .note      small gray footnote under a table/section
    .foot      absolute page footer (two spans: source note, page number)

Logo path is resolved from the repo's "Wassel Branding" folder.
"""
import base64
import os
import shutil
import subprocess
import sys


def find_chrome() -> str:
    """Locate a Chrome/Chromium binary cross-platform.

    Honors CHROME_BIN first (set it on headless Linux/Fly), then PATH, then the
    usual per-OS install locations. Raises with a clear message if none found —
    the render step is useless without a browser.
    """
    env = os.environ.get("CHROME_BIN")
    if env and os.path.exists(env):
        return env
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise FileNotFoundError(
        "No Chrome/Chromium found. Set CHROME_BIN, or install chromium "
        "(apt-get install -y chromium on Linux)."
    )


CHROME = find_chrome()

# Official Wassel brand palette (COLOR PALETTE guide, 2026-07). Copper Bronze
# unchanged; terracotta/chocolate/sand/cream/charcoal/gold refreshed.
COPPER = "#B8734F"; CHARCOAL = "#3F3F3F"; CHOC = "#6B4226"
SAND = "#E8D9C0"; CREAM = "#F8F5E9"; GOLD = "#D9B57F"; TERRA = "#A6482A"

SCAFFOLD = """<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:'Amiri', serif; color:__CHARCOAL__; background:__CREAM__; }
  .page { width:210mm; height:297mm; padding:12mm 14mm 10mm; page-break-after:always; position:relative; background:__CREAM__; overflow:hidden; }
  .page:last-child { page-break-after:auto; }
  .head { display:flex; align-items:center; justify-content:space-between; border-bottom:2.5px solid __COPPER__; padding-bottom:5mm; margin-bottom:6mm; }
  .head img { height:19mm; }
  .head .t { text-align:right; }
  .head .t h1 { font-size:21pt; color:__CHOC__; line-height:1.3; }
  .head .t p  { font-size:11pt; color:__TERRA__; }
  .q { background:#fff; border-right:5px solid __COPPER__; border-radius:10px; padding:4mm 5mm; margin-bottom:5mm; }
  .q .lbl { color:__COPPER__; font-weight:bold; font-size:10.5pt; }
  .q .txt { font-size:13pt; color:__CHOC__; }
  .verdict { background:__CHOC__; color:#fff; border-radius:12px; padding:5mm 6mm; margin-bottom:6mm; }
  .verdict h2 { color:__GOLD__; font-size:13pt; margin-bottom:2mm; }
  .verdict p { font-size:11.5pt; line-height:1.75; }
  .verdict b { color:__GOLD__; }
  h3.sec { font-size:13.5pt; color:__CHOC__; margin:5mm 0 2.5mm; }
  h3.sec span { color:__COPPER__; }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden; font-size:10.5pt; }
  th { background:__CHARCOAL__; color:#fff; padding:2.2mm 2mm; font-weight:normal; font-size:10pt; }
  td { padding:2mm; text-align:center; border-bottom:1px solid __SAND__55; }
  tr:last-child td { border-bottom:none; }
  td.r { font-weight:bold; color:__CHOC__; }
  .hl td { background:__COPPER__18; }
  .stats { display:flex; gap:4mm; margin-bottom:1mm; }
  .stat { flex:1; background:#fff; border-radius:10px; padding:3.5mm 3mm; text-align:center; border-top:3px solid __COPPER__; }
  .stat .v { font-size:16pt; font-weight:bold; color:__CHOC__; }
  .stat .l { font-size:9.5pt; color:__CHARCOAL__aa; }
  .bars { background:#fff; border-radius:10px; padding:4mm 5mm; }
  .brow { display:flex; align-items:center; gap:3mm; margin:2.2mm 0; }
  .brow .n { width:52mm; font-size:10pt; text-align:left; color:__CHARCOAL__; }
  .brow .track { flex:1; background:__CREAM__; border-radius:4px; height:7mm; position:relative; }
  .brow .fill { height:100%; border-radius:4px; display:flex; align-items:center; justify-content:flex-end; padding-left:2mm; color:#fff; font-size:9.5pt; }
  .note { font-size:9.5pt; color:__CHARCOAL__99; margin-top:2mm; }
  .duo { display:flex; gap:5mm; }
  .duo > div { flex:1; }
  .card { background:#fff; border-radius:10px; padding:4mm 5mm; }
  .card h4 { color:__COPPER__; font-size:11.5pt; margin-bottom:1.5mm; }
  .card ul { padding-right:5mm; font-size:10.5pt; line-height:1.8; }
  .alt { background:#fff; border:1.5px solid __GOLD__; border-radius:12px; padding:4mm 5mm; margin-top:5mm; }
  .alt h4 { color:__TERRA__; font-size:12pt; }
  .alt p { font-size:10.8pt; line-height:1.75; }
  .foot { position:absolute; bottom:7mm; right:14mm; left:14mm; border-top:1.5px solid __SAND__; padding-top:2.5mm; display:flex; justify-content:space-between; font-size:8.5pt; color:__CHARCOAL__99; }
  .num { font-feature-settings:'lnum'; }
</style>
</head>
<body>
__BODY__
</body>
</html>
"""


def find_logo() -> str:
    """Resolve the full Wassel logo.

    Prefers the logo BUNDLED with this skill (assets/wassel_logo.png) — it's the
    only copy guaranteed to exist everywhere the skill runs (Fly runner, any
    worktree), because the repo's top-level "Wassel Branding/" folder is
    gitignored and never reaches a build context. Falls back to that folder for
    local convenience.
    """
    here = os.path.abspath(os.path.dirname(__file__))
    bundled = os.path.join(here, "wassel_logo.png")
    if os.path.exists(bundled):
        return bundled
    d = here
    for _ in range(8):
        cand = os.path.join(d, "Wassel Branding", "الشعار كامل.png")
        if os.path.exists(cand):
            return cand
        d = os.path.dirname(d)
    fallback = r"C:\Users\rayan\Claude\wassell-claude-code\Wassel Branding\الشعار كامل.png"
    if os.path.exists(fallback):
        return fallback
    raise FileNotFoundError("Wassel logo not found (expected assets/wassel_logo.png)")


def build(body_path: str, out_name: str) -> None:
    body = open(body_path, encoding="utf-8").read()
    logo_b64 = base64.b64encode(open(find_logo(), "rb").read()).decode()
    body = body.replace("{logo}", logo_b64)

    html = SCAFFOLD.replace("__BODY__", body)
    for k, v in [("__COPPER__", COPPER), ("__CHARCOAL__", CHARCOAL), ("__CHOC__", CHOC),
                 ("__SAND__", SAND), ("__CREAM__", CREAM), ("__GOLD__", GOLD), ("__TERRA__", TERRA)]:
        html = html.replace(k, v)

    html_path = os.path.abspath(out_name + ".html")
    open(html_path, "w", encoding="utf-8").write(html)

    # Container/root Chromium refuses its sandbox — required on Linux/Fly, inert
    # on Windows/macOS desktop Chrome.
    linux_flags = ["--no-sandbox", "--disable-dev-shm-usage"] if sys.platform.startswith("linux") else []

    pdf_path = os.path.abspath(out_name + ".pdf")
    url = "file:///" + html_path.replace("\\", "/")
    r = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", *linux_flags, "--no-pdf-header-footer",
         "--print-to-pdf=" + pdf_path, "--virtual-time-budget=15000", url],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0 or not os.path.exists(pdf_path):
        raise RuntimeError(f"chrome print failed rc={r.returncode}: {r.stderr[-400:]}")

    # Verification screenshot: 1123px per A4 page at 794px width.
    pages = body.count('class="page"')
    shot_path = os.path.abspath(out_name + "_preview.png")
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", *linux_flags, f"--screenshot={shot_path}",
         f"--window-size=794,{1123 * max(pages, 1)}", "--virtual-time-budget=15000", url],
        capture_output=True, text=True, timeout=120,
    )
    print(f"pdf: {pdf_path} ({os.path.getsize(pdf_path)} bytes, {pages} pages)")
    print(f"preview: {shot_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    build(sys.argv[1], sys.argv[2])
