/**
 * Listing-message JOB RUNNER — owns the generation work so the modal is just
 * a viewer/editor over it.
 *
 * Before (2026-07-17 report): closing the ListingMessageModal orphaned the
 * flow — the text draft died with the component and cleaning progress was only
 * visible while the popup stayed open. Now:
 *
 *   - ensureListingMessageJob() starts (or attaches to) the work for a
 *     listing: draft creation + photo-cleaning fan-out, AI text drafting, and
 *     a module-level poll loop — all independent of any mounted component.
 *   - Progress + completion surface through the Job Center (floating
 *     indicator + toasts); the modal subscribes to the same state.
 *   - The drafted text is PERSISTED onto the draft record (set-text mode) so
 *     it survives a reload; rehydrateListingJobs() re-registers unfinished
 *     drafts on boot so a reloaded tab shows them as running jobs again.
 */

import {
  startListingClean,
  generateListingMessageText,
  fetchDraftData,
  readCleaning,
  isCleaningInFlight,
  setListingDraftText,
  type CleaningEntry,
} from '@/lib/listingMessage/client';
import { startJob, updateJob, completeJob, failJob } from '@/lib/jobs/jobCenter';
import { useAppStore } from '@/stores/appStore';

export interface ListingJobState {
  listingId: string;
  label: string;
  /** The chat_templates draft id, once created. */
  recordId: string | null;
  /** Fatal start failure (no draft) — the modal shows retry. */
  startError: string | null;
  bodyAr: string;
  bodyEn: string;
  textLoading: boolean;
  textError: string | null;
  cleaning: CleaningEntry[];
  /** True once cleaning settled AND text finished (ok or error). */
  settled: boolean;
}

type Listener = () => void;

const states = new Map<string, ListingJobState>();
const stateListeners = new Map<string, Set<Listener>>();
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
const jobIds = new Map<string, string>();

function emit(listingId: string): void {
  for (const l of stateListeners.get(listingId) ?? []) l();
}

function patch(listingId: string, p: Partial<ListingJobState>): void {
  const cur = states.get(listingId);
  if (!cur) return;
  states.set(listingId, { ...cur, ...p });
  emit(listingId);
}

export function getListingJobState(listingId: string): ListingJobState | null {
  return states.get(listingId) ?? null;
}

export function subscribeListingJob(listingId: string, l: Listener): () => void {
  let set = stateListeners.get(listingId);
  if (!set) {
    set = new Set();
    stateListeners.set(listingId, set);
  }
  set.add(l);
  return () => {
    set!.delete(l);
  };
}

function isAr(): boolean {
  try {
    return useAppStore.getState().language === 'ar';
  } catch {
    return true;
  }
}

function jobDetail(s: ListingJobState): string {
  const total = s.cleaning.length;
  const done = s.cleaning.filter((c) => c.status === 'completed' || c.status === 'failed').length;
  const parts: string[] = [];
  if (s.textLoading) parts.push(isAr() ? 'كتابة النص…' : 'drafting text…');
  else if (s.textError) parts.push(isAr() ? 'تعذّر النص' : 'text failed');
  if (total > 0 && done < total) parts.push(isAr() ? `تنظيف الصور ${done}/${total}` : `cleaning photos ${done}/${total}`);
  else if (total > 0) parts.push(isAr() ? `الصور جاهزة (${total})` : `photos ready (${total})`);
  return parts.join(' · ') || (isAr() ? 'جارٍ التحضير…' : 'preparing…');
}

function refreshJob(listingId: string): void {
  const s = states.get(listingId);
  const jobId = jobIds.get(listingId);
  if (!s || !jobId) return;
  const total = s.cleaning.length;
  const done = s.cleaning.filter((c) => c.status === 'completed' || c.status === 'failed').length;
  updateJob(jobId, {
    detail: jobDetail(s),
    progress: total > 0 ? { done, total } : null,
  });
}

function maybeSettle(listingId: string): void {
  const s = states.get(listingId);
  const jobId = jobIds.get(listingId);
  if (!s || !jobId || s.settled) return;
  const cleaningSettled = s.cleaning.length > 0 && !isCleaningInFlight(s.cleaning);
  const textSettled = !s.textLoading;
  if (!cleaningSettled || !textSettled) return;
  patch(listingId, { settled: true });
  stopPolling(listingId);
  const failedPhotos = s.cleaning.filter((c) => c.status === 'failed').length;
  if (s.textError && failedPhotos === s.cleaning.length) {
    failJob(jobId, isAr() ? 'فشل النص وتنظيف الصور' : 'text and photo cleaning failed');
    return;
  }
  const warn =
    failedPhotos > 0
      ? isAr() ? ` (تعذّر ${failedPhotos} صورة)` : ` (${failedPhotos} photo(s) failed)`
      : '';
  completeJob(jobId, {
    detail: jobDetail(s),
    toastMessage: isAr()
      ? `${s.label} جاهزة${warn} — افتح الإعلان للاعتماد والحفظ`
      : `${s.label} is ready${warn} — open the listing to approve & save`,
  });
}

function stopPolling(listingId: string): void {
  const t = pollTimers.get(listingId);
  if (t) {
    clearInterval(t);
    pollTimers.delete(listingId);
  }
}

/** Poll the draft for worker cleaning progress until it settles. */
function startPolling(listingId: string): void {
  if (pollTimers.get(listingId)) return;
  const tick = async () => {
    const s = states.get(listingId);
    if (!s?.recordId) return;
    try {
      const data = await fetchDraftData(s.recordId);
      const entries = readCleaning(data);
      patch(listingId, { cleaning: entries });
      refreshJob(listingId);
      if (!isCleaningInFlight(entries)) maybeSettle(listingId);
    } catch {
      /* transient network — keep polling */
    }
  };
  void tick();
  pollTimers.set(listingId, setInterval(tick, 2500));
}

