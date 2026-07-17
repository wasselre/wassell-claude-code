/**
 * Job Center — the app-wide registry of long-running client-observed jobs.
 *
 * Anything that takes more than a moment (listing-message generation, media
 * fan-outs, …) registers here so:
 *   - the floating JobsIndicator shows a spinner + count while work runs and
 *     a panel listing every job with its status,
 *   - the user gets a toast when a job completes or fails,
 *   - the stale-build forced reload defers while any job is running
 *     (setJobActive('job-center') — see src/lib/staleBuild.ts),
 *   - closing the popup that STARTED the work doesn't matter: the runner
 *     modules own the work, this registry owns the visibility.
 *
 * Plain module + tiny pub/sub (same pattern as staleBuild): readable from
 * non-React code, synchronously, with React kept in sync via subscribe.
 */

import { useAppStore } from '@/stores/appStore';
import { setJobActive } from '@/lib/staleBuild';

export type AppJobStatus = 'running' | 'completed' | 'failed';

export interface AppJob {
  id: string;
  /** Short machine tag: 'listing_message' | 'media_fanout' | … */
  kind: string;
  /** Human label shown in the panel + completion toast. */
  label: string;
  /** One-line current state ("تنظيف الصور 3/9…"). */
  detail: string | null;
  status: AppJobStatus;
  progress: { done: number; total: number } | null;
  createdAt: number;
  finishedAt: number | null;
  /** Optional in-app path the panel navigates to on click. */
  href: string | null;
  error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let jobs: AppJob[] = [];

// Completed/failed jobs auto-prune after this long (the panel stays tidy).
const FINISHED_TTL_MS = 30 * 60_000;

function emit(): void {
  for (const l of listeners) l();
}

function syncStaleBuildFlag(): void {
  setJobActive('job-center', jobs.some((j) => j.status === 'running'));
}

function toast(message: string, type: 'success' | 'error' | 'info'): void {
  try {
    useAppStore.getState().addToast(message, type);
  } catch {
    // Store not ready (very early boot) — the panel still shows the state.
    console.error('[jobCenter] toast failed:', message);
  }
}

export function getJobs(): AppJob[] {
  return jobs;
}

export function subscribeJobs(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function startJob(input: {
  id?: string;
  kind: string;
  label: string;
  detail?: string | null;
  progress?: { done: number; total: number } | null;
  href?: string | null;
}): string {
  const id = input.id ?? crypto.randomUUID();
  // Re-registering an id (e.g. rehydration) replaces the old entry.
  jobs = [
    ...jobs.filter((j) => j.id !== id),
    {
      id,
      kind: input.kind,
      label: input.label,
      detail: input.detail ?? null,
      status: 'running',
      progress: input.progress ?? null,
      createdAt: Date.now(),
      finishedAt: null,
      href: input.href ?? null,
      error: null,
    },
  ];
  syncStaleBuildFlag();
  emit();
  return id;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<AppJob, 'label' | 'detail' | 'progress' | 'href'>>,
): void {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return;
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  emit();
}

export function completeJob(id: string, opts: { detail?: string; toastMessage?: string | null } = {}): void {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'running') return;
  jobs = jobs.map((j) =>
    j.id === id
      ? { ...j, status: 'completed' as const, finishedAt: Date.now(), detail: opts.detail ?? j.detail }
      : j,
  );
  syncStaleBuildFlag();
  emit();
  // toastMessage: undefined → default; null → silent completion.
  if (opts.toastMessage !== null) {
    toast(opts.toastMessage ?? `${job.label} — ${isAr() ? 'اكتمل' : 'done'}`, 'success');
  }
  schedulePrune();
}

export function failJob(id: string, error: string, opts: { toastMessage?: string | null } = {}): void {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'running') return;
  jobs = jobs.map((j) =>
    j.id === id ? { ...j, status: 'failed' as const, finishedAt: Date.now(), error } : j,
  );
  syncStaleBuildFlag();
  emit();
  if (opts.toastMessage !== null) {
    toast(opts.toastMessage ?? `${job.label} — ${isAr() ? 'فشل: ' : 'failed: '}${error}`, 'error');
  }
  schedulePrune();
}

/** Remove one finished job from the panel (running jobs can't be dismissed). */
export function dismissJob(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status === 'running') return;
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export function dismissFinishedJobs(): void {
  jobs = jobs.filter((j) => j.status === 'running');
  emit();
}

let pruneTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePrune(): void {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    const cutoff = Date.now() - FINISHED_TTL_MS;
    const next = jobs.filter((j) => j.status === 'running' || (j.finishedAt ?? 0) > cutoff);
    if (next.length !== jobs.length) {
      jobs = next;
      emit();
    }
    if (jobs.some((j) => j.status !== 'running')) schedulePrune();
  }, 60_000);
}

function isAr(): boolean {
  try {
    return useAppStore.getState().language === 'ar';
  } catch {
    return true;
  }
}

/** TEST-ONLY. */
export function __resetJobCenter(): void {
  jobs = [];
  syncStaleBuildFlag();
  emit();
}
