import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import { getSession, getSessionEmail, getSessionUid, onAuthChange, signOut as authSignOut, isAuthAvailable } from '@/lib/auth';
import { SEED_MODELS, SEED_GROUPS } from '@/data/seedModels';
import { SEED_PROFILES, SEED_ROLES, SEED_USERS } from '@/data/seedUsers';
import { buildMarketingSeedWorkflows } from '@/data/seedWorkflows';
import { executeWorkflows, executeWebhookWorkflows } from '@/lib/workflowEngine';
import { assignAutoIds } from '@/lib/autoIdAssigner';
import { applyFieldFallbacks } from '@/lib/fieldFallbackResolver';
import { computeAllFormulas } from '@/lib/formulaEngine';
import { runMigrations, healSystemModelGroups, healClientsSchema, healResearchMultiProject, healResearchComparisonContainer, healMapsConfigForModels, refreshSystemModels } from '@/lib/schemaMigrations';
import { applyFieldRename } from '@/lib/fieldRename';
import { listDevices as listHaberchatDevices, listChats as listHaberchatChats, listMessages as listHaberchatMessages, sendMessage as sendHaberchatMessage, patchChat as patchHaberchatChat } from '@/lib/haberchat/client';
import { mergeChatIntoRecord, resolveClientLink, phoneFieldSlugs } from '@/lib/haberchat/normalize';
import type {
  AppState,
  AppModel,
  ModelGroup,
  AppRecord,
  Workflow,
  WorkflowGroup,
  WorkflowRun,
  Dashboard,
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
} from '@/types';
import { activityLogger } from '@/lib/activityLogger';

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

function saveLocal<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
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
          'تجاوز الذاكرة المؤقتة — وضع عدم الاتصال معطل. حدّث الصفحة عند توفر اتصال.',
          'error',
        );
      } catch {
        // Store not yet initialized; the console.error above is enough.
      }
    }
  }
}

// ─── Per-model records cache ──────────────────────────────────────────
// Records used to live under a single `wassell_records` key — a flat array
// re-stringified on every save. With ~1000 records of ~5KB each this hit the
// browser's 5–10 MB localStorage cap, plus blocked the main thread for
// 100–500 ms per save. Now each model's records live under
// `wassell_records:<modelId>`, so a saveRecord rewrites only that bucket.
// On first load we migrate from the legacy single key.
const RECORDS_KEY_PREFIX = 'wassell_records:';
const RECORDS_LEGACY_KEY = 'wassell_records';

function recordsKeyFor(modelId: string): string {
  return `${RECORDS_KEY_PREFIX}${modelId}`;
}

/** Load every per-model bucket; on first run, migrates from the legacy single
 *  key and deletes it. Returns a `model_id → records` map ready for the store. */
function loadLocalRecordsMap(): Record<string, AppRecord[]> {
  const out: Record<string, AppRecord[]> = {};
  let foundPerModel = false;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(RECORDS_KEY_PREFIX)) continue;
    foundPerModel = true;
    const modelId = key.slice(RECORDS_KEY_PREFIX.length);
    try {
      const raw = localStorage.getItem(key);
      if (raw) out[modelId] = JSON.parse(raw) as AppRecord[];
    } catch {
      // Skip a bucket that's gone bad — the next save will repopulate it.
    }
  }
  if (foundPerModel) return out;

  // First run with the new layout: pull from the legacy key, split by model_id,
  // re-write per-model, and remove the legacy key.
  const legacy = loadLocal<AppRecord[]>(RECORDS_LEGACY_KEY) ?? [];
  for (const rec of legacy) {
    if (!rec.model_id) continue;
    if (!out[rec.model_id]) out[rec.model_id] = [];
    out[rec.model_id]!.push(rec);
  }
  if (Object.keys(out).length > 0) saveLocalRecordsMap(out);
  try {
    localStorage.removeItem(RECORDS_LEGACY_KEY);
  } catch {
    // ignore
  }
  return out;
}

/** Persist the full records map, one bucket per model. Sweeps stale buckets
 *  for models that no longer have any records (e.g. a model that was just
 *  deleted, or whose records were all removed). */
