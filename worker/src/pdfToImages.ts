/**
 * pdfToImages — render PDF pages to PNG bytes using poppler-utils (`pdftoppm`).
 *
 * Why this exists: Anthropic's `document` content block for PDFs has an
 * unpredictable token cost — a 6.5 MB image-heavy real estate brochure hit
 * the 1M token ceiling and got rejected before Claude even started.
 * Switching to per-page `image` content blocks gives us a predictable
 * cost (~1.5k tokens per image, capped) without sacrificing Claude's
 * ability to "see" the layout — and Claude still gets the original PDF
 * mounted in the sandbox for any text/structure extraction via Python.
 *
 * The implementation shells out to `pdftoppm` (from `poppler-utils`, which
 * the Dockerfile installs). Pure-JS alternatives (`pdfjs-dist` + a canvas
 * package) work, but pull in 30+ MB of native deps and have known edge
 * cases on Alpine. Poppler is mature, fast, and ~10 MB.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface PdfPage {
  /** 1-based page number. */
  pageNumber: number;
  /** Suggested filename for the rendered image. */
  filename: string;
  /** PNG bytes. */
  bytes: Uint8Array;
}

export interface PdfRenderOptions {
  /** Long-edge pixel count to render at. Uses pdftoppm's `-scale-to <N>`
   *  which scales the LONGER axis to N px (the shorter axis follows aspect
   *  ratio). This is the key knob for keeping vision-token cost predictable
   *  regardless of source PDF page size — a Letter page and an A1
   *  architectural plan both produce an image with the same long edge.
   *
   *  Default 1200. Token-cost back-of-envelope (Anthropic vision tiles each
   *  ~512px region into ~170 tokens): 1200×900 page = ⌈1200/512⌉×⌈900/512⌉
   *  = 3×2 = 6 tiles ≈ 1020 tokens/page → 20 pages ≈ 20k tokens. Fits with
   *  comfortable headroom under the 1M context budget.
   *
   *  Previously this was `dpi` (default 120), which produced a fixed scale
   *  per inch and therefore a VARIABLE pixel count per page — large-format
   *  PDFs (A3 brochure spreads, architectural plans) tokenized to ~2x what
   *  Letter pages did and could overflow context. Switched 2026-05-23. */
  longEdgePx?: number;
  /** Maximum number of pages to render. Defaults to 20 to keep the vision
   *  token cost bounded (~20k tokens for 20 page-images at default
   *  longEdgePx). */
  maxPages?: number;
  /** If the PDF has more than maxPages, take the first N pages (`'first'`)
   *  or sample evenly across the document (`'evenly'`). Default 'first' —
   *  the cover + early pages usually carry the brand identity. */
  oversampleStrategy?: 'first' | 'evenly';
}

const DEFAULTS: Required<PdfRenderOptions> = {
  longEdgePx: 1200,
  maxPages: 20,
  oversampleStrategy: 'first',
};

/**
 * Render a PDF (passed as bytes) to per-page PNG images.
 *
 * @throws if `pdftoppm` exits non-zero or no pages were produced.
 */
