import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import {
  isStaleBuildWriteLocked,
  engageHardWriteStop,
} from '@/lib/staleBuild';
import {
  noteRecordConflict,
  recordSaveBlocked,
  markRecordWedged,
  releaseBreakerForRetry,
  clearRecordConflict,
  noteReloadAttempt,
  reachedReloadCap,
} from '@/lib/conflictBreaker';
import { getSession, getSessionEmail, getSessionUid, onAuthChange, signOut as authSignOut, isAuthAvailable } from '@/lib/auth';
import { SEED_MODELS, SEED_GROUPS } from '@/data/seedModels';
import { SEED_PROFILES, SEED_ROLES, SEED_USERS } from '@/data/seedUsers';
import { executeWorkflows, executeWebhookWorkflows } from '@/lib/workflowEngine';
import { isModelServerEnrolled, loadServerEnrolledModelIds } from '@/lib/serverWorkflowEnrollment';
import { assignAutoIdsAsync } from '@/lib/autoIdAssigner';
import { applyFieldFallbacks } from '@/lib/fieldFallbackResolver';
import { computeAllFormulas } from '@/lib/formulaEngine';
import { runMigrations, healSystemModelGroups, healClientsSchema, healDecksSchema, healMapsConfigForModels, refreshSystemModels, pruneRemovedSystemModels } from '@/lib/schemaMigrations';
import { applyFieldRename } from '@/lib/fieldRename';
import { listDevices as listHaberchatDevices, listChats as listHaberchatChats, listMessages as listHaberchatMessages, sendMessage as sendHaberchatMessage, patchChat as patchHaberchatChat } from '@/lib/haberchat/client';
import { mergeChatIntoRecord, resolveClientLink, phoneFieldSlugs, isLiveClient, deviceIdString } from '@/lib/haberchat/normalize';
import { mergeMessageSources, identityKey } from '@/lib/chat/messageIdentity';
import { normalizePhone } from '@/lib/phone';
import { markRecentlyWritten } from '@/lib/realtime/dedup';
import { startRealtimeOrchestrator } from '@/lib/realtime/RealtimeOrchestrator';
import { markLoaded, startStaleWhileRevalidate } from '@/lib/realtime/staleWhileRevalidate';
import { mergeRecord } from '@/lib/realtime/mergeHandlers';
import { installPerfMarkers, markEvent } from '@/lib/perfMarkers';
import { assertSerializable, validateAnalyticsQuery } from '@/lib/analytics/validate';
import type { AnalyticsQuery } from '@/lib/analytics/types';
import {
  buildFilterKey,
  emptyCache,
  appendPage,
  setLoading as setCacheLoading,
  setError as setCacheError,
} from '@/lib/recordsCache';
import type { PaginatedRecordsByModel, RecordsPageCache } from '@/lib/recordsCache';
import { bootExcludedModelIds, isSummaryModelName, summaryViewName, SUMMARY_MODEL_NAMES } from '@/lib/lazyModels';
import type {
  AppState,
  AppModel,
  ModelGroup,
  AppRecord,
  Workflow,
  WorkflowGroup,
  WorkflowRun,
  Dashboard,
  MetricDefinition,
  ScheduledReport,
  SalesProcessOverride,
  SalesProcess,
  SalesProcessVersion,
  SalesProcessVersionConfig,
  SalesExperiment,
  ClientSalesProcessAssignment,
  ModelView,
  User,
  Profile,
  Role,
  Language,
  ToastType,
  FieldTemplate,
  ModelPermission,
  StoreMutationResult,
  WebhookSlug,
  WebhookPayload,
  WhatsAppNumber,
  ChatMessage,
  Whiteboard,
  WhiteboardFolder,
  ActivityLogEntry,
  FreezeCoercionFailure,
  FreezeResult,
  SaveRecordOpts,
  SaveResult,
} from '@/types';
import { activityLogger } from '@/lib/activityLogger';
import {
  buildProcessOverlayResolver,
  activeAssignmentsByClient,
  buildDefaultVersionConfig,
  resolveExperimentAssignments,
  DEFAULT_PROCESS_NAME,
  DEFAULT_PROCESS_DESCRIPTION,
} from '@/lib/salesStudio';

/** Returns a human-readable reason a widget/metric AnalyticsQuery must not be
 *  persisted — non-serializable (the HARD RULE) or structurally invalid — else
 *  null. Used by saveDashboard / saveMetricDefinition to fail loudly. */
function analyticsQueryProblem(query: AnalyticsQuery | undefined): string | null {
  if (!query) return null;
  try {
    assertSerializable(query);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return validateAnalyticsQuery(query);
}

/** Map a process-version id → its parent sales_process_id (for assignment). */
function versionProcessId(versions: SalesProcessVersion[], versionId: string | null | undefined): string | null {
  if (!versionId) return null;
  return versions.find((v) => v.id === versionId)?.sales_process_id ?? null;
}

// --- localStorage helpers ---

function loadLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// Track which keys have already shouted about a quota error this session so we
// don't toast on every keystroke once the cliff hits.
const localStorageWarned = new Set<string>();

// Cap on the serialized size of a SINGLE localStorage value. The offline
// mirror is best-effort — every persisted slice is re-fetched from Supabase on
// load and also lives in the in-memory store — so no one slice is worth letting
// it starve the browser's ~10MB localStorage quota. Measured live 2026-06-29 on
// app.wassel.re: `wassell_whiteboards` held ~4.82MB (one image-heavy board at
// ~4.5MB), leaving only ~3.3MB headroom and tripping QuotaExceededError on the
// next routine write — the "تجاوز الذاكرة المؤقتة" toast users saw on heavy
// pages like /model/market_listings. When a value exceeds this cap we SKIP
// mirroring it (and drop any already-stored oversized copy so returning users
// reclaim the space immediately) rather than let it blow the quota. This is a
// documented, logged skip of a network-backed blob — NOT a silenced error: the
// data is safe in Supabase + memory, only the OFFLINE cache of that one slice
// is forgone. Same tradeoff the team already made when records-mirroring was
// retired (2026-06-08). Set well above the largest legitimately-cached slice
// (`wassell_models` ~0.96MB) so normal slices keep their offline cache.
const MAX_LOCAL_VALUE_BYTES = 2 * 1024 * 1024; // ~2MB (UTF-16 ≈ chars × 2)

// Keys we've already warned about skipping (oversized) this session, so the
// console.warn fires once per key, not on every save.
const localStorageOversizeWarned = new Set<string>();

// Network-backed slices that can grow without bound (full workflow-run history,
// image-heavy whiteboards). They reliably blow past MAX_LOCAL_VALUE_BYTES, and the
// ONLY cost of re-discovering that on every save is JSON.stringify-ing the whole
// thing on the main thread — measured live at 114.6MB for `wassell_workflow_runs`,
// which froze the tab for SECONDS on every save, INCLUDING every realtime
// workflow-run update while the user was elsewhere in the app (e.g. the Project
// Finder). They're re-fetched from Supabase on load, so the offline cache is
// intentionally forgone: never even serialize them. (Dynamically-oversized OTHER
// keys are still detected the slow way once, then short-circuited via
// localStorageOversizeWarned below.)
const NEVER_MIRROR_KEYS: ReadonlySet<string> = new Set([
  'wassell_workflow_runs',
  'wassell_whiteboards',
]);

// Audit fix M9: keys we'll evict (in this order) when we hit a quota error,
// before the saveLocal call gives up. Ordered by "lowest user impact when
// dropped" first. The active record/model state is excluded — losing those
// would defeat the entire offline-cache purpose.
const EVICTION_ORDER: readonly string[] = [
  'wassell_workflow_runs',
  'wassell_activity_log',
  'wassell_whiteboards',
  'wassell_whiteboard_folders',
  'wassell_webhook_payloads',
  'wassell_chat_messages',
];

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // DOMException name on most browsers; Firefox uses NS_ERROR_DOM_QUOTA_REACHED.
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota/i.test(err.message)
  );
}

function saveLocal<T>(key: string, data: T): void {
  // Fast path: keys we KNOW are too big to mirror (or already found oversized this
  // session) are skipped BEFORE serializing — the JSON.stringify itself is the
  // main-thread freeze we're avoiding (a 114MB workflow_runs history). Data is safe
  // in memory + Supabase; only the offline cache of this one slice is forgone.
  if (NEVER_MIRROR_KEYS.has(key) || localStorageOversizeWarned.has(key)) {
    try {
      localStorage.removeItem(key);
    } catch {
      // best-effort cleanup; the in-memory store + Supabase copy are unaffected
    }
    if (!localStorageOversizeWarned.has(key)) {
      localStorageOversizeWarned.add(key);
      // eslint-disable-next-line no-console
      console.warn(
        `[localStorage] "${key}" is network-backed and not mirrored offline ` +
          `(too large to cache; re-fetched from Supabase on load).`,
      );
    }
    return;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch (err) {
    // Non-serializable payload — a programming error, not a quota condition.
    // Surface it loudly; never silently drop (see "Silent Failures" in CLAUDE.md).
    // eslint-disable-next-line no-console
    console.error(`[localStorage] could not serialize "${key}":`, err);
    return;
  }

  // Skip oversized network-backed blobs BEFORE they can starve the quota
  // (see MAX_LOCAL_VALUE_BYTES). Drop any previously-stored oversized copy so
  // returning users (whose cache already holds e.g. a ~4.5MB whiteboard)
  // reclaim the space on the next save rather than carrying it forever.
  if (serialized.length * 2 > MAX_LOCAL_VALUE_BYTES) {
    try {
      localStorage.removeItem(key);
    } catch {
      // best-effort cleanup; the in-memory store + Supabase copy are unaffected
    }
    if (!localStorageOversizeWarned.has(key)) {
      localStorageOversizeWarned.add(key);
      // eslint-disable-next-line no-console
      console.warn(
        `[localStorage] "${key}" is ${(serialized.length * 2 / 1024 / 1024).toFixed(1)}MB ` +
          `(> ${MAX_LOCAL_VALUE_BYTES / 1024 / 1024}MB cap) — not mirrored offline to protect the ` +
          `quota; it is re-fetched from Supabase on load.`,
      );
    }
    return;
  }

  try {
    localStorage.setItem(key, serialized);
    return;
  } catch (err) {
    // Audit M9: on QuotaExceededError, evict less-critical buckets and
    // retry once before giving up. The in-memory store + Supabase write
    // path are unaffected — this is purely the offline cache's recovery.
    if (isQuotaError(err)) {
      let evicted = 0;
      for (const evictKey of EVICTION_ORDER) {
        if (evictKey === key) continue;
        try {
          if (localStorage.getItem(evictKey) !== null) {
            localStorage.removeItem(evictKey);
            evicted += 1;
          }
        } catch {
          // ignore — best-effort cleanup
        }
      }
      if (evicted > 0) {
        try {
          localStorage.setItem(key, serialized);
          // eslint-disable-next-line no-console
          console.warn(
            `[localStorage] quota recovered after evicting ${evicted} non-critical bucket(s); "${key}" saved`,
          );
          return;
        } catch (retryErr) {
          // Eviction wasn't enough — fall through to the loud-warn path.
          if (!isQuotaError(retryErr)) {
            // eslint-disable-next-line no-console
            console.error(`[localStorage] retry write to "${key}" hit a non-quota error:`, retryErr);
          }
        }
      }
    }

    // Surface the failure — silent catches here historically hid the
    // 1000-row pagination bug and the localStorage 5–10 MB cliff. The
    // in-memory store and the Supabase write path are independent of this
    // cache; the only thing that breaks when this throws is offline mode.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[localStorage] write to "${key}" failed: ${msg}`);
    if (!localStorageWarned.has(key)) {
      localStorageWarned.add(key);
      try {
        useAppStore.getState().addToast(
          useAppStore.getState().language === 'ar'
            ? 'تجاوز الذاكرة المؤقتة — وضع عدم الاتصال معطل. حدّث الصفحة عند توفر اتصال.'
            : 'Cache limit exceeded — offline mode is disabled. Refresh the page when you have a connection.',
          'error',
        );
      } catch {
        // Store not yet initialized; the console.error above is enough.
      }
    }
  }
}

// ─── Per-model records cache ──────────────────────────────────────────
// Records are NO LONGER cached in localStorage (retired 2026-06-08). They once
// lived under `wassell_records:<modelId>` as an offline fallback, but on real
// datasets that mirror grew past 8 MB and blew the browser's 5-10 MB quota:
// every page load re-wrote it and threw QuotaExceededError (the user-facing
// "تجاوز الذاكرة المؤقتة" toast). This cloud, auth-gated CRM can't run offline
// anyway, and we don't need offline record viewing — so records load only from
// Supabase. The persist helpers below are kept (callers unchanged) but now only
// SWEEP any pre-existing buckets so returning users' bloat gets cleaned up.
const RECORDS_KEY_PREFIX = 'wassell_records:';
const RECORDS_LEGACY_KEY = 'wassell_records';

function recordsKeyFor(modelId: string): string {
  return `${RECORDS_KEY_PREFIX}${modelId}`;
}

/** Offline fallback reader for records. Records are no longer cached in
 *  localStorage (retired 2026-06-08 — see the section note above), so this
 *  always returns an empty map now: an offline / Supabase-unreachable load
 *  shows no records rather than a stale cache. Kept because the fallback
 *  branch in initialize() still calls it. */
function loadLocalRecordsMap(): Record<string, AppRecord[]> {
  return {};
}

/** Was: persist the full records map. Now: SWEEP every record bucket.
 *  Records are no longer mirrored to localStorage (retired 2026-06-08) — the
 *  mirror grew past 8 MB and blew the browser's 5-10 MB quota, throwing
 *  QuotaExceededError on every load. This cloud, auth-gated CRM can't run
 *  offline anyway (decks/AI/WhatsApp/maps need the network) and we don't need
 *  offline record viewing, so records load only from Supabase now. Callers are
 *  unchanged; leaving liveModelIds empty makes the loop below delete every
 *  `wassell_records:*` key, cleaning up returning users' bloated cache. */
function saveLocalRecordsMap(records: Record<string, AppRecord[]>): void {
  void records;
  const liveModelIds = new Set<string>();
  // Sweep stale buckets so deleted models / emptied models don't pile up.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(RECORDS_KEY_PREFIX)) continue;
    const modelId = key.slice(RECORDS_KEY_PREFIX.length);
    if (!liveModelIds.has(modelId)) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }
  // Sweep the legacy single-blob 'wassell_records' key — never written by
  // current code, only accumulating ~1 MB of dead weight on returning users.
  // The migration in loadLocalRecordsMap only fires when Supabase load fails;
  // doing it here makes cleanup self-healing on every persist.
  try {
    localStorage.removeItem(RECORDS_LEGACY_KEY);
  } catch {
    // ignore
  }
}

/** Was: persist a single model's records bucket from the saveRecord hot path.
 *  Now: ensure no stale bucket lingers for the model. Records aren't cached in
 *  localStorage anymore — see saveLocalRecordsMap. */
function saveLocalRecordsForModel(modelId: string, rows: AppRecord[]): void {
  void rows;
  try {
    localStorage.removeItem(recordsKeyFor(modelId));
  } catch (err) {
    // Cleanup-only: removeItem throws only if storage is blocked. No data is
    // lost (the real write path is Supabase); log so it isn't a silent swallow.
    // eslint-disable-next-line no-console
    console.warn('[localStorage] record-bucket cleanup failed:', err);
  }
}

// ────────────────────────────────────────────────────────────────────
// Supabase helpers
// ────────────────────────────────────────────────────────────────────
// Every Supabase write goes through the helpers below. They add two
// guarantees on top of the raw Supabase client:
//
//   1. Foreign-key ordering.  If you pass a `parent` tuple, the upsert
//      waits for any in-flight write targeting that row to resolve before
//      firing.  Without this, a write like `records.model_id = X` can hit
//      Postgres before the matching `models.id = X` row does, trip the FK
//      constraint, and silently fail.  The app would then diverge
//      permanently: the record lives in localStorage, never in Supabase.
//      FK-bearing tables in the schema today:
//         models.group_id          → model_groups.id
//         records.model_id         → models.id           (CASCADE)
//         workflows.trigger_model_id → models.id         (CASCADE)
//         model_views.model_id     → models.id           (CASCADE)
//         users.profile_id         → profiles.id
//
//   2. Error surfacing.  The previous implementation caught and discarded
//      every error with a `// silent fail` comment.  Now errors land in
//      `reportSupabaseError`, which logs to the console AND — once the
//      store is initialized — pushes a toast so the user can see when
//      something went wrong on the server.  LocalStorage remains the
//      immediate source of truth, so the app keeps working; the user just
//      gets a heads-up that the server copy fell behind.

// In-flight writes keyed by `${table}:${id}`.  Dependents consult this
// map before firing so the parent row is guaranteed to exist before the
// child tries to reference it.
const pendingWrites = new Map<string, Promise<unknown>>();
const writeKey = (table: string, id: string): string => `${table}:${id}`;

// Error reporter.  Defaults to console-only for any call that happens
// before the store is created; `initialize()` replaces this with a
// toast-backed reporter on first run.
let reportSupabaseError: (table: string, op: 'upsert' | 'delete' | 'load' | 'rpc', msg: string) => void =
  (table, op, msg) => {
    console.error(`[supabase] ${op} failed on ${table}: ${msg}`);
  };

/**
 * Whether Supabase writes are allowed right now. Returns false when the user
 * hasn't signed in yet — otherwise the write will be rejected by RLS and the
 * error toast piles up on the login page. Reads are still allowed (anon role
 * just returns empty arrays under RLS, no error) so `supabaseLoad` skips this.
 */
function canWriteToSupabase(): boolean {
  if (!supabase) return false;
  try {
    return useAppStore.getState().authEmail !== null;
  } catch {
    // Store not yet constructed (happens on the very first sync call during
    // module bootstrap). Fail closed — we'll pick up any missed writes when
    // initialize re-runs after sign-in.
    return false;
  }
}

// ─── Pending sync queue ──────────────────────────────────────────────
// Persists Supabase writes that failed (or that the user wasn't signed in
// to attempt) so they can be replayed on the next page load BEFORE
// supabaseLoad pulls fresh state. Without this, the classic silent-loss
// flow was: localStorage gets the change → Supabase upsert fails / user
// signed out / network blip → next reload pulls Supabase (stale) and
// clobbers localStorage (which still had the unsynced change). The user's
// edit silently disappears.
//
// Storage shape: a JSON array under `wassell_pending_sync`, each entry
// carrying enough info to retry (op, table, row OR rowId, optional
// FK parent). Dedupes by row id within table — the latest version of a
// given row replaces any older queued version (last-write-wins).
const PENDING_QUEUE_KEY = 'wassell_pending_sync';
const MAX_REPLAY_ATTEMPTS = 5;
// Audit fix L5: schema version for queue entries. Bump whenever any RPC
// signature, table column set, or op enum changes in a way that would
// make a stale queued entry replay incorrectly. On load, entries with a
// different version are dropped with a loud warning rather than silently
// failing on replay.
const PENDING_QUEUE_SCHEMA_VERSION = 1;

interface PendingWrite {
  id: string;
  // Schema version at the time this entry was enqueued. Replay drops
  // entries whose v doesn't match PENDING_QUEUE_SCHEMA_VERSION.
  v?: number;
  // 'upsert' / 'delete' — direct .from(table) ops; same shape as before.
  // 'record_upsert' / 'record_delete' — records-table ops that branch on
  //   the model's `is_hardcoded` flag at replay time. Frozen models route
  //   through the `record_save` / `record_delete` SQL RPCs instead of
  //   .from('records'), which the records-block-frozen-writes trigger
  //   would otherwise reject. modelId is required on record_delete so
  //   replay can look up whether the model is frozen without scanning.
  op: 'upsert' | 'delete' | 'record_upsert' | 'record_delete';
  table: string;
  // Audit M1 expanded: was `Record<string, unknown>`, which forced ~40
  // `as unknown as Record<string, unknown>` casts at every supabaseUpsert
  // call site (because typed AppModel/Workflow/etc. don't have an index
  // signature). Loosening to `object` accepts any object subtype directly
  // — the row is JSON-serialized into localStorage anyway, so we don't
  // need a stronger compile-time shape here.
  row?: object;
  rowId?: string;
  modelId?: string;
  parent?: { table: string; id: string | null | undefined };
  enqueuedAt: string;
  attempts: number;
}

function loadPendingQueue(): PendingWrite[] {
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingWrite[];
    // Audit L5: filter out entries from older queue schemas. Replaying a
    // pre-Phase-F.2 record_save call without `p_expected_version` would
    // technically still work (the RPC tolerates missing params), but we
    // don't want to ship that surprise across breaking changes — the
    // pattern of "drop with a warning, force the user to re-do the edit"
    // is safer than silently replaying with stale arg shapes.
    const valid: PendingWrite[] = [];
    let dropped = 0;
    for (const entry of parsed) {
      if ((entry.v ?? 0) !== PENDING_QUEUE_SCHEMA_VERSION) {
        dropped += 1;
        continue;
      }
      valid.push(entry);
    }
    if (dropped > 0) {
      console.warn(
        `[pendingQueue] dropped ${dropped} entry(ies) from an older queue schema; ` +
          `they were enqueued before the latest deploy and would not replay correctly.`,
      );
    }
    return valid;
  } catch (err) {
    console.error('[pendingQueue] read failed:', err);
    return [];
  }
}

function savePendingQueue(queue: PendingWrite[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(PENDING_QUEUE_KEY);
    else localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    // Surfaced loudly — losing the pending queue means losing unsynced edits.
    console.error('[pendingQueue] persist failed:', err);
    try {
      useAppStore.getState().addToast(
        useAppStore.getState().language === 'ar'
          ? 'فشل حفظ قائمة المزامنة المعلّقة — قد تضيع تعديلات غير محفوظة.'
          : 'Could not save the pending-sync queue — unsynced edits may be lost.',
        'error',
      );
    } catch {
      // Store not yet ready; console message above is enough.
    }
  }
}

function enqueuePendingWrite(entry: Omit<PendingWrite, 'id' | 'enqueuedAt' | 'attempts'>): void {
  const queue = loadPendingQueue();
  // Dedupe: if a write for this row is already queued, replace it (last
  // write wins). Keeps the queue from ballooning when the user edits the
  // same record repeatedly while offline.
  const rowId = ((entry.row as { id?: string } | undefined)?.id) ?? entry.rowId;
  if (typeof rowId === 'string') {
    const idx = queue.findIndex(
      (w) =>
        w.table === entry.table &&
        (((w.row as { id?: string } | undefined)?.id) === rowId || w.rowId === rowId),
    );
    if (idx >= 0) {
      queue[idx] = {
        ...queue[idx]!,
        ...entry,
        enqueuedAt: new Date().toISOString(),
      };
      savePendingQueue(queue);
      return;
    }
  }
  queue.push({
    ...entry,
    v: PENDING_QUEUE_SCHEMA_VERSION,
    id:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  });
  savePendingQueue(queue);
}

/**
 * Drain the pending queue against Supabase. Called from `initialize()` after
 * auth is wired but before any `supabaseLoad`, so unsynced writes from a
 * previous session land before we'd otherwise overwrite them with stale
 * Supabase state. Writes that fail again get their attempt count bumped and
 * stay queued; entries that fail MAX_REPLAY_ATTEMPTS times are dropped with
 * a loud console warning (and a toast — losing data is an admin-visible
 * event, not a silent one).
 */
async function replayPendingWrites(): Promise<{
  replayed: number;
  stillQueued: number;
  dropped: number;
}> {
  if (!supabase) return { replayed: 0, stillQueued: 0, dropped: 0 };
  if (!canWriteToSupabase()) {
    // Not signed in — leave the queue intact for a later session.
    const stillQueued = loadPendingQueue().length;
    return { replayed: 0, stillQueued, dropped: 0 };
  }
  const queue = loadPendingQueue();
  if (queue.length === 0) return { replayed: 0, stillQueued: 0, dropped: 0 };

  const remaining: PendingWrite[] = [];
  let replayed = 0;
  let dropped = 0;

  for (const w of queue) {
    let ok = false;
    try {
      if (w.op === 'upsert' && w.row) {
        const { error } = await supabase.from(w.table).upsert(w.row);
        if (!error) ok = true;
        else console.error(`[pendingQueue] replay upsert ${w.table} failed:`, error.message);
      } else if (w.op === 'delete' && w.rowId) {
        const { error } = await supabase.from(w.table).delete().eq('id', w.rowId);
        if (!error) ok = true;
        else console.error(`[pendingQueue] replay delete ${w.table} failed:`, error.message);
      } else if (w.op === 'record_upsert' && w.row) {
        // Records-table write — branch on the (now-current) is_hardcoded
        // flag for the row's model. The model may have been frozen between
        // when this entry was queued and now; the dispatcher RPC handles
        // both paths uniformly.
        const modelId = (w.row as { model_id?: string }).model_id;
        const id = (w.row as { id?: string }).id;
        const data = (w.row as { data?: unknown }).data;
        const createdBy = (w.row as { created_by_user_id?: string | null }).created_by_user_id ?? null;
        if (modelId && id && isModelHardcoded(modelId)) {
          const { error } = await supabase.rpc('record_save', {
            p_model_id: modelId,
            p_id: id,
            p_data: data ?? {},
            p_created_by: createdBy,
          });
          if (!error) ok = true;
          else console.error(`[pendingQueue] replay record_save (frozen) failed:`, error.message);
        } else {
          const { error } = await supabase.from('records').upsert(w.row);
          if (!error) ok = true;
          else console.error(`[pendingQueue] replay record_upsert failed:`, error.message);
        }
      } else if (w.op === 'record_delete' && w.rowId && w.modelId) {
        if (isModelHardcoded(w.modelId)) {
          const { error } = await supabase.rpc('record_delete', {
            p_model_id: w.modelId,
            p_id: w.rowId,
          });
          if (!error) ok = true;
          else console.error(`[pendingQueue] replay record_delete (frozen) failed:`, error.message);
        } else {
          const { error } = await supabase.from('records').delete().eq('id', w.rowId);
          if (!error) ok = true;
          else console.error(`[pendingQueue] replay record_delete failed:`, error.message);
        }
      }
    } catch (err) {
      console.error(`[pendingQueue] replay ${w.op} ${w.table} threw:`, err);
    }

    if (ok) {
      replayed++;
    } else {
      const next = { ...w, attempts: w.attempts + 1 };
      if (next.attempts >= MAX_REPLAY_ATTEMPTS) {
        dropped++;
        const idShort = ((next.row as { id?: string } | undefined)?.id)?.slice(0, 8) ?? next.rowId?.slice(0, 8) ?? '?';
        console.error(
          `[pendingQueue] DROPPING ${next.op} on ${next.table}#${idShort} after ${MAX_REPLAY_ATTEMPTS} attempts.`,
          next,
        );
      } else {
        remaining.push(next);
      }
    }
  }

  savePendingQueue(remaining);

  if (replayed > 0) {
    console.log(`[pendingQueue] replayed ${replayed} write(s).`);
  }
  if (dropped > 0) {
    try {
      useAppStore
        .getState()
        .addToast(
          `تم إسقاط ${dropped} تعديل غير متزامن بعد محاولات متكررة. راجع وحدة التحكم.`,
          'error',
        );
    } catch {
      // Store not ready; the console.error above carries the detail.
    }
  }
  return { replayed, stillQueued: remaining.length, dropped };
}