async function runText(listingId: string): Promise<void> {
  const s = states.get(listingId);
  if (!s) return;
  patch(listingId, { textLoading: true, textError: null });
  refreshJob(listingId);
  try {
    const txt = await generateListingMessageText(listingId);
    patch(listingId, { bodyAr: txt.body_ar, bodyEn: txt.body_en, textLoading: false });
    // Persist so a reload doesn't lose the draft text (best-effort — the
    // in-memory copy still serves the open session; failure is logged).
    const cur = states.get(listingId);
    if (cur?.recordId) {
      setListingDraftText(cur.recordId, txt.body_ar, txt.body_en).catch((err) => {
        console.error('[listingMessage] failed to persist draft text:', err);
      });
    }
  } catch (err) {
    patch(listingId, { textLoading: false, textError: err instanceof Error ? err.message : String(err) });
  }
  refreshJob(listingId);
  maybeSettle(listingId);
}

/**
 * Start the generation for a listing, or attach to the one already running.
 * Safe to call from the modal on every open.
 */
export function ensureListingMessageJob(listingId: string, label: string): ListingJobState {
  const existing = states.get(listingId);
  if (existing && !existing.settled) return existing;
  if (existing?.settled) return existing; // finished; caller reads final state

  const state: ListingJobState = {
    listingId,
    label,
    recordId: null,
    startError: null,
    bodyAr: '',
    bodyEn: '',
    textLoading: false,
    textError: null,
    cleaning: [],
    settled: false,
  };
  states.set(listingId, state);
  const jobId = startJob({
    kind: 'listing_message',
    label,
    detail: isAr() ? 'جارٍ التحضير…' : 'preparing…',
    href: `/model/market_listings/${listingId}`,
  });
  jobIds.set(listingId, jobId);

  void (async () => {
    try {
      const { recordId } = await startListingClean(listingId);
      patch(listingId, { recordId });
      startPolling(listingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(listingId, { startError: msg, settled: true });
      failJob(jobId, msg);
      return;
    }
    void runText(listingId);
  })();

  return state;
}

/** Retry just the AI text (modal button). */
export function retryListingText(listingId: string): void {
  const s = states.get(listingId);
  if (!s || s.textLoading) return;
  if (s.settled) patch(listingId, { settled: false });
  void runText(listingId);
}

/** After a redo re-enqueue, resume polling + mark unsettled. */
export function resumeListingPolling(listingId: string): void {
  const s = states.get(listingId);
  if (!s) return;
  if (s.settled) {
    patch(listingId, { settled: false });
    const jobId = jobIds.get(listingId);
    // Re-open the job entry so the indicator spins again.
    if (jobId) startJob({ id: jobId, kind: 'listing_message', label: s.label, href: `/model/market_listings/${listingId}` });
  }
  startPolling(listingId);
}

/** The modal edited the bodies — keep the runner's copy in sync so a re-open
 *  mid-run shows the user's edits, not the original AI text. */
export function setListingJobBodies(listingId: string, bodyAr: string, bodyEn: string): void {
  const s = states.get(listingId);
  if (!s) return;
  states.set(listingId, { ...s, bodyAr, bodyEn });
  // No emit — the editing surface is the source here; avoids echo loops.
}

/** Drop the tracked state after the draft was approved/saved or discarded. */
export function clearListingJob(listingId: string): void {
  stopPolling(listingId);
  states.delete(listingId);
  jobIds.delete(listingId);
  const set = stateListeners.get(listingId);
  if (set) for (const l of set) l();
}

/**
 * Boot-time rehydration: re-register unfinished listing-message drafts as
 * running jobs (a reload previously orphaned them silently). Reads the
 * already-loaded chat_templates records from the store — call once records
 * are available (JobsIndicator does this).
 */
export function rehydrateListingJobs(): number {
  let found = 0;
  try {
    const s = useAppStore.getState();
    const ctModel = s.models.find((m) => m.name === 'chat_templates');
    if (!ctModel) return 0;
    const cutoff = Date.now() - 24 * 3600_000;
    for (const rec of s.records[ctModel.id] ?? []) {
      const d = rec.data as Record<string, unknown>;
      const listingId = typeof d.listing_id === 'string' ? d.listing_id : null;
      if (!listingId || d.status !== 'generating') continue;
      const entries = readCleaning(d);
      if (entries.length === 0 || !isCleaningInFlight(entries)) continue;
      if (new Date(rec.created_at ?? 0).getTime() < cutoff) continue;
      if (states.get(listingId)) continue; // already tracked this session
      const label = typeof d.name === 'string' && d.name
        ? (isAr() ? `رسالة الإعلان ${d.name}` : `Listing message ${d.name}`)
        : (isAr() ? 'رسالة إعلان' : 'Listing message');
      const state: ListingJobState = {
        listingId,
        label,
        recordId: rec.id,
        startError: null,
        bodyAr: typeof d.body_ar === 'string' ? d.body_ar : '',
        bodyEn: typeof d.body_en === 'string' ? d.body_en : '',
        textLoading: false,
        textError: null,
        cleaning: entries,
        settled: false,
      };
      states.set(listingId, state);
      const jobId = startJob({
        kind: 'listing_message',
        label,
        detail: jobDetail(state),
        href: `/model/market_listings/${listingId}`,
      });
      jobIds.set(listingId, jobId);
      refreshJob(listingId);
      startPolling(listingId);
      found++;
    }
  } catch (err) {
    console.error('[listingMessage] rehydrate failed:', err);
  }
  return found;
}