function saveLocalRecordsMap(records: Record<string, AppRecord[]>): void {
  const liveModelIds = new Set<string>();
  for (const [modelId, rows] of Object.entries(records)) {
    if (!rows || rows.length === 0) continue;
    saveLocal(recordsKeyFor(modelId), rows);
    liveModelIds.add(modelId);
  }
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

/** Persist a single model's records bucket. Used by saveRecord — the hot path
 *  now writes O(records-in-this-model) bytes instead of O(all-records). */
function saveLocalRecordsForModel(modelId: string, rows: AppRecord[]): void {
  if (!rows || rows.length === 0) {
    try {
      localStorage.removeItem(recordsKeyFor(modelId));
    } catch {
      // ignore
    }
    return;
  }
  saveLocal(recordsKeyFor(modelId), rows);
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
let reportSupabaseError: (table: string, op: 'upsert' | 'delete' | 'load', msg: string) => void =
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

interface PendingWrite {
  id: string;
  op: 'upsert' | 'delete';
  table: string;
  row?: Record<string, unknown>;
  rowId?: string;
  parent?: { table: string; id: string | null | undefined };
  enqueuedAt: string;
  attempts: number;
}

function loadPendingQueue(): PendingWrite[] {
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PendingWrite[]) : [];
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
        'فشل حفظ قائمة المزامنة المعلّقة — قد تضيع تعديلات غير محفوظة.',
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
  const rowId = (entry.row?.id as string | undefined) ?? entry.rowId;
  if (typeof rowId === 'string') {
    const idx = queue.findIndex(
      (w) =>
        w.table === entry.table &&
        ((w.row?.id as string | undefined) === rowId || w.rowId === rowId),
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
        const idShort = (next.row?.id as string | undefined)?.slice(0, 8) ?? next.rowId?.slice(0, 8) ?? '?';
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
  row: Record<string, unknown>,
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
  const id = typeof row.id === 'string' ? row.id : undefined;
  const key = id ? writeKey(table, id) : undefined;
  const op = (async () => {
    try {
      const { error } = await supabase!.from(table).upsert(row);
      if (error) {
        reportSupabaseError(table, 'upsert', error.message ?? String(error));
        // Queue for retry on next initialize so the local edit isn't lost
        // when Supabase load runs and overwrites localStorage.
        enqueuePendingWrite({ op: 'upsert', table, row, parent });
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

async function supabaseLoad<T>(table: string): Promise<T[] | null> {
  if (!supabase) return null;
  // Paginate via .range() in 1000-row pages. Supabase/PostgREST silently
  // caps a bare .select('*') at db-max-rows=1000 — no error, just truncated
  // data — which manifests downstream as missing records, "deleted but not
  // really" rows, dashboard miscounts, and AI-agent / UI count drift. The
  // loop walks pages until a short batch (< pageSize) comes back, meaning
  // we've hit the end. Stops cleanly on error and surfaces via the same
  // toast path the original code used.
  const pageSize = 1000;
  const all: T[] = [];
  try {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .range(from, from + pageSize - 1);
      if (error) {
        reportSupabaseError(table, 'load', error.message ?? String(error));
        return null;
      }
      const batch = (data ?? []) as T[];
      all.push(...batch);
      if (batch.length < pageSize) break;
    }
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

/** Merge one live `chat_messages` row into `chatMessages[chat_wid]`.
 *  If the row's `reference` matches a pending optimistic placeholder, the
 *  placeholder is replaced (keyed by client_id). Otherwise the row is
 *  upserted by id. List stays sorted ascending by date. */
function applyRealtimeRow(row: DbChatMessageRow): void {
  const incoming: ChatMessage = {
    id: row.id,
    chat_wid: row.chat_wid,
    flow: row.flow,
    kind: row.kind,
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
  // Capture whether this id is new BEFORE we mutate the slice — used by
  // bumpParentFromMessage to decide whether to increment unread_count.
  const prevState = useAppStore.getState();
  const wasKnown = (prevState.chatMessages[row.chat_wid] ?? []).some((m) => m.id === row.id);
  useAppStore.setState((s) => {
    const existing = s.chatMessages[row.chat_wid] ?? [];
    const byId = new Map<string, ChatMessage>();
    for (const m of existing) {
      // Dedupe on reference match — handles BOTH cases:
      //  a) pending optimistic placeholder still present (pre-ack)
      //  b) post-ack message whose id came from POST /messages (Haberchat
      //     `id`) but the webhook echoes with a different WhatsApp-style
      //     wid (`3EB0...`). Without this dedupe by reference the row
      //     would be added as a second bubble.
      if (row.reference && (m.reference === row.reference || m.client_id === row.reference)) continue;
      byId.set(m.id, m);
    }
    byId.set(incoming.id, incoming);
    const merged = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
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

    // Opportunistic client link — only if the chat isn't already linked.
    let clientLinkPatch: { client_link: string } | null = null;
    if (!data.client_link) {
      const clientsModel = s.models.find((m) => m.name === 'clients');
      const clients = clientsModel ? (s.records[clientsModel.id] ?? []) : [];
      const slugs = phoneFieldSlugs(clientsModel);
      const link = resolveClientLink(data.phone as string | null | undefined, clients, slugs);
      if (link) clientLinkPatch = { client_link: link };
    }

    if (!isNewer && nextUnread === curUnread && !clientLinkPatch) return s;
    const nextData = {
      ...data,
      last_message_at: isNewer ? row.date : curAt,
      last_message_preview: isNewer ? (row.body ? row.body.slice(0, 120) : curPreview) : curPreview,
      unread_count: nextUnread,
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
    if (data.client_link) return rec;
    const link = resolveClientLink(data.phone as string | null | undefined, clients, slugs);
    if (!link) return rec;
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
    void supabaseUpsert('records', rec as unknown as Record<string, unknown>, {
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
  activityLog: loadLocal<ActivityLogEntry[]>('wassell_activity_log') ?? [],
  dashboards: [],
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
  authEmail: null,
  authUid: null,
  authReady: false,
  language: (loadLocal<Language>('wassell_language') ?? 'ar'),
  toasts: [],
  pendingResearchPromptTargetedIds: [],
  recordNavContext: null,
  initialized: false,

  // --- Initialize ---
  initialize: async () => {
    if (get().initialized) return;

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

    // ORDER MATTERS: groups must be persisted to Supabase BEFORE models,
    // because `models.group_id` is a foreign key to `model_groups.id`. If we
    // upsert models first, Postgres rejects them with a FK violation that our
    // silent-fail error handler swallows — leaving some models missing from
    // Supabase while others (those without a group_id) slip through.

    // --- Groups ---
    // Load groups with cascading fallback: Supabase → localStorage → SEED.
    const supabaseGroups = await supabaseLoad<ModelGroup>('model_groups');
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
            supabaseUpsert('model_groups', g as unknown as Record<string, unknown>),
          ),
        );
      }
    }

    // --- Models ---
    // Three cascading sources: Supabase → localStorage → SEED. After loading,
    // backfill any system models missing from Supabase (matched by `name`,
    // which is UNIQUE in the schema) so subsequent loads see the full set.
    const supabaseModels = await supabaseLoad<AppModel>('models');
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
            supabaseUpsert('models', m as unknown as Record<string, unknown>),
          ),
        );
      }
    }
    saveLocal('wassell_models', models);

    // Load records — Supabase first, per-model localStorage buckets as fallback
    // (loadLocalRecordsMap also migrates from the legacy single 'wassell_records'
    // key on first run with the new layout).
    let records: Record<string, AppRecord[]>;
    const supabaseRecords = await supabaseLoad<AppRecord>('records');
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

    // Load workflows
    let workflows = await supabaseLoad<Workflow>('workflows');
    if (!workflows) workflows = loadLocal<Workflow[]>('wassell_workflows') ?? [];
    saveLocal('wassell_workflows', workflows);

    // Load workflow folders. Tolerate the table not existing yet on
    // older installs that haven't run the latest schema migration.
    let workflowGroups: WorkflowGroup[] = [];
    try {
      const loaded = await supabaseLoad<WorkflowGroup>('workflow_groups');
      workflowGroups = loaded ?? loadLocal<WorkflowGroup[]>('wassell_workflow_groups') ?? [];
    } catch {
      workflowGroups = loadLocal<WorkflowGroup[]>('wassell_workflow_groups') ?? [];
    }
    saveLocal('wassell_workflow_groups', workflowGroups);

    // Load workflow execution logs
    let workflowRuns = await supabaseLoad<WorkflowRun>('workflow_runs');
    if (!workflowRuns) workflowRuns = loadLocal<WorkflowRun[]>('wassell_workflow_runs') ?? [];
    saveLocal('wassell_workflow_runs', workflowRuns);

    // Load unified activity log — fetch the most recent 500 from Supabase, or
    // fall back to the localStorage cap of 200. The LogsPage can request more
    // via `loadActivityLog(limit)` if the admin scrolls past the cached set.
    let activityLog: ActivityLogEntry[] = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('activity_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (!error && data) {
        activityLog = data as ActivityLogEntry[];
      }
    }
    if (activityLog.length === 0) {
      activityLog = loadLocal<ActivityLogEntry[]>('wassell_activity_log') ?? [];
    }
    saveLocal('wassell_activity_log', activityLog.slice(0, 200));

    // Load dashboards
    let dashboards = await supabaseLoad<Dashboard>('dashboards');
    if (!dashboards) dashboards = loadLocal<Dashboard[]>('wassell_dashboards') ?? [];
    saveLocal('wassell_dashboards', dashboards);

    // Load whiteboards + their folders
    let whiteboardFolders = await supabaseLoad<WhiteboardFolder>('whiteboard_folders');
    if (!whiteboardFolders) whiteboardFolders = loadLocal<WhiteboardFolder[]>('wassell_whiteboard_folders') ?? [];
    saveLocal('wassell_whiteboard_folders', whiteboardFolders);
    let whiteboards = await supabaseLoad<Whiteboard>('whiteboards');
    if (!whiteboards) whiteboards = loadLocal<Whiteboard[]>('wassell_whiteboards') ?? [];
    saveLocal('wassell_whiteboards', whiteboards);

    // Load saved table views
    let views = await supabaseLoad<ModelView>('model_views');
    if (!views) views = loadLocal<ModelView[]>('wassell_views') ?? [];
    saveLocal('wassell_views', views);

    // --- Profiles ---
    // Cascading fallback: Supabase → localStorage → SEED. Same pattern as
    // models/groups. Users FK into profiles via `profile_id`, so we AWAIT
    // the profile backfill before moving on to users below.
    const supabaseProfiles = await supabaseLoad<Profile>('profiles');
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
    if (supabaseProfiles !== null) {
      const existingProfileIds = new Set(supabaseProfiles.map((p) => p.id));
      const missingProfiles = profiles.filter((p) => !existingProfileIds.has(p.id));
      if (missingProfiles.length > 0) {
        await Promise.all(
          missingProfiles.map((p) =>
            supabaseUpsert('profiles', p as unknown as Record<string, unknown>),
          ),
        );
      }
    }

    // --- Roles ---
    // Cascading fallback: Supabase → localStorage → SEED.
    const supabaseRoles = await supabaseLoad<Role>('roles');
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
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
    saveLocal('wassell_roles', roles);
    // Backfill missing roles to Supabase. No FK dependents — fire-and-forget OK.
    if (supabaseRoles !== null) {
      const existingRoleIds = new Set(supabaseRoles.map((r) => r.id));
      for (const r of roles) {
        if (!existingRoleIds.has(r.id)) {
          supabaseUpsert('roles', r as unknown as Record<string, unknown>);
        }
      }
    }

    // --- Users ---
    // Cascading fallback: Supabase → localStorage → SEED. Profiles are already
    // in Supabase (we awaited them above), so user FK writes are safe.
    const supabaseUsers = await supabaseLoad<User>('users');
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
            u as unknown as Record<string, unknown>,
            { table: 'profiles', id: u.profile_id },
          );
        }
      }
    }

    // --- Field templates ---
    // User-created; no seed. Just load and mirror localStorage.
    let fieldTemplates = await supabaseLoad<FieldTemplate>('field_templates');
    if (!fieldTemplates) fieldTemplates = loadLocal<FieldTemplate[]>('wassell_field_templates') ?? [];
    saveLocal('wassell_field_templates', fieldTemplates);

    // --- Webhook inbox (user-declared inbound endpoints) ---
    let webhookSlugs = await supabaseLoad<WebhookSlug>('webhook_slugs');
    if (!webhookSlugs) webhookSlugs = loadLocal<WebhookSlug[]>('wassell_webhook_slugs') ?? [];
    saveLocal('wassell_webhook_slugs', webhookSlugs);

    // --- Seed the marketing-pipeline workflows ---
    // The 11 workflows that glue the edge functions to record writes live
    // in `src/data/seedWorkflows.ts`. They have stable ids so re-seeding
    // is idempotent. We only seed the ones missing from the loaded set
    // so user-edited copies (same id, different content) aren't clobbered.
    {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
      if (supabaseUrl) {
        const seedList = buildMarketingSeedWorkflows(models, webhookSlugs, supabaseUrl);
        if (seedList.length > 0) {
          const existingIds = new Set(workflows.map((w) => w.id));
          const toAdd = seedList.filter((w) => !existingIds.has(w.id));
          if (toAdd.length > 0) {
            workflows = [...workflows, ...toAdd];
            saveLocal('wassell_workflows', workflows);
            await Promise.all(
              toAdd.map((w) => supabaseUpsert('workflows', workflowToSupabaseRow(w))),
            );
          }
        }
      }
    }

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
    const bindAuthUidToUser = (user: User): User => {
      if (!authUid || user.auth_uid === authUid) return user;
      const updated: User = {
        ...user,
        auth_uid: authUid,
        updated_at: new Date().toISOString(),
      };
      users = users.map((u) => (u.id === updated.id ? updated : u));
      saveLocal('wassell_users', users);
      supabaseUpsert(
        'users',
        updated as unknown as Record<string, unknown>,
        { table: 'users', id: updated.id },
      );
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
            'حسابك معطّل — تواصل مع المسؤول للتفعيل.',
            'error',
          );
          return;
        }
        const bound = bindAuthUidToUser(match);
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
            adopted as unknown as Record<string, unknown>,
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

    // Always-run heal for Projects Research multi-project support. Idempotent:
    // no-op once the project_name lookup is already multi and records are arrays.
    const healedResearch = healResearchMultiProject({ models, records: migratedRecords });
    if (healedResearch.changed) {
      models = healedResearch.models;
      migratedRecords = healedResearch.records;
    }

    // Always-run heal for the research comparison container. Idempotent:
    // no-op once the project_comparison section_mirror field is present.
    const healedComparison = healResearchComparisonContainer({ models, records: migratedRecords });
    if (healedComparison.changed) {
      models = healedComparison.models;
      migratedRecords = healedComparison.records;
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

    saveLocal('wassell_models', models);
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
        supabaseUpsert('profiles', p as unknown as Record<string, unknown>);
      }
    }

    set({
      models,
      groups,
      records: migratedRecords,
      workflows: migrated.workflows,
      workflowGroups,
      workflowRuns,
      activityLog,
      dashboards: migrated.dashboards,
      views: migrated.views,
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

    // Realtime: watch the webhook_payloads table so incoming agent
    // webhooks fan out to the workflow engine without a page reload.
    get().subscribeMarketingRealtime();

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

  // --- Research prompt ---
  // Queue-based: bulk-edit / bulk-import can create many targeted_projects
  // records in a tight loop, and every new id should accumulate into a single
  // modal rather than clobber the previous one.
  queueResearchPromptTargetedId: (id: string) => {
    set((s) => (
      s.pendingResearchPromptTargetedIds.includes(id)
        ? s
        : { pendingResearchPromptTargetedIds: [...s.pendingResearchPromptTargetedIds, id] }
    ));
  },
  dismissResearchPrompts: (ids?: string[]) => {
    set((s) => ({
      pendingResearchPromptTargetedIds: ids
        ? s.pendingResearchPromptTargetedIds.filter((x) => !ids.includes(x))
        : [],
    }));
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
        model as unknown as Record<string, unknown>,
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
            m as unknown as Record<string, unknown>,
            m.group_id ? { table: 'model_groups', id: m.group_id } : undefined,
          );
        }
      }
      for (const id of result.changedRecordIds) {
        const r = Object.values(result.records).flat().find((x) => x.id === id);
        if (r) {
          supabaseUpsert(
            'records',
            r as unknown as Record<string, unknown>,
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
            v as unknown as Record<string, unknown>,
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
      supabaseUpsert('model_groups', group as unknown as Record<string, unknown>);
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
        supabaseUpsert('models', m as unknown as Record<string, unknown>);
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
        supabaseUpsert('model_groups', g as unknown as Record<string, unknown>);
      }
      for (const m of changedModels) {
        supabaseUpsert(
          'models',
          m as unknown as Record<string, unknown>,
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
  saveRecord: (record: AppRecord) => {
    const state = get();
    const previousRecord = (state.records[record.model_id] ?? []).find((r) => r.id === record.id);
    const isNew = !previousRecord;
    const origModel = state.models.find((m) => m.id === record.model_id);

    // Enrich the record with auto_id assignments (on create only) and formula
    // snapshots (always). The returned model may have bumped auto_id counters —
    // we persist it alongside the record in a single atomic `set` below.
    let enrichedModel = origModel;
    let enrichedData = record.data;
    if (origModel) {
      const assigned = assignAutoIds(origModel, record.data, isNew);
      enrichedModel = assigned.model;
      enrichedData = assigned.data;
      enrichedData = applyFieldFallbacks(
        enrichedModel,
        enrichedData,
        (modelId) => (state.records[modelId] ?? []).map((r) => ({ id: r.id, data: r.data })),
      );
      const formulaValues = computeAllFormulas(enrichedModel, enrichedData);
      if (Object.keys(formulaValues).length > 0) {
        enrichedData = { ...enrichedData, ...formulaValues };
      }
    }
    // Stamp `created_by_user_id` on first save. Preserved across edits so the
    // value reflects who CREATED the record, not who last touched it. Records
    // saved without an active session (offline / pre-auth) stay null and are
    // treated as "no known creator" by scope filters that reference `created_by`.
    const stampedCreatedBy =
      isNew && record.created_by_user_id == null && state.currentUserId
        ? state.currentUserId
        : record.created_by_user_id ?? previousRecord?.created_by_user_id ?? null;
    const finalRecord: AppRecord = {
      ...record,
      data: enrichedData,
      created_by_user_id: stampedCreatedBy,
    };
    const modelChanged = !!enrichedModel && enrichedModel !== origModel;

    set((s) => {
      const modelRecords = s.records[record.model_id] ?? [];
      const idx = modelRecords.findIndex((r) => r.id === record.id);
      const updated = idx >= 0
        ? modelRecords.map((r) => (r.id === record.id ? finalRecord : r))
        : [...modelRecords, finalRecord];
      const records = { ...s.records, [record.model_id]: updated };
      // Per-model bucket write: O(records-in-this-model) instead of O(all).
      saveLocalRecordsForModel(record.model_id, updated);
      // FK: records.model_id → models.id. Gate on the model write so a record
      // created immediately after a new model doesn't hit an FK violation.
      supabaseUpsert(
        'records',
        finalRecord as unknown as Record<string, unknown>,
        { table: 'models', id: finalRecord.model_id },
      );

      if (modelChanged && enrichedModel) {
        const models = s.models.map((m) => (m.id === enrichedModel!.id ? enrichedModel! : m));
        saveLocal('wassell_models', models);
        supabaseUpsert(
          'models',
          enrichedModel as unknown as Record<string, unknown>,
          enrichedModel.group_id ? { table: 'model_groups', id: enrichedModel.group_id } : undefined,
        );
        return { records, models };
      }
      return { records };
    });
    // Execute workflows after state is settled
    queueMicrotask(() => {
      const s = get();
      void executeWorkflows(
        isNew ? 'create' : 'update',
        finalRecord,
        previousRecord,
        s.workflows,
        s.models,
        s.records,
        s.users,
        s.roles,
        (r) => get().saveRecord(r),
        (msg) => get().addToast(msg, 'info'),
        s.currentUserId,
        0,
        (run) => get().appendWorkflowRun(run),
      );
    });

    // Activity log — fires after the state mutation so the unified /logs
    // timeline picks up every record write. recordUpdated is a no-op when
    // there are no field-level diffs (auto_id-only writes, formula re-runs).
    if (isNew) {
      activityLogger.recordCreated(finalRecord, origModel);
    } else if (previousRecord) {
      activityLogger.recordUpdated(finalRecord, previousRecord, origModel);
    }

    // New Targeted Projects record → open the research-prompt modal on the next tick.
    // Fires regardless of how the record was created (manual entry, workflow, import)
    // so the user always gets the "link to research?" opportunity.
    if (isNew && origModel && origModel.name === 'targeted_projects') {
      queueMicrotask(() => {
        set((s) => (
          s.pendingResearchPromptTargetedIds.includes(finalRecord.id)
            ? s
            : { pendingResearchPromptTargetedIds: [...s.pendingResearchPromptTargetedIds, finalRecord.id] }
        ));
      });
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
  },
  deleteRecord: (modelId: string, recordId: string) => {
    // Capture the model + last snapshot BEFORE the state mutation so the
    // activity log can record what was deleted.
    const stateBefore = get();
    const model = stateBefore.models.find((m) => m.id === modelId);
    const previous = (stateBefore.records[modelId] ?? []).find((r) => r.id === recordId);
    set((s) => {
      const modelRecords = (s.records[modelId] ?? []).filter((r) => r.id !== recordId);
      const records = { ...s.records, [modelId]: modelRecords };
      saveLocalRecordsForModel(modelId, modelRecords);
      supabaseDelete('records', recordId);
      return { records };
    });
    if (previous) {
      activityLogger.recordDeleted(previous, model);
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
      supabaseUpsert('workflow_groups', group as unknown as Record<string, unknown>);
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
      supabaseUpsert('workflow_runs', run as unknown as Record<string, unknown>);
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
      supabaseUpsert('activity_log', entry as unknown as Record<string, unknown>);
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
    set((s) => {
      const idx = s.dashboards.findIndex((d) => d.id === dashboard.id);
      const dashboards = idx >= 0
        ? s.dashboards.map((d) => (d.id === dashboard.id ? dashboard : d))
        : [...s.dashboards, dashboard];
      saveLocal('wassell_dashboards', dashboards);
      supabaseUpsert('dashboards', dashboard as unknown as Record<string, unknown>);
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
      supabaseUpsert('whiteboard_folders', folder as unknown as Record<string, unknown>);
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
      if (updated) supabaseUpsert('whiteboard_folders', updated as unknown as Record<string, unknown>);
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
      supabaseUpsert('whiteboards', board as unknown as Record<string, unknown>);
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
      if (updated) supabaseUpsert('whiteboards', updated as unknown as Record<string, unknown>);
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
      if (updated) supabaseUpsert('whiteboards', updated as unknown as Record<string, unknown>);
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
      if (updated) supabaseUpsert('whiteboards', updated as unknown as Record<string, unknown>);
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
        view as unknown as Record<string, unknown>,
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
          updated as unknown as Record<string, unknown>,
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
        user as unknown as Record<string, unknown>,
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
    set({ currentUserId: userId });
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
      supabaseUpsert('profiles', healed as unknown as Record<string, unknown>);
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
      supabaseUpsert('roles', role as unknown as Record<string, unknown>);
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
          next as unknown as Record<string, unknown>,
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
      supabaseUpsert('field_templates', template as unknown as Record<string, unknown>);
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
    set({ authEmail: null, authUid: null, currentUserId: null });
    saveLocal('wassell_current_user_id', '');
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
    let overlay = await supabaseLoad<WhatsAppNumber>('whatsapp_numbers');
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
    await supabaseUpsert('whatsapp_numbers', next as unknown as Record<string, unknown>);
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
        const prev = byId.get(mergeChatIntoRecord(null, chat, deviceId, chatsModel.id).id) ?? null;
        const next = mergeChatIntoRecord(prev, chat, deviceId, chatsModel.id);
        byId.set(next.id, next);
        changed = true;
      }
    }

    if (!changed) return;

    // Resolve client_link for any unlinked chats. Matches clients records
    // by digits-only phone compare so format differences ("+966...",
    // "0...", "966...") don't block the match. Never overwrites an
    // existing link — an admin may have manually linked to a different
    // client and we respect that.
    const clientsModel = state.models.find((m) => m.name === 'clients');
    const clientRecords = clientsModel ? (state.records[clientsModel.id] ?? []) : [];
    const clientPhoneSlugs = phoneFieldSlugs(clientsModel);
    const merged = [...byId.values()].map((rec) => {
      const data = rec.data as Record<string, unknown>;
      if (data.client_link) return rec;
      const link = resolveClientLink(data.phone as string | null | undefined, clientRecords, clientPhoneSlugs);
      if (!link) return rec;
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
      void supabaseUpsert('records', rec as unknown as Record<string, unknown>);
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
    const recordDeviceId = record ? ((record.data as Record<string, unknown>).device_id as string | undefined) : undefined;

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

    let result: { messages: ChatMessage[]; hasMore: boolean };
    try {
      result = await listHaberchatMessages(deviceId, chatWid, opts);
    } catch (err) {
      console.warn('[loadMessagesForChat] proxy call failed:', err);
      return { hasMore: false };
    }

    // Merge into the slice. When `before` is set, we're loading older
    // history — prepend. Otherwise replace the window with the fresh latest.
    // Either way, dedupe by message id and keep ascending by date.
    set((s) => {
      const existing = s.chatMessages[chatWid] ?? [];
      const byId = new Map<string, ChatMessage>();
      // Existing rows first so fresh-from-Haberchat values overwrite stale ones.
      for (const m of existing) byId.set(m.id, m);
      for (const m of result.messages) byId.set(m.id, m);
      const merged = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { chatMessages: { ...s.chatMessages, [chatWid]: merged } };
    });

    return { hasMore: result.hasMore };
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

    const recordDeviceId = (data.device_id as string | undefined) ?? null;
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

    const clientId = uuid();
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
    }
  },

  startNewChat: async (input: { phone: string; body: string; deviceId?: string }) => {
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) throw new Error('chats model not found');

    const body = input.body.trim();
    if (!body) throw new Error(state.language === 'ar' ? 'الرسالة مطلوبة' : 'Message body is required');

    // Normalize phone. Accept "+966...", "966...", "0555...". Strip
    // everything but digits, then ensure we have a leading country
    // code. For Saudi we default to 966 if the number starts with 05.
    const digits = input.phone.replace(/\D/g, '');
    if (digits.length < 7) throw new Error(state.language === 'ar' ? 'رقم هاتف غير صالح' : 'Invalid phone number');
    const withCountry = digits.startsWith('0') ? `966${digits.slice(1)}` : digits;
    const e164 = `+${withCountry}`;
    const chatWid = `${withCountry}@c.us`;

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
    // Opportunistic client link for brand-new chats.
    if (!(record.data as Record<string, unknown>).client_link) {
      const clientsModel = state.models.find((m) => m.name === 'clients');
      const clients = clientsModel ? (state.records[clientsModel.id] ?? []) : [];
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
    void supabaseUpsert('records', record as unknown as Record<string, unknown>, {
      table: 'models',
      id: record.model_id,
    });

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
      nextList[idx] = { ...rec, data: { ...data, unread_count: 0 } };
      return { records: { ...s.records, [chatsModel.id]: nextList } };
    });
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
    const deviceId = (data.device_id as string | undefined) ??
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
      { ...rec, data: nextData } as unknown as Record<string, unknown>,
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
    await supabaseUpsert('webhook_slugs', updated as unknown as Record<string, unknown>);
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