async function supabaseUpsert(
  table: string,
  // Audit M1 expanded: typed `object` instead of `Record<string, unknown>`.
  // AppModel / AppRecord / Workflow / etc. now flow in directly without
  // the `as unknown as Record<string, unknown>` ceremony at every call
  // site. We re-narrow internally where we need to read named props.
  row: object,
  parent?: { table: string; id: string | null | undefined },
): Promise<void> {
  // No Supabase client at all (env not configured) → pure offline-only mode.
  // Nothing to queue, nothing to retry.
  if (!supabase) return;
  // Signed out / mid-bootstrap → can't write to Supabase right now, but the
  // change must not be lost. Queue it; replayPendingWrites picks it up next
  // initialize() once auth is restored.
  if (!canWriteToSupabase()) {
    enqueuePendingWrite({ op: 'upsert', table, row, parent });
    return;
  }
  // Block on any in-flight parent write so the FK exists when we land.
  // `parent.id` can be null/undefined for optional FKs (e.g. `group_id`).
  if (parent && parent.id) {
    const prior = pendingWrites.get(writeKey(parent.table, parent.id));
    if (prior) {
      try { await prior; } catch { /* parent errored; we still try our write */ }
    }
  }
  // Re-narrow once for the internal property reads (id, updated_at).
  // The contract is: every row this function takes has a string `id` and
  // optionally a string `updated_at`. We don't try to verify the rest of
  // the shape — Supabase's PostgREST will reject malformed payloads at
  // the wire if any required column is missing, and the typed call sites
  // upstream are the source of truth for shape.
  const rowReadable = row as Record<string, unknown>;
  const id = typeof rowReadable.id === 'string' ? rowReadable.id : undefined;
  const key = id ? writeKey(table, id) : undefined;
  const op = (async () => {
    try {
      // Supabase's .upsert() accepts a record-shaped object; the cast
      // here mirrors the cast-once pattern.
      //
      // Ask for `.select()` back so we can detect the silent-RLS-denial
      // case: PostgREST does NOT raise an error when an UPDATE's USING
      // clause filters the row out — it returns 200 OK with zero rows
      // affected. This is exactly how the 2026-05-06 auth_uid binding
      // deadlock hid for 18 days. Surfacing zero-rows as a loud error
      // forces the same class of bug to fail loudly next time, in line
      // with CLAUDE.md → "Silent Failures".
      const { data, error } = await supabase!.from(table).upsert(rowReadable).select();
      if (error) {
        reportSupabaseError(table, 'upsert', error.message ?? String(error));
        // Queue for retry on next initialize so the local edit isn't lost
        // when Supabase load runs and overwrites localStorage.
        enqueuePendingWrite({ op: 'upsert', table, row, parent });
      } else if (id && (!data || data.length === 0)) {
        // RLS silently filtered the upsert. Don't enqueue — a retry
        // won't help if the policy is what's denying. Surface so the
        // user knows the write didn't land, and the dev can fix the
        // RLS policy (or the caller's assumption).
        reportSupabaseError(
          table,
          'upsert',
          `RLS silently filtered the upsert on ${table}/${id} (0 rows returned). The write did not land. Check the table's RLS policies — this is the class of bug that hid the auth_uid deadlock from 2026-05-06 to 2026-05-24.`,
        );
      } else if (id) {
        // Echo dedup: tell the RealtimeOrchestrator this row id was
        // just written by us so it skips the inevitable echo from the
        // supabase_realtime publication. Pass updated_at (audit fix H1)
        // so the dedup check is timing-independent.
        const updatedAt = typeof rowReadable['updated_at'] === 'string' ? (rowReadable['updated_at'] as string) : null;
        markRecentlyWritten(table, id, updatedAt);
      }
    } catch (err) {
      reportSupabaseError(table, 'upsert', err instanceof Error ? err.message : String(err));
      enqueuePendingWrite({ op: 'upsert', table, row, parent });
    }
  })();
  if (key) pendingWrites.set(key, op);
  try {
    await op;
  } finally {
    if (key && pendingWrites.get(key) === op) pendingWrites.delete(key);
  }
}

async function supabaseDelete(table: string, id: string): Promise<void> {
  if (!supabase) return;
  if (!canWriteToSupabase()) {
    enqueuePendingWrite({ op: 'delete', table, rowId: id });
    return;
  }
  // Wait for any in-flight upsert to this row first — otherwise the
  // delete can race past it and leave the row orphaned in the DB.
  const prior = pendingWrites.get(writeKey(table, id));
  if (prior) {
    try { await prior; } catch { /* ignore */ }
  }
  try {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) {
      reportSupabaseError(table, 'delete', error.message ?? String(error));
      enqueuePendingWrite({ op: 'delete', table, rowId: id });
    } else {
      // Deletes have no updated_at to compare; rely on soft-TTL fallback
      // in wasEchoOf for the DELETE event.
      markRecentlyWritten(table, id, null);
    }
  } catch (err) {
    reportSupabaseError(table, 'delete', err instanceof Error ? err.message : String(err));
    enqueuePendingWrite({ op: 'delete', table, rowId: id });
  }
}

/**
 * Write a row to `audit_log` (Phase 3 of the user-mgmt plan).
 *
 * Fire-and-forget by design — audit writes are best-effort. We surface
 * failures via console.error but don't queue / retry: losing a row is
 * better than blocking the user-management UI on a slow audit insert,
 * and the entries are append-only so a missed row can't corrupt state.
 *
 * Caller passes:
 *   - entityType: 'user' | 'profile' | 'role'
 *   - action:     'created' | 'updated' | 'deleted' | 'deactivated' | 'activated'
 *   - id, label:  for the entity (label is the display string at write time)
 *   - before:     pre-mutation row, or null on creates
 *   - after:      post-mutation row, or null on deletes
 *
 * Actor identity is read from the live store state (currentUserId / authUid /
 * authEmail) so the helper has zero arguments for the actor side.
 */
