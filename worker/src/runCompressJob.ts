/**
 * PDF compression job (pdf_compress_jobs queue).
 *
 * Downloads the source PDF from the private `wassel-files` bucket, compresses
 * it with Ghostscript (`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook` — 150 dpi
 * image downsampling + recompression, the sweet spot for image-heavy real
 * estate brochures), uploads the result as a NEW storage object, and INSERTs a
 * NEW `files` row next to the original. Originals are never replaced — file
 * bytes are immutable in this system (the office-preview cache depends on it).
 *
 * Privacy: compression happens entirely inside this worker — file bytes never
 * leave Wassel infrastructure. The iLovePDF API was evaluated and rejected
 * (third-party upload + 250 files/month cap); see the 2026-06-11 migration.
 *
 * "No gain": Ghostscript can produce output as big as (or bigger than) an
 * already-optimized input. When the result saves less than 5% we complete the
 * job with resultFileId=null and create nothing — a "(مضغوط)" copy that is
 * barely smaller than the original is clutter, not a feature.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';

const PDF_MIME = 'application/pdf';

/** gs memory scales with page complexity, not linearly with size, but very
 *  large inputs on a shared-cpu 512MB machine are still the risk zone. Past
 *  this we refuse with a clear error instead of OOMing the machine. */
const MAX_COMPRESS_BYTES = 150 * 1024 * 1024;

/** Hard ceiling on a single gs run — same backstop posture as soffice in
 *  runPreviewJob.ts. The SQL watchdog (10 min) is the crash backstop above. */
const COMPRESS_TIMEOUT_MS = 240_000;

/** Result must be below 95% of the input to count as a win. */
const NO_GAIN_RATIO = 0.95;

/** files.original_name has CHECK (length BETWEEN 1 AND 500). */
const MAX_NAME_LENGTH = 500;

export interface CompressJob {
  id: string;
  fileId: string;
  attempts: number;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  folderId: string | null;
  modelId: string | null;
  recordId: string | null;
  uploadedByUserId: string;
}

export interface CompressResult {
  /** Id of the new files row, or null when compression gained nothing. */
  resultFileId: string | null;
  originalBytes: number;
  compressedBytes: number;
}

export interface RunCompressJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: CompressJob;
}