export async function pdfToImages(
  pdfBytes: Uint8Array,
  opts: PdfRenderOptions = {},
): Promise<PdfPage[]> {
  const o = { ...DEFAULTS, ...opts };

  // Temp dir for pdftoppm to write into. Cleaned up in finally.
  const dir = await mkdtemp(join(tmpdir(), 'wassel-pdf-'));
  const pdfPath = join(dir, 'in.pdf');
  const outPrefix = join(dir, 'page');

  try {
    await writeFile(pdfPath, pdfBytes);

    // Step 1: ask poppler how many pages.
    const pageCount = await getPageCount(pdfPath);
    if (pageCount === 0) {
      throw new Error('PDF has 0 pages (corrupt or empty input)');
    }

    // Decide which pages to render.
    const pagesToRender = pickPages(pageCount, o.maxPages, o.oversampleStrategy);

    // Step 2: render each chosen page individually. pdftoppm's -f/-l flags
    // give us per-page control; we render one page per spawn so we can pick
    // a non-contiguous subset when oversampleStrategy='evenly'.
    const pages: PdfPage[] = [];
    for (const pageNum of pagesToRender) {
      await runPdftoppm(pdfPath, outPrefix, pageNum, o.longEdgePx);
      const file = await locatePngForPage(dir, pageNum);
      if (!file) {
        throw new Error(`pdftoppm produced no PNG for page ${pageNum}`);
      }
      const bytes = await readFile(join(dir, file));
      pages.push({
        pageNumber: pageNum,
        filename: `page-${String(pageNum).padStart(3, '0')}.png`,
        bytes: new Uint8Array(bytes),
      });
    }

    return pages;
  } finally {
    // Always clean up, even on throw.
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[pdfToImages] tmp cleanup failed (non-fatal): ${(err as Error).message}`);
    });
  }
}

/**
 * Decide which 1-based page numbers to render given the page count, cap,
 * and oversample strategy. Always returns 1..N when count <= cap.
 */
function pickPages(
  pageCount: number,
  maxPages: number,
  strategy: 'first' | 'evenly',
): number[] {
  if (pageCount <= maxPages) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  if (strategy === 'first') {
    return Array.from({ length: maxPages }, (_, i) => i + 1);
  }
  // Evenly spaced — always include page 1 (cover) and the last page.
  const picks = new Set<number>();
  picks.add(1);
  picks.add(pageCount);
  // Fill the middle.
  const step = (pageCount - 1) / (maxPages - 1);
  for (let i = 1; i < maxPages - 1; i++) {
    picks.add(Math.round(1 + i * step));
  }
  return Array.from(picks).sort((a, b) => a - b).slice(0, maxPages);
}

/**
 * Run `pdfinfo` to discover page count. Falls back to parsing pdftoppm's
 * `--help` output? No — pdfinfo is always installed alongside pdftoppm in
 * poppler-utils, so this is reliable.
 */
async function getPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await runCommand('pdfinfo', [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) {
    throw new Error('pdfinfo did not report a page count (corrupt PDF?)');
  }
  return parseInt(m[1]!, 10);
}

/**
 * Spawn `pdftoppm -scale-to <N> -png -f P -l P pdfPath outPrefix`.
 * `-scale-to N` scales the LONGER dimension to N pixels (shorter follows
 * aspect ratio). This is what keeps the vision token cost predictable
 * across heterogeneous source PDFs — see PdfRenderOptions.longEdgePx.
 *
 * Output file lands at `<outPrefix>-NNN.png` (pdftoppm zero-pads to the
 * width of the total page count by default; -f/-l with a single page tends
 * to produce a 1-2 digit suffix, hence `locatePngForPage` afterwards).
 */
async function runPdftoppm(
  pdfPath: string,
  outPrefix: string,
  pageNum: number,
  longEdgePx: number,
): Promise<void> {
  await runCommand('pdftoppm', [
    '-scale-to', String(longEdgePx),
    '-png',
    '-f', String(pageNum),
    '-l', String(pageNum),
    pdfPath,
    outPrefix,
  ]);
}

/**
 * Find the PNG file pdftoppm just produced for a specific page. We can't
 * predict the exact filename (pdftoppm's zero-padding varies with input
 * page count), so we list the dir and find any file matching the page
 * number suffix.
 */
async function locatePngForPage(dir: string, pageNum: number): Promise<string | null> {
  const files = await readdir(dir);
  // Match e.g. "page-1.png", "page-01.png", "page-001.png" — but exactly
  // this page number, not page-10 when looking for page-1.
  const re = new RegExp(`-0*${pageNum}\\.png$`);
  return files.find((f) => re.test(f)) ?? null;
}

/**
 * Promise wrapper around spawn that captures stdout/stderr and rejects
 * non-zero exits with a useful message.
 */
function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', (err) => {
      reject(new Error(
        `Failed to spawn ${cmd}: ${err.message}. ` +
        `Is poppler-utils installed in the worker image?`,
      ));
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(
          `${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim() || '(no output)'}`,
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