async function writeAuditLog(args: {
  entityType: 'user' | 'profile' | 'role';
  action: 'created' | 'updated' | 'deleted' | 'deactivated' | 'activated';
  entityId: string;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  if (!supabase) return;
  const state = useAppStore.getState();
  const row = {
    actor_auth_uid: state.authUid ?? null,
    actor_email: state.authEmail ?? null,
    entity_type: args.entityType,
    entity_id: args.entityId,
    entity_label: args.entityLabel ?? null,
    action: args.action,
    before: args.before ?? null,
    after: args.after ?? null,
  };
  try {
    const { error } = await supabase.from('audit_log').insert(row);
    if (error) {
      // No retry queue — audit rows are append-only and best-effort.
      console.error('[audit_log] insert failed:', error.message ?? String(error));
    }
  } catch (err) {
    console.error('[audit_log] insert failed:', err instanceof Error ? err.message : String(err));
  }
}

// ─── Frozen-model record helpers ─────────────────────────────────────
// Wraps Supabase record writes so frozen models route through the
// `record_save` / `record_delete` SQL RPCs instead of .from('records'),
// which the records-block-frozen-writes trigger would reject. Surfacing
// + queueing on failure mirror the regular supabaseUpsert/Delete path.
//
// The store actions saveRecord / deleteRecord call these instead of
// supabaseUpsert / supabaseDelete on 'records'. Server-side consumers
// (api/, supabase/functions/) can call the RPCs directly via PostgREST.
//
// `created_by_user_id` (Phase 1 RLS column on records) is threaded
// through via the same record shape the upstream `saveRecord` builds.
// For unfrozen models, .from('records').upsert(record) sends it as a
// column. For frozen models, the record_save RPC takes it as an
// explicit p_created_by parameter so the dedicated table can stamp it
// without losing the value (the JSONB `data` payload doesn't carry it).

function isModelHardcoded(modelId: string): boolean {
  try {
    const m = useAppStore.getState().models.find((x) => x.id === modelId);
    return !!m?.is_hardcoded;
  } catch {
    return false;
  }
}

// ─── M1 partial: typed serialization for records ─────────────────────
//
// The codebase is full of `record`
// casts at the Supabase boundary; the audit flagged them as a silent-
// corruption surface (a future schema rename can ship a row with the
// wrong shape and TypeScript won't notice). Closing them all in one
// pass is a big refactor; this helper handles the hottest spot — the
// retry-queue serialization for record writes — and the rest can be
// migrated incrementally on a per-table basis.
//
// `SupabaseRecordsRow` is the exact shape the public.records row takes:
// the JSONB `data` column plus the standard metadata. By going through
// this serializer we get a compile-time check that AppRecord still has
// the fields we need; if AppRecord adds a column the serializer breaks
// at the next type-check instead of silently dropping it.
interface SupabaseRecordsRow {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  version: number | null;
  [k: string]: unknown; // allow forward-compat columns to ride through unmolested
}

function serializeRecord(record: AppRecord): SupabaseRecordsRow {
  return {
    id: record.id,
    model_id: record.model_id,
    data: record.data,
    created_at: record.created_at,
    updated_at: record.updated_at,
    created_by_user_id: record.created_by_user_id ?? null,
    version: record.version ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────
// record_save conflict circuit breaker (incident 2026-06-02)
//
// `record_save` rejects a write whose `p_expected_version` is behind the
// row's current version (SQLSTATE 40001 / "version_mismatch"). If a client's
// local `version` falls behind the server — which used to happen whenever
// Realtime dropped the client's own version bump (see the version-advance fix
// in `saveRecord`) — every retry re-sends the SAME stale version and is
// rejected again. A wizard that auto-saves the same record (Data Migration)
// then hammers `record_save` indefinitely; combined with re-render reloads it
// saturated Postgres CPU until compute was bumped 4×.
//
// This breaker bounds the blast radius: count consecutive conflicts per record
// id within a short window; once a record trips the limit, STOP issuing saves
// for it and surface ONE loud toast telling the user to reload (CLAUDE.md:
// fail loudly, never spin silently). A successful save — or a page reload,
// which resets this module state — clears the breaker.
// The per-record conflict breaker + the reload-attempt cap (T1) now live in a
// PURE, unit-tested module — src/lib/conflictBreaker.ts (imported at the top of
// this file) — so the kill-switch state machine can be tested in the node test
// env. See src/lib/__tests__/conflictBreaker.test.ts. Behavior is unchanged;
// this is an extraction-for-testability move.

// Phase F.2 fix (audit H5): the second arg lets the caller override which
// version to send as p_expected_version. Form pages snapshot the version
// at mount time and pass it here so the check is against the version the
// user was actually editing — not the one realtime may have just updated
// underneath them. When `expectedVersion` is undefined we fall back to
// `record.version`, which is what fire-and-forget callers (workflow,
// import, lookup combobox) want. `null` is meaningful too: it forces the
// RPC's "skip the check" branch (used by workflow chains where each step
// reloads the row anyway).
async function supabaseRecordUpsert(
  record: AppRecord,
  opts: { expectedVersion?: number | null } = {},
): Promise<SaveResult> {
  if (!supabase) return { status: 'saved' };
  // Stale-build lockout (conflict-storm layer 2): once this tab is confirmed
  // outdated AND it tripped the storm breaker, every save short-circuits here —
  // terminal + NON-silent (returns 'conflict' so the caller surfaces it; the
  // form keeps the user's edits until the forced reload) — so a stale tab can't
  // keep hammering the DB while it waits out the forced-reload grace.
  if (isStaleBuildWriteLocked()) {
    // T1 (req 7): the build-independent hard write-stop is engaged — EVERY record
    // write from this tab (manual save, autosave, workflow chain, assistant-panel
    // action, import) short-circuits HERE, terminally, before touching the DB.
    // kind:'hard_stop' (not 'version_mismatch') so reload-on-conflict never
    // re-fetches/retries on this; the tab is reloading regardless.
    return {
      status: 'conflict',
      kind: 'hard_stop',
      message: 'A required update is loading — reload to continue. Your changes are kept in the form.',
    };
  }
  if (!canWriteToSupabase()) {
    enqueuePendingWrite({
      op: 'record_upsert',
      table: 'records',
      row: serializeRecord(record),
    });
    return { status: 'queued', reason: 'offline' };
  }
  const frozen = isModelHardcoded(record.model_id);
  const id = record.id;
  const key = writeKey('records', id);
  // The actual expectedVersion the RPC will see. Caller-supplied wins.
  const expectedVersion =
    opts.expectedVersion !== undefined ? opts.expectedVersion : (record.version ?? null);
  let outcome: SaveResult = { status: 'saved' };
  const op = (async () => {
    try {
      if (frozen) {
        // Pass `created_by_user_id` through to the RPC so the dedicated
        // table stamps it on first save (the RPC's freeze_apply_row
        // preserves any existing value on update — never overwrites).
        const { error } = await supabase!.rpc('record_save', {
          p_model_id: record.model_id,
          p_id: record.id,
          p_data: record.data,
          p_created_by: record.created_by_user_id ?? null,
        });
        if (error) {
          const msg = error.message ?? String(error);
          reportSupabaseError('records', 'upsert', msg);
          enqueuePendingWrite({
            op: 'record_upsert',
            table: 'records',
            row: serializeRecord(record),
          });
          outcome = { status: 'queued', reason: msg };
        } else {
          // Frozen-model writes don't echo through `records` realtime
          // (the row lives in the dedicated table), but a future
          // frozen-table channel would — register defensively.
          // Audit H1: records writes go through record_save which doesn't
          // return the row, so we don't have the canonical Postgres-side
          // updated_at to mark with. Pass null and let dedup fall back to
          // soft-TTL for records-channel echoes. Future work: change the
          // RPC signature to RETURN TABLE(updated_at) so we can do strict
          // compare here too — tracked in the audit follow-up migration.
          markRecentlyWritten('records', record.id, null);
          outcome = { status: 'saved' };
        }
      } else {
        // Block on any in-flight model write so the FK exists when we land.
        const prior = pendingWrites.get(writeKey('models', record.model_id));
        if (prior) { try { await prior; } catch { /* parent error */ } }
        // Circuit breaker (incident 2026-06-02): if this record is wedged in a
        // version-conflict loop, stop hitting the DB until the page reloads.
        // Protects Postgres from a stale-version retry storm (the Data
        // Migration wizard auto-saved the same record after its local version
        // froze behind the server's, pinning DB CPU). No-op for the common case
        // — only trips after repeated rapid conflicts on the same record.
        if (recordSaveBlocked(id)) {
          // Breaker tripped (count-based, or wedged/storm-blocked). Terminal:
          // kind:'wedged' so reload-on-conflict does NOT re-fetch/retry — the
          // record only resumes on a successful save (impossible while tripped)
          // or a page reload, which resets this module state.
          outcome = {
            status: 'conflict',
            kind: 'wedged',
            message: 'save paused after repeated version conflicts — reload the page to continue',
          };
          return;
        }
        // Phase F.2: route unfrozen writes through `record_save` so the
        // optimistic-concurrency check applies. Pass the caller-supplied
        // `expectedVersion` (form-mount snapshot) when available; otherwise
        // fall back to record.version. New records pass null, which the
        // RPC treats as "skip the check".
        const { error } = await supabase!.rpc('record_save', {
          p_model_id: record.model_id,
          p_id: record.id,
          p_data: record.data,
          p_created_by: record.created_by_user_id ?? null,
          p_expected_version: expectedVersion,
        });
        if (error) {
          const errMsg = error.message ?? '';
          // T1 (req 1/2): split the SERVER's terminal storm block from a normal
          // concurrent-edit version_mismatch. They used to be treated identically;
          // they must NOT be. conflict_storm_blocked = "the DB has rate-limited
          // you" → STOP everything, no reload-retry. version_mismatch = a possibly
          // one-off concurrent edit → allow exactly one reload-and-retry.
          const isStormBlocked = errMsg.includes('conflict_storm_blocked');
          // serialization_failure (SQLSTATE 40001) is the version_mismatch raise.
          const isVersionConflict =
            !isStormBlocked &&
            (error.code === '40001' || errMsg.includes('version_mismatch'));

          if (isStormBlocked) {
            // req 1/2/6: terminal. Wedge the breaker so no path retries this
            // record, and engage the BUILD-INDEPENDENT hard write-stop so every
            // other write in this tab stops too and the tab force-reloads (even
            // on the current build). Still report the conflict for telemetry.
            markRecordWedged(id);
            engageHardWriteStop('server-blocked');
            void supabase!.rpc('record_conflict_report', { p_record_id: id })
              .then(({ error: reportErr }) => {
                if (reportErr) console.warn('[conflict] record_conflict_report failed:', reportErr.message);
              });
            try {
              const ar = useAppStore.getState().language === 'ar';
              useAppStore.getState().addToast(
                ar
                  ? 'تم إيقاف الحفظ بعد تكرار التعارض. ستُعاد تهيئة الصفحة تلقائياً للمتابعة.'
                  : 'Saving was blocked after a conflict storm. The page will reload to recover.',
                'error',
              );
            } catch { /* store not ready */ }
            outcome = {
              status: 'conflict',
              kind: 'storm_blocked',
              message: 'Saving is blocked after repeated conflicts — reloading to recover.',
            };
            return;
          }

          if (isVersionConflict) {
            const tripped = noteRecordConflict(id);
            // Report this conflict to the backend auto-throttle (fire-and-forget).
            // Once one (record, session) crosses the server threshold the record
            // is auto-blocked, so even a re-render retry loop becomes a cheap
            // terminal reject server-side without an operator in the loop. Never
            // throws into the save path. (2026-06-21 conflict-storm hardening.)
            void supabase!.rpc('record_conflict_report', { p_record_id: id })
              .then(({ error: reportErr }) => {
                if (reportErr) console.warn('[conflict] record_conflict_report failed:', reportErr.message);
              });
            const msg = 'Another user just edited this record. Reload to see their changes before re-saving.';
            if (tripped) {
              // req 6 (T1): a tripped per-record breaker means this tab is
              // storming one record — escalate to the BUILD-INDEPENDENT hard
              // write-stop (previously this only happened when the build was
              // already outdated, so a storming tab on the CURRENT build never
              // stopped). The reload-on-conflict re-sync (req 5) keeps a LEGIT
              // single concurrent edit from ever reaching the trip, so reaching
              // it here means a genuinely wedged client.
              engageHardWriteStop('record-storm');
              // Repeated conflicts in a short window = a stuck client (stale
              // local version), not a one-off race. Fire ONE strong toast and
              // let the breaker short-circuit future saves above so we stop
              // hammering the DB. (CLAUDE.md: fail loudly, never spin silently.)
              try {
                const ar = useAppStore.getState().language === 'ar';
                useAppStore.getState().addToast(
                  ar
                    ? 'تعذّر حفظ هذا السجل بسبب تعارض النسخة المتكرر. أعد تحميل الصفحة للمتابعة.'
                    : 'Saving was paused after repeated version conflicts on this record. Reload the page to continue.',
                  'error',
                );
              } catch { /* store not ready — the per-conflict reports below still log */ }
            } else {
              reportSupabaseError('records', 'upsert', msg);
            }
            outcome = { status: 'conflict', kind: 'version_mismatch', message: msg };
          } else {
            const msg = error.message ?? String(error);
            reportSupabaseError('records', 'upsert', msg);
            enqueuePendingWrite({
              op: 'record_upsert',
              table: 'records',
              row: serializeRecord(record),
            });
            outcome = { status: 'queued', reason: msg };
          }
        } else {
          // Audit H1: records writes go through record_save which doesn't
          // return the row, so we don't have the canonical Postgres-side
          // updated_at to mark with. Pass null and let dedup fall back to
          // soft-TTL for records-channel echoes. Future work: change the
          // RPC signature to RETURN TABLE(updated_at) so we can do strict
          // compare here too — tracked in the audit follow-up migration.
          markRecentlyWritten('records', record.id, null);
          clearRecordConflict(id);
          outcome = { status: 'saved' };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportSupabaseError('records', 'upsert', msg);
      enqueuePendingWrite({
        op: 'record_upsert',
        table: 'records',
        row: serializeRecord(record),
      });
      outcome = { status: 'queued', reason: msg };
    }
  })();
  pendingWrites.set(key, op);
  try {
    await op;
  } finally {
    if (pendingWrites.get(key) === op) pendingWrites.delete(key);
  }
  return outcome;
}

async function supabaseRecordDelete(modelId: string, recordId: string): Promise<void> {
  if (!supabase) return;
  if (!canWriteToSupabase()) {
    enqueuePendingWrite({
      op: 'record_delete',
      table: 'records',
      rowId: recordId,
      modelId,
    });
    return;
  }
  // Wait for any in-flight upsert to this row first.
  const prior = pendingWrites.get(writeKey('records', recordId));
  if (prior) { try { await prior; } catch { /* ignore */ } }
  const frozen = isModelHardcoded(modelId);
  try {
    if (frozen) {
      const { error } = await supabase.rpc('record_delete', {
        p_model_id: modelId,
        p_id: recordId,
      });
      if (error) {
        reportSupabaseError('records', 'delete', error.message ?? String(error));
        enqueuePendingWrite({
          op: 'record_delete',
          table: 'records',
          rowId: recordId,
          modelId,
        });
      } else {
        markRecentlyWritten('records', recordId, null);
      }
    } else {
      const { error } = await supabase.from('records').delete().eq('id', recordId);
      if (error) {
        reportSupabaseError('records', 'delete', error.message ?? String(error));
        enqueuePendingWrite({
          op: 'record_delete',
          table: 'records',
          rowId: recordId,
          modelId,
        });
      } else {
        markRecentlyWritten('records', recordId, null);
      }
    }
  } catch (err) {
    reportSupabaseError('records', 'delete', err instanceof Error ? err.message : String(err));
    enqueuePendingWrite({
      op: 'record_delete',
      table: 'records',
      rowId: recordId,
      modelId,
    });
  }
}

// Webhook-triggered workflows have no source model, which the app represents
// as `trigger_model_id: ''`. Postgres rejects empty strings on UUID columns,
// so convert to null before any upsert. Kept near the Supabase helpers so
// all three call sites go through the same normalizer.
function workflowToSupabaseRow(w: Workflow): Record<string, unknown> {
  return {
    ...w,
    trigger_model_id: w.trigger_model_id || null,
    // Postgres has the same empty-string-not-uuid problem for group_id.
    group_id: w.group_id || null,
  };
}

async function supabaseLoad<T>(
  table: string,
  opts?: { excludeModelIds?: string[]; idColumn?: string },
): Promise<T[] | null> {
  if (!supabase) return null;
  // The keyset cursor column. Defaults to `id` (every models-owned table has a
  // uuid PK). Small non-`id`-keyed tables (e.g. whatsapp_numbers, PK device_id)
  // pass their PK here so the `.gt(<key>, cursor)` filter targets a real column —
  // otherwise PostgREST errors "column <table>.id does not exist". Such tables are
  // tiny (they finish in the single head page, never reaching the uuid-bound
  // shard walk, which assumes a uuid key).
  const idCol = opts?.idColumn ?? 'id';
  // Lazy models (e.g. market_listings) are excluded from the bulk boot
  // load via `.not('model_id','in',(…))` so their (potentially huge) row
  // sets never enter the in-memory `records` slice. They're paged in on
  // demand by `loadRecordsPage`. Empty list ⇒ no filter (every other
  // supabaseLoad call passes nothing and behaves exactly as before).
  const excludeIds = opts?.excludeModelIds ?? [];
  const excludeInList = excludeIds.length > 0 ? `(${excludeIds.join(',')})` : null;
  // KEYSET pagination (id > cursor ORDER BY id), sharded for parallelism.
  //
  // Why not OFFSET: every read of `unified_records` (and the RLS tables) runs
  // the per-row scope check `wassell_can_view_record` on each scanned row.
  // With OFFSET, page N re-scans+re-filters ALL rows up to the offset, so a
  // full load is O(n²) RLS evaluations — measured ~2.1s for a single deep page
  // as a real user (vs 14ms bypassing RLS). Keyset filters only ~pageSize rows
  // per page (~74ms DB) because the index seeks straight to the cursor.
  //
  // Why shard: keyset is inherently sequential (each page needs the previous
  // page's last id), and the per-page cost is dominated by the network round
  // trip (~0.9s), so 29 pages nose-to-tail is still ~25s. The id space is
  // uniformly distributed v4 uuids, so we split it into fixed half-open ranges
  // (lo, hi] and walk them CONCURRENTLY — each range keyset-walks itself; no
  // row lands in two ranges, none is skipped.
  //
  // The 1000-row PostgREST cap (db-max-rows) still applies per request — the
  // keyset loop is what reads PAST it. A bare select silently truncates at
  // 1000 (no error), which historically surfaced as missing records / count
  // drift; that guard is preserved.
  const pageSize = 1000;
  const MIN_ID = '00000000-0000-0000-0000-000000000000';
  const MAX_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const idOf = (row: T): string => (row as unknown as Record<string, string>)[idCol] ?? '';

  // Keyset-walk one (loExclusive, hiInclusive] id-range into `out`. Returns an
  // error string on failure (caller surfaces + aborts), else null.
  const walkRange = async (loExclusive: string, hiInclusive: string, out: T[]): Promise<string | null> => {
    let cursor = loExclusive;
    for (;;) {
      let q = supabase!
        .from(table)
        .select('*')
        .gt(idCol, cursor)
        .lte(idCol, hiInclusive)
        .order(idCol, { ascending: true })
        .limit(pageSize);
      if (excludeInList) q = q.not('model_id', 'in', excludeInList);
      const { data, error } = await q;
      if (error) return error.message ?? String(error);
      const batch = (data ?? []) as T[];
      out.push(...batch);
      if (batch.length < pageSize) return null;   // short page ⇒ range drained
      cursor = idOf(batch[batch.length - 1] as T); // advance keyset cursor
    }
  };

  try {
    // First page over the whole space. The common case (small config tables)
    // finishes here in ONE request — no shard amplification.
    const head: T[] = [];
    let headQ = supabase
      .from(table)
      .select('*')
      .gt(idCol, MIN_ID)
      .order(idCol, { ascending: true })
      .limit(pageSize);
    if (excludeInList) headQ = headQ.not('model_id', 'in', excludeInList);
    const { data: headData, error: headError } = await headQ;
    if (headError) {
      reportSupabaseError(table, 'load', headError.message ?? String(headError));
      return null;
    }
    head.push(...((headData ?? []) as T[]));
    if (head.length < pageSize) return head;       // whole table fit in one page

    // Large table: page 0 covered (MIN_ID, lastId]. Shard the REMAINING id
    // space into fixed ranges and walk them in parallel. Clamp each range's
    // lower bound up to lastId so we never re-fetch page 0's rows.
    const lastId = idOf(head[head.length - 1] as T);
    // 16 half-open id ranges (one per leading hex nibble) walked concurrently.
    // 16 measured ~15% faster than 8 here; the keyset pages are cheap (~74ms
    // DB) so even 16 in flight don't saturate the DB the way OFFSET did.
    const BOUNDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']
      .map((nibble) => `${nibble}0000000-0000-0000-0000-000000000000`)
      .concat(MAX_ID);
    const ranges: Array<{ lo: string; hi: string; out: T[] }> = [];
    let lo = lastId;
    for (const hi of BOUNDS) {
      if (hi > lo) {
        ranges.push({ lo, hi, out: [] });
        lo = hi;
      }
    }

    let failure: string | null = null;
    await Promise.all(
      ranges.map(async (r) => {
        const err = await walkRange(r.lo, r.hi, r.out);
        if (err && failure === null) failure = err;
      }),
    );
    if (failure !== null) {
      reportSupabaseError(table, 'load', failure);
      return null;
    }

    const all = head.slice();
    for (const r of ranges) all.push(...r.out);
    return all;
  } catch (err) {
    reportSupabaseError(table, 'load', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Chats Realtime plumbing ────────────────────────────────────────
// Per-chat Supabase Realtime channels live outside the Zustand state so
// that non-serializable RealtimeChannel instances never leak into
// localStorage or cause React re-renders. The map is keyed by chat wid.
const chatRealtimeChannels = new Map<string, ReturnType<NonNullable<typeof supabase>['channel']>>();

// Shape of the `chat_messages` table row (snake_case from Supabase REST).
interface DbChatMessageRow {
  id: string;
  chat_wid: string;
  conversation_record_id: string;
  device_id: string;
  flow: 'in' | 'out';
  kind: string;
  subtype: string | null;
  body: string | null;
  from_phone: string | null;
  to_phone: string | null;
  ack: ChatMessage['ack'];
  date: string;
  media_file_id: string | null;
  media_mime: string | null;
  media_size: number | null;
  media_caption: string | null;
  reference: string | null;
  quoted: ChatMessage['quoted'];
}

/** Map a `chat_messages` table row to the store's ChatMessage shape. Shared
 *  by the Realtime merge and the mirror-fallback read in loadMessagesForChat. */
function dbRowToChatMessage(row: DbChatMessageRow): ChatMessage {
  return {
    id: row.id,
    chat_wid: row.chat_wid,
    flow: row.flow,
    kind: row.kind,
    subtype: row.subtype ?? null,
    body: row.body,
    from_phone: row.from_phone,
    to_phone: row.to_phone,
    ack: row.ack,
    date: row.date,
    media_file_id: row.media_file_id,
    media_mime: row.media_mime,
    media_size: row.media_size,
    media_caption: row.media_caption,
    reference: row.reference,
    quoted: row.quoted,
  };
}

/** Read a page of one chat's messages from the `chat_messages` mirror table.
 *  Fallback path for when the live Haberchat fetch fails (their API has real
 *  outage windows — e.g. 2026-07-09..12) so the thread renders our ingested
 *  history instead of a false "no messages yet" empty state. Newest-first
 *  query, returned ascending like the live path. Returns null when Supabase
 *  is unconfigured or the read fails. */
/**
 * Reactions live ONLY in our own `chat_messages` mirror — the gateway's history
 * API returns messages, not reactions — so a thread rebuilt from the live fetch
 * would lose every 👍 on reload. Load them separately and merge.
 */
async function loadReactionsFromMirror(chatWid: string): Promise<ChatMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('chat_wid', chatWid)
    .eq('kind', 'reaction')
    .order('date', { ascending: true })
    .limit(500);
  if (error) {
    console.error('[loadReactionsFromMirror] read failed:', error.message);
    return [];
  }
  return ((data ?? []) as DbChatMessageRow[]).map(dbRowToChatMessage);
}

async function loadMessagesFromMirror(
  chatWid: string,
  opts: { before?: string; size?: number },
): Promise<{ messages: ChatMessage[]; hasMore: boolean } | null> {
  if (!supabase) return null;
  const size = opts.size ?? 50;
  let q = supabase
    .from('chat_messages')
    .select('*')
    .eq('chat_wid', chatWid)
    // Reactions are loaded separately (loadReactionsFromMirror) and are not
    // thread entries — leaving them in would let a burst of 👍 consume the
    // page window and push real messages out of the first screen.
    .neq('kind', 'reaction')
    .order('date', { ascending: false })
    .limit(size);
  if (opts.before) q = q.lt('date', opts.before);
  const { data, error } = await q;
  if (error) {
    console.error('[loadMessagesFromMirror] chat_messages read failed:', error.message);
    return null;
  }
  const rows = (data ?? []) as DbChatMessageRow[];
  return {
    messages: rows.map(dbRowToChatMessage).reverse(),
    hasMore: rows.length >= size,
  };
}

/** Merge one live `chat_messages` row into `chatMessages[chat_wid]`.
 *  If the row's `reference` matches a pending optimistic placeholder, the
 *  placeholder is replaced (keyed by client_id). Otherwise the row is
 *  upserted by id. List stays sorted ascending by date. */
function applyRealtimeRow(row: DbChatMessageRow): void {
  const incoming: ChatMessage = dbRowToChatMessage(row);
  // Capture whether this id is new BEFORE we mutate the slice — used by
  // bumpParentFromMessage to decide whether to increment unread_count.
  const prevState = useAppStore.getState();
  const wasKnown = (prevState.chatMessages[row.chat_wid] ?? []).some((m) => m.id === row.id);
  useAppStore.setState((s) => {
    const existing = s.chatMessages[row.chat_wid] ?? [];
    const kept: ChatMessage[] = [];
    const incomingKey = identityKey(incoming);
    for (const m of existing) {
      // Dedupe on reference match — handles BOTH cases:
      //  a) pending optimistic placeholder still present (pre-ack)
      //  b) post-ack message whose id came from POST /messages (Haberchat
      //     `id`) but the webhook echoes with a different WhatsApp-style
      //     wid (`3EB0...`). Without this dedupe by reference the row
      //     would be added as a second bubble.
      if (row.reference && (m.reference === row.reference || m.client_id === row.reference)) continue;
      // Same physical message under the other addressing mode (`@lid` vs
      // `@c.us`). Reference dedupe cannot catch this — WAHA has no send-time
      // reference at all — so match on the stable identity instead.
      if (identityKey(m) === incomingKey) continue;
      kept.push(m);
    }
    // The realtime row is the freshest view of that message, so it leads.
    const merged = mergeMessageSources([incoming], kept);
    return { chatMessages: { ...s.chatMessages, [row.chat_wid]: merged } };
  });
  // Also bump the parent conversation record so the ChatList reflects
  // new activity without a full refresh.
  bumpParentFromMessage(row, wasKnown);
}

/** Update the chats record's last_message_at / last_message_preview /
 *  unread_count in local state from an incoming chat_messages row. Skips
 *  if the incoming is older than what we already show. Unread only
 *  increments on NEW inbound rows (not on UPDATEs to existing rows like
 *  ack progression). */
function bumpParentFromMessage(row: DbChatMessageRow, wasKnown: boolean): void {
  // A REACTION must never steal the conversation preview or raise an unread
  // badge — a customer reacting 👍 is not "sent a message awaiting a reply".
  // The webhook already skips the durable bump; this is the browser-side twin
  // (without it the emoji showed up as the chat's title/preview, live 2026-07-19).
  if (row.kind === 'reaction') return;
  useAppStore.setState((s) => {
    const chatsModel = s.models.find((m) => m.name === 'chats');
    if (!chatsModel) return s;
    const list = s.records[chatsModel.id] ?? [];
    const idx = list.findIndex(
      (r) => ((r.data as Record<string, unknown>).wid as string | undefined) === row.chat_wid,
    );
    const rec = list[idx];
    if (!rec) return s;
    const data = rec.data as Record<string, unknown>;
    const curAt = (data.last_message_at as string | undefined) ?? '';
    const curPreview = (data.last_message_preview as string | null | undefined) ?? null;
    const curUnread = typeof data.unread_count === 'number' ? data.unread_count : 0;
    const isNewer = !curAt || row.date > curAt;
    const nextUnread = row.flow === 'in' && !wasKnown ? curUnread + 1 : curUnread;
    // Auto-reopen: a customer message into a closed conversation reopens it
    // locally right away. The webhook does the durable side (record write +
    // Haberchat PATCH); this just avoids waiting for that echo.
    const curStatus = typeof data.status === 'string' ? data.status : 'active';
    const reopen = isNewer && row.flow === 'in' && (curStatus === 'resolved' || curStatus === 'archived');

    // Opportunistic client link — when the chat isn't currently attached
    // to a LIVE client. A stale `client_link` UUID pointing at a since-
    // deleted client is treated as unlinked so a freshly-created client
    // with the same phone can pick the chat up.
    let clientLinkPatch: { client_link: string } | null = null;
    const clientsModel = s.models.find((m) => m.name === 'clients');
    const clients = clientsModel ? (s.records[clientsModel.id] ?? []) : [];
    if (!isLiveClient(data.client_link, clients)) {
      const slugs = phoneFieldSlugs(clientsModel);
      const link = resolveClientLink(data.phone as string | null | undefined, clients, slugs);
      if (link) clientLinkPatch = { client_link: link };
    }

    if (!isNewer && nextUnread === curUnread && !clientLinkPatch && !reopen) return s;
    const nextData = {
      ...data,
      last_message_at: isNewer ? row.date : curAt,
      last_message_preview: isNewer ? (row.body ? row.body.slice(0, 120) : curPreview) : curPreview,
      // Direction of the newest message — the Chats list's "needs reply"
      // filter reads this ('in' = the customer spoke last).
      last_message_flow: isNewer ? row.flow : (data.last_message_flow ?? null),
      unread_count: nextUnread,
      ...(reopen ? { status: 'active' } : {}),
      ...(clientLinkPatch ?? {}),
    };
    const nextList = [...list];
    nextList[idx] = { ...rec, data: nextData, updated_at: new Date().toISOString() };
    return { records: { ...s.records, [chatsModel.id]: nextList } };
  });
}

/** Module-scope singleton: one global Realtime channel across the app,
 *  created on first subscribeToAllChats() call and torn down by
 *  unsubscribeFromAllChats(). Keeps React state free of non-serializable
 *  Supabase handles. */
let globalChatsChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;

/** In-flight composer sends, keyed by (chat|body|attachment) → idempotency key.
 *  See sendChatMessage: this is what makes a double-click one message. */
const inFlightSends = new Map<string, string>();

/**
 * Sweep every unlinked chat and try to link it to a client. Called from
 * saveRecord when the user saves a clients record (new or edit) so a
 * freshly-created client immediately gets attached to any matching
 * existing conversation. Never overwrites existing links.
 *
 * Uses setState + a batched Supabase upsert per changed chat row so the
 * UI updates in one frame and the server sees the linked fields on the
 * next reload.
 */
function relinkChatsAgainstClients(): void {
  const state = useAppStore.getState();
  const chatsModel = state.models.find((m) => m.name === 'chats');
  const clientsModel = state.models.find((m) => m.name === 'clients');
  if (!chatsModel || !clientsModel) return;
  const chats = state.records[chatsModel.id] ?? [];
  const clients = state.records[clientsModel.id] ?? [];
  const slugs = phoneFieldSlugs(clientsModel);
  if (slugs.length === 0 || clients.length === 0 || chats.length === 0) return;

  const patched: AppRecord[] = [];
  const next = chats.map((rec) => {
    const data = rec.data as Record<string, unknown>;
    // Skip only when already linked to a LIVE client. A dangling
    // `client_link` (target client was deleted) is treated as unlinked
    // so the sweep can attach the chat to whoever owns the phone now.
    if (isLiveClient(data.client_link, clients)) return rec;
    const link = resolveClientLink(data.phone as string | null | undefined, clients, slugs);
    if (!link || link === data.client_link) return rec;
    const updated = { ...rec, data: { ...data, client_link: link }, updated_at: new Date().toISOString() };
    patched.push(updated);
    return updated;
  });

  if (patched.length === 0) return;

  useAppStore.setState((s) => {
    const records = { ...s.records, [chatsModel.id]: next };
    saveLocalRecordsForModel(chatsModel.id, next);
    return { records };
  });

  for (const rec of patched) {
    void supabaseUpsert('records', rec, {
      table: 'models',
      id: rec.model_id,
    });
  }
}

// --- Store ---

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  models: [],
  groups: [],
  records: {},
  workflows: [],
  workflowGroups: [],
  workflowRuns: [],
  serverEnrolledModelIds: new Set<string>(),
  activityLog: loadLocal<ActivityLogEntry[]>('wassell_activity_log') ?? [],
  dashboards: [],
  metricDefinitions: [],
  scheduledReports: [],
  salesProcessOverrides: [],
  salesProcesses: [],
  salesProcessVersions: [],
  salesExperiments: [],
  clientSalesProcessAssignments: [],
  chatComposerTarget: null,
  views: [],
  users: [],
  profiles: [],
  roles: [],
  fieldTemplates: [],
  waDevices: [],
  waDevicesLive: [],
  chatMessages: {},
  webhookSlugs: [],
  webhookPayloads: [],
  whiteboards: [],
  whiteboardFolders: [],
  currentUserId: loadLocal<string>('wassell_current_user_id') ?? null,
  // Profile-preview override ("view app as"). Persisted so a reload keeps
  // the preview; the permission layer ignores it unless the current user
  // carries `can_preview_profiles`, so a stale value is inert.
  previewProfileId: loadLocal<string>('wassell_preview_profile_id') || null,
  authEmail: null,
  authUid: null,
  authReady: false,
  language: (loadLocal<Language>('wassell_language') ?? 'ar'),
  toasts: [],
  recordNavContext: null,
  mapsViewState: {},
  initialized: false,
  criticalDataReady: false,
  // Phase E.2: empty paginated cache. First loadRecordsPage call per
  // (modelId, filterKey) populates this lazily — never blocks init.
  recordsByModel: {} as PaginatedRecordsByModel,
  // Background slim-full-load state for SUMMARY models (market_listings).
  // Populated by loadSummaryRecords after boot.
  summaryLoadState: {},

  // --- Initialize ---
  initialize: async () => {
    if (get().initialized) return;
    // Phase G.2: install the __wasselPerf() debug global early so any
    // marks emitted during init are observable from the console.
    installPerfMarkers();
    markEvent('init:start');

    // Wire the Supabase error reporter to push user-visible toasts. We do
    // this lazily (here, not at module scope) because `useAppStore` isn't
    // defined until the `create()` call below finishes — pulling from it
    // at module load time would be `undefined`.
    reportSupabaseError = (table, op, msg) => {
      console.error(`[supabase] ${op} failed on ${table}: ${msg}`);
      try {
        useAppStore.getState().addToast(
          `Server sync failed (${table}): ${msg}`,
          'error',
        );
      } catch {
        // addToast unavailable — already logged to console above.
      }
    };

    // Drain the pending-writes queue BEFORE any supabaseLoad. If we read
    // from Supabase first, those reads would clobber localStorage with state
    // that's missing the unsynced edits the user made in the previous
    // session. Replaying first lets every queued write land before we trust
    // Supabase as the source of truth. No-op when the queue is empty or
    // the user isn't signed in yet.
    await replayPendingWrites();

    // Phase D.3: capture wall-clock BEFORE the loads start. Any row
    // updated AFTER this timestamp will be picked up by the next
    // stale-while-revalidate sweep on focus/online; the merge
    // handler's stale-dedup harmlessly skips rows we already have.
    const loadsStartedAtIso = new Date().toISOString();

    // ─────────────────────────────────────────────────────────────────
    // Phase D.1: PARALLEL LOAD KICKOFF
    // ─────────────────────────────────────────────────────────────────
    // Fire every Supabase read up-front so they run concurrently across
    // the network. Each `await xP` below resolves with the same shape as
    // a direct `supabaseLoad` — only the wall-clock cost changes (one
    // round-trip total instead of N sequential ones).
    //
    // Reads have NO FK ordering — SELECT queries don't depend on each
    // other. The FK ordering for BACKFILL upserts (groups before models,
    // profiles before users) is preserved by the awaits later in this
    // function: those still happen serially.
    //
    // Boot time on a 200ms-RTT link drops from ~3000ms to ~250ms.
    // Re-instrument via performance.mark()/measure() (Phase G.2).
    performance.mark('wassell:init:loads:start');
    const groupsP            = supabaseLoad<ModelGroup>('model_groups');
    const modelsP            = supabaseLoad<AppModel>('models');
    // Large models (summary + lazy) must never enter the boot payload —
    // their rows would bloat the main records tail that gates clients /
    // followups / units. We need the model list to map name → id, so the
    // unified-records load awaits modelsP first (the other parallel loads
    // are unaffected — modelsP itself is already in flight above). When
    // models fail to load we exclude nothing (fail-safe). Summary models'
    // slim full set is background-loaded after `initialized` (see below).
    const unifiedRecordsP    = (async () => {
      const loadedModels = await modelsP;
      const excludeModelIds = loadedModels ? bootExcludedModelIds(loadedModels) : [];
      return supabaseLoad<AppRecord>('unified_records', { excludeModelIds });
    })();
    const workflowsP         = supabaseLoad<Workflow>('workflows');
    const workflowGroupsP    = (async () => {
      // Tolerate the table not existing yet on older installs that haven't
      // run the latest schema migration — same defensive try/catch the
      // serial version had.
      try { return await supabaseLoad<WorkflowGroup>('workflow_groups'); }
      catch { return null; }
    })();
    // Only the most-recent runs are loaded into memory — the full history grew to
    // 114 MB and every consumer (the Logs list) only needs recent ones; an older
    // deep-linked run is fetched on demand by WorkflowRunDetailPage. Mirrors the
    // activity_log cap below. (Newest-first + limit is a server-side top-N, so the
    // heavy older rows never travel to the browser.)
    const WORKFLOW_RUNS_BOOT_LIMIT = 500;
    const workflowRunsP      = (async () => {
      if (!supabase) return null;
      const { data, error } = await supabase
        .from('workflow_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(WORKFLOW_RUNS_BOOT_LIMIT);
      if (error) { reportSupabaseError('workflow_runs', 'load', error.message ?? String(error)); return null; }
      return (data as WorkflowRun[] | null);
    })();
    const activityLogP       = (async () => {
      if (!supabase) return null;
      const { data, error } = await supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      return error ? null : (data as ActivityLogEntry[] | null);
    })();
    const dashboardsP        = supabaseLoad<Dashboard>('dashboards');
    const metricDefinitionsP = supabaseLoad<MetricDefinition>('metric_definitions');
    const scheduledReportsP  = supabaseLoad<ScheduledReport>('scheduled_reports');
    const salesProcessOverridesP = supabaseLoad<SalesProcessOverride>('sales_process_overrides');
    const salesProcessesP = supabaseLoad<SalesProcess>('sales_processes');
    const salesProcessVersionsP = supabaseLoad<SalesProcessVersion>('sales_process_versions');
    const salesExperimentsP = supabaseLoad<SalesExperiment>('sales_experiments');
    const clientSalesProcessAssignmentsP = supabaseLoad<ClientSalesProcessAssignment>('client_sales_process_assignments');
    const whiteboardFoldersP = supabaseLoad<WhiteboardFolder>('whiteboard_folders');
    const whiteboardsP       = supabaseLoad<Whiteboard>('whiteboards');
    const viewsP             = supabaseLoad<ModelView>('model_views');
    const profilesP          = supabaseLoad<Profile>('profiles');
    const rolesP             = supabaseLoad<Role>('roles');
    const usersP             = supabaseLoad<User>('users');
    const fieldTemplatesP    = supabaseLoad<FieldTemplate>('field_templates');
    const webhookSlugsP      = supabaseLoad<WebhookSlug>('webhook_slugs');

    // ORDER MATTERS for backfills (NOT loads): groups must be persisted to
    // Supabase BEFORE models, because `models.group_id` is a foreign key to
    // `model_groups.id`. If we upsert models first, Postgres rejects them
    // with a FK violation that our silent-fail error handler swallows —
    // leaving some models missing from Supabase while others (those without
    // a group_id) slip through.

    // --- Groups ---
    // Load groups with cascading fallback: Supabase → localStorage → SEED.
    const supabaseGroups = await groupsP;
    let groups: ModelGroup[];
    if (supabaseGroups && supabaseGroups.length > 0) {
      groups = supabaseGroups;
    } else {
      const localGroups = loadLocal<ModelGroup[]>('wassell_groups');
      groups = localGroups && localGroups.length > 0 ? localGroups : SEED_GROUPS;
    }

    // Union with SEED_GROUPS by id — catches returning users whose stored
    // groups predate a newly-added seed group (e.g. the Marketing group
    // added in phase 3A). Without this, models that reference the new
    // group's id fail Postgres's models_group_id_fkey on insert.
    {
      const existingGroupIds = new Set(groups.map((g) => g.id));
      const seedExtras = SEED_GROUPS.filter((g) => !existingGroupIds.has(g.id));
      if (seedExtras.length > 0) {
        groups = [...groups, ...seedExtras];
      }
    }
    saveLocal('wassell_groups', groups);

    // Backfill any missing groups, and AWAIT — models depend on these existing
    // in Supabase before their FK-bearing rows can land.
    if (supabaseGroups !== null) {
      const existingGroupIds = new Set(supabaseGroups.map((g) => g.id));
      const missingGroups = groups.filter((g) => !existingGroupIds.has(g.id));
      if (missingGroups.length > 0) {
        await Promise.all(
          missingGroups.map((g) =>
            supabaseUpsert('model_groups', g),
          ),
        );
      }
    }

    // --- Models ---
    // Three cascading sources: Supabase → localStorage → SEED. After loading,
    // backfill any system models missing from Supabase (matched by `name`,
    // which is UNIQUE in the schema) so subsequent loads see the full set.
    const supabaseModels = await modelsP;
    let models: AppModel[];
    if (supabaseModels && supabaseModels.length > 0) {
      models = supabaseModels;
    } else {
      const localModels = loadLocal<AppModel[]>('wassell_models');
      models = localModels && localModels.length > 0 ? localModels : SEED_MODELS;
    }
    if (supabaseModels !== null) {
      const existingNames = new Set(supabaseModels.map((m) => m.name));
      const missing = SEED_MODELS.filter((m) => !existingNames.has(m.name));
      if (missing.length > 0) {
        // Avoid in-memory duplicates: only add seeds whose name isn't already
        // in the merged `models` array (e.g. from localStorage fallback).
        const currentNames = new Set(models.map((m) => m.name));
        const toAdd = missing.filter((m) => !currentNames.has(m.name));
        models = [...models, ...toAdd];
        // Await the upserts — if the user navigates or reloads immediately, we
        // want the writes to land. Groups already exist (above), so no FK trap.
        await Promise.all(
          missing.map((m) =>
            supabaseUpsert('models', m),
          ),
        );
      }
    }
    saveLocal('wassell_models', models);

    // ─── Phase D.2: chrome-critical loads first ──────────────
    // The variables declared below (records, workflowRuns, activityLog,
    // whiteboardFolders, whiteboards) are populated in the SLOW TAIL
    // block further down, AFTER `criticalDataReady` is set. Declaring
    // them here keeps them in scope for the migrations + final set
    // without forcing the chrome to wait on the slow loads.
    let records: Record<string, AppRecord[]> = {};
    let workflowRuns: WorkflowRun[] = [];
    let activityLog: ActivityLogEntry[] = [];
    let whiteboardFolders: WhiteboardFolder[] = [];
    let whiteboards: Whiteboard[] = [];

    // Load workflows (chrome-critical: needed by the seed marketing
    // workflows block below + by the workflow-list page in the sidebar).
    let workflows = await workflowsP;
    if (!workflows) workflows = loadLocal<Workflow[]>('wassell_workflows') ?? [];
    saveLocal('wassell_workflows', workflows);

    // Workflow folders (chrome — sidebar grouping).
    let workflowGroups: WorkflowGroup[] = [];
    const loadedWorkflowGroups = await workflowGroupsP;
    workflowGroups = loadedWorkflowGroups ?? loadLocal<WorkflowGroup[]>('wassell_workflow_groups') ?? [];
    saveLocal('wassell_workflow_groups', workflowGroups);

    // Dashboards (chrome — sidebar dashboard list).
    let dashboards = await dashboardsP;
    if (!dashboards) dashboards = loadLocal<Dashboard[]>('wassell_dashboards') ?? [];
    saveLocal('wassell_dashboards', dashboards);

    let metricDefinitions = await metricDefinitionsP;
    if (!metricDefinitions) metricDefinitions = loadLocal<MetricDefinition[]>('wassell_metric_definitions') ?? [];
    saveLocal('wassell_metric_definitions', metricDefinitions);

    let scheduledReports = await scheduledReportsP;
    if (!scheduledReports) scheduledReports = loadLocal<ScheduledReport[]>('wassell_scheduled_reports') ?? [];
    saveLocal('wassell_scheduled_reports', scheduledReports);

    let salesProcessOverrides = await salesProcessOverridesP;
    if (!salesProcessOverrides) salesProcessOverrides = loadLocal<SalesProcessOverride[]>('wassell_sales_process_overrides') ?? [];
    saveLocal('wassell_sales_process_overrides', salesProcessOverrides);

    let salesProcesses = await salesProcessesP;
    if (!salesProcesses) salesProcesses = loadLocal<SalesProcess[]>('wassell_sales_processes') ?? [];
    saveLocal('wassell_sales_processes', salesProcesses);
    let salesProcessVersions = await salesProcessVersionsP;
    if (!salesProcessVersions) salesProcessVersions = loadLocal<SalesProcessVersion[]>('wassell_sales_process_versions') ?? [];
    saveLocal('wassell_sales_process_versions', salesProcessVersions);
    let salesExperiments = await salesExperimentsP;
    if (!salesExperiments) salesExperiments = loadLocal<SalesExperiment[]>('wassell_sales_experiments') ?? [];
    saveLocal('wassell_sales_experiments', salesExperiments);
    let clientSalesProcessAssignments = await clientSalesProcessAssignmentsP;
    if (!clientSalesProcessAssignments) clientSalesProcessAssignments = loadLocal<ClientSalesProcessAssignment[]>('wassell_client_sales_process_assignments') ?? [];
    saveLocal('wassell_client_sales_process_assignments', clientSalesProcessAssignments);

    // Saved table views (chrome — view selector on each model page).
    let views = await viewsP;
    if (!views) views = loadLocal<ModelView[]>('wassell_views') ?? [];
    saveLocal('wassell_views', views);

    // --- Profiles ---
    // Cascading fallback: Supabase → localStorage → SEED. Same pattern as
    // models/groups. Users FK into profiles via `profile_id`, so we AWAIT
    // the profile backfill before moving on to users below.
    const supabaseProfiles = await profilesP;
    let profiles: Profile[];
    if (supabaseProfiles && supabaseProfiles.length > 0) {
      profiles = supabaseProfiles;
    } else {
      const localProfiles = loadLocal<Profile[]>('wassell_profiles');
      profiles = localProfiles && localProfiles.length > 0 ? localProfiles : SEED_PROFILES;
    }

    // Backfill is_system / is_admin for existing localStorage installs upgraded
    // from a version that didn't have these flags. Idempotent: re-running is a
    // no-op once flags exist.
    profiles = profiles.map((p) => ({
      ...p,
      is_system: typeof p.is_system === 'boolean' ? p.is_system : false,
      is_admin: typeof p.is_admin === 'boolean' ? p.is_admin : false,
    }));
    // If no profile has is_admin, promote the most-likely candidate to avoid
    // locking out existing users on upgrade. Order: label match → full-perms
    // match → first profile.
    if (!profiles.some((p) => p.is_admin)) {
      const byLabel = profiles.findIndex((p) => p.label_en === 'Administrator' || p.label_ar === 'مدير النظام');
      const byPerms = profiles.findIndex((p) =>
        p.model_permissions.length > 0 &&
        p.model_permissions.every((mp) => ['view', 'create', 'edit', 'delete', 'import', 'export'].every((x) => mp.permissions.includes(x as never))),
      );
      const promoteIdx = byLabel >= 0 ? byLabel : byPerms >= 0 ? byPerms : 0;
      profiles = profiles.map((p, i) => (i === promoteIdx ? { ...p, is_admin: true, is_system: true } : p));
    }
    saveLocal('wassell_profiles', profiles);
    // Backfill missing profiles to Supabase and AWAIT — users FK into profiles.
    // Dedupe by id AND (for system seeds) by label: a DB restore/branch/backup-copy
    // can leave a seed under a DRIFTED id, and id-only matching would then re-insert
    // the seed as a label duplicate (this happened on prod — see the 2026-06-16
    // dedup migration). When a same-label system row already exists we ADOPT it
    // instead of inserting, which also keeps the app from tripping the DB-level
    // `profiles_system_label_uniq` guard. Scoped to is_system so user-created
    // same-label profiles (e.g. several "New Profile" rows) are never collapsed.
    if (supabaseProfiles !== null) {
      const existingProfileIds = new Set(supabaseProfiles.map((p) => p.id));
      const existingSystemProfileLabels = new Set(
        supabaseProfiles
          .filter((p) => p.is_system)
          .map((p) => (p.label_en ?? '').trim().toLowerCase())
          .filter(Boolean),
      );
      const missingProfiles = profiles.filter((p) => {
        if (existingProfileIds.has(p.id)) return false;
        if (p.is_system && existingSystemProfileLabels.has((p.label_en ?? '').trim().toLowerCase())) {
          return false; // adopt the existing same-label seed; don't duplicate it
        }
        return true;
      });
      if (missingProfiles.length > 0) {
        await Promise.all(
          missingProfiles.map((p) =>
            supabaseUpsert('profiles', p),
          ),
        );
      }
    }

    // --- Roles ---
    // Cascading fallback: Supabase → localStorage → SEED.
    const supabaseRoles = await rolesP;
    let roles: Role[];
    if (supabaseRoles && supabaseRoles.length > 0) {
      roles = supabaseRoles;
    } else {
      const localRoles = loadLocal<Role[]>('wassell_roles');
      roles = localRoles && localRoles.length > 0 ? localRoles : SEED_ROLES;
    }
    // Backfill + migrate legacy `field_definitions` flat list → `schema.sections`.
    // Legacy shape: { field_definitions: [...] }. New shape: { schema: { sections: [{ fields: [...] }] } }.
    // Idempotent: if schema already exists, leave it alone.
    roles = roles.map((r) => {
      type LegacyRoleField = {
        id: string; name: string; label_ar: string; label_en: string;
        type: string; order: number;
        options?: unknown[]; lookup_model_id?: string | null; lookup_display_field?: string | null;
      };
      const legacy = r as unknown as { field_definitions?: LegacyRoleField[]; schema?: Role['schema'] };
      let schema = legacy.schema;
      if (!schema) {
        const sectionId = uuid();
        const legacyFields = legacy.field_definitions ?? [];
        schema = {
          sections: [
            {
              id: sectionId,
              label_ar: 'عام',
              label_en: 'General',
              order: 0,
              is_base: true,
              color: '#B8734F',
              fields: legacyFields.map((f, i) => ({
                id: f.id,
                name: f.name,
                label_ar: f.label_ar,
                label_en: f.label_en,
                type: f.type as never,
                required: false,
                order: typeof f.order === 'number' ? f.order : i,
                section_id: sectionId,
                width: 'half',
                show_in_table: true,
                options: f.options as never,
                lookup_model_id: f.lookup_model_id ?? null,
                lookup_display_field: f.lookup_display_field ?? null,
              })),
            },
          ],
          section_selector_field_id: null,
        };
      }
      return {
        id: r.id,
        label_ar: r.label_ar,
        label_en: r.label_en,
        schema,
        is_system: typeof r.is_system === 'boolean' ? r.is_system : false,
        // Preserve the engine namespace (sales / marketing / intel); absent
        // legacy rows read as 'sales' so the Sales pickers keep showing them.
        domain: r.domain ?? 'sales',
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
    saveLocal('wassell_roles', roles);
    // Backfill missing roles to Supabase. No FK dependents — fire-and-forget OK.
    // Same id-AND-label dedupe as profiles above: skip a system seed whose label
    // already exists under a drifted id (restore/branch), so we adopt it rather
    // than re-inserting a duplicate and tripping `roles_system_label_uniq`.
    if (supabaseRoles !== null) {
      const existingRoleIds = new Set(supabaseRoles.map((r) => r.id));
      const existingSystemRoleLabels = new Set(
        supabaseRoles
          .filter((r) => r.is_system)
          .map((r) => (r.label_en ?? '').trim().toLowerCase())
          .filter(Boolean),
      );
      for (const r of roles) {
        if (existingRoleIds.has(r.id)) continue;
        if (r.is_system && existingSystemRoleLabels.has((r.label_en ?? '').trim().toLowerCase())) {
          continue; // adopt the existing same-label seed; don't duplicate it
        }
        supabaseUpsert('roles', r);
      }
    }

    // --- Users ---
    // Cascading fallback: Supabase → localStorage → SEED. Profiles are already
    // in Supabase (we awaited them above), so user FK writes are safe.
    const supabaseUsers = await usersP;
    let users: User[];
    if (supabaseUsers && supabaseUsers.length > 0) {
      users = supabaseUsers;
    } else {
      const localUsers = loadLocal<User[]>('wassell_users');
      users = localUsers && localUsers.length > 0 ? localUsers : SEED_USERS;
    }
    saveLocal('wassell_users', users);
    // Backfill missing users to Supabase, each gated on its profile being
    // present (helper checks pendingWrites; profiles already landed).
    if (supabaseUsers !== null) {
      const existingUserIds = new Set(supabaseUsers.map((u) => u.id));
      for (const u of users) {
        if (!existingUserIds.has(u.id)) {
          supabaseUpsert(
            'users',
            u,
            { table: 'profiles', id: u.profile_id },
          );
        }
      }
    }

    // --- Field templates ---
    // User-created; no seed. Just load and mirror localStorage.
    let fieldTemplates = await fieldTemplatesP;
    if (!fieldTemplates) fieldTemplates = loadLocal<FieldTemplate[]>('wassell_field_templates') ?? [];
    saveLocal('wassell_field_templates', fieldTemplates);

    // --- Webhook inbox (user-declared inbound endpoints) ---
    let webhookSlugs = await webhookSlugsP;
    if (!webhookSlugs) webhookSlugs = loadLocal<WebhookSlug[]>('wassell_webhook_slugs') ?? [];
    saveLocal('wassell_webhook_slugs', webhookSlugs);

    // Mark end of the parallel load phase. With 200ms RTT and 16 loads,
    // expected duration drops from ~3000ms (serial) to ~250ms (parallel).
    performance.mark('wassell:init:loads:end');
    try {
      performance.measure('wassell:init:loads', 'wassell:init:loads:start', 'wassell:init:loads:end');
    } catch { /* perf API quirks — never block init on telemetry */ }

    // WhatsApp device overlay — load eagerly at boot (fire-and-forget so it
    // never blocks init). Until now `waDevices` was populated ONLY when the
    // user opened Settings → WhatsApp Numbers (or the Workflow editor's device
    // picker). Every other send entry point — the Chats composer, the
    // Follow-up Workspace's in-app WhatsApp composer, the record WhatsApp
    // panel, workflow-triggered sends — reads `waDevices` to resolve the
    // send-from device, so opening one of those in a fresh session (before
    // visiting Settings) left the overlay empty and the device-resolution
    // fallback chain bottomed out at '' → the user-facing "No WhatsApp device
    // configured" error, even when the DB had a correct default. Loading here
    // makes the default device available app-wide from the first render.
    // `loadWhatsAppNumbers` sets the overlay first, then best-effort fetches
    // the live Haberchat device list (`waDevicesLive`, used as the
    // self-healing last-resort fallback); a live-fetch failure is non-fatal
    // because the overlay is already in place.
    void get().loadWhatsAppNumbers().catch((err) => {
      console.warn('[init] WhatsApp device overlay load failed (non-fatal):', err);
    });

    // ────────────────────────────────────────────────────────────────────
    // Resolve the current user based on auth state.
    //
    // Three cases:
    //   A. Auth IS configured AND user is signed in → find the app user by
    //      email. If no match and this is a fresh install (only seed admin
    //      present), adopt the seed admin's email to the signed-in address
    //      so the first admin sign-in is frictionless. Otherwise leave
    //      currentUserId null; the sign-in succeeds but the user sees an
    //      access-denied state until an admin provisions them in Users.
    //   B. Auth IS configured AND user is NOT signed in → clear currentUserId
    //      so nothing leaks through; the App-level RequireAuth gate will
    //      redirect to /login before any UI renders.
    //   C. Auth is NOT configured (local-only / dev mode) → keep the legacy
    //      "first user in the list" fallback so the app works offline.
    // ────────────────────────────────────────────────────────────────────
    let currentUserId = get().currentUserId;
    const authEmail = get().authEmail;
    const authUid = get().authUid;
    const authConfigured = isAuthAvailable();

    // Helper: persist auth_uid back to the users row the first time we see
    // it. RLS policies key off this column; without it every authenticated
    // query returns an empty set. Idempotent — re-runs are no-ops once set.
    //
    // Implementation note (fixes the 2026-05-06 regression):
    // We DELIBERATELY do not call supabaseUpsert here, even though the
    // local user object has auth_uid populated. The users_write RLS
    // policy is `USING (wassell_is_admin(...) OR users.auth_uid = ...)`,
    // and for a brand-new invited user both legs evaluate to false
    // against the OLD row (NULL auth_uid + not yet admin), so PostgREST
    // silently filters the UPDATE to zero rows. Instead we call the
    // SECURITY DEFINER RPC `bind_my_auth_uid()` which runs as the
    // function owner and bypasses RLS, with its own guards (NULL slot
    // only, email match against the JWT, is_active = true). See
    // supabase/migrations/2026-05-24_bind_my_auth_uid.sql.
    const bindAuthUidToUser = async (user: User): Promise<User> => {
      if (!authUid || user.auth_uid === authUid) return user;
      // No Supabase client → local-only mode; just mirror the bind
      // into the in-memory store so frontend permission checks still
      // resolve. RLS isn't in play here.
      if (!supabase) {
        const localOnly: User = {
          ...user,
          auth_uid: authUid,
          updated_at: new Date().toISOString(),
        };
        users = users.map((u) => (u.id === localOnly.id ? localOnly : u));
        saveLocal('wassell_users', users);
        return localOnly;
      }
      const { data: boundId, error } = await supabase.rpc('bind_my_auth_uid');
      if (error) {
        reportSupabaseError('users', 'rpc', `bind_my_auth_uid: ${error.message ?? String(error)}`);
        // Don't return early — keep the local mirror so the rest of
        // initialize() can resolve currentUserId. Records will still be
        // empty until the bind succeeds on a future load, but at least
        // the sidebar / chrome render with the right identity.
        const localMirror: User = {
          ...user,
          auth_uid: authUid,
          updated_at: new Date().toISOString(),
        };
        users = users.map((u) => (u.id === localMirror.id ? localMirror : u));
        saveLocal('wassell_users', users);
        return localMirror;
      }
      // boundId === null means the JWT email had no match in public.users.
      // That's an access-denied condition the caller already handles by
      // setting currentUserId = null further down — nothing extra to do
      // here. If boundId is set, the row now has auth_uid bound in
      // Supabase; mirror that into the local store so the rest of the
      // session is consistent without waiting for a realtime echo.
      const updated: User = {
        ...user,
        auth_uid: authUid,
        updated_at: new Date().toISOString(),
      };
      users = users.map((u) => (u.id === updated.id ? updated : u));
      saveLocal('wassell_users', users);
      // Mark the row as recently-written so the realtime echo from the
      // RPC's UPDATE doesn't trigger a redundant local refresh.
      markRecentlyWritten('users', updated.id, updated.updated_at);
      void boundId; // returned for diagnostic / future use
      return updated;
    };

    if (authConfigured && authEmail) {
      const needle = authEmail.toLowerCase();
      const match = users.find((u) => (u.email ?? '').toLowerCase() === needle);
      if (match) {
        // Deactivation enforcement at sign-in. RLS already gates the data
        // (helpers require is_active = true), but a deactivated user could
        // otherwise stay signed in viewing an empty workspace forever. Sign
        // them out cleanly so the login page shows.
        if (match.is_active === false) {
          // Don't await — fire-and-forget so initialize() returns. The
          // onAuthChange callback in bindAuth will fire once Supabase
          // clears the session and tear down the rest of the state.
          void authSignOut();
          set({ currentUserId: null, authEmail: null, authUid: null, initialized: true });
          // Surface the reason — without this the user just sees the
          // login page and assumes their password is wrong.
          get().addToast(
            get().language === 'ar'
              ? 'حسابك معطّل — تواصل مع المسؤول للتفعيل.'
              : 'Your account is disabled — contact an administrator to reactivate it.',
            'error',
          );
          return;
        }
        const bound = await bindAuthUidToUser(match);
        currentUserId = bound.id;
      } else {
        // Bootstrap: if the only existing user is the default seed admin,
        // rewrite its email to match the signed-in address. This turns the
        // first-ever sign-in into a one-click admin adoption.
        const SEED_ADMIN_EMAIL = 'admin@wassel.sa';
        const seedAdmin = users.find((u) => u.email === SEED_ADMIN_EMAIL);
        const isBootstrap = users.length === 1 && seedAdmin !== undefined;
        if (isBootstrap && seedAdmin) {
          const adopted: User = {
            ...seedAdmin,
            email: authEmail,
            // Bind auth_uid in the same write so the very first save lands
            // both fields atomically — no half-bound state for RLS to trip on.
            auth_uid: authUid ?? seedAdmin.auth_uid ?? null,
            updated_at: new Date().toISOString(),
          };
          users = users.map((u) => (u.id === adopted.id ? adopted : u));
          saveLocal('wassell_users', users);
          supabaseUpsert(
            'users',
            adopted,
            { table: 'profiles', id: adopted.profile_id },
          );
          currentUserId = adopted.id;
        } else {
          // No match and not bootstrap → access-denied state. currentUserId stays
          // null so permissions checks fail closed. The user can sign out from
          // the header and retry with a different account.
          currentUserId = null;
        }
      }
      saveLocal('wassell_current_user_id', currentUserId ?? '');
    } else if (authConfigured && !authEmail) {
      // Signed out but auth IS configured — don't pick a default user.
      currentUserId = null;
      saveLocal('wassell_current_user_id', '');
    } else {
      // Local/dev mode — legacy behavior.
      if (!currentUserId && users.length > 0) {
        currentUserId = users[0]!.id;
        saveLocal('wassell_current_user_id', currentUserId);
      }
    }

    // ─── Phase D.2: chrome can render NOW ─────────────────────
    // All chrome-critical data is loaded and the user is resolved.
    // Push the partial state so the sidebar, header, and per-page
    // skeletons can paint with real data while the slow tail
    // (records, workflow_runs, whiteboards, activity_log) finishes
    // in the background. Pages that need records gate on `initialized`.
    set({
      models, groups, profiles, roles, users, views, dashboards, metricDefinitions, scheduledReports,
      salesProcessOverrides,
      salesProcesses, salesProcessVersions, salesExperiments, clientSalesProcessAssignments,
      fieldTemplates, webhookSlugs, workflowGroups, workflows,
      currentUserId, criticalDataReady: true,
    });
    markEvent('init:critical-ready');
    try { performance.measure('wassell:init:critical', 'wassell:init:start', 'wassell:init:critical-ready'); }
    catch { /* perf API quirk — never block init on telemetry */ }

    // ─── Phase D.2: slow tail ─────────────────────────────────
    // These loads were kicked off in parallel at the top of init();
    // awaiting them here only blocks the rest of init(), not chrome.
    // Variables were declared earlier so they remain in scope for
    // the migrations and final set below.
    const supabaseRecords = await unifiedRecordsP;
    if (supabaseRecords) {
      records = {};
      for (const rec of supabaseRecords) {
        if (!records[rec.model_id]) records[rec.model_id] = [];
        records[rec.model_id]!.push(rec);
      }
    } else {
      records = loadLocalRecordsMap();
    }
    saveLocalRecordsMap(records);

    const loadedWorkflowRuns = await workflowRunsP;
    workflowRuns = loadedWorkflowRuns ?? loadLocal<WorkflowRun[]>('wassell_workflow_runs') ?? [];
    saveLocal('wassell_workflow_runs', workflowRuns);

    const activityLogData = await activityLogP;
    if (activityLogData && activityLogData.length > 0) activityLog = activityLogData;
    if (activityLog.length === 0) {
      activityLog = loadLocal<ActivityLogEntry[]>('wassell_activity_log') ?? [];
    }
    saveLocal('wassell_activity_log', activityLog.slice(0, 200));

    const loadedWhiteboardFolders = await whiteboardFoldersP;
    whiteboardFolders = loadedWhiteboardFolders ?? loadLocal<WhiteboardFolder[]>('wassell_whiteboard_folders') ?? [];
    saveLocal('wassell_whiteboard_folders', whiteboardFolders);
    const loadedWhiteboards = await whiteboardsP;
    whiteboards = loadedWhiteboards ?? loadLocal<Whiteboard[]>('wassell_whiteboards') ?? [];
    saveLocal('wassell_whiteboards', whiteboards);

    // Run pending schema migrations (keeps system models in sync with seedModels.ts
    // even for returning users who already have localStorage state).
    const migrated = runMigrations({ models, records, workflows, dashboards, views, groups });
    models = migrated.models;
    groups = migrated.groups;

    // Always-run heal — not gated by schema version. Re-attaches orphaned project
    // system models to the Projects group and re-seeds the group if it was deleted.
    // Idempotent: no-op when data is already consistent.
    const healed = healSystemModelGroups({ models, groups });
    if (healed.changed) {
      models = healed.models;
      groups = healed.groups;
      saveLocal('wassell_groups', groups);
    }

    // Always-run heal for the Clients schema — catches users whose version marker
    // was bumped past the clients rebuild before the rebuild landed. Idempotent.
    let migratedRecords = migrated.records;
    const healedClients = healClientsSchema({ models, records: migratedRecords });
    if (healedClients.changed) {
      models = healedClients.models;
      migratedRecords = healedClients.records;
    }

    // Always-run heal for the Decks schema — appends seed fields missing
    // from the persisted shape (added 2026-05-10 to roll out the new
    // `size` field without forcing a hand-migration on every install).
    // Idempotent.
    const healedDecks = healDecksSchema({ models, records: migratedRecords });
    if (healedDecks.changed) {
      models = healedDecks.models;
      migratedRecords = healedDecks.records;
    }

    // Always-run heal for maps_config. Backfills default on any model missing
    // it (covers version-drift past 10 without running migration_9_to_10).
    const healedMaps = healMapsConfigForModels(models);
    if (healedMaps.changed) models = healedMaps.models;

    // Always-run heal — backfills any `is_system` model from SEED_MODELS that's
    // MISSING from this install (e.g. a returning user whose stored models
    // predate a newly-added system model like `ai_chats`). Despite the name, it
    // does NOT overwrite existing system models — Builder edits to existing
    // is_system models persist across reloads. To push a structural change to
    // existing installs, add a versioned migration in schemaMigrations.ts.
    const refreshed = refreshSystemModels({
      models,
      records: migratedRecords,
      workflows: migrated.workflows,
      dashboards: migrated.dashboards,
      views: migrated.views,
      groups,
    });
    models = refreshed.models;

    // Counterpart to refreshSystemModels: drops is_system models listed in
    // the explicit RETIRED_SYSTEM_MODEL_NAMES set (currently the old
    // marketing pipeline's reels / posts / research_questions, retired
    // 2026-05-09 in favor of the template-driven design generator).
    //
    // The pruner returns the retired ids; we fan out `supabaseDelete` for
    // each one so the cleanup propagates from local cache to Supabase. This
    // is the load-bearing piece — without the supabaseDelete fan-out, a
    // stale browser session could re-upsert the row from a queued pending
    // write or HMR cycle, and the ghost comes back across every install
    // that loads after.
    const pruned = pruneRemovedSystemModels({
      models,
      records: migratedRecords,
      workflows: refreshed.workflows,
      dashboards: refreshed.dashboards,
      views: refreshed.views,
      groups: refreshed.groups,
    });
    models = pruned.models;
    migratedRecords = pruned.records;
    let prunedWorkflows = pruned.workflows;
    let prunedViews = pruned.views;

    if (pruned.retiredModelIds.length > 0) {
      // Fire-and-forget delete via the standard helper. Each call goes
      // through `supabaseDelete` which (a) tries the wire request, (b)
      // queues on failure for replay on next sign-in, (c) toasts on
      // hard failures. Running these sequentially lets the FK cascade
      // (records → models) play out cleanly. Records under retired
      // models also get deleted to keep the records table tight.
      void Promise.all(
        pruned.retiredModelIds.flatMap((modelId) => [
          // Records first, then the model. Postgres CASCADE would handle
          // this server-side, but explicitly deleting also clears the
          // pending-write queue for any orphans.
          ...((migratedRecords[modelId] ?? []).map((r) =>
            supabaseDelete('records', r.id),
          ) as Promise<void>[]),
          supabaseDelete('models', modelId),
        ]),
      ).catch(() => { /* errors already toasted by supabaseDelete */ });
    }

    saveLocal('wassell_models', models);
    saveLocal('wassell_workflows', prunedWorkflows);
    saveLocal('wassell_views', prunedViews);
    saveLocalRecordsMap(migratedRecords);

    // --- Admin profile normalization ---
    // Every profile flagged `is_admin: true` should have ALL permissions for
    // EVERY current model. When models are added (seed backfill with fresh
    // UUIDs from a different session, user creating a new model in the
    // Builder, etc.) the admin profile's stored `model_permissions` array
    // drifts out of sync. The runtime check in `permissions.ts` already
    // bypasses the array for `is_admin` — this step keeps the stored array
    // matching reality so the Profiles UI shows every checkbox ticked.
    const ADMIN_ALL_PERMS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];
    const currentModelIds = new Set(models.map((m) => m.id));
    const upsertedAdminProfiles: Profile[] = [];
    profiles = profiles.map((p) => {
      if (!p.is_admin) return p;
      // Desired state: exactly one entry per current model, all perms. Drop
      // stale entries (pointing at models that no longer exist), refresh
      // entries that are missing a perm, and add entries for new models.
      const kept = p.model_permissions.filter((mp) => currentModelIds.has(mp.model_id));
      const refreshedKept = kept.map((mp) =>
        ADMIN_ALL_PERMS.every((perm) => mp.permissions.includes(perm))
          ? mp
          : { ...mp, permissions: [...ADMIN_ALL_PERMS] },
      );
      const keptIds = new Set(refreshedKept.map((mp) => mp.model_id));
      const added = models
        .filter((m) => !keptIds.has(m.id))
        .map((m) => ({ model_id: m.id, permissions: [...ADMIN_ALL_PERMS] }));
      const next = [...refreshedKept, ...added];
      // Any real change? If not, keep the same reference — no upsert needed.
      const changed =
        added.length > 0 ||
        kept.length !== p.model_permissions.length ||
        refreshedKept.some((mp, i) => mp !== kept[i]);
      if (!changed) return p;
      const updated: Profile = { ...p, model_permissions: next, updated_at: new Date().toISOString() };
      upsertedAdminProfiles.push(updated);
      return updated;
    });
    if (upsertedAdminProfiles.length > 0) {
      saveLocal('wassell_profiles', profiles);
      for (const p of upsertedAdminProfiles) {
        supabaseUpsert('profiles', p);
      }
    }

    // Boot-excluded models (SUMMARY — market_listings) are deliberately absent
    // from the boot query, so `migratedRecords` has no key for them. The set
    // below REPLACES `records` wholesale, which silently DROPPED any slice the
    // background summary load had already landed while boot was still running.
    //
    // Not hypothetical: landing DIRECTLY on /model/market_listings makes the
    // list page kick the summary load immediately; the 53k slim rows arrive
    // before boot finishes, and this set then threw them away — leaving the
    // page permanently empty (summaryLoadState said "loaded", so nothing ever
    // retried) while every signal claimed success. Reproduced on production
    // 2026-07-29. Client-side navigation hid it because boot had already
    // finished, which is why it never showed up in normal use.
    const bootExcluded = bootExcludedModelIds(models);
    for (const excludedId of bootExcluded) {
      const landed = get().records[excludedId];
      if (landed && landed.length > 0 && !migratedRecords[excludedId]?.length) {
        migratedRecords = { ...migratedRecords, [excludedId]: landed };
      }
    }

    set({
      models,
      groups,
      records: migratedRecords,
      workflows: prunedWorkflows,
      workflowGroups,
      workflowRuns,
      activityLog,
      dashboards: migrated.dashboards,
      views: prunedViews,
      profiles,
      roles,
      users,
      fieldTemplates,
      webhookSlugs,
      whiteboardFolders,
      whiteboards,
      currentUserId,
      initialized: true,
    });

    // ─── Background slim-full-load for SUMMARY models ─────────────
    // Fire AFTER `initialized` so the ~31MB slim market_listings set
    // (all ~46k rows) lands in the normal `records` store WITHOUT
    // delaying boot or the main records tail. Non-blocking, errors
    // surfaced via reportSupabaseError inside loadSummaryRecords. Each
    // call is idempotent (skips if already loading/loaded). queueMicrotask
    // defers it past this synchronous tick so paint isn't blocked.
    for (const m of models) {
      if (SUMMARY_MODEL_NAMES.has(m.name)) {
        const summaryModelId = m.id;
        queueMicrotask(() => { void get().loadSummaryRecords(summaryModelId); });
      }
    }

    // Realtime: watch the webhook_payloads table so incoming agent
    // webhooks fan out to the workflow engine without a page reload.
    get().subscribeMarketingRealtime();

    // Phase C.3: subscribe to records / models / workflows / etc. so
    // multi-user changes appear live without manual refresh. Idempotent
    // — repeated calls are no-ops if already running. Per-table channels
    // can be disabled via VITE_REALTIME_<TABLE>=off env vars or globally
    // via localStorage.wassell_realtime_disabled = '1'.
    if (supabase) {
      startRealtimeOrchestrator(set as Parameters<typeof startRealtimeOrchestrator>[0]);

      // Server-authoritative workflow enrollment: load the allowlist so the
      // client engine SKIPS models the Fly worker now owns (no client+server
      // double-fire), and keep it fresh via a realtime channel so enroll/
      // unenroll propagates without a hard refresh. Same singleton-channel
      // pattern as the marketing pipeline.
      void loadServerEnrolledModelIds().then((ids) => set({ serverEnrolledModelIds: ids }));
      const seGlobals = globalThis as unknown as { __wasselServerEnrollChannel?: unknown };
      if (!seGlobals.__wasselServerEnrollChannel) {
        seGlobals.__wasselServerEnrollChannel = supabase
          .channel('server-workflow-enrollment')
          .on(
            'postgres_changes' as never,
            { event: '*', schema: 'public', table: 'workflow_capture_models' },
            () => {
              void loadServerEnrolledModelIds().then((ids) => set({ serverEnrolledModelIds: ids }));
            },
          )
          .subscribe();
      }

      // Phase D.3: backstop realtime with a stale-while-revalidate sweep
      // on window focus + online events. Tables that have an updated_at
      // column get a `WHERE updated_at > <last-load-ts>` delta fetch and
      // the rows are merged via the same handlers as live realtime. Mark
      // the chrome-critical tables we just loaded so the first sweep
      // (after the user returns from another tab / closes the laptop)
      // picks up only what changed since.
      markLoaded('records', loadsStartedAtIso);
      markLoaded('models', loadsStartedAtIso);
      markLoaded('profiles', loadsStartedAtIso);
      markLoaded('roles', loadsStartedAtIso);
      markLoaded('users', loadsStartedAtIso);
      markLoaded('model_views', loadsStartedAtIso);
      markLoaded('workflows', loadsStartedAtIso);
      markLoaded('dashboards', loadsStartedAtIso);
      startStaleWhileRevalidate(set as Parameters<typeof startStaleWhileRevalidate>[0]);
    }

    // Backfill unconsumed webhooks from the last 24 hours. Realtime only
    // delivers INSERTs that happen while we're subscribed, so anything
    // that landed while every browser tab was closed would sit forever
    // unless we sweep here. Each payload is claimed atomically by the
    // server, so only one tab will actually run the workflows for a
    // given row — multi-tab safe.
    if (supabase) {
      void (async () => {
        try {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: stuck, error: stuckErr } = await supabase
            .from('webhook_payloads')
            .select('id')
            .is('consumed_at', null)
            .gte('received_at', since)
            .order('received_at', { ascending: true })
            .limit(200);
          if (stuckErr) {
            console.warn('[webhook-backfill] lookup failed:', stuckErr.message);
            return;
          }
          for (const row of stuck ?? []) {
            await get().claimAndRunWebhookPayload(row.id);
          }
        } catch (err) {
          console.warn('[webhook-backfill] failed:', err);
        }
      })();
    }

    // Backfill chat→client links once on boot. Heals chats whose
    // previous `client_link` pointed to a since-deleted client AND chats
    // that were never linked because the client was created AFTER the
    // chat record was synced (and no message has arrived since). Cheap,
    // idempotent, in-memory only — Supabase upserts go through
    // supabaseUpsert so failures persist to the retry queue.
    queueMicrotask(() => relinkChatsAgainstClients());

    // Phase G.2: total init wall time, useful for catching boot regressions.
    markEvent('init:end');
    try { performance.measure('wassell:init:total', 'wassell:init:start', 'wassell:init:end'); }
    catch { /* perf API quirk — never block init on telemetry */ }
  },

  subscribeMarketingRealtime: () => {
    if (!supabase) return () => {};
    const globals = globalThis as unknown as { __wasselMarketingChannel?: unknown };
    if (globals.__wasselMarketingChannel) return () => {};

    const upsertById = <T extends { id: string }>(list: T[], row: T): T[] => {
      const idx = list.findIndex((r) => r.id === row.id);
      if (idx >= 0) {
        const next = list.slice();
        next[idx] = row;
        return next;
      }
      return [...list, row];
    };

    // The webhook_payloads table is the only realtime surface the
    // workflow-driven marketing pipeline cares about: every edge-function
    // side-effect arrives here as an INSERT, and the first client to
    // atomically claim it runs the matching webhook workflows.
    const channel = supabase
      .channel('marketing-pipeline')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'webhook_payloads' },
        (payload) => {
          const row = payload.new as WebhookPayload;
          if (!row?.id) return;
          set((s) => ({ webhookPayloads: upsertById(s.webhookPayloads, row) }));
          void get().claimAndRunWebhookPayload(row.id);
        },
      )
      .subscribe();

    globals.__wasselMarketingChannel = channel;
    return () => {
      supabase!.removeChannel(channel);
      globals.__wasselMarketingChannel = undefined;
    };
  },

  // --- Language ---
  setLanguage: (lang: Language) => {
    saveLocal('wassell_language', lang);
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
    set({ language: lang });
    // Bilingual W4: persist the preference so SERVER-side consumers (workflow
    // push notifications) know each employee's language. Fire-and-forget with a
    // loud log — a failed stamp only means the server keeps the previous
    // preference; the UI language above is already switched.
    const meId = get().currentUserId;
    if (meId && supabase) {
      void supabase
        .from('users')
        .update({ preferred_language: lang })
        .eq('id', meId)
        .then(({ error }) => {
          if (error) console.error('[setLanguage] preferred_language stamp failed:', error.message);
        });
    }
  },

  // --- Toasts ---
  addToast: (message: string, type: ToastType) => {
    const id = uuid();
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },
  removeToast: (id: string) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  // --- Models ---
  saveModel: (model: AppModel) => {
    set((s) => {
      const idx = s.models.findIndex((m) => m.id === model.id);
      const models = idx >= 0
        ? s.models.map((m) => (m.id === model.id ? model : m))
        : [...s.models, model];
      saveLocal('wassell_models', models);
      // FK: models.group_id → model_groups.id. Gate the upsert on the group
      // write so a freshly-created group lands before the model references it.
      supabaseUpsert(
        'models',
        model,
        model.group_id ? { table: 'model_groups', id: model.group_id } : undefined,
      );
      return { models };
    });
  },
  deleteModel: (modelId: string) => {
    set((s) => {
      // Postgres CASCADE wipes the model's records, workflows, and views on
      // the server automatically. We need to mirror that locally — otherwise
      // stale rows sit in localStorage and reappear in memory on next load,
      // creating the "deleted model's workflows still trigger" class of bug.
      const models = s.models.filter((m) => m.id !== modelId);
      const records = { ...s.records };
      delete records[modelId];
      const workflows = s.workflows.filter((w) => w.trigger_model_id !== modelId);
      const views = s.views.filter((v) => v.model_id !== modelId);
      // Also drop workflow run history tied to this model so the logs view
      // doesn't show runs for a model that no longer exists.
      const workflowRuns = s.workflowRuns.filter((r) => r.trigger_model_id !== modelId);
      saveLocal('wassell_models', models);
      saveLocalRecordsMap(records);
      saveLocal('wassell_workflows', workflows);
      saveLocal('wassell_views', views);
      saveLocal('wassell_workflow_runs', workflowRuns);
      // Server-side CASCADE handles the delete of dependent rows, so we only
      // need to issue the delete on `models` itself.
      supabaseDelete('models', modelId);
      return { models, records, workflows, views, workflowRuns };
    });
  },
  renameField: (modelId: string, fieldId: string, updatedField) => {
    set((s) => {
      const origModel = s.models.find((m) => m.id === modelId);
      if (!origModel) return s;
      const origField = origModel.schema.sections.flatMap((sec) => sec.fields).find((f) => f.id === fieldId);
      if (!origField) return s;
      const oldSlug = origField.name;
      const newSlug = updatedField.name;
      // Propagate the slug rename across records, formulas, cross-model refs, workflows, and views.
      // Returns new state; if oldSlug === newSlug the result matches input.
      const result = applyFieldRename(modelId, fieldId, oldSlug, newSlug, {
        models: s.models,
        records: s.records,
        workflows: s.workflows,
        views: s.views,
      });
      // Overlay the full updatedField onto THIS model — replaces the field by id,
      // handling section moves (target section = updatedField.section_id) and all
      // non-slug edits (type, label, options, etc.). Same contract as SectionManager.saveField.
      const renamedThis = result.models.find((m) => m.id === modelId)!;
      const nextSections = renamedThis.schema.sections.map((sec) => {
        const withoutField = sec.fields.filter((f) => f.id !== fieldId);
        if (sec.id === updatedField.section_id) {
          return { ...sec, fields: [...withoutField, updatedField] };
        }
        return { ...sec, fields: withoutField };
      });
      const finalThisModel = {
        ...renamedThis,
        schema: {
          ...renamedThis.schema,
          section_selector_field_id:
            updatedField.type === 'section_selector' ? updatedField.id : renamedThis.schema.section_selector_field_id,
          sections: nextSections,
        },
        updated_at: new Date().toISOString(),
      };
      const finalModels = result.models.map((m) => (m.id === modelId ? finalThisModel : m));
      result.changedModelIds.add(modelId);
      // Persist locally
      saveLocal('wassell_models', finalModels);
      saveLocalRecordsMap(result.records);
      saveLocal('wassell_workflows', result.workflows);
      saveLocal('wassell_views', result.views);
      // Fire-and-forget Supabase upserts for only the rows that changed.
      // FK-aware: records/workflows/views all reference models, so pass the
      // model they belong to as a parent gate.
      for (const id of result.changedModelIds) {
        const m = finalModels.find((x) => x.id === id);
        if (m) {
          supabaseUpsert(
            'models',
            m,
            m.group_id ? { table: 'model_groups', id: m.group_id } : undefined,
          );
        }
      }
      for (const id of result.changedRecordIds) {
        const r = Object.values(result.records).flat().find((x) => x.id === id);
        if (r) {
          supabaseUpsert(
            'records',
            r,
            { table: 'models', id: r.model_id },
          );
        }
      }
      for (const id of result.changedWorkflowIds) {
        const w = result.workflows.find((x) => x.id === id);
        if (w) {
          supabaseUpsert(
            'workflows',
            workflowToSupabaseRow(w),
            { table: 'models', id: w.trigger_model_id || null },
          );
        }
      }
      for (const id of result.changedViewIds) {
        const v = result.views.find((x) => x.id === id);
        if (v) {
          supabaseUpsert(
            'model_views',
            v,
            { table: 'models', id: v.model_id },
          );
        }
      }
      return {
        models: finalModels,
        records: result.records,
        workflows: result.workflows,
        views: result.views,
      };
    });
  },

  // --- Groups ---
  saveGroup: (group: ModelGroup) => {
    set((s) => {
      const idx = s.groups.findIndex((g) => g.id === group.id);
      const groups = idx >= 0
        ? s.groups.map((g) => (g.id === group.id ? group : g))
        : [...s.groups, group];
      saveLocal('wassell_groups', groups);
      supabaseUpsert('model_groups', group);
      return { groups };
    });
  },
  deleteGroup: (groupId: string) => {
    set((s) => {
      // Postgres has `ON DELETE SET NULL` on models.group_id, so the server
      // nulls out any referring models automatically. Mirror that in memory
      // + localStorage so the sidebar doesn't keep showing models nested
      // under a group that no longer exists.
      const groups = s.groups.filter((g) => g.id !== groupId);
      const touchedModels: AppModel[] = [];
      const models = s.models.map((m) => {
        if (m.group_id !== groupId) return m;
        const updated = { ...m, group_id: null, updated_at: new Date().toISOString() };
        touchedModels.push(updated);
        return updated;
      });
      saveLocal('wassell_groups', groups);
      saveLocal('wassell_models', models);
      supabaseDelete('model_groups', groupId);
      // Postgres took care of the cascade. No need to re-upsert models —
      // the server already nulled their group_id. But to keep things tight
      // in case Supabase was offline, flush the touched models on next
      // connection via a fire-and-forget upsert.
      for (const m of touchedModels) {
        supabaseUpsert('models', m);
      }
      return { groups, models };
    });
  },

  // Reorder the sidebar menu in one atomic commit. Accepts the full new
  // shape of `models` and `groups` — callers pass arrays whose position
  // reflects the desired order, and this action:
  //   • Assigns `order` to each model and group based on its index.
  //   • Persists each changed row to Supabase (FK-aware: models upsert
  //     waits for their group if that group is also being written).
  //   • Commits everything to local state + localStorage in one set().
  // Idempotent: rows whose order + group_id haven't changed aren't rewritten.
  reorderMenu: (nextModels: AppModel[], nextGroups: ModelGroup[]) => {
    set((s) => {
      const now = new Date().toISOString();
      // Determine which groups changed order.
      const changedGroups: ModelGroup[] = [];
      const finalGroups: ModelGroup[] = nextGroups.map((g, i) => {
        const prev = s.groups.find((x) => x.id === g.id);
        const updated: ModelGroup = { ...g, order: i };
        if (!prev || prev.order !== i || prev.label_ar !== g.label_ar || prev.label_en !== g.label_en) {
          changedGroups.push(updated);
        }
        return updated;
      });

      // Determine which models changed order or group.
      // Models are grouped by their new group_id; index within each group = order.
      const orderByModelId = new Map<string, number>();
      const groupBuckets = new Map<string | null, AppModel[]>();
      for (const m of nextModels) {
        const key = m.group_id ?? null;
        if (!groupBuckets.has(key)) groupBuckets.set(key, []);
        groupBuckets.get(key)!.push(m);
      }
      for (const [, bucket] of groupBuckets) {
        bucket.forEach((m, i) => orderByModelId.set(m.id, i));
      }

      const changedModels: AppModel[] = [];
      const finalModels: AppModel[] = nextModels.map((m) => {
        const newOrder = orderByModelId.get(m.id) ?? 0;
        const prev = s.models.find((x) => x.id === m.id);
        const nextModel: AppModel = {
          ...m,
          order: newOrder,
          updated_at: now,
        };
        if (!prev || prev.order !== newOrder || (prev.group_id ?? null) !== (nextModel.group_id ?? null)) {
          changedModels.push(nextModel);
        }
        return nextModel;
      });

      // Persist locally.
      saveLocal('wassell_groups', finalGroups);
      saveLocal('wassell_models', finalModels);

      // Persist to Supabase — groups first so model upserts see their parents.
      for (const g of changedGroups) {
        supabaseUpsert('model_groups', g);
      }
      for (const m of changedModels) {
        supabaseUpsert(
          'models',
          m,
          m.group_id ? { table: 'model_groups', id: m.group_id } : undefined,
        );
      }

      return { models: finalModels, groups: finalGroups };
    });
  },

  // --- Records ---
  getRecords: (modelId: string) => {
    return get().records[modelId] ?? [];
  },
  setRecordNavContext: (modelId: string, orderedIds: string[]) => {
    set({ recordNavContext: { modelId, orderedIds } });
  },
  setMapsViewState: (modelId: string, state: { center: { lat: number; lng: number }; zoom: number; selectedId: string | null }) => {
    set((s) => ({ mapsViewState: { ...s.mapsViewState, [modelId]: state } }));
  },

  // ─── Phase E.2: paginated record loader ───────────────────────
  // Calls record_search RPC and accumulates results into
  // state.recordsByModel[modelId]. Idempotent: subsequent calls
  // advance via the cached cursor; pass `reset: true` to start
  // over (e.g., when filters change). Concurrent-safe: the loading
  // flag prevents double-fires.
  loadRecordsPage: async (modelId, opts = {}) => {
    const { filters, searchText, reset = false, limit = 50 } = opts;
    const filterKey = buildFilterKey(filters, searchText);

    // Decide which cache entry to extend, OR reset to empty.
    const stateBefore = get();
    const existing: RecordsPageCache | undefined = stateBefore.recordsByModel[modelId];
    const filterChanged = !existing || existing.filterKey !== filterKey;
    const baseCache: RecordsPageCache =
      filterChanged || reset ? emptyCache(filterKey) : existing;

    // Already loading this exact context, or exhausted: short-circuit.
    if (baseCache.loading) return;
    if (!filterChanged && !reset && existing && !existing.hasMore) return;

    // Mark loading.
    set((s) => ({
      recordsByModel: {
        ...s.recordsByModel,
        [modelId]: setCacheLoading(baseCache, true),
      },
    }));

    if (!supabase) {
      set((s) => ({
        recordsByModel: {
          ...s.recordsByModel,
          [modelId]: setCacheError(baseCache, 'Supabase not configured'),
        },
      }));
      return;
    }

    // Cursor: only re-use the cached one if we're continuing the
    // same filter context.
    const cursor = !filterChanged && !reset ? existing?.nextCursor ?? null : null;

    try {
      const { data, error } = await supabase.rpc('record_search', {
        p_model_id: modelId,
        p_filters: (filters ?? {}) as Record<string, unknown>,
        p_cursor: cursor,
        p_limit: limit,
        p_search_text: searchText ?? null,
      });

      if (error) {
        reportSupabaseError('record_search', 'rpc', error.message ?? String(error));
        set((s) => ({
          recordsByModel: {
            ...s.recordsByModel,
            [modelId]: setCacheError(
              s.recordsByModel[modelId] ?? baseCache,
              error.message ?? String(error),
            ),
          },
        }));
        return;
      }

      const rawRows = (data ?? []) as Array<AppRecord & { has_more?: boolean }>;
      const hasMore = rawRows.length > 0 ? Boolean(rawRows[0]?.has_more) : false;
      // Strip the metadata column so the rest of the app sees plain AppRecord.
      const cleanRows: AppRecord[] = rawRows.map((r) => {
        const { has_more: _omit, ...rest } = r;
        void _omit;
        return rest as AppRecord;
      });

      set((s) => {
        const current =
          filterChanged || reset
            ? emptyCache(filterKey)
            : s.recordsByModel[modelId] ?? emptyCache(filterKey);
        return {
          recordsByModel: {
            ...s.recordsByModel,
            [modelId]: appendPage(current, cleanRows, hasMore),
          },
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportSupabaseError('record_search', 'rpc', msg);
      set((s) => ({
        recordsByModel: {
          ...s.recordsByModel,
          [modelId]: setCacheError(s.recordsByModel[modelId] ?? baseCache, msg),
        },
      }));
    }
  },

  // ─── Background slim-full-load for SUMMARY models ──────────────
  // Keyset-pages the model's `<name>_summary` view (a slim projection of
  // ALL rows) into `records[modelId]` so the list page browses/searches/
  // filters every row client-side like a normal model. Non-blocking:
  // fired AFTER `initialized` so it never delays boot or the main records
  // tail. Idempotent — skips if a load is in flight or already completed
  // this session unless `force: true`. The heavy per-record fields are
  // fetched on demand when a single record is opened (RecordFormPage).
  loadSummaryRecords: async (modelId, opts = {}) => {
    const { force = false } = opts;
    const model = get().models.find((m) => m.id === modelId);
    if (!model || !isSummaryModelName(model.name)) return;
    const existing = get().summaryLoadState[modelId];
    // A load that COMPLETED WITH ROWS but whose slice is now empty means
    // something replaced the whole `records` map after we landed them. That
    // used to be permanent: `loaded` stayed true, so this function no-op'd on
    // every later visit and the list showed "0 سجل" forever with no spinner,
    // no error and a network log full of 200s. `initialize` now carries these
    // slices forward (see the boot carry-forward there), so this is the safety
    // net for any other wholesale writer. Gated on `count > 0` so a model that
    // genuinely returned zero rows is never re-fetched in a loop.
    const wiped =
      !!existing?.loaded &&
      (existing.count ?? 0) > 0 &&
      (get().records[modelId]?.length ?? 0) === 0;
    if (!force && existing && (existing.loading || (existing.loaded && !wiped))) return;
    if (!supabase) return;

    set((s) => ({
      summaryLoadState: {
        ...s.summaryLoadState,
        [modelId]: { loading: true, loaded: existing?.loaded ?? false, error: null },
      },
    }));

    // supabaseLoad keyset-pages by id (sharded) and surfaces errors via
    // reportSupabaseError on failure (returns null) — no silent fail.
    const rows = await supabaseLoad<AppRecord>(summaryViewName(model.name));
    if (rows === null) {
      // Error already surfaced by supabaseLoad. Record it so the list page
      // can show a retry affordance instead of an indefinite spinner.
      set((s) => ({
        summaryLoadState: {
          ...s.summaryLoadState,
          [modelId]: { loading: false, loaded: existing?.loaded ?? false, error: 'load_failed' },
        },
      }));
      return;
    }

    // Land the slim rows in the normal in-memory store, keyed by model id.
    // Replace the slice wholesale (these are the authoritative full set);
    // realtime keeps it fresh afterward via mergeRecord (which slims).
    set((s) => ({
      records: { ...s.records, [modelId]: rows },
      summaryLoadState: {
        ...s.summaryLoadState,
        [modelId]: { loading: false, loaded: true, error: null, count: rows.length },
      },
    }));
  },

  saveRecord: async (record: AppRecord, opts: SaveRecordOpts = {}): Promise<SaveResult> => {
    const state = get();
    const previousRecord = (state.records[record.model_id] ?? []).find((r) => r.id === record.id);
    const isNew = !previousRecord;
    const origModel = state.models.find((m) => m.id === record.model_id);

    // Enrich the record with auto_id assignments (on create only) and formula
    // snapshots (always). Phase F.1: auto_id assignment AWAITS the server-side
    // atomic RPC so concurrent saves never collide on the same counter value.
    // For existing records (isNew=false) the assigner short-circuits — no RPC
    // call, no perceptible latency.
    //
    // Audit H3: assignAutoIdsAsync now THROWS AutoIdRpcError on RPC failure
    // (instead of silently falling back to the racey JSONB counter). Catch
    // it here, enqueue the write for retry, and return `queued` so the
    // caller doesn't think the save succeeded.
    let enrichedModel = origModel;
    let enrichedData = record.data;
    if (origModel) {
      try {
        const assigned = await assignAutoIdsAsync(origModel, record.data, isNew);
        enrichedModel = assigned.model;
        enrichedData = assigned.data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reportSupabaseError('records', 'rpc', `auto_id_assign: ${msg}`);
        enqueuePendingWrite({
          op: 'record_upsert',
          table: 'records',
          row: serializeRecord(record),
        });
        return { status: 'queued', reason: msg };
      }
      enrichedData = applyFieldFallbacks(
        enrichedModel,
        enrichedData,
        (modelId) => (state.records[modelId] ?? []).map((r) => ({ id: r.id, data: r.data })),
      );
      const formulaValues = computeAllFormulas(enrichedModel, enrichedData);
      if (Object.keys(formulaValues).length > 0) {
        enrichedData = { ...enrichedData, ...formulaValues };
      }
      // Project rollup fields (is_rollup / legacy is_computed) are NO LONGER
      // stripped: they are now STORED aggregates maintained by a DB trigger.
      // recalc_project_rollups_data() + the records_fill_project_rollups
      // BEFORE trigger re-fill them on every write, so whatever the form holds
      // is overwritten authoritatively server-side — a client value can never
      // wipe or stale them. Formula / mirror / auto_id fields keep their own
      // code paths (formulas snapshot above, mirror resolved at render,
      // auto_id stamped on create). See 2026-06-15_persist_project_rollups.sql.
    }
    // Stamp `created_by_user_id` on first save. Preserved across edits so the
    // value reflects who CREATED the record, not who last touched it. Records
    // saved without an active session (offline / pre-auth) stay null and are
    // treated as "no known creator" by scope filters that reference `created_by`.
    const stampedCreatedBy =
      isNew && record.created_by_user_id == null && state.currentUserId
        ? state.currentUserId
        : record.created_by_user_id ?? previousRecord?.created_by_user_id ?? null;
    // Phase F.2 / audit H5: when the caller supplied an `expectedVersion`
    // (form-mount snapshot), use that as the optimistic-concurrency input.
    // Otherwise fall back to the live previousRecord — the pre-fix behavior
    // that's adequate for fire-and-forget callers (workflow chains, lookup
    // combobox, import) but unsafe for forms that may stay open while
    // realtime mutates the underlying row.
    const liveVersion = previousRecord?.version ?? record.version;
    const expectedVersion =
      opts.expectedVersion !== undefined ? opts.expectedVersion : (liveVersion ?? null);
    const finalRecord: AppRecord = {
      ...record,
      data: enrichedData,
      created_by_user_id: stampedCreatedBy,
      version: liveVersion,
    };
    const modelChanged = !!enrichedModel && enrichedModel !== origModel;

    // 1. Apply the in-memory + localStorage update synchronously so the UI
    //    sees the change instantly. Model side-effects (when an auto_id
    //    counter bumped or a formula re-cached the schema) ride along on
    //    the same set() so the model FK exists for the records write.
    set((s) => {
      const modelRecords = s.records[record.model_id] ?? [];
      const idx = modelRecords.findIndex((r) => r.id === record.id);
      const updated = idx >= 0
        ? modelRecords.map((r) => (r.id === record.id ? finalRecord : r))
        : [...modelRecords, finalRecord];
      const records = { ...s.records, [record.model_id]: updated };
      // Per-model bucket write: O(records-in-this-model) instead of O(all).
      saveLocalRecordsForModel(record.model_id, updated);

      if (modelChanged && enrichedModel) {
        const models = s.models.map((m) => (m.id === enrichedModel!.id ? enrichedModel! : m));
        saveLocal('wassell_models', models);
        supabaseUpsert(
          'models',
          enrichedModel,
          enrichedModel.group_id ? { table: 'model_groups', id: enrichedModel.group_id } : undefined,
        );
        return { records, models };
      }
      return { records };
    });

    // 2. Now await the actual Supabase write so the function resolves with
    //    a meaningful SaveResult. Existing fire-and-forget callers (`void
    //    saveRecord(rec)` / no await) keep working because they never
    //    observed the resolution timing — only the lack of a return value
    //    is new. Callers that DO await get { status: 'saved' | 'queued' |
    //    'conflict' } and can react (e.g. abort a fan-out, summarize
    //    bulk-edit conflicts).
    const result = await supabaseRecordUpsert(finalRecord, { expectedVersion });

    // Incident 2026-06-02 fix: `record_save` bumps the row's `version` by +1 on
    // a successful UPDATE (records_bump_version trigger) but the RPC returns
    // only the id — so the local copy used to stay pinned at the pre-save
    // version. The SECOND save of the same record in one session then sent a
    // stale `expected_version` and was rejected (version_mismatch), and
    // Realtime echo-suppression kept the client blind to its own bump. A flow
    // that saves the same record repeatedly (the Data Migration wizard) thus
    // entered a permanent-conflict loop that pinned Postgres CPU. Advance the
    // local version ourselves on success so subsequent saves match the server.
    // Guard: only when we sent a concrete numeric version AND the store row is
    // still at exactly that version (a concurrent realtime merge may have
    // already advanced it — don't fight that).
    if (
      result.status === 'saved' &&
      typeof expectedVersion === 'number' &&
      !isModelHardcoded(record.model_id)
    ) {
      set((s) => {
        const list = s.records[record.model_id] ?? [];
        const idx = list.findIndex((r) => r.id === record.id);
        if (idx < 0 || (list[idx]!.version ?? null) !== expectedVersion) return {};
        const bumped = list.slice();
        bumped[idx] = { ...bumped[idx]!, version: expectedVersion + 1 };
        saveLocalRecordsForModel(record.model_id, bumped);
        return { records: { ...s.records, [record.model_id]: bumped } };
      });
    }

    // Reload-on-conflict (2026-06-16): a version_mismatch means our local copy
    // is behind the server. Re-fetch the live row so (a) the user sees the
    // latest and (b) the NEXT save sends the CURRENT version instead of
    // re-sending the same stale one forever. This is the root-cause cure for
    // the conflict retry-storm — a client can no longer get permanently wedged
    // on an old version (the 2026-06-16 incident). Best-effort + guarded; the
    // permanent breaker still protects the DB if this read fails. Frozen models
    // live in dedicated tables (not `records`) and don't hit this path.
    // Reload-on-conflict — BOUNDED by T1 (req 3/4). Only a recoverable
    // 'version_mismatch' is re-fetched; 'storm_blocked'/'wedged'/'hard_stop' are
    // terminal and never re-fetched. The re-fetch is allowed AT MOST ONCE per
    // record (MAX_RELOAD_RETRIES): if the record conflicts AGAIN after a reload it
    // is WEDGED (a stale FORM version that never re-synced, or a trigger that
    // self-bumps the row) — so we keep the breaker tripped and engage the hard
    // write-stop instead of re-fetching forever. The repeated clear→retry→conflict
    // cycle was the storm engine; this cap + releaseBreakerForRetry (which does
    // NOT reset the attempt counter) ends it.
    if (
      result.status === 'conflict' && result.kind === 'version_mismatch'
      && supabase && !isModelHardcoded(record.model_id)
    ) {
      if (reachedReloadCap(record.id)) {
        markRecordWedged(record.id);
        engageHardWriteStop('wedged-after-reload');
      } else {
        noteReloadAttempt(record.id);
        void (async () => {
          try {
            const { data: fresh, error } = await supabase!
              .from('records')
              .select('data, created_by_user_id, updated_at, version')
              .eq('id', record.id)
              .maybeSingle();
            if (error || !fresh) return;
            set((s) => {
              const list = s.records[record.model_id] ?? [];
              const idx = list.findIndex((r) => r.id === record.id);
              if (idx < 0) return {};
              const next = list.slice();
              next[idx] = {
                ...next[idx]!,
                data: (fresh.data as Record<string, unknown>) ?? next[idx]!.data,
                created_by_user_id:
                  (fresh.created_by_user_id as string | null) ?? next[idx]!.created_by_user_id ?? null,
                updated_at: (fresh.updated_at as string) ?? next[idx]!.updated_at,
                version: (fresh.version as number | null) ?? undefined,
              };
              saveLocalRecordsForModel(record.model_id, next);
              return { records: { ...s.records, [record.model_id]: next } };
            });
            // Fresh version loaded → allow ONE retry by releasing the breaker, but
            // KEEP the reload-attempt counter so a recurrence is capped (a clean
            // SAVE — clearRecordConflict — is what resets it).
            releaseBreakerForRetry(record.id);
          } catch {
            /* best-effort reload; the conflict breaker still protects the DB */
          }
        })();
      }
    }

    // Execute workflows after state is settled
    queueMicrotask(() => {
      const s = get();
      // Server-authoritative skip: when this model is enrolled in
      // workflow_capture_models, the Fly worker is the SOLE executor. Running
      // the client engine too would double-fire every create/update (duplicate
      // follow-ups). Skip loudly. (Delete is unaffected — the client engine
      // never fires on delete; webhook/on_due paths are separate and the
      // capture trigger doesn't enqueue for them.)
      if (isModelServerEnrolled(finalRecord.model_id, s.serverEnrolledModelIds)) {
        // eslint-disable-next-line no-console
        console.debug(
          `[server-workflows] client workflow skipped: model is server-enrolled (model_id=${finalRecord.model_id}, trigger=${isNew ? 'create' : 'update'})`,
        );
        return;
      }
      void executeWorkflows(
        isNew ? 'create' : 'update',
        finalRecord,
        previousRecord,
        s.workflows,
        s.models,
        s.records,
        s.users,
        s.roles,
        // Audit M5: workflow-driven saves are tagged so the activity log
        // can distinguish them from manual edits. The cb closure can't
        // reach into individual workflow ids (the engine knows those),
        // so we tag every chained write here as 'workflow' without an
        // id. Future work: pass the current workflow_id in via the
        // engine's tool-call boundary.
        //
        // expectedVersion: null — workflow-engine writes opt OUT of optimistic
        // concurrency, matching the server-side sweeper (api/_lib/workflowSweeper.ts
        // calls record_save without p_expected_version). RATIONALE / ROOT-CAUSE FIX
        // (2026-06-21): completing a follow-up fires the records_touch_client_on_activity
        // AFTER trigger → _touch_client() → `UPDATE clients SET data=data` → the
        // records_bump_version trigger advances the client's version. The very next
        // step — the bound workflow's update_record on that same client — then sent
        // the store's PRE-bump version as expected_version, so record_save raised
        // version_mismatch (40001) and the client stage/status move was silently
        // rejected (the next-task create_record survived because INSERTs aren't
        // version-checked). Optimistic concurrency exists to stop a stale USER FORM
        // from clobbering concurrent edits; a workflow transition is a deterministic
        // system write that must apply, and the BEFORE triggers re-derive computed
        // fields (next-action, rollups) on every write, so last-write-wins is correct
        // here. Do NOT re-introduce a version here without solving the _touch_client
        // self-bump race first.
        (r) => get().saveRecord(r, { actor: { kind: 'workflow', workflow_id: 'unknown' }, expectedVersion: null }),
        (msg) => get().addToast(msg, 'info'),
        s.currentUserId,
        0,
        (run) => get().appendWorkflowRun(run),
        // Audit M4: closure over the live store so each branch re-reads
        // the trigger record. If a concurrent user edit lands while the
        // workflow is still selecting a branch, we pick based on fresh
        // data rather than the snapshot at execute-time.
        () => (get().records[finalRecord.model_id] ?? []).find((r) => r.id === finalRecord.id),
        // Sales Studio 2.0: process overlay. If the trigger record's client has
        // an active assignment to a process version, the resolver returns a
        // config-overlaid copy of each matching workflow (safe values only). No
        // assignment → the workflow runs its built-in (legacy/default) behavior.
        buildProcessOverlayResolver({
          assignmentsByClient: activeAssignmentsByClient(s.clientSalesProcessAssignments),
          versionsById: new Map(s.salesProcessVersions.map((v) => [v.id, v])),
        }),
      );
    });

    // Activity log — fires after the state mutation so the unified /logs
    // timeline picks up every record write. recordUpdated is a no-op when
    // there are no field-level diffs (auto_id-only writes, formula re-runs).
    // Audit M5: actor defaults to 'user'; workflow/webhook/agent callers
    // pass their own kind so /logs can split bot-driven edits from manual.
    const actor = opts.actor ?? { kind: 'user' as const };
    if (isNew) {
      activityLogger.recordCreated(finalRecord, origModel, actor);
    } else if (previousRecord) {
      activityLogger.recordUpdated(finalRecord, previousRecord, origModel, actor);
    }

    // When a clients record is saved, sweep every unlinked chat and try
    // to match it to a client. Handles the "message arrived, then the
    // user created the client" ordering — previously the chat would
    // stay unlinked until the next inbound message or a chats-page
    // re-mount. Runs in a microtask so the clients-record write lands
    // first and our sweep reads the fresh state.
    if (origModel && origModel.name === 'clients') {
      queueMicrotask(() => relinkChatsAgainstClients());
    }

    return result;
  },
  deleteRecord: (modelId: string, recordId: string) => {
    // Capture the model + last snapshot BEFORE the state mutation so the
    // activity log can record what was deleted.
    const stateBefore = get();
    const model = stateBefore.models.find((m) => m.id === modelId);
    const previous = (stateBefore.records[modelId] ?? []).find((r) => r.id === recordId);

    // Audit fix H8 — dangling-ref detection.
    //
    // Records reference each other via JSONB lookup fields; there's no
    // FK at the DB level, so deleting a record leaves stale UUIDs in
    // every other record's `data`. Sweep every model whose schema
    // declares a lookup pointing to this model, count the rows that
    // hold a stale reference, and surface the count via activity log
    // + a non-blocking warning toast.
    //
    // We deliberately do NOT auto-null/cascade — that's a per-field
    // policy decision (some workflows treat the dead reference as a
    // signal to keep). Documented as a follow-up: per-lookup
    // `on_target_delete: 'null' | 'leave' | 'cascade'` setting.
    let danglingCount = 0;
    const danglingByModel: Record<string, number> = {};
    if (model) {
      for (const otherModel of stateBefore.models) {
        const lookupFieldsToHere = otherModel.schema.sections
          .flatMap((s) => s.fields)
          .filter((f) => f.type === 'lookup' && f.lookup_model_id === modelId);
        if (lookupFieldsToHere.length === 0) continue;
        const otherList = stateBefore.records[otherModel.id] ?? [];
        let countForThisModel = 0;
        for (const rec of otherList) {
          for (const fld of lookupFieldsToHere) {
            const v = rec.data[fld.name];
            if (fld.is_multi) {
              if (Array.isArray(v) && v.includes(recordId)) {
                countForThisModel += 1;
                break;
              }
            } else if (v === recordId) {
              countForThisModel += 1;
              break;
            }
          }
        }
        if (countForThisModel > 0) {
          danglingByModel[otherModel.name] = countForThisModel;
          danglingCount += countForThisModel;
        }
      }
    }

    set((s) => {
      const modelRecords = (s.records[modelId] ?? []).filter((r) => r.id !== recordId);
      const records = { ...s.records, [modelId]: modelRecords };
      saveLocalRecordsForModel(modelId, modelRecords);
      void supabaseRecordDelete(modelId, recordId);
      return { records };
    });
    if (previous) {
      activityLogger.recordDeleted(previous, model);
    }
    if (danglingCount > 0) {
      // Non-blocking surface — admins can audit later.
      // eslint-disable-next-line no-console
      console.warn(
        `[deleteRecord] left ${danglingCount} dangling lookup reference(s) across ${Object.keys(danglingByModel).length} model(s):`,
        danglingByModel,
      );
      try {
        const lang = get().language;
        const isAr = lang === 'ar';
        get().addToast(
          isAr
            ? `تم حذف السجل، لكن ${danglingCount} إشارة في سجلات أخرى لا تزال تشير إليه.`
            : `Record deleted, but ${danglingCount} reference(s) in other records still point to it.`,
          'info',
        );
      } catch {
        // If the toast bus isn't ready (very early in init), the console.warn above is enough.
      }
    }
  },
  // Targeted single-record refresh — the Realtime-INDEPENDENT fallback for
  // surfacing a worker's writes when the Realtime WebSocket isn't reaching this
  // browser (corporate proxy / firewall blocking wss://, a silently dropped
  // socket). Reads ONE row from `unified_records` and feeds it through the SAME
  // `mergeRecord` handler Realtime + stale-while-revalidate use: identical
  // staleness guard (only a STRICTLY-newer row is adopted) and store mutation,
  // so it can never revert in-progress local state.
  //
  // READ-ONLY by design: it issues no `record_save`, so it cannot create a
  // version_mismatch, cannot contribute to the record_save conflict-storm (see
  // docs/conflict-storm-hardening.md — the storm is a WRITE pathology), and never
  // touches the write breaker. Used by the Data Migration wizard's in-flight poll
  // (MigrationWizard.tsx) — gated to only run while a worker job is actually
  // pending, so the per-request cost stays negligible. No-op when Supabase isn't
  // configured.
  refreshRecordById: async (recordId: string) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('unified_records')
        .select('*')
        .eq('id', recordId)
        .maybeSingle();
      if (error) {
        // A transient read miss is not data loss and must NOT spam a toast every
        // few seconds. This is a deliberately scoped silence (read-only poll),
        // logged loudly — NOT a swallowed error on a write/error-surfacing path
        // (see CLAUDE.md "Silent Failures").
        // eslint-disable-next-line no-console
        console.error('[refreshRecordById] fetch failed', recordId, error.message);
        return;
      }
      if (!data) return;
      // Cast `set` to the merge handler's SetState shape — same pattern as the
      // startRealtimeOrchestrator / startStaleWhileRevalidate call sites.
      mergeRecord('UPDATE', { new: data as AppRecord }, set as Parameters<typeof mergeRecord>[2]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[refreshRecordById] unexpected error', recordId, err);
    }
  },
  // Bulk-apply the fallback configured on `targetFieldId` to every existing
  // record on `modelId` whose target value is empty. Re-saves each via
  // `saveRecord` so auto_id / formulas / update-trigger workflows all fire
  // per record. Returns how many records were actually touched.
  applyFallbackToExistingRecords: (modelId: string, targetFieldId: string) => {
    const state = get();
    const model = state.models.find((m) => m.id === modelId);
    if (!model) return { count: 0 };
    const targetField = model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === targetFieldId);
    if (!targetField || !targetField.fallback_source_field_id) return { count: 0 };
    const modelRecords = state.records[modelId] ?? [];
    const isEmpty = (v: unknown): boolean => {
      if (v === undefined || v === null) return true;
      if (typeof v === 'string') return v.trim() === '';
      if (Array.isArray(v)) return v.length === 0;
      return false;
    };
    const pending = modelRecords.filter((r) => isEmpty(r.data[targetField.name]));
    for (const rec of pending) {
      get().saveRecord(rec);
    }
    return { count: pending.length };
  },

  // ── Freeze (model promotion) ─────────────────────────────────────────
  checkFreezeCoercion: async (modelId: string) => {
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('freeze_check_coercion', {
      p_model_id: modelId,
    });
    if (error) {
      reportSupabaseError('freeze_check_coercion', 'load', error.message ?? String(error));
      return null;
    }
    return (data ?? []) as FreezeCoercionFailure[];
  },

  freezeModel: async (modelId: string): Promise<FreezeResult> => {
    if (!supabase) {
      return {
        ok: false,
        modelId,
        modelName: '',
        tableName: '',
        rowsCopied: 0,
        frozenAt: '',
        error: 'Supabase not configured — Freeze is unavailable in offline-only mode',
      };
    }
    // Audit fix H6 cutover: route through `freeze_model_safe` (defined in
    // the audit-followup migration). The wrapper takes a per-model
    // advisory lock so two admins clicking Freeze simultaneously can't
    // both pass the validation phase + duplicate rows in the dedicated
    // table. It's also idempotent on already-frozen models — returns
    // `{ok: true, already_frozen: true}` instead of erroring or
    // double-freezing. The wrapper additionally writes an activity_log
    // entry (audit L3) so the freeze is auditable.
    const { data, error } = await supabase.rpc('freeze_model_safe', {
      p_model_id: modelId,
    });
    if (error) {
      reportSupabaseError('freeze_model', 'upsert', error.message ?? String(error));
      return {
        ok: false,
        modelId,
        modelName: '',
        tableName: '',
        rowsCopied: 0,
        frozenAt: '',
        error: error.message ?? String(error),
      };
    }
    const payload = (data ?? {}) as {
      model_id?: string;
      model_name?: string;
      table_name?: string;
      rows_copied?: number;
      frozen_at?: string;
      already_frozen?: boolean;
    };
    // already_frozen means another writer beat us to it; flip the local
    // flag from whatever fresh data the wrapper returned but don't
    // celebrate as a brand-new freeze.
    // Update local model: flip is_hardcoded + set table_name. Don't refetch
    // from Supabase — the RPC has already committed; the local state just
    // needs the two new flags so subsequent saves dispatch correctly.
    set((s) => {
      const models = s.models.map((m) =>
        m.id === modelId
          ? { ...m, is_hardcoded: true, table_name: payload.table_name ?? m.name }
          : m,
      );
      saveLocal('wassell_models', models);
      return { models };
    });
    return {
      ok: true,
      modelId: payload.model_id ?? modelId,
      modelName: payload.model_name ?? '',
      tableName: payload.table_name ?? '',
      rowsCopied: payload.rows_copied ?? 0,
      frozenAt: payload.frozen_at ?? new Date().toISOString(),
    };
  },

  // --- Workflows ---
  saveWorkflow: (workflow: Workflow) => {
    set((s) => {
      const idx = s.workflows.findIndex((w) => w.id === workflow.id);
      const workflows = idx >= 0
        ? s.workflows.map((w) => (w.id === workflow.id ? workflow : w))
        : [...s.workflows, workflow];
      saveLocal('wassell_workflows', workflows);
      // FK: workflows.trigger_model_id → models.id. Gate on the model write.
      // Webhook-triggered workflows have no model — pass null so the gate
      // short-circuits instead of waiting on an id that never lands.
      supabaseUpsert(
        'workflows',
        workflowToSupabaseRow(workflow),
        { table: 'models', id: workflow.trigger_model_id || null },
      );
      return { workflows };
    });
  },
  deleteWorkflow: (workflowId: string) => {
    set((s) => {
      const workflows = s.workflows.filter((w) => w.id !== workflowId);
      saveLocal('wassell_workflows', workflows);
      supabaseDelete('workflows', workflowId);
      return { workflows };
    });
  },

  // --- Workflow folders (groups) ---
  saveWorkflowGroup: (group: WorkflowGroup) => {
    set((s) => {
      const idx = s.workflowGroups.findIndex((g) => g.id === group.id);
      const workflowGroups = idx >= 0
        ? s.workflowGroups.map((g) => (g.id === group.id ? group : g))
        : [...s.workflowGroups, group];
      saveLocal('wassell_workflow_groups', workflowGroups);
      supabaseUpsert('workflow_groups', group);
      return { workflowGroups };
    });
  },
  deleteWorkflowGroup: (groupId: string) => {
    set((s) => {
      // Postgres has `ON DELETE SET NULL` on workflows.group_id, so the
      // server nulls out any referring workflows automatically. Mirror
      // that in memory + localStorage so the list page doesn't keep
      // showing workflows nested under a folder that no longer exists.
      const workflowGroups = s.workflowGroups.filter((g) => g.id !== groupId);
      const touched: Workflow[] = [];
      const workflows = s.workflows.map((w) => {
        if (w.group_id !== groupId) return w;
        const updated: Workflow = { ...w, group_id: null, updated_at: new Date().toISOString() };
        touched.push(updated);
        return updated;
      });
      saveLocal('wassell_workflow_groups', workflowGroups);
      saveLocal('wassell_workflows', workflows);
      supabaseDelete('workflow_groups', groupId);
      // Belt-and-suspenders: re-upsert the orphaned workflows in case the
      // server's ON DELETE SET NULL didn't fire (offline mode).
      for (const w of touched) {
        supabaseUpsert('workflows', workflowToSupabaseRow(w));
      }
      return { workflowGroups, workflows };
    });
  },

  // --- Workflow execution logs (audit trail) ---
  appendWorkflowRun: (run: WorkflowRun) => {
    set((s) => {
      // Cap the in-memory + localStorage log to the most recent 500 runs so
      // busy projects don't bloat storage. Newest first (unshift semantics).
      const MAX_RUNS = 500;
      const next = [run, ...s.workflowRuns].slice(0, MAX_RUNS);
      saveLocal('wassell_workflow_runs', next);
      supabaseUpsert('workflow_runs', run);
      return { workflowRuns: next };
    });
    // Mirror a one-line summary into the unified activity log so workflow
    // runs show up in the same timeline as user CRUD, AI agent turns, etc.
    // The rich trace stays in `workflow_runs` and the LogsPage deep-links to
    // it via workflow_run_id.
    activityLogger.workflowRunSummary({
      runId: run.id,
      workflowId: run.workflow_id,
      workflowLabelAr: run.workflow_label_ar,
      workflowLabelEn: run.workflow_label_en,
      triggerEvent: run.trigger_event,
      triggerModelId: run.trigger_model_id ?? null,
      triggerRecordId: run.trigger_record_id ?? null,
      status: run.status,
      durationMs: run.duration_ms,
      actorUserId: run.triggered_by_user_id ?? null,
      error: run.error,
      actionsCount: run.actions_trace?.length ?? 0,
      conditionsPassed: run.conditions_passed,
    });
  },
  deleteWorkflowRun: (runId: string) => {
    set((s) => {
      const next = s.workflowRuns.filter((r) => r.id !== runId);
      saveLocal('wassell_workflow_runs', next);
      supabaseDelete('workflow_runs', runId);
      return { workflowRuns: next };
    });
  },
  clearWorkflowRuns: (workflowId?: string) => {
    set((s) => {
      const toDelete = workflowId ? s.workflowRuns.filter((r) => r.workflow_id === workflowId) : s.workflowRuns;
      const next = workflowId ? s.workflowRuns.filter((r) => r.workflow_id !== workflowId) : [];
      saveLocal('wassell_workflow_runs', next);
      for (const r of toDelete) supabaseDelete('workflow_runs', r.id);
      return { workflowRuns: next };
    });
  },
  fetchWorkflowRun: async (runId: string): Promise<WorkflowRun | null> => {
    // The detail page can be deep-linked to a run older than the recent-runs
    // boot window (only the newest ~500 are held in memory). Fetch that one row
    // on demand rather than loading the whole 100MB+ history.
    const cached = get().workflowRuns.find((r) => r.id === runId);
    if (cached) return cached;
    if (!supabase) return null;
    const { data, error } = await supabase.from('workflow_runs').select('*').eq('id', runId).maybeSingle();
    if (error) {
      reportSupabaseError('workflow_runs', 'load', error.message ?? String(error));
      return null;
    }
    return (data as WorkflowRun | null) ?? null;
  },

  // --- Unified activity log ---
  appendActivityLog: (input) => {
    const entry: ActivityLogEntry = {
      id: input.id ?? uuid(),
      created_at: input.created_at ?? new Date().toISOString(),
      category: input.category,
      event_type: input.event_type,
      actor_user_id: input.actor_user_id,
      actor_email: input.actor_email,
      target_model_id: input.target_model_id,
      target_record_id: input.target_record_id,
      target_label: input.target_label,
      summary_ar: input.summary_ar,
      summary_en: input.summary_en,
      details: input.details ?? {},
      duration_ms: input.duration_ms ?? null,
      status: input.status ?? null,
      error: input.error ?? null,
      workflow_run_id: input.workflow_run_id ?? null,
    };
    set((s) => {
      // Cap in-memory + localStorage at 200 so busy projects don't balloon
      // localStorage. Older entries live in Supabase and are paged in by
      // loadActivityLog when the admin opens /logs.
      const MAX_ENTRIES = 200;
      const next = [entry, ...s.activityLog].slice(0, MAX_ENTRIES);
      saveLocal('wassell_activity_log', next);
      supabaseUpsert('activity_log', entry);
      return { activityLog: next };
    });
  },
  loadActivityLog: async (limit = 500) => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      reportSupabaseError('activity_log', 'load', error.message ?? String(error));
      return;
    }
    if (data) {
      const entries = data as ActivityLogEntry[];
      saveLocal('wassell_activity_log', entries.slice(0, 200));
      set({ activityLog: entries });
    }
  },
  deleteActivityLog: (id: string) => {
    set((s) => {
      const next = s.activityLog.filter((e) => e.id !== id);
      saveLocal('wassell_activity_log', next.slice(0, 200));
      supabaseDelete('activity_log', id);
      return { activityLog: next };
    });
  },
  clearActivityLog: () => {
    set((s) => {
      const toDelete = s.activityLog;
      saveLocal('wassell_activity_log', []);
      // Best-effort: delete every visible entry. Older Supabase rows beyond
      // the in-memory cap are NOT cleared by this — admins can run a SQL
      // delete from Supabase Studio if a full purge is needed.
      for (const e of toDelete) supabaseDelete('activity_log', e.id);
      return { activityLog: [] };
    });
  },

  // --- Dashboards ---
  saveDashboard: (dashboard: Dashboard) => {
    // Guard (AnalyticsQuery HARD RULE): never persist a non-serializable or
    // structurally-invalid widget query. Fail loudly and abort — don't save.
    for (const w of dashboard.widgets) {
      const problem = analyticsQueryProblem(w.query);
      if (problem) {
        console.error('[saveDashboard] refusing to persist invalid widget query', w.id, problem);
        get().addToast(`${get().language === 'ar' ? 'تعذّر الحفظ' : 'Cannot save'} — "${w.title_en || w.title_ar || w.id}": ${problem}`, 'error');
        return;
      }
    }
    set((s) => {
      const idx = s.dashboards.findIndex((d) => d.id === dashboard.id);
      const dashboards = idx >= 0
        ? s.dashboards.map((d) => (d.id === dashboard.id ? dashboard : d))
        : [...s.dashboards, dashboard];
      saveLocal('wassell_dashboards', dashboards);
      supabaseUpsert('dashboards', dashboard);
      return { dashboards };
    });
  },
  deleteDashboard: (dashboardId: string) => {
    set((s) => {
      const dashboards = s.dashboards.filter((d) => d.id !== dashboardId);
      saveLocal('wassell_dashboards', dashboards);
      supabaseDelete('dashboards', dashboardId);
      return { dashboards };
    });
  },

  // --- Semantic metrics ---
  saveMetricDefinition: (metric: MetricDefinition) => {
    const problem = analyticsQueryProblem(metric.query);
    if (problem) {
      console.error('[saveMetricDefinition] refusing to persist invalid metric query', metric.id, problem);
      get().addToast(`${get().language === 'ar' ? 'تعذّر حفظ المقياس' : 'Cannot save metric'}: ${problem}`, 'error');
      return;
    }
    set((s) => {
      const idx = s.metricDefinitions.findIndex((m) => m.id === metric.id);
      const metricDefinitions = idx >= 0
        ? s.metricDefinitions.map((m) => (m.id === metric.id ? metric : m))
        : [...s.metricDefinitions, metric];
      saveLocal('wassell_metric_definitions', metricDefinitions);
      supabaseUpsert('metric_definitions', metric);
      return { metricDefinitions };
    });
  },
  deleteMetricDefinition: (metricId: string) => {
    set((s) => {
      const metricDefinitions = s.metricDefinitions.filter((m) => m.id !== metricId);
      saveLocal('wassell_metric_definitions', metricDefinitions);
      supabaseDelete('metric_definitions', metricId);
      return { metricDefinitions };
    });
  },

  // --- Scheduled reports ---
  saveScheduledReport: (report: ScheduledReport) => {
    set((s) => {
      const idx = s.scheduledReports.findIndex((r) => r.id === report.id);
      const scheduledReports = idx >= 0
        ? s.scheduledReports.map((r) => (r.id === report.id ? report : r))
        : [...s.scheduledReports, report];
      saveLocal('wassell_scheduled_reports', scheduledReports);
      supabaseUpsert('scheduled_reports', report);
      return { scheduledReports };
    });
  },
  deleteScheduledReport: (reportId: string) => {
    set((s) => {
      const scheduledReports = s.scheduledReports.filter((r) => r.id !== reportId);
      saveLocal('wassell_scheduled_reports', scheduledReports);
      supabaseDelete('scheduled_reports', reportId);
      return { scheduledReports };
    });
  },

  // --- Sales-process instruction overrides ---
  saveSalesProcessOverride: (override: SalesProcessOverride) => {
    set((s) => {
      const idx = s.salesProcessOverrides.findIndex((o) => o.id === override.id);
      const salesProcessOverrides = idx >= 0
        ? s.salesProcessOverrides.map((o) => (o.id === override.id ? override : o))
        : [...s.salesProcessOverrides, override];
      saveLocal('wassell_sales_process_overrides', salesProcessOverrides);
      supabaseUpsert('sales_process_overrides', override);
      return { salesProcessOverrides };
    });
  },

  // --- Sales Studio 2.0 — processes / versions / experiments / assignments ---
  saveSalesProcess: (process: SalesProcess) => {
    set((s) => {
      const idx = s.salesProcesses.findIndex((p) => p.id === process.id);
      const salesProcesses = idx >= 0
        ? s.salesProcesses.map((p) => (p.id === process.id ? process : p))
        : [...s.salesProcesses, process];
      saveLocal('wassell_sales_processes', salesProcesses);
      supabaseUpsert('sales_processes', process);
      return { salesProcesses };
    });
  },
  deleteSalesProcess: (processId: string) => {
    set((s) => {
      const salesProcesses = s.salesProcesses.filter((p) => p.id !== processId);
      // DB cascades versions; mirror that locally so the UI stays consistent.
      const salesProcessVersions = s.salesProcessVersions.filter((v) => v.sales_process_id !== processId);
      saveLocal('wassell_sales_processes', salesProcesses);
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      supabaseDelete('sales_processes', processId);
      return { salesProcesses, salesProcessVersions };
    });
  },
  setDefaultSalesProcess: async (processId: string) => {
    set((s) => {
      const salesProcesses = s.salesProcesses.map((p) => ({
        ...p,
        is_default: p.id === processId,
        status: (p.id === processId && p.status !== 'archived' ? 'active' : p.status) as SalesProcess['status'],
      }));
      saveLocal('wassell_sales_processes', salesProcesses);
      return { salesProcesses };
    });
    if (supabase) {
      const { error } = await supabase.rpc('sales_process_set_default', { p_process_id: processId });
      if (error) reportSupabaseError('sales_processes', 'rpc', error.message ?? String(error));
    } else {
      get().salesProcesses.forEach((p) => supabaseUpsert('sales_processes', p));
    }
  },
  saveSalesProcessVersion: (version: SalesProcessVersion) => {
    set((s) => {
      const idx = s.salesProcessVersions.findIndex((v) => v.id === version.id);
      const salesProcessVersions = idx >= 0
        ? s.salesProcessVersions.map((v) => (v.id === version.id ? version : v))
        : [...s.salesProcessVersions, version];
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      supabaseUpsert('sales_process_versions', version, { table: 'sales_processes', id: version.sales_process_id });
      return { salesProcessVersions };
    });
  },
  ensureDraftVersion: (processId: string) => {
    const s = get();
    const existing = s.salesProcessVersions.find((v) => v.sales_process_id === processId && v.status === 'draft');
    if (existing) return existing;
    const active = s.salesProcessVersions.find((v) => v.sales_process_id === processId && v.status === 'active');
    const maxNum = s.salesProcessVersions
      .filter((v) => v.sales_process_id === processId)
      .reduce((m, v) => Math.max(m, v.version_number), 0);
    const now = new Date().toISOString();
    const emptyConfig: SalesProcessVersionConfig = { steps: [], workflows: {}, schema_version: 1 };
    const draft: SalesProcessVersion = {
      id: uuid(),
      sales_process_id: processId,
      version_number: maxNum + 1,
      status: 'draft',
      config_json: active ? (JSON.parse(JSON.stringify(active.config_json)) as SalesProcessVersionConfig) : emptyConfig,
      published_at: null,
      published_by: null,
      created_at: now,
      updated_at: now,
    };
    set((st) => {
      const salesProcessVersions = [...st.salesProcessVersions, draft];
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      return { salesProcessVersions };
    });
    supabaseUpsert('sales_process_versions', draft, { table: 'sales_processes', id: processId });
    return draft;
  },
  publishSalesProcessVersion: async (versionId: string) => {
    const s = get();
    const target = s.salesProcessVersions.find((v) => v.id === versionId);
    if (!target) return;
    const processId = target.sales_process_id;
    const now = new Date().toISOString();
    set((st) => {
      const salesProcessVersions = st.salesProcessVersions.map((v) => {
        if (v.id === versionId) return { ...v, status: 'active' as const, published_at: now, updated_at: now };
        if (v.sales_process_id === processId && v.status === 'active') return { ...v, status: 'archived' as const, updated_at: now };
        return v;
      });
      const salesProcesses = st.salesProcesses.map((p) =>
        p.id === processId
          ? { ...p, active_version_id: versionId, status: (p.status === 'archived' ? p.status : 'active') as SalesProcess['status'], updated_at: now }
          : p);
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      saveLocal('wassell_sales_processes', salesProcesses);
      return { salesProcessVersions, salesProcesses };
    });
    if (supabase) {
      const { error } = await supabase.rpc('sales_process_publish_version', { p_version_id: versionId });
      if (error) reportSupabaseError('sales_process_versions', 'rpc', error.message ?? String(error));
    } else {
      const fresh = get();
      fresh.salesProcessVersions
        .filter((v) => v.sales_process_id === processId)
        .forEach((v) => supabaseUpsert('sales_process_versions', v, { table: 'sales_processes', id: processId }));
      const p = fresh.salesProcesses.find((x) => x.id === processId);
      if (p) supabaseUpsert('sales_processes', p);
    }
  },
  discardDraftVersion: (versionId: string) => {
    set((st) => {
      const target = st.salesProcessVersions.find((v) => v.id === versionId);
      if (!target || target.status !== 'draft') return {};
      const salesProcessVersions = st.salesProcessVersions.filter((v) => v.id !== versionId);
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      supabaseDelete('sales_process_versions', versionId);
      return { salesProcessVersions };
    });
  },
  saveSalesExperiment: (experiment: SalesExperiment) => {
    set((s) => {
      const idx = s.salesExperiments.findIndex((e) => e.id === experiment.id);
      const salesExperiments = idx >= 0
        ? s.salesExperiments.map((e) => (e.id === experiment.id ? experiment : e))
        : [...s.salesExperiments, experiment];
      saveLocal('wassell_sales_experiments', salesExperiments);
      supabaseUpsert('sales_experiments', experiment);
      return { salesExperiments };
    });
  },
  deleteSalesExperiment: (experimentId: string) => {
    set((s) => {
      const salesExperiments = s.salesExperiments.filter((e) => e.id !== experimentId);
      saveLocal('wassell_sales_experiments', salesExperiments);
      supabaseDelete('sales_experiments', experimentId);
      return { salesExperiments };
    });
  },
  assignClientToProcess: ({ clientId, processId, versionId, experimentId = null, group = null, reason = null }) => {
    const now = new Date().toISOString();
    const assignedBy = get().currentUserId;
    const priorActive = get().clientSalesProcessAssignments.filter((a) => a.client_id === clientId && a.is_active);
    const newRow: ClientSalesProcessAssignment = {
      id: uuid(),
      client_id: clientId,
      sales_process_id: processId,
      sales_process_version_id: versionId,
      sales_experiment_id: experimentId,
      experiment_group: group,
      assigned_at: now,
      assigned_by: assignedBy,
      assignment_reason: reason,
      is_active: true,
      created_at: now,
    };
    set((st) => {
      const clientSalesProcessAssignments = [
        ...st.clientSalesProcessAssignments.map((a) =>
          a.client_id === clientId && a.is_active ? { ...a, is_active: false } : a),
        newRow,
      ];
      saveLocal('wassell_client_sales_process_assignments', clientSalesProcessAssignments);
      return { clientSalesProcessAssignments };
    });
    // Persist sequentially so the deactivations land BEFORE the new active row —
    // the partial unique index allows only one is_active=true row per client.
    void (async () => {
      for (const a of priorActive) {
        await supabaseUpsert('client_sales_process_assignments', { ...a, is_active: false });
      }
      await supabaseUpsert('client_sales_process_assignments', newRow);
    })();
    // Mirror the assignment onto the client record's visible JSONB keys.
    const st = get();
    const clientsModel = st.models.find((m) => m.name === 'clients');
    if (clientsModel) {
      const client = (st.records[clientsModel.id] ?? []).find((r) => r.id === clientId);
      if (client) {
        get().saveRecord({
          ...client,
          data: {
            ...client.data,
            current_sales_process_id: processId,
            current_sales_process_version_id: versionId,
            current_sales_experiment_id: experimentId,
            experiment_group: group,
          },
        });
      }
    }
  },
  removeClientFromExperiment: (clientId: string) => {
    set((st) => {
      const clientSalesProcessAssignments = st.clientSalesProcessAssignments.map((a) =>
        a.client_id === clientId && a.is_active
          ? { ...a, sales_experiment_id: null, experiment_group: null }
          : a);
      saveLocal('wassell_client_sales_process_assignments', clientSalesProcessAssignments);
      const changed = clientSalesProcessAssignments.find((a) => a.client_id === clientId && a.is_active);
      if (changed) supabaseUpsert('client_sales_process_assignments', changed);
      return { clientSalesProcessAssignments };
    });
    const st = get();
    const clientsModel = st.models.find((m) => m.name === 'clients');
    const client = clientsModel ? (st.records[clientsModel.id] ?? []).find((r) => r.id === clientId) : undefined;
    if (client) {
      get().saveRecord({
        ...client,
        data: { ...client.data, current_sales_experiment_id: null, experiment_group: null },
      });
    }
  },
  applyExperimentAssignments: (experimentId: string) => {
    const s = get();
    const experiment = s.salesExperiments.find((e) => e.id === experimentId);
    if (!experiment) return 0;
    const clientsModel = s.models.find((m) => m.name === 'clients');
    const clients = clientsModel ? s.records[clientsModel.id] ?? [] : [];
    const resolved = resolveExperimentAssignments(experiment, clients);
    for (const r of resolved) {
      get().assignClientToProcess({
        clientId: r.clientId,
        processId: r.group === 'variant'
          ? versionProcessId(get().salesProcessVersions, experiment.variant_process_version_id)
          : versionProcessId(get().salesProcessVersions, experiment.control_process_version_id),
        versionId: r.versionId,
        experimentId: experiment.id,
        group: r.group,
        reason: r.reason,
      });
    }
    return resolved.length;
  },
  seedDefaultSalesProcess: () => {
    const s = get();
    if (s.salesProcesses.length > 0) return; // already seeded
    const now = new Date().toISOString();
    const processId = uuid();
    const versionId = uuid();
    const config = buildDefaultVersionConfig(s.workflows);
    const process: SalesProcess = {
      id: processId,
      name_ar: DEFAULT_PROCESS_NAME.ar,
      name_en: DEFAULT_PROCESS_NAME.en,
      description_ar: DEFAULT_PROCESS_DESCRIPTION.ar,
      description_en: DEFAULT_PROCESS_DESCRIPTION.en,
      status: 'active',
      is_default: true,
      active_version_id: versionId,
      created_by: s.currentUserId,
      created_at: now,
      updated_at: now,
    };
    const version: SalesProcessVersion = {
      id: versionId,
      sales_process_id: processId,
      version_number: 1,
      status: 'active',
      config_json: config,
      published_at: now,
      published_by: s.currentUserId,
      created_at: now,
      updated_at: now,
    };
    set((st) => {
      const salesProcesses = [...st.salesProcesses, process];
      const salesProcessVersions = [...st.salesProcessVersions, version];
      saveLocal('wassell_sales_processes', salesProcesses);
      saveLocal('wassell_sales_process_versions', salesProcessVersions);
      return { salesProcesses, salesProcessVersions };
    });
    supabaseUpsert('sales_processes', process);
    supabaseUpsert('sales_process_versions', version, { table: 'sales_processes', id: processId });
  },

  // --- App-level WhatsApp composer ---
  openChatComposer: (target) => set({ chatComposerTarget: target }),
  closeChatComposer: () => set({ chatComposerTarget: null }),

  // --- Whiteboards ---
  createWhiteboardFolder: (name: string) => {
    const folder: WhiteboardFolder = {
      id: uuid(),
      name: name.trim(),
      order: get().whiteboardFolders.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    set((s) => {
      const whiteboardFolders = [...s.whiteboardFolders, folder];
      saveLocal('wassell_whiteboard_folders', whiteboardFolders);
      supabaseUpsert('whiteboard_folders', folder);
      return { whiteboardFolders };
    });
    return folder;
  },
  renameWhiteboardFolder: (folderId: string, name: string) => {
    set((s) => {
      const whiteboardFolders = s.whiteboardFolders.map((f) =>
        f.id === folderId
          ? { ...f, name: name.trim(), updated_at: new Date().toISOString() }
          : f,
      );
      saveLocal('wassell_whiteboard_folders', whiteboardFolders);
      const updated = whiteboardFolders.find((f) => f.id === folderId);
      if (updated) supabaseUpsert('whiteboard_folders', updated);
      return { whiteboardFolders };
    });
  },
  deleteWhiteboardFolder: (folderId: string) => {
    set((s) => {
      // DB has ON DELETE SET NULL on whiteboards.folder_id, so boards survive
      // — mirror that locally by clearing folder_id on affected boards.
      const whiteboards = s.whiteboards.map((b) =>
        b.folder_id === folderId
          ? { ...b, folder_id: null, updated_at: new Date().toISOString() }
          : b,
      );
      const whiteboardFolders = s.whiteboardFolders.filter((f) => f.id !== folderId);
      saveLocal('wassell_whiteboard_folders', whiteboardFolders);
      saveLocal('wassell_whiteboards', whiteboards);
      supabaseDelete('whiteboard_folders', folderId);
      return { whiteboardFolders, whiteboards };
    });
  },

  createWhiteboard: (name: string, folderId: string | null) => {
    const board: Whiteboard = {
      id: uuid(),
      folder_id: folderId,
      name: name.trim(),
      snapshot: null,
      order: get().whiteboards.filter((b) => b.folder_id === folderId).length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    set((s) => {
      const whiteboards = [...s.whiteboards, board];
      saveLocal('wassell_whiteboards', whiteboards);
      supabaseUpsert('whiteboards', board);
      return { whiteboards };
    });
    return board;
  },
  renameWhiteboard: (boardId: string, name: string) => {
    set((s) => {
      const whiteboards = s.whiteboards.map((b) =>
        b.id === boardId ? { ...b, name: name.trim(), updated_at: new Date().toISOString() } : b,
      );
      saveLocal('wassell_whiteboards', whiteboards);
      const updated = whiteboards.find((b) => b.id === boardId);
      if (updated) supabaseUpsert('whiteboards', updated);
      return { whiteboards };
    });
  },
  deleteWhiteboard: (boardId: string) => {
    set((s) => {
      const whiteboards = s.whiteboards.filter((b) => b.id !== boardId);
      saveLocal('wassell_whiteboards', whiteboards);
      supabaseDelete('whiteboards', boardId);
      return { whiteboards };
    });
  },
  moveWhiteboard: (boardId: string, folderId: string | null) => {
    set((s) => {
      const whiteboards = s.whiteboards.map((b) =>
        b.id === boardId ? { ...b, folder_id: folderId, updated_at: new Date().toISOString() } : b,
      );
      saveLocal('wassell_whiteboards', whiteboards);
      const updated = whiteboards.find((b) => b.id === boardId);
      if (updated) supabaseUpsert('whiteboards', updated);
      return { whiteboards };
    });
  },
  saveWhiteboardSnapshot: (boardId: string, snapshot: unknown) => {
    set((s) => {
      const whiteboards = s.whiteboards.map((b) =>
        b.id === boardId ? { ...b, snapshot, updated_at: new Date().toISOString() } : b,
      );
      saveLocal('wassell_whiteboards', whiteboards);
      const updated = whiteboards.find((b) => b.id === boardId);
      if (updated) supabaseUpsert('whiteboards', updated);
      return { whiteboards };
    });
  },

  // --- Views (saved table configurations, per-model, per-user, optionally shared) ---
  saveView: (view: ModelView) => {
    set((s) => {
      const idx = s.views.findIndex((v) => v.id === view.id);
      let views = idx >= 0
        ? s.views.map((v) => (v.id === view.id ? view : v))
        : [...s.views, view];
      // Enforce at most one default per (model_id, user_id): if this view is default,
      // clear any other default held by the same author on the same model.
      if (view.is_default) {
        views = views.map((v) =>
          v.id !== view.id && v.model_id === view.model_id && v.user_id === view.user_id && v.is_default
            ? { ...v, is_default: false, updated_at: new Date().toISOString() }
            : v,
        );
      }
      saveLocal('wassell_views', views);
      // FK: model_views.model_id → models.id.
      supabaseUpsert(
        'model_views',
        view,
        { table: 'models', id: view.model_id },
      );
      return { views };
    });
  },
  deleteView: (viewId: string) => {
    set((s) => {
      const views = s.views.filter((v) => v.id !== viewId);
      saveLocal('wassell_views', views);
      supabaseDelete('model_views', viewId);
      return { views };
    });
  },
  setDefaultView: (modelId: string, userId: string, viewId: string | null) => {
    set((s) => {
      const now = new Date().toISOString();
      const views = s.views.map((v) => {
        if (v.model_id !== modelId || v.user_id !== userId) return v;
        const shouldBeDefault = v.id === viewId;
        if (v.is_default === shouldBeDefault) return v;
        const updated = { ...v, is_default: shouldBeDefault, updated_at: now };
        supabaseUpsert(
          'model_views',
          updated,
          { table: 'models', id: updated.model_id },
        );
        return updated;
      });
      saveLocal('wassell_views', views);
      return { views };
    });
  },

  // --- Users ---
  saveUser: (user: User): StoreMutationResult => {
    const s = get();
    // Invariant: user must have a valid profile assigned.
    if (!user.profile_id || !s.profiles.some((p) => p.id === user.profile_id)) {
      return { ok: false, reason: 'missing_profile' };
    }
    // Invariant: deactivating the last active admin is blocked.
    const existing = s.users.find((u) => u.id === user.id);
    const becomingInactive = existing?.is_active === true && user.is_active === false;
    const leavingAdmin =
      existing?.profile_id &&
      s.profiles.find((p) => p.id === existing.profile_id)?.is_admin === true &&
      s.profiles.find((p) => p.id === user.profile_id)?.is_admin !== true;
    if (becomingInactive || leavingAdmin) {
      const adminProfileIds = new Set(s.profiles.filter((p) => p.is_admin).map((p) => p.id));
      const remainingActiveAdmins = s.users.filter((u) => {
        if (u.id === user.id) {
          // Use the incoming values for this user
          return user.is_active && adminProfileIds.has(user.profile_id);
        }
        return u.is_active && adminProfileIds.has(u.profile_id);
      });
      if (remainingActiveAdmins.length === 0) {
        return { ok: false, reason: 'last_admin' };
      }
    }
    set((state) => {
      const idx = state.users.findIndex((u) => u.id === user.id);
      const users = idx >= 0
        ? state.users.map((u) => (u.id === user.id ? user : u))
        : [...state.users, user];
      saveLocal('wassell_users', users);
      // FK: users.profile_id → profiles.id. Gate on the profile write so a
      // user assigned to a newly-created profile doesn't race past it.
      supabaseUpsert(
        'users',
        user,
        { table: 'profiles', id: user.profile_id },
      );
      // Audit log — fire and forget. Distinguish create / update /
      // deactivate / activate so the log page can surface the meaningful
      // distinction. existing is captured BEFORE set runs.
      const before = existing ?? null;
      let action: 'created' | 'updated' | 'deactivated' | 'activated' = 'updated';
      if (!before) action = 'created';
      else if (before.is_active === true && user.is_active === false) action = 'deactivated';
      else if (before.is_active === false && user.is_active === true) action = 'activated';
      void writeAuditLog({
        entityType: 'user',
        action,
        entityId: user.id,
        entityLabel: user.email,
        before,
        after: user,
      });
      return { users };
    });
    return { ok: true };
  },
  deleteUser: (userId: string): StoreMutationResult => {
    const s = get();
    if (userId === s.currentUserId) {
      return { ok: false, reason: 'self_delete' };
    }
    const target = s.users.find((u) => u.id === userId);
    if (!target) return { ok: true }; // already gone — idempotent
    const adminProfileIds = new Set(s.profiles.filter((p) => p.is_admin).map((p) => p.id));
    const wasActiveAdmin = target.is_active && adminProfileIds.has(target.profile_id);
    if (wasActiveAdmin) {
      const remaining = s.users.filter(
        (u) => u.id !== userId && u.is_active && adminProfileIds.has(u.profile_id),
      );
      if (remaining.length === 0) {
        return { ok: false, reason: 'last_admin' };
      }
    }
    set((state) => {
      const users = state.users.filter((u) => u.id !== userId);
      saveLocal('wassell_users', users);
      supabaseDelete('users', userId);
      void writeAuditLog({
        entityType: 'user',
        action: 'deleted',
        entityId: userId,
        entityLabel: target.email,
        before: target,
        after: null,
      });
      return { users };
    });
    return { ok: true };
  },
  setCurrentUser: (userId: string | null) => {
    saveLocal('wassell_current_user_id', userId);
    // Switching identity ends any profile preview — the preview grant and
    // perspective belong to the previous user.
    saveLocal('wassell_preview_profile_id', '');
    set({ currentUserId: userId, previewProfileId: null });
  },
  setPreviewProfile: (profileId: string | null) => {
    saveLocal('wassell_preview_profile_id', profileId ?? '');
    set({ previewProfileId: profileId });
  },

  // --- Profiles ---
  saveProfile: (profile: Profile) => {
    set((s) => {
      // Heal each scope condition's `field_slug` from the model schema so the
      // SQL-side RLS evaluator can read it directly without joining `models`.
      // No-op for already-healed conditions and for `created_by`-target rules
      // (they don't reference a model field).
      const healed: Profile = {
        ...profile,
        model_permissions: profile.model_permissions.map((mp) => {
          const model = s.models.find((m) => m.id === mp.model_id);
          if (!model) return mp;
          const healScope = (rule?: Profile['model_permissions'][number]['view_scope']) => {
            if (!rule || rule.mode !== 'filtered') return rule;
            return {
              ...rule,
              conditions: rule.conditions.map((c) => {
                if (c.field.kind !== 'field' || c.field.field_slug) return c;
                const targetId = c.field.field_id;
                const f = model.schema.sections
                  .flatMap((sec) => sec.fields)
                  .find((ff) => ff.id === targetId);
                return f ? { ...c, field: { ...c.field, field_slug: f.name } } : c;
              }),
            };
          };
          return {
            ...mp,
            view_scope: healScope(mp.view_scope),
            edit_scope: healScope(mp.edit_scope),
          };
        }),
      };
      const idx = s.profiles.findIndex((p) => p.id === healed.id);
      const before = idx >= 0 ? s.profiles[idx] : null;
      const profiles = idx >= 0
        ? s.profiles.map((p) => (p.id === healed.id ? healed : p))
        : [...s.profiles, healed];
      saveLocal('wassell_profiles', profiles);
      supabaseUpsert('profiles', healed);
      void writeAuditLog({
        entityType: 'profile',
        action: before ? 'updated' : 'created',
        entityId: healed.id,
        entityLabel: healed.label_en || healed.label_ar,
        before,
        after: healed,
      });
      return { profiles };
    });
  },
  deleteProfile: (profileId: string): StoreMutationResult => {
    const s = get();
    const target = s.profiles.find((p) => p.id === profileId);
    if (target?.is_system) return { ok: false, reason: 'is_system' };
    if (s.users.some((u) => u.profile_id === profileId)) {
      return { ok: false, reason: 'has_users' };
    }
    set((state) => {
      const before = state.profiles.find((p) => p.id === profileId) ?? null;
      const profiles = state.profiles.filter((p) => p.id !== profileId);
      saveLocal('wassell_profiles', profiles);
      supabaseDelete('profiles', profileId);
      if (before) {
        void writeAuditLog({
          entityType: 'profile',
          action: 'deleted',
          entityId: profileId,
          entityLabel: before.label_en || before.label_ar,
          before,
          after: null,
        });
      }
      return { profiles };
    });
    return { ok: true };
  },

  // --- Roles ---
  saveRole: (role: Role) => {
    set((s) => {
      const idx = s.roles.findIndex((r) => r.id === role.id);
      const before = idx >= 0 ? s.roles[idx] : null;
      const roles = idx >= 0
        ? s.roles.map((r) => (r.id === role.id ? role : r))
        : [...s.roles, role];
      saveLocal('wassell_roles', roles);
      supabaseUpsert('roles', role);
      void writeAuditLog({
        entityType: 'role',
        action: before ? 'updated' : 'created',
        entityId: role.id,
        entityLabel: role.label_en || role.label_ar,
        before,
        after: role,
      });
      return { roles };
    });
  },
  deleteRole: (roleId: string): StoreMutationResult => {
    const s = get();
    const target = s.roles.find((r) => r.id === roleId);
    if (target?.is_system) return { ok: false, reason: 'is_system' };
    set((state) => {
      const roles = state.roles.filter((r) => r.id !== roleId);
      // Cascade: remove any role_assignments pointing at the deleted role from
      // every user. Mirrors deleteModel's record cleanup.
      const users = state.users.map((u) => {
        if (!u.role_assignments.some((ra) => ra.role_id === roleId)) return u;
        const next = {
          ...u,
          role_assignments: u.role_assignments.filter((ra) => ra.role_id !== roleId),
          updated_at: new Date().toISOString(),
        };
        supabaseUpsert(
          'users',
          next,
          { table: 'profiles', id: next.profile_id },
        );
        return next;
      });
      saveLocal('wassell_roles', roles);
      saveLocal('wassell_users', users);
      supabaseDelete('roles', roleId);
      if (target) {
        void writeAuditLog({
          entityType: 'role',
          action: 'deleted',
          entityId: roleId,
          entityLabel: target.label_en || target.label_ar,
          before: target,
          after: null,
        });
      }
      return { roles, users };
    });
    return { ok: true };
  },

  // --- Field templates ---
  saveFieldTemplate: (template: FieldTemplate) => {
    set((s) => {
      const idx = s.fieldTemplates.findIndex((t) => t.id === template.id);
      const fieldTemplates = idx >= 0
        ? s.fieldTemplates.map((t) => (t.id === template.id ? template : t))
        : [...s.fieldTemplates, template];
      saveLocal('wassell_field_templates', fieldTemplates);
      supabaseUpsert('field_templates', template);
      return { fieldTemplates };
    });
  },
  deleteFieldTemplate: (templateId: string) => {
    set((s) => {
      const fieldTemplates = s.fieldTemplates.filter((t) => t.id !== templateId);
      saveLocal('wassell_field_templates', fieldTemplates);
      supabaseDelete('field_templates', templateId);
      return { fieldTemplates };
    });
  },

  // ────────────────────────────────────────────────────────────────────
  // Auth actions
  // ────────────────────────────────────────────────────────────────────

  /**
   * Read the cached Supabase session once at startup, then subscribe to
   * future auth events. Sets `authEmail` + `authReady` so the App-level
   * RequireAuth gate can decide whether to render the app or the login page.
   *
   * When a sign-in is detected after the initial load, we re-run `initialize`
   * so the current user / permissions pick up immediately without a reload.
   * When a sign-out is detected we clear the in-memory user and data.
   */
  bindAuth: async () => {
    // Initial read — synchronous for the app-level gate's first render.
    const initialSession = await getSession();
    const initialEmail = getSessionEmail(initialSession);
    const initialUid = getSessionUid(initialSession);
    set({ authEmail: initialEmail, authUid: initialUid, authReady: true });

    // Subscribe to future events. The callback may fire many times
    // (sign-in, sign-out, token refresh, password-recovery).
    onAuthChange((session) => {
      const email = getSessionEmail(session);
      const uid = getSessionUid(session);
      const prev = get().authEmail;
      if (email === prev) {
        // Token-refresh: the email is unchanged but the auth_uid should
        // already be set; refresh the in-memory copy in case Supabase
        // returned a fresh session with the same user.
        if (uid !== get().authUid) set({ authUid: uid });
        return;
      }
      set({ authEmail: email, authUid: uid });
      // If the user just signed in, re-run initialize so the user record,
      // permissions, and data all reflect the new identity.
      if (email && get().initialized) {
        // Reset the `initialized` flag so initialize runs fresh.
        set({ initialized: false });
        void get().initialize().then(() => {
          // Activity log — fire AFTER initialize so currentUserId is wired.
          // Skip when prev was already non-null (token refresh that hit a new
          // email — extremely rare; we'd rather miss the log than spam).
          if (!prev) {
            const userId = useAppStore.getState().currentUserId;
            activityLogger.signIn(email, userId);
          }
        });
      } else if (email && !prev) {
        // First-load case: bindAuth hasn't run initialize yet (App.tsx awaits
        // initialize separately). Defer one tick so currentUserId resolves.
        setTimeout(() => {
          const userId = useAppStore.getState().currentUserId;
          activityLogger.signIn(email, userId);
        }, 100);
      }
      // If the user just signed out, wipe in-memory state. We keep
      // localStorage intact — the next sign-in will re-hydrate instantly.
      if (!email) {
        // Activity log — capture who was signed out before we clear state.
        const prevUserId = get().currentUserId;
        activityLogger.signOut(prev, prevUserId);
        set({
          currentUserId: null,
          authUid: null,
          // Keep the data arrays intact; clearing them would cause a flash of
          // "empty app" as the login page routes in. The RequireAuth gate
          // blocks render before anyone sees it.
        });
      }
    });
  },

  /**
   * Sign out of Supabase Auth and clear the in-memory current user. Safe to
   * call even when auth isn't configured (no-op in that case).
   */
  signOutAndClear: async () => {
    // Capture identity BEFORE we clear it so the activity log records who
    // signed out. The onAuthChange callback in bindAuth also fires its own
    // sign_out log; both go through the dedupe-by-id path on the server,
    // so the worst case is one row instead of two.
    const prevEmail = get().authEmail;
    const prevUserId = get().currentUserId;
    await authSignOut();
    // authEmail is cleared by the onAuthChange callback in bindAuth, but we
    // also do it synchronously here so the UI updates without waiting for the
    // subscription round-trip.
    set({ authEmail: null, authUid: null, currentUserId: null, previewProfileId: null });
    saveLocal('wassell_current_user_id', '');
    saveLocal('wassell_preview_profile_id', '');
    if (prevEmail) {
      activityLogger.signOut(prevEmail, prevUserId);
    }
  },

  // ── Chats module: WhatsApp numbers ────────────────────────────────
  // `waDevices` is the local overlay (friendly names + default flag),
  // `waDevicesLive` is the authoritative Haberchat-side state fetched
  // through our proxy. The Settings page merges them at render time.
  loadWhatsAppNumbers: async () => {
    // Local overlay first — survives if Haberchat proxy is unreachable.
    // whatsapp_numbers has no `id` column (PK = device_id) → key the loader on it.
    let overlay = await supabaseLoad<WhatsAppNumber>('whatsapp_numbers', { idColumn: 'device_id' });
    if (!overlay) overlay = loadLocal<WhatsAppNumber[]>('wassell_wa_numbers') ?? [];
    saveLocal('wassell_wa_numbers', overlay);
    set({ waDevices: overlay });

    // Live list — tolerated to fail (admin still sees the overlay even
    // if HABERCHAT_TOKEN is misconfigured). We re-throw after the overlay
    // is in place so the calling page can render an error banner; the
    // overlay update already happened so nothing is lost on partial failure.
    const live = await listHaberchatDevices();
    set({ waDevicesLive: live });
  },

  saveWhatsAppNumber: async (entry: WhatsAppNumber) => {
    const next: WhatsAppNumber = {
      ...entry,
      updated_at: new Date().toISOString(),
    };
    set((s) => {
      // If this row is being set as default, clear the flag on every other row.
      const normalized = next.is_default
        ? s.waDevices.map((d) => (d.device_id === next.device_id ? next : { ...d, is_default: false }))
        : s.waDevices.some((d) => d.device_id === next.device_id)
          ? s.waDevices.map((d) => (d.device_id === next.device_id ? next : d))
          : [...s.waDevices, next];
      saveLocal('wassell_wa_numbers', normalized);
      return { waDevices: normalized };
    });
    // whatsapp_numbers.device_id is the PK, so supabase-js infers onConflict.
    // The generic supabaseUpsert works even though `row.id` is undefined —
    // the write still succeeds; it just isn't tracked in `pendingWrites`.
    await supabaseUpsert('whatsapp_numbers', next);
  },

  loadChatsFromHaberchat: async () => {
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) return;

    // Figure out which devices to sync. Preferred: active rows in the local
    // overlay. Fallback: every live device from Haberchat (if we never
    // populated the overlay). This lets the first-ever Chats page visit
    // work before the admin opens /settings/whatsapp-numbers.
    let deviceIds: string[] = state.waDevices.filter((d) => d.is_active).map((d) => d.device_id);
    if (deviceIds.length === 0) {
      // Best-effort: fetch live device list once; if that fails too, bail
      // quietly so the list page can still render its local view.
      try {
        const live = await listHaberchatDevices();
        set({ waDevicesLive: live });
        deviceIds = live.map((d) => d.id);
      } catch (err) {
        console.warn('[loadChatsFromHaberchat] could not resolve any device:', err);
        return;
      }
    }
    if (deviceIds.length === 0) return;

    // Fetch each device's chats in parallel. A single failed device
    // shouldn't block the others — collect failures and log them.
    const results = await Promise.allSettled(deviceIds.map((id) => listHaberchatChats(id).then((chats) => ({ id, chats }))));

    const existing = state.records[chatsModel.id] ?? [];
    const byId = new Map<string, AppRecord>(existing.map((r) => [r.id, r]));
    let changed = false;

    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[loadChatsFromHaberchat] device sync failed:', r.reason);
        continue;
      }
      const { id: deviceId, chats } = r.value;
      for (const chat of chats) {
        const candidate = mergeChatIntoRecord(null, chat, deviceId, chatsModel.id);
        const prev = byId.get(candidate.id) ?? null;
        // A gateway chat addressed by LID is the SAME human as an existing
        // phone-keyed chat, under WhatsApp's other identity. Minting a record
        // for it produced a duplicate of every client conversation — 266 empty
        // shells against 292 real chats, so the rep saw each client twice and
        // the copy they opened had no history (live 2026-07-26).
        //
        // Only track a LID chat we already know: conversations still appear the
        // moment a message arrives, because the webhook creates the record then
        // — and it resolves the phone when WhatsApp gives us one.
        if (!prev && String(chat.wid ?? '').endsWith('@lid')) continue;
        const next = mergeChatIntoRecord(prev, chat, deviceId, chatsModel.id);
        byId.set(next.id, next);
        changed = true;
      }
    }

    if (!changed) return;

    // Resolve client_link for any chat that isn't attached to a LIVE
    // client. Matches by digits-only phone compare so format differences
    // ("+966...", "0...", "966...") don't block. A `client_link` pointing
    // to a since-deleted client is treated as unlinked — that's the only
    // way a chat picks up a freshly-recreated client with the same phone.
    // Never overwrites a link to a live client — admins may have manually
    // linked to someone other than the phone owner and we respect that.
    const clientsModel = state.models.find((m) => m.name === 'clients');
    const clientRecords = clientsModel ? (state.records[clientsModel.id] ?? []) : [];
    const clientPhoneSlugs = phoneFieldSlugs(clientsModel);
    const merged = [...byId.values()].map((rec) => {
      const data = rec.data as Record<string, unknown>;
      if (isLiveClient(data.client_link, clientRecords)) return rec;
      const link = resolveClientLink(data.phone as string | null | undefined, clientRecords, clientPhoneSlugs);
      if (!link || link === data.client_link) return rec;
      return { ...rec, data: { ...data, client_link: link } };
    });

    set((s) => {
      const nextRecords = { ...s.records, [chatsModel.id]: merged };
      // Persist the chats bucket so a refresh keeps the list even if Haberchat
      // is offline on next load.
      saveLocalRecordsForModel(chatsModel.id, merged);
      return { records: nextRecords };
    });

    // Background Supabase upsert of every chat record. Done per-row so one
    // row's failure doesn't abort the rest. No FK parent gating needed —
    // the chats model itself is already in Supabase.
    for (const rec of merged) {
      // Intentionally not awaited — fire-and-forget batched via microtask.
      void supabaseUpsert('records', rec);
    }
  },

  loadMessagesForChat: async (chatWid: string, opts: { before?: string; size?: number } = {}) => {
    if (!chatWid) return { hasMore: false };
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) return { hasMore: false };

    // Find the parent conversation record so we know which device to query.
    const record = (state.records[chatsModel.id] ?? []).find((r) => {
      const wid = (r.data as Record<string, unknown>).wid;
      return typeof wid === 'string' && wid === chatWid;
    });
    // deviceIdString guards against the legacy corrupt shape where the
    // webhook persisted the whole device OBJECT — a raw cast produced
    // "deviceId=[object Object]" proxy calls that 400'd the thread load.
    // (Extracts the object's id when possible, so multi-device setups still
    // hit the right device instead of falling back to the default.)
    const recordDeviceId = record ? deviceIdString((record.data as Record<string, unknown>).device_id) : null;

    // Pick the device: record's own device_id first, else the overlay
    // default, else the first active device. This lets us load messages
    // even if the chats list hasn't been refreshed yet this session.
    const fallbackDevice =
      state.waDevices.find((d) => d.is_default && d.is_active)?.device_id ??
      state.waDevices.find((d) => d.is_active)?.device_id ??
      state.waDevicesLive[0]?.id ??
      null;
    const deviceId = recordDeviceId ?? fallbackDevice;
    if (!deviceId) {
      console.warn('[loadMessagesForChat] no deviceId available — is a number set as default in Settings?');
      return { hasMore: false };
    }

    // ── OUR DATABASE IS THE THREAD. The gateway only supplements it. ────────
    //
    // This used to be the other way round: fetch from the gateway, and fall
    // back to `chat_messages` only inside a `catch`. That fallback fires on an
    // EXCEPTION, and the gateway does not throw when it has no history — it
    // answers 200 with `[]`. After the 2026-07-24 re-pair it had nothing for
    // most chats, so 57 of the 68 busiest conversations rendered the
    // "No messages in this conversation yet" empty state while their history
    // sat intact in our own table (1,655 messages invisible, measured
    // 2026-07-28).
    //
    // So: always read the mirror, treat the gateway as an optional extra that
    // can only ADD messages, and never let its answer — empty, short or
    // missing — decide what the thread contains.
    const mirror = await loadMessagesFromMirror(chatWid, opts);

    let gatewayMessages: ChatMessage[] = [];
    let gatewayHasMore = false;
    try {
      const live = await listHaberchatMessages(deviceId, chatWid, opts);
      gatewayMessages = live.messages;
      gatewayHasMore = live.hasMore;
    } catch (err) {
      // Entirely non-fatal now — the mirror already has the thread.
      console.warn('[loadMessagesForChat] gateway history unavailable (mirror still rendered):', err);
    }

    if (!mirror && gatewayMessages.length === 0) {
      // No Supabase AND no gateway — nothing to show, and nothing to claim.
      return { hasMore: false };
    }

    // Reactions live ONLY in our mirror (the gateway's history API returns
    // messages, not reactions), so they are loaded separately either way.
    const reactions = await loadReactionsFromMirror(chatWid);

    set((s) => {
      const existing = s.chatMessages[chatWid] ?? [];
      // Trust order: our mirror → what we already hold → the gateway.
      //
      // The mirror leads because it is the only source that reflects EDITS and
      // DELETIONS: a revoked message is re-kinded and emptied there, and an
      // in-memory copy from before the deletion would otherwise keep showing
      // the withdrawn text. In-flight optimistic bubbles are not lost by this
      // ordering — until they are confirmed their id is `pending:<uuid>`, which
      // is an identity of its own and collides with nothing.
      //
      // Merged on the STABLE message identity, so the same message reported as
      // `…@c.us_<HASH>` by one source and `…@lid_<HASH>` by the other collapses
      // into one bubble instead of two.
      const merged = mergeMessageSources(
        mirror?.messages ?? [],
        existing,
        gatewayMessages,
        reactions,
      );
      return { chatMessages: { ...s.chatMessages, [chatWid]: merged } };
    });

    // Paging follows the mirror, which is the complete record. The gateway can
    // still report more when it holds history we have not ingested.
    return { hasMore: (mirror?.hasMore ?? false) || gatewayHasMore };
  },

  sendChatMessage: async (
    chatWid: string,
    input: {
      body?: string;
      quotedWid?: string;
      mediaFileId?: string;
      mediaCaption?: string;
      kind?: ChatMessage['kind'];
      mediaMime?: string | null;
      mediaSize?: number | null;
      /** Future ISO datetime — schedule instead of sending now. The message
       *  waits in Haberchat's delivery queue (no thread bubble until it
       *  actually sends and the webhook echoes it). */
      deliverAt?: string;
    },
  ) => {
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) throw new Error('chats model not found');

    const record = (state.records[chatsModel.id] ?? []).find((r) => {
      const wid = (r.data as Record<string, unknown>).wid;
      return typeof wid === 'string' && wid === chatWid;
    });
    if (!record) throw new Error('conversation not found in records');

    const data = record.data as Record<string, unknown>;
    const convKind = (data.kind as string | null) ?? 'user';
    if (convKind !== 'user') {
      throw new Error(get().language === 'ar'
        ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا'
        : 'Sending to groups and channels is not yet supported');
    }
    const phone = data.phone as string | null;
    if (!phone) throw new Error('conversation is missing the recipient phone');

    const body = input.body?.trim() || undefined;
    const mediaFileId = input.mediaFileId || undefined;
    if (!body && !mediaFileId) {
      throw new Error(get().language === 'ar'
        ? 'يلزم نص أو مرفق للإرسال'
        : 'Body or attachment is required');
    }

    // deviceIdString: legacy webhook-created chats can carry the whole
    // device OBJECT in data.device_id — sending with it 400s at Haberchat.
    const recordDeviceId = deviceIdString(data.device_id);
    const deviceId =
      recordDeviceId ??
      state.waDevices.find((d) => d.is_default && d.is_active)?.device_id ??
      state.waDevices.find((d) => d.is_active)?.device_id ??
      state.waDevicesLive[0]?.id ??
      '';
    if (!deviceId) throw new Error('no WhatsApp device configured to send from');

    const fromPhone =
      state.waDevicesLive.find((d) => d.id === deviceId)?.phone ??
      state.waDevices.find((d) => d.device_id === deviceId)?.phone ??
      null;

    // Scheduled send — hand the message to Haberchat's delivery queue and
    // stop. No optimistic bubble: nothing has been sent yet, and the normal
    // message:out webhook will echo it into the thread at delivery time.
    // Errors propagate to the caller (Composer toasts them).
    if (input.deliverAt) {
      await sendHaberchatMessage({
        deviceId,
        phone,
        body,
        mediaFileId,
        mediaCaption: input.mediaCaption,
        quotedWid: input.quotedWid,
        reference: uuid(),
        deliverAt: input.deliverAt,
      });
      return;
    }

    // Pick the bubble kind. If caller supplied one, use that. Else infer
    // from whether there's media (guessing 'image' is safer than 'document'
    // for display purposes — the webhook echo corrects it anyway).
    const bubbleKind: ChatMessage['kind'] =
      input.kind ??
      (mediaFileId
        ? (input.mediaMime?.startsWith('image/') ? 'image'
         : input.mediaMime?.startsWith('video/') ? 'video'
         : input.mediaMime?.startsWith('audio/') ? 'audio'
         : 'document')
        : 'text');

    // IDEMPOTENCY KEY (WA-12). The server treats `reference` as the identity of
    // one logical send and replays the original result instead of sending
    // twice. That only works if a repeat carries the SAME key — and a
    // double-click minted a fresh uuid each time, so two requests looked like
    // two different messages and the customer received both.
    //
    // Keyed on (chat, body, attachment): the same text to the same chat while
    // the first attempt is still in flight is a double-click, not someone
    // deliberately sending the same sentence twice inside a second. The key is
    // released when the attempt settles, so genuinely repeating yourself still
    // works.
    const dedupeKey = `${chatWid}|${body ?? ''}|${mediaFileId ?? ''}`;
    const inFlight = inFlightSends.get(dedupeKey);
    if (inFlight) console.warn('[sendChatMessage] identical send already in flight — reusing its idempotency key');
    const clientId = inFlight ?? uuid();
    inFlightSends.set(dedupeKey, clientId);
    const placeholder: ChatMessage = {
      id: `pending:${clientId}`,
      chat_wid: chatWid,
      flow: 'out',
      kind: bubbleKind,
      body: body ?? null,
      from_phone: fromPhone,
      to_phone: phone,
      ack: 'pending',
      date: new Date().toISOString(),
      media_file_id: mediaFileId ?? null,
      media_mime: input.mediaMime ?? null,
      media_size: input.mediaSize ?? null,
      media_caption: input.mediaCaption ?? null,
      reference: clientId,
      quoted: null,
      pending: true,
      client_id: clientId,
    };
    set((s) => {
      const existing = s.chatMessages[chatWid] ?? [];
      return { chatMessages: { ...s.chatMessages, [chatWid]: [...existing, placeholder] } };
    });

    try {
      const result = await sendHaberchatMessage({
        deviceId,
        phone,
        body,
        mediaFileId,
        mediaCaption: input.mediaCaption,
        quotedWid: input.quotedWid,
        reference: clientId,
      });
      // Swap the placeholder for a real row keyed by the server wid. We
      // keep the ack as 'sent' until the message:out:ack webhook upgrades
      // it to delivered/read (that lands in Step 8).
      set((s) => {
        const existing = s.chatMessages[chatWid] ?? [];
        const next = existing.map((m) =>
          m.client_id === clientId
            ? {
                ...m,
                id: result.wid,
                pending: false,
                ack: 'sent' as const,
                reference: result.reference ?? m.reference,
              }
            : m,
        );
        return { chatMessages: { ...s.chatMessages, [chatWid]: next } };
      });
    } catch (err) {
      // Mark the placeholder as failed so the bubble shows the red warning.
      set((s) => {
        const existing = s.chatMessages[chatWid] ?? [];
        const next = existing.map((m) =>
          m.client_id === clientId ? { ...m, pending: false, ack: 'failed' as const } : m,
        );
        return { chatMessages: { ...s.chatMessages, [chatWid]: next } };
      });
      // Surface the error as a toast so the user knows something went wrong.
      const msg = err instanceof Error ? err.message : String(err);
      get().addToast(msg, 'error');
      throw err;
    } finally {
      // Released whichever way it ended: a failed attempt must be retryable
      // with a fresh key, or the chat would be stuck refusing that message.
      inFlightSends.delete(dedupeKey);
    }
  },

  startNewChat: async (input: { phone: string; body: string; deviceId?: string; clientRecordId?: string; deliverAt?: string }) => {
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) throw new Error('chats model not found');

    const body = input.body.trim();
    if (!body) throw new Error(state.language === 'ar' ? 'الرسالة مطلوبة' : 'Message body is required');

    // Canonicalize to KSA E.164 via the shared helper (the same one telUrl /
    // whatsappUrl / the webhook phone-match use) so a bare 9-digit Saudi number
    // ("554446109"), "966…", "+966…", and "05…" all collapse to the SAME wid.
    // The previous open-coded version only prepended 966 when the number began
    // with "0", so typing the bare form minted a DUPLICATE chat record (a
    // spurious "+554446109" thread separate from the real "+966554446109" one).
    const e164 = normalizePhone(input.phone);
    if (!e164) throw new Error(state.language === 'ar' ? 'رقم هاتف غير صالح' : 'Invalid phone number');
    const chatWid = `${e164.slice(1)}@c.us`;

    // Pick the send-from device — explicit, else default, else first active.
    const deviceId =
      input.deviceId ??
      state.waDevices.find((d) => d.is_default && d.is_active)?.device_id ??
      state.waDevices.find((d) => d.is_active)?.device_id ??
      state.waDevicesLive[0]?.id ??
      '';
    if (!deviceId) {
      throw new Error(state.language === 'ar'
        ? 'لم يتم تحديد رقم واتساب للإرسال — أضف رقم افتراضي في الإعدادات'
        : 'No WhatsApp device configured — set a default in Settings');
    }

    // Create / upsert the local chat record. Use mergeChatIntoRecord with
    // a synthesized HaberchatChat so we share the same shape + normalizer
    // with loadChatsFromHaberchat. If a record already exists for this
    // phone (the user is "starting new" to someone they already chatted
    // with), we reuse it instead of duplicating.
    const existing = (state.records[chatsModel.id] ?? []).find((r) => {
      return ((r.data as Record<string, unknown>).wid as string | undefined) === chatWid;
    });
    const synth = {
      wid: chatWid,
      kind: 'user' as const,
      name: existing ? ((existing.data as Record<string, unknown>).name as string | null) ?? null : null,
      phone: e164,
      status: 'active',
      ownerAgentId: null,
      labels: [],
      unreadCount: 0,
      lastMessageAt: new Date().toISOString(),
      lastMessagePreview: body.slice(0, 120),
      meta: {},
    };
    let record = mergeChatIntoRecord(existing ?? null, synth, deviceId, chatsModel.id);
    // Client link resolution. An explicit selection from the Start New Chat
    // picker wins — it links the conversation directly to the chosen client
    // (still verified live, so a since-deleted id falls through). Otherwise
    // fall back to the opportunistic phone-match heuristic, used for the
    // manual-entry path AND for revived chats whose previous `client_link`
    // points to a since-deleted client.
    const clientsModel = state.models.find((m) => m.name === 'clients');
    const clients = clientsModel ? (state.records[clientsModel.id] ?? []) : [];
    if (input.clientRecordId && isLiveClient(input.clientRecordId, clients)) {
      record = { ...record, data: { ...record.data, client_link: input.clientRecordId } };
    } else if (!isLiveClient((record.data as Record<string, unknown>).client_link, clients)) {
      const slugs = phoneFieldSlugs(clientsModel);
      const link = resolveClientLink(e164, clients, slugs);
      if (link) record = { ...record, data: { ...record.data, client_link: link } };
    }

    set((s) => {
      const list = s.records[chatsModel.id] ?? [];
      const idx = list.findIndex((r) => r.id === record.id);
      const nextList = idx >= 0
        ? list.map((r) => (r.id === record.id ? record : r))
        : [...list, record];
      const nextRecords = { ...s.records, [chatsModel.id]: nextList };
      saveLocalRecordsForModel(chatsModel.id, nextList);
      return { records: nextRecords };
    });
    void supabaseUpsert('records', record, {
      table: 'models',
      id: record.model_id,
    });

    // Scheduled first message — the conversation record above still gets
    // created (so the user can open it and see the scheduled chip), but the
    // message goes to Haberchat's delivery queue instead of out now. No
    // optimistic bubble; the webhook echoes it at delivery time.
    if (input.deliverAt) {
      try {
        await sendHaberchatMessage({
          deviceId,
          phone: e164,
          body,
          reference: uuid(),
          deliverAt: input.deliverAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        get().addToast(msg, 'error');
        throw err;
      }
      return { recordId: record.id, chatWid };
    }

    // Now send the first message — use the same optimistic+proxy flow as
    // sendChatMessage. We inline it (not delegate) because sendChatMessage
    // expects the record to already exist in state and resolves the
    // device from there; we'd end up with a redundant lookup.
    const clientId = uuid();
    const placeholder: ChatMessage = {
      id: `pending:${clientId}`,
      chat_wid: chatWid,
      flow: 'out',
      kind: 'text',
      body,
      from_phone: null,
      to_phone: e164,
      ack: 'pending',
      date: new Date().toISOString(),
      media_file_id: null,
      media_mime: null,
      media_size: null,
      media_caption: null,
      reference: clientId,
      quoted: null,
      pending: true,
      client_id: clientId,
    };
    set((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [chatWid]: [...(s.chatMessages[chatWid] ?? []), placeholder],
      },
    }));

    try {
      const result = await sendHaberchatMessage({
        deviceId,
        phone: e164,
        body,
        reference: clientId,
      });
      set((s) => {
        const existing = s.chatMessages[chatWid] ?? [];
        const next = existing.map((m) =>
          m.client_id === clientId
            ? {
                ...m,
                id: result.wid,
                pending: false,
                ack: 'sent' as const,
                reference: result.reference ?? m.reference,
              }
            : m,
        );
        return { chatMessages: { ...s.chatMessages, [chatWid]: next } };
      });
    } catch (err) {
      set((s) => {
        const existing = s.chatMessages[chatWid] ?? [];
        const next = existing.map((m) =>
          m.client_id === clientId ? { ...m, pending: false, ack: 'failed' as const } : m,
        );
        return { chatMessages: { ...s.chatMessages, [chatWid]: next } };
      });
      const msg = err instanceof Error ? err.message : String(err);
      get().addToast(msg, 'error');
      throw err;
    }

    return { recordId: record.id, chatWid };
  },

  subscribeToChat: (chatWid: string) => {
    if (!supabase || !chatWid) return;
    const existing = chatRealtimeChannels.get(chatWid);
    if (existing) return; // Idempotent — already subscribed.

    const channel = supabase
      .channel(`chat_messages:${chatWid}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_messages', filter: `chat_wid=eq.${chatWid}` },
        (payload) => {
          const row = payload.new as DbChatMessageRow | null;
          if (!row || !row.id) return;
          applyRealtimeRow(row);
        },
      )
      .subscribe();

    chatRealtimeChannels.set(chatWid, channel);
  },

  unsubscribeFromChat: (chatWid: string) => {
    const channel = chatRealtimeChannels.get(chatWid);
    if (!channel || !supabase) return;
    void supabase.removeChannel(channel);
    chatRealtimeChannels.delete(chatWid);
  },

  subscribeToAllChats: () => {
    if (!supabase || globalChatsChannel) return;
    globalChatsChannel = supabase
      .channel('chat_messages:all')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_messages' },
        (payload) => {
          const row = payload.new as DbChatMessageRow | null;
          if (!row || !row.id) return;
          applyRealtimeRow(row);
        },
      )
      .subscribe();
  },

  unsubscribeFromAllChats: () => {
    if (!globalChatsChannel || !supabase) return;
    void supabase.removeChannel(globalChatsChannel);
    globalChatsChannel = null;
  },

  markChatAsRead: (chatWid: string) => {
    if (!chatWid) return;
    // Track what we changed so the zero can be PERSISTED after the local
    // update. The old local-only version was the "unread badge comes back
    // after refresh" bug: the webhook increments unread_count in Supabase,
    // and nothing ever wrote the zero back — every reload resurrected it.
    let updatedRec: AppRecord | null = null;
    let modelId: string | null = null;
    let updatedList: AppRecord[] | null = null;
    set((s) => {
      const chatsModel = s.models.find((m) => m.name === 'chats');
      if (!chatsModel) return s;
      const list = s.records[chatsModel.id] ?? [];
      const idx = list.findIndex(
        (r) => ((r.data as Record<string, unknown>).wid as string | undefined) === chatWid,
      );
      const rec = list[idx];
      if (!rec) return s;
      const data = rec.data as Record<string, unknown>;
      if ((data.unread_count ?? 0) === 0) return s;
      const nextList = [...list];
      nextList[idx] = {
        ...rec,
        data: { ...data, unread_count: 0, last_read_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      };
      updatedRec = nextList[idx];
      modelId = chatsModel.id;
      updatedList = nextList;
      return { records: { ...s.records, [chatsModel.id]: nextList } };
    });
    if (updatedRec && modelId && updatedList) {
      // Same persistence pattern as loadChatsFromHaberchat: local mirror
      // synchronously, Supabase in the background (surfaces + queues on
      // failure via supabaseUpsert).
      saveLocalRecordsForModel(modelId, updatedList);
      void supabaseUpsert('records', updatedRec);
    }
  },

  patchChat: async (
    chatWid: string,
    patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
  ) => {
    if (!chatWid) return;
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) throw new Error('chats model not found');
    const list = state.records[chatsModel.id] ?? [];
    const idx = list.findIndex(
      (r) => ((r.data as Record<string, unknown>).wid as string | undefined) === chatWid,
    );
    const rec = list[idx];
    if (!rec) throw new Error('conversation not found in records');

    const data = rec.data as Record<string, unknown>;
    const deviceId = deviceIdString(data.device_id) ??
      state.waDevices.find((d) => d.is_default && d.is_active)?.device_id ??
      state.waDevices.find((d) => d.is_active)?.device_id ??
      state.waDevicesLive[0]?.id ??
      '';
    if (!deviceId) throw new Error('no WhatsApp device configured for this chat');

    // Optimistic local patch. Remember the previous values so we can
    // revert on failure — users typically react faster than the network,
    // and a silent revert is worse than a loud error + undo.
    const prevStatus = (data.status as string | undefined) ?? 'active';
    const prevLabels = Array.isArray(data.labels) ? (data.labels as string[]) : [];
    const nextData: Record<string, unknown> = { ...data };
    if (patch.status) nextData.status = patch.status;
    if (patch.labels) nextData.labels = patch.labels;
    set((s) => {
      const curList = s.records[chatsModel.id] ?? [];
      const curIdx = curList.findIndex(
        (r) => ((r.data as Record<string, unknown>).wid as string | undefined) === chatWid,
      );
      if (curIdx === -1) return s;
      const curRec = curList[curIdx];
      if (!curRec) return s;
      const nextList = [...curList];
      nextList[curIdx] = { ...curRec, data: nextData, updated_at: new Date().toISOString() };
      return { records: { ...s.records, [chatsModel.id]: nextList } };
    });
    void supabaseUpsert(
      'records',
      { ...rec, data: nextData },
      { table: 'models', id: rec.model_id },
    );

    try {
      await patchHaberchatChat(deviceId, chatWid, patch);
    } catch (err) {
      // Revert local state.
      set((s) => {
        const curList = s.records[chatsModel.id] ?? [];
        const curIdx = curList.findIndex(
          (r) => ((r.data as Record<string, unknown>).wid as string | undefined) === chatWid,
        );
        if (curIdx === -1) return s;
        const curRec = curList[curIdx];
        if (!curRec) return s;
        const revertData = {
          ...(curRec.data as Record<string, unknown>),
          status: prevStatus,
          labels: prevLabels,
        };
        const nextList = [...curList];
        nextList[curIdx] = { ...curRec, data: revertData };
        return { records: { ...s.records, [chatsModel.id]: nextList } };
      });
      const msg = err instanceof Error ? err.message : String(err);
      get().addToast(msg, 'error');
      throw err;
    }
  },

  saveWebhookSlug: async (slug) => {
    const now = new Date().toISOString();
    const updated: WebhookSlug = { ...slug, updated_at: now };
    set((s) => {
      const exists = s.webhookSlugs.some((w) => w.id === slug.id);
      const next = exists
        ? s.webhookSlugs.map((w) => (w.id === slug.id ? updated : w))
        : [...s.webhookSlugs, updated];
      saveLocal('wassell_webhook_slugs', next);
      return { webhookSlugs: next };
    });
    await supabaseUpsert('webhook_slugs', updated);
  },

  deleteWebhookSlug: async (slugId) => {
    set((s) => {
      const next = s.webhookSlugs.filter((w) => w.id !== slugId);
      saveLocal('wassell_webhook_slugs', next);
      return { webhookSlugs: next };
    });
    await supabaseDelete('webhook_slugs', slugId);
  },

  claimAndRunWebhookPayload: async (payloadId) => {
    if (!supabase) return false;
    const state = get();
    const session = await supabase.auth.getSession();
    const userId = session.data.session?.user.id ?? null;

    // Atomic claim: the `consumed_at IS NULL` guard means only the first
    // client to run this UPDATE gets the returned row. Everyone else gets
    // zero rows and skips.
    const { data: claimed, error: claimErr } = await supabase
      .from('webhook_payloads')
      .update({ consumed_at: new Date().toISOString(), consumed_by: userId })
      .eq('id', payloadId)
      .is('consumed_at', null)
      .select('*')
      .maybeSingle();
    if (claimErr) {
      console.error('[claimAndRunWebhookPayload] claim failed:', claimErr.message);
      return false;
    }
    if (!claimed) return false;

    const payloadRow = claimed as WebhookPayload;
    if (!payloadRow.slug_id) return true;

    const matches = state.workflows.filter(
      (w) =>
        w.is_active &&
        w.trigger_event === 'webhook' &&
        w.trigger_webhook_slug_id === payloadRow.slug_id,
    );
    if (matches.length === 0) return true;

    const triggerRecord: AppRecord = {
      id: payloadRow.id,
      model_id: '__webhook__',
      data: (payloadRow.payload ?? {}) as Record<string, unknown>,
      created_at: payloadRow.received_at,
      updated_at: payloadRow.received_at,
    };

    try {
      await executeWebhookWorkflows(
        matches,
        triggerRecord,
        state.models,
        state.records,
        state.users,
        state.roles,
        (record) => void get().saveRecord(record),
        (message) => get().addToast(message, 'info'),
        userId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[claimAndRunWebhookPayload] engine failed:', msg);
      await supabase
        .from('webhook_payloads')
        .update({ error: msg.slice(0, 500) })
        .eq('id', payloadId);
    }
    return true;
  },

}));