/** Throws on any failure — index.ts catches and routes to pdf_compress_fail. */
export async function runCompressJob({ supabase, env, job }: RunCompressJobArgs): Promise<CompressResult> {
  if ((job.mimeType || '').toLowerCase() !== PDF_MIME) {
    throw new Error(`not a PDF: ${job.mimeType}`);
  }
  if (job.sizeBytes > MAX_COMPRESS_BYTES) {
    throw new Error(
      `file too large to compress (${Math.round(job.sizeBytes / 1024 / 1024)} MB > ${MAX_COMPRESS_BYTES / 1024 / 1024} MB)`,
    );
  }

  // ── 1. Download the original ─────────────────────────────────────────
  console.log(`[compress] job=${job.id} downloading ${job.storagePath} (${job.sizeBytes} bytes)`);
  const { data: blob, error: dlErr } = await supabase.storage
    .from(job.storageBucket)
    .download(job.storagePath);
  if (dlErr || !blob) {
    throw new Error(`download failed: ${dlErr?.message ?? 'no data'}`);
  }
  const input = Buffer.from(await blob.arrayBuffer());

  // ── 2. Compress in an isolated temp workspace ────────────────────────
  const work = await mkdtemp(path.join(os.tmpdir(), 'wassel-compress-'));
  try {
    const inPath = path.join(work, 'in.pdf');
    const outPath = path.join(work, 'out.pdf');
    await writeFile(inPath, input);

    console.log(`[compress] job=${job.id} running ghostscript`);
    const t0 = Date.now();
    await runGhostscript(env.GS_BIN, [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-dQUIET',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.5',
      // /ebook = 150 dpi downsampling — visually fine on screens, big wins on
      // print-resolution brochures. /screen (72 dpi) visibly degrades plans
      // and maps; /printer (300 dpi) barely saves anything.
      '-dPDFSETTINGS=/ebook',
      // pdfwrite defaults to rotating pages to match dominant text direction;
      // on mixed Arabic/Latin brochures that mangles page orientation.
      '-dAutoRotatePages=/None',
      '-dDetectDuplicateImages=true',
      `-sOutputFile=${outPath}`,
      inPath,
    ]);

    const output = await readFile(outPath).catch(() => null);
    if (!output || output.length === 0) {
      throw new Error('ghostscript produced no output');
    }
    const pct = Math.round((1 - output.length / input.length) * 100);
    console.log(
      `[compress] job=${job.id} done in ${Date.now() - t0}ms: ${input.length} → ${output.length} bytes (${pct}% saved)`,
    );

    if (output.length >= input.length * NO_GAIN_RATIO) {
      // Already optimized — complete without creating a copy.
      return { resultFileId: null, originalBytes: input.length, compressedBytes: output.length };
    }

    // ── 3. Upload the result as a NEW object next to the original ────────
    // Path schema matches uploads: <uploader_auth_uid>/<file_id>.pdf — reuse
    // the source's prefix so the bucket's path-prefix convention stays
    // coherent (same approach as the office-preview artifact).
    const newFileId = randomUUID();
    const prefix = job.storagePath.split('/')[0] ?? '';
    const newPath = `${prefix}/${newFileId}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(job.storageBucket)
      .upload(newPath, output, { contentType: PDF_MIME, upsert: false });
    if (upErr) {
      throw new Error(`upload failed: ${upErr.message}`);
    }

    // ── 4. Register the files row (same folder / record link / owner) ────
    const { error: insErr } = await supabase.from('files').insert({
      id: newFileId,
      folder_id: job.folderId,
      model_id: job.modelId,
      record_id: job.recordId,
      uploaded_by_user_id: job.uploadedByUserId,
      original_name: compressedName(job.originalName),
      mime_type: PDF_MIME,
      size_bytes: output.length,
      storage_bucket: job.storageBucket,
      storage_path: newPath,
      kind: 'pdf',
    });
    if (insErr) {
      // Don't leave an orphan object behind the failed row.
      await supabase.storage
        .from(job.storageBucket)
        .remove([newPath])
        .catch((e: unknown) => console.error(`[compress] orphan cleanup failed for ${newPath}:`, e));
      throw new Error(`files insert failed: ${insErr.message}`);
    }

    return { resultFileId: newFileId, originalBytes: input.length, compressedBytes: output.length };
  } finally {
    // Best-effort temp cleanup — a leak here only wastes /tmp space until the
    // machine recycles, never blocks the job result.
    void rm(work, { recursive: true, force: true }).catch((err) => {
      console.error(`[compress] tmp cleanup failed for ${work}:`, err);
    });
  }
}

/** "تقرير.pdf" → "تقرير (مضغوط).pdf" — Arabic suffix, the company language.
 *  Clamped so the files CHECK (length ≤ 500) can never reject the insert. */
function compressedName(name: string): string {
  const SUFFIX = ' (مضغوط).pdf';
  const base = (name || 'file').replace(/\.pdf$/i, '');
  return base.slice(0, MAX_NAME_LENGTH - SUFFIX.length) + SUFFIX;
}

/**
 * Run gs with a hard timeout that kills the ENTIRE process group — same
 * pattern as runSoffice in runPreviewJob.ts. gs doesn't re-spawn itself the
 * way the soffice launcher does, but the group kill costs nothing and keeps
 * the two job runners' failure behavior identical.
 */
function runGhostscript(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (d: Buffer) => {
      // Keep the tail — the useful gs error is at the end.
      stderr = (stderr + d.toString()).slice(-2000);
    });

    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // negative pid = whole group
        } catch {
          // Group already gone — exactly the state we want.
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      reject(
        new Error(
          `compression timed out after ${COMPRESS_TIMEOUT_MS / 1000}s — the PDF may be too large or complex`,
        ),
      );
    }, COMPRESS_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ghostscript failed to start: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(); // sweep any stray children even on normal exit
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() || `exit code ${code ?? `signal ${signal}`}`;
        // Password-protected PDFs land here with gs's "This file requires a
        // password" message — surfaced verbatim to the UI.
        reject(new Error(`ghostscript failed: ${detail}`));
      }
    });
  });
}
