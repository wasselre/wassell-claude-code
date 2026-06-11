/**
 * Office → PDF preview conversion job (file_preview_jobs queue).
 *
 * Downloads the original office document from the private `wassel-files`
 * bucket, converts it to PDF with headless LibreOffice (`soffice`), uploads
 * the artifact to `<uploader_auth_uid>/<file_id>.preview.pdf` in the SAME
 * bucket, and marks the file ready via the `file_preview_complete` RPC
 * (called by index.ts on success).
 *
 * Privacy: conversion happens entirely inside this worker — file bytes never
 * leave Wassel infrastructure (third-party embed viewers were explicitly
 * rejected; see docs/prd/files.md "Office document preview").
 *
 * Concurrency: each run gets its own throwaway LibreOffice user profile
 * (-env:UserInstallation=...) because soffice locks its profile directory —
 * without this, two conversions on the same machine would collide.
 *
 * Fonts: the Docker image installs Amiri + Noto Arabic so Arabic documents
 * render with real glyphs, not tofu. If a doc uses a font we don't have,
 * LibreOffice substitutes — acceptable for preview purposes.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';

/** KEEP IN SYNC with api/files/office-preview.ts (the worker is a standalone
 *  package and cannot import from api/_lib — same posture as imageGen.ts). */
const OFFICE_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Conversion memory/time scales with input size; past this we refuse and let
 *  the UI fall back to the download card. */
const MAX_CONVERT_BYTES = 50 * 1024 * 1024;

/** Hard ceiling on a single soffice run. A light docx converts in seconds,
 *  but a large image-heavy pptx on a shared-cpu 512MB machine can take a few
 *  minutes (live data point 2026-06-11: a 17 MB deck blew the original 120 s).
 *  This is the runaway backstop — the SQL watchdog (10 min) is the crash
 *  backstop above it. */
const CONVERT_TIMEOUT_MS = 240_000;

export interface PreviewJob {
  id: string;
  fileId: string;
  attempts: number;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

export interface RunPreviewJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: PreviewJob;
}

/** Returns the storage path of the uploaded preview PDF. Throws on any
 *  failure — index.ts catches and routes to file_preview_fail. */
export async function runPreviewJob({ supabase, env, job }: RunPreviewJobArgs): Promise<string> {
  if (!OFFICE_MIMES.has((job.mimeType || '').toLowerCase())) {
    throw new Error(`unsupported mime for office preview: ${job.mimeType}`);
  }
  if (job.sizeBytes > MAX_CONVERT_BYTES) {
    throw new Error(
      `file too large for preview conversion (${Math.round(job.sizeBytes / 1024 / 1024)} MB > ${MAX_CONVERT_BYTES / 1024 / 1024} MB)`,
    );
  }

  // ── 1. Download the original ─────────────────────────────────────────
  console.log(`[preview] job=${job.id} downloading ${job.storagePath} (${job.sizeBytes} bytes)`);
  const { data: blob, error: dlErr } = await supabase.storage
    .from(job.storageBucket)
    .download(job.storagePath);
  if (dlErr || !blob) {
    throw new Error(`download failed: ${dlErr?.message ?? 'no data'}`);
  }
  const input = Buffer.from(await blob.arrayBuffer());

  // ── 2. Convert in an isolated temp workspace ─────────────────────────
  const work = await mkdtemp(path.join(os.tmpdir(), 'wassel-preview-'));
  try {
    const ext = extFromStoragePath(job.storagePath);
    const inPath = path.join(work, `in.${ext}`);
    const outDir = path.join(work, 'out');
    const profileDir = path.join(work, 'lo-profile');
    await writeFile(inPath, input);

    console.log(`[preview] job=${job.id} converting (${ext} → pdf)`);
    const t0 = Date.now();
    await runSoffice(
      env.SOFFICE_BIN,
      [
        '--headless',
        '--norestore',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inPath,
      ],
    );

    // soffice writes <outdir>/in.pdf — but discover by extension to be safe
    // against version differences in output naming.
    const produced = (await readdir(outDir).catch(() => [] as string[])).find((f) =>
      f.toLowerCase().endsWith('.pdf'),
    );
    if (!produced) {
      throw new Error('soffice produced no PDF output');
    }
    const pdf = await readFile(path.join(outDir, produced));
    console.log(
      `[preview] job=${job.id} converted in ${Date.now() - t0}ms → ${pdf.length} bytes`,
    );

    // ── 3. Upload the artifact next to the original ──────────────────────
    // Path schema: <uploader_auth_uid>/<file_id>.preview.pdf — same prefix as
    // the original so the bucket's path-prefix RLS stays coherent. Cannot
    // collide with a files.storage_path (those are <uid>/<uuid>.<ext> with a
    // dot-free ext). upsert:true makes retries idempotent.
    const prefix = job.storagePath.split('/')[0] ?? '';
    const previewPath = `${prefix}/${job.fileId}.preview.pdf`;
    const { error: upErr } = await supabase.storage
      .from(job.storageBucket)
      .upload(previewPath, pdf, { contentType: 'application/pdf', upsert: true });
    if (upErr) {
      throw new Error(`preview upload failed: ${upErr.message}`);
    }
    return previewPath;
  } finally {
    // Best-effort temp cleanup — a leak here only wastes /tmp space until the
    // machine recycles, never blocks the job result.
    void rm(work, { recursive: true, force: true }).catch((err) => {
      console.error(`[preview] tmp cleanup failed for ${work}:`, err);
    });
  }
}

/** The storage path's extension is server-generated from the MIME→ext map at
 *  upload time, so it's the trustworthy signal for soffice's input filter. */
function extFromStoragePath(storagePath: string): string {
  const dot = storagePath.lastIndexOf('.');
  const ext = dot >= 0 ? storagePath.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

/**
 * Run soffice with a hard timeout that kills the ENTIRE process group.
 *
 * Why not execFile's built-in timeout: soffice is a launcher that re-spawns
 * the real soffice.bin — the built-in timeout SIGKILLs only the direct child,
 * the grandchild survives holding the stdio pipes (live incident 2026-06-11:
 * a timed-out conversion left an orphaned soffice.bin chewing the machine's
 * 512 MB until the health check went critical). `detached: true` puts the
 * launcher in its own process group so kill(-pid) reaps the whole tree.
 */
function runSoffice(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (d: Buffer) => {
      // Keep the tail — soffice can be chatty; the useful error is at the end.
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
          `conversion timed out after ${CONVERT_TIMEOUT_MS / 1000}s — the document may be too large or complex to preview`,
        ),
      );
    }, CONVERT_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`soffice failed to start: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(); // sweep any stray grandchildren even on normal exit
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() || `exit code ${code ?? `signal ${signal}`}`;
        reject(new Error(`soffice conversion failed: ${detail}`));
      }
    });
  });
}
