import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import { getSession, getSessionEmail, onAuthChange, signOut as authSignOut, isAuthAvailable } from '@/lib/auth';
import { SEED_MODELS, SEED_GROUPS } from '@/data/seedModels';
import { SEED_PROFILES, SEED_ROLES, SEED_USERS } from '@/data/seedUsers';
import { SEED_PRESENTATION_TEMPLATES } from '@/data/seedPresentationTemplates';
import { executeWorkflows, executeWebhookWorkflows } from '@/lib/workflowEngine';
import { assignAutoIds } from '@/lib/autoIdAssigner';
import { applyFieldFallbacks } from '@/lib/fieldFallbackResolver';
import { computeAllFormulas } from '@/lib/formulaEngine';
import { runMigrations, healSystemModelGroups, healClientsSchema, healResearchMultiProject, healResearchComparisonContainer, healMapsConfigForModels, refreshSystemModels } from '@/lib/schemaMigrations';
import { applyFieldRename } from '@/lib/fieldRename';
import { listDevices as listHaberchatDevices, listChats as listHaberchatChats, listMessages as listHaberchatMessages, sendMessage as sendHaberchatMessage } from '@/lib/haberchat/client';
import { mergeChatIntoRecord } from '@/lib/haberchat/normalize';
import type {
  AppState,
  AppModel,
  ModelGroup,
  AppRecord,
  Workflow,
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
  PresentationTemplate,
  PresentationJob,
  DaemonStatus,
  Competitor,
  MarketingOperation,
  ResearchQuestion,
  Reel,
  Post,
  MarketingNotification,
  WebhookSlug,
  WebhookPayload,
  WhatsAppNumber,
  ChatMessage,
} from '@/types';

// --- localStorage helpers ---

function loadLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveLocal<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Browser-side SHA-256 → lowercase hex. Used for presentation-job dedup keys
 *  (hash of template_id + record_id + inputs) to block duplicate queues. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

async function supabaseUpsert(
  table: string,
  row: Record<string, unknown>,
  parent?: { table: string; id: string | null | undefined },
): Promise<void> {
  if (!canWriteToSupabase() || !supabase) return;
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
      if (error) reportSupabaseError(table, 'upsert', error.message ?? String(error));
    } catch (err) {
      reportSupabaseError(table, 'upsert', err instanceof Error ? err.message : String(err));
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
  if (!canWriteToSupabase() || !supabase) return;
  // Wait for any in-flight upsert to this row first — otherwise the
  // delete can race past it and leave the row orphaned in the DB.
  const prior = pendingWrites.get(writeKey(table, id));
  if (prior) {
    try { await prior; } catch { /* ignore */ }
  }
  try {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) reportSupabaseError(table, 'delete', error.message ?? String(error));
  } catch (err) {
    reportSupabaseError(table, 'delete', err instanceof Error ? err.message : String(err));
  }
}

async function supabaseLoad<T>(table: string): Promise<T[] | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      reportSupabaseError(table, 'load', error.message ?? String(error));
      return null;
    }
    return data as T[];
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
      if (m.pending && (m.reference === row.reference || m.client_id === row.reference)) continue;
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
    if (!isNewer && nextUnread === curUnread) return s;
    const nextData = {
      ...data,
      last_message_at: isNewer ? row.date : curAt,
      last_message_preview: isNewer ? (row.body ? row.body.slice(0, 120) : curPreview) : curPreview,
      unread_count: nextUnread,
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

// --- Store ---

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  models: [],
  groups: [],
  records: {},
  workflows: [],
  workflowRuns: [],
  dashboards: [],
  views: [],
  users: [],
  profiles: [],
  roles: [],
  fieldTemplates: [],
  waDevices: [],
  waDevicesLive: [],
  chatMessages: {},
  presentationTemplates: [],
  presentationJobs: [],
  daemonStatus: null,
  competitors: [],
  marketingOperations: [],
  researchQuestions: [],
  reels: [],
  posts: [],
  marketingNotifications: [],
  webhookSlugs: [],
  webhookPayloads: [],
  currentUserId: loadLocal<string>('wassell_current_user_id') ?? null,
  authEmail: null,
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

    // Load records
    const records: Record<string, AppRecord[]> = {};
    let allRecords = await supabaseLoad<AppRecord>('records');
    if (!allRecords) allRecords = loadLocal<AppRecord[]>('wassell_records') ?? [];
    saveLocal('wassell_records', allRecords);
    for (const rec of allRecords) {
      if (!records[rec.model_id]) records[rec.model_id] = [];
      records[rec.model_id]!.push(rec);
    }

    // Load workflows
    let workflows = await supabaseLoad<Workflow>('workflows');
    if (!workflows) workflows = loadLocal<Workflow[]>('wassell_workflows') ?? [];
    saveLocal('wassell_workflows', workflows);

    // Load workflow execution logs
    let workflowRuns = await supabaseLoad<WorkflowRun>('workflow_runs');
    if (!workflowRuns) workflowRuns = loadLocal<WorkflowRun[]>('wassell_workflow_runs') ?? [];
    saveLocal('wassell_workflow_runs', workflowRuns);

    // Load dashboards
    let dashboards = await supabaseLoad<Dashboard>('dashboards');
    if (!dashboards) dashboards = loadLocal<Dashboard[]>('wassell_dashboards') ?? [];
    saveLocal('wassell_dashboards', dashboards);

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

    // --- Presentation templates (daemon-synced catalog + seed fallback) ---
    // The daemon (daemon/) syncs manifests from ~/.claude/ppt/templates/ into
    // this table. Until it runs, fall through to localStorage, then to the
    // bundled seed (so the catalog is never empty on a fresh install).
    const supabasePresTemplates = await supabaseLoad<PresentationTemplate>('presentation_templates');
    let presentationTemplates: PresentationTemplate[];
    if (supabasePresTemplates && supabasePresTemplates.length > 0) {
      presentationTemplates = supabasePresTemplates;
    } else {
      const localPresTemplates = loadLocal<PresentationTemplate[]>('wassell_presentation_templates');
      presentationTemplates =
        localPresTemplates && localPresTemplates.length > 0
          ? localPresTemplates
          : SEED_PRESENTATION_TEMPLATES;
    }
    saveLocal('wassell_presentation_templates', presentationTemplates);
    // Backfill seed rows to Supabase so the daemon has a real id to sync against.
    // No FK dependents on this table.
    if (supabasePresTemplates !== null) {
      const existingSlugs = new Set(supabasePresTemplates.map((t) => t.slug));
      for (const tpl of presentationTemplates) {
        if (!existingSlugs.has(tpl.slug)) {
          supabaseUpsert('presentation_templates', tpl as unknown as Record<string, unknown>);
        }
      }
    }

    // --- Presentation jobs ---
    // User-created; no seed. Local mirror for offline.
    let presentationJobs = await supabaseLoad<PresentationJob>('presentation_jobs');
    if (!presentationJobs) presentationJobs = loadLocal<PresentationJob[]>('wassell_presentation_jobs') ?? [];
    saveLocal('wassell_presentation_jobs', presentationJobs);

    // --- Daemon status (singleton heartbeat) ---
    // The app reads this to show the "daemon offline" banner. Only loads
    // when Supabase is reachable.
    let daemonStatus: DaemonStatus | null = null;
    if (supabase) {
      try {
        const { data } = await supabase
          .from('daemon_status')
          .select('*')
          .eq('id', 'presentations')
          .maybeSingle();
        if (data) daemonStatus = data as DaemonStatus;
      } catch {
        // Same fail-open pattern as `supabaseLoad` — banner just shows offline.
      }
    }

    // --- Marketing operations (reels + posts content pipeline) ---
    // All six tables use the same Supabase-first + localStorage-fallback pattern.
    // The edge functions use the service-role key and bypass RLS, so these
    // tables stay in sync even while the user isn't on the app.
    let competitors = await supabaseLoad<Competitor>('competitors');
    if (!competitors) competitors = loadLocal<Competitor[]>('wassell_competitors') ?? [];
    saveLocal('wassell_competitors', competitors);

    let marketingOperations = await supabaseLoad<MarketingOperation>('marketing_operations');
    if (!marketingOperations) marketingOperations = loadLocal<MarketingOperation[]>('wassell_marketing_operations') ?? [];
    saveLocal('wassell_marketing_operations', marketingOperations);

    let researchQuestions = await supabaseLoad<ResearchQuestion>('research_questions');
    if (!researchQuestions) researchQuestions = loadLocal<ResearchQuestion[]>('wassell_research_questions') ?? [];
    saveLocal('wassell_research_questions', researchQuestions);

    let reels = await supabaseLoad<Reel>('reels');
    if (!reels) reels = loadLocal<Reel[]>('wassell_reels') ?? [];
    saveLocal('wassell_reels', reels);

    let posts = await supabaseLoad<Post>('posts');
    if (!posts) posts = loadLocal<Post[]>('wassell_posts') ?? [];
    saveLocal('wassell_posts', posts);

    let marketingNotifications = await supabaseLoad<MarketingNotification>('marketing_notifications');
    if (!marketingNotifications) marketingNotifications = loadLocal<MarketingNotification[]>('wassell_marketing_notifications') ?? [];
    saveLocal('wassell_marketing_notifications', marketingNotifications);

    // --- Webhook inbox (user-declared inbound endpoints) ---
    let webhookSlugs = await supabaseLoad<WebhookSlug>('webhook_slugs');
    if (!webhookSlugs) webhookSlugs = loadLocal<WebhookSlug[]>('wassell_webhook_slugs') ?? [];
    saveLocal('wassell_webhook_slugs', webhookSlugs);

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
    const authConfigured = isAuthAvailable();

    if (authConfigured && authEmail) {
      const needle = authEmail.toLowerCase();
      const match = users.find((u) => (u.email ?? '').toLowerCase() === needle);
      if (match) {
        currentUserId = match.id;
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

    // Always-run system-model refresh — re-apply seed schema/card_config/labels
    // for every `is_system` model on every load. Makes `seedModels.ts` the live
    // source of truth; seed edits always show up on next reload. Builder edits
    // to system models are transient by design.
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
    const flatRecords = Object.values(migratedRecords).flat();
    saveLocal('wassell_records', flatRecords);

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
      workflowRuns,
      dashboards: migrated.dashboards,
      views: migrated.views,
      profiles,
      roles,
      users,
      fieldTemplates,
      presentationTemplates,
      presentationJobs,
      daemonStatus,
      competitors,
      marketingOperations,
      researchQuestions,
      reels,
      posts,
      marketingNotifications,
      webhookSlugs,
      currentUserId,
      initialized: true,
    });

    // Realtime: subscribe to agent-driven changes so the UI flips from
    // research_pending → research_waiting_answers → content_generating →
    // ready_for_review without the user reloading.
    get().subscribeMarketingRealtime();
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

    const channel = supabase
      .channel('marketing-pipeline')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'marketing_operations' },
        (payload) => {
          const row = (payload.new ?? payload.old) as MarketingOperation;
          if (!row?.id) return;
          set((s) => {
            if (payload.eventType === 'DELETE') {
              const next = s.marketingOperations.filter((o) => o.id !== row.id);
              saveLocal('wassell_marketing_operations', next);
              return { marketingOperations: next };
            }
            const next = upsertById(s.marketingOperations, row);
            saveLocal('wassell_marketing_operations', next);
            return { marketingOperations: next };
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'research_questions' },
        (payload) => {
          const row = (payload.new ?? payload.old) as ResearchQuestion;
          if (!row?.id) return;
          set((s) => {
            if (payload.eventType === 'DELETE') {
              const next = s.researchQuestions.filter((q) => q.id !== row.id);
              saveLocal('wassell_research_questions', next);
              return { researchQuestions: next };
            }
            const next = upsertById(s.researchQuestions, row);
            saveLocal('wassell_research_questions', next);
            return { researchQuestions: next };
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reels' },
        (payload) => {
          const row = (payload.new ?? payload.old) as Reel;
          if (!row?.id) return;
          set((s) => {
            if (payload.eventType === 'DELETE') {
              const next = s.reels.filter((r) => r.id !== row.id);
              saveLocal('wassell_reels', next);
              return { reels: next };
            }
            const next = upsertById(s.reels, row);
            saveLocal('wassell_reels', next);
            return { reels: next };
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        (payload) => {
          const row = (payload.new ?? payload.old) as Post;
          if (!row?.id) return;
          set((s) => {
            if (payload.eventType === 'DELETE') {
              const next = s.posts.filter((p) => p.id !== row.id);
              saveLocal('wassell_posts', next);
              return { posts: next };
            }
            const next = upsertById(s.posts, row);
            saveLocal('wassell_posts', next);
            return { posts: next };
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'marketing_notifications' },
        (payload) => {
          const row = (payload.new ?? payload.old) as MarketingNotification;
          if (!row?.id) return;
          set((s) => {
            if (payload.eventType === 'DELETE') {
              const next = s.marketingNotifications.filter((n) => n.id !== row.id);
              saveLocal('wassell_marketing_notifications', next);
              return { marketingNotifications: next };
            }
            const next = upsertById(s.marketingNotifications, row);
            saveLocal('wassell_marketing_notifications', next);
            return { marketingNotifications: next };
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'webhook_payloads' },
        (payload) => {
          const row = payload.new as WebhookPayload;
          if (!row?.id) return;
          // Update the local cache so the UI can show recent payloads, then
          // attempt the atomic claim. If another tab beats us to the claim,
          // the workflow run happens there instead (no double-fire).
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
      saveLocal('wassell_records', Object.values(records).flat());
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
      saveLocal('wassell_records', Object.values(result.records).flat());
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
            w as unknown as Record<string, unknown>,
            { table: 'models', id: w.trigger_model_id },
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
    const finalRecord: AppRecord = { ...record, data: enrichedData };
    const modelChanged = !!enrichedModel && enrichedModel !== origModel;

    set((s) => {
      const modelRecords = s.records[record.model_id] ?? [];
      const idx = modelRecords.findIndex((r) => r.id === record.id);
      const updated = idx >= 0
        ? modelRecords.map((r) => (r.id === record.id ? finalRecord : r))
        : [...modelRecords, finalRecord];
      const records = { ...s.records, [record.model_id]: updated };
      const allRecords = Object.values(records).flat();
      saveLocal('wassell_records', allRecords);
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
  },
  deleteRecord: (modelId: string, recordId: string) => {
    set((s) => {
      const modelRecords = (s.records[modelId] ?? []).filter((r) => r.id !== recordId);
      const records = { ...s.records, [modelId]: modelRecords };
      const allRecords = Object.values(records).flat();
      saveLocal('wassell_records', allRecords);
      supabaseDelete('records', recordId);
      return { records };
    });
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
      supabaseUpsert(
        'workflows',
        workflow as unknown as Record<string, unknown>,
        { table: 'models', id: workflow.trigger_model_id },
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
      const idx = s.profiles.findIndex((p) => p.id === profile.id);
      const profiles = idx >= 0
        ? s.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...s.profiles, profile];
      saveLocal('wassell_profiles', profiles);
      supabaseUpsert('profiles', profile as unknown as Record<string, unknown>);
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
      const profiles = state.profiles.filter((p) => p.id !== profileId);
      saveLocal('wassell_profiles', profiles);
      supabaseDelete('profiles', profileId);
      return { profiles };
    });
    return { ok: true };
  },

  // --- Roles ---
  saveRole: (role: Role) => {
    set((s) => {
      const idx = s.roles.findIndex((r) => r.id === role.id);
      const roles = idx >= 0
        ? s.roles.map((r) => (r.id === role.id ? role : r))
        : [...s.roles, role];
      saveLocal('wassell_roles', roles);
      supabaseUpsert('roles', role as unknown as Record<string, unknown>);
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

  // --- Presentations ---
  queuePresentationJob: async ({ templateId, recordId, inputs }) => {
    const s = get();
    const template = s.presentationTemplates.find((t) => t.id === templateId);
    if (!template) {
      throw new Error(`Presentation template not found: ${templateId}`);
    }
    const resolvedRecordId = recordId ?? null;
    let recordSnapshot: Record<string, unknown> | null = null;
    let recordModelId: string | null = null;
    if (resolvedRecordId) {
      for (const [modelId, list] of Object.entries(s.records)) {
        const found = list.find((r) => r.id === resolvedRecordId);
        if (found) {
          recordSnapshot = { ...found.data };
          recordModelId = modelId;
          break;
        }
      }
    }

    // Dedup key: SHA-256 of (template_id + record_id + normalized inputs).
    // If a queued/running job with the same key exists, return it instead of
    // creating a duplicate.
    const normalizedInputs = JSON.stringify(inputs, Object.keys(inputs).sort());
    const dedupPayload = `${templateId}|${resolvedRecordId ?? ''}|${normalizedInputs}`;
    const dedupKey = await sha256Hex(dedupPayload);
    const existing = s.presentationJobs.find(
      (j) =>
        j.template_id === templateId &&
        j.client_dedup_key === dedupKey &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (existing) return existing;

    const nowIso = new Date().toISOString();
    const job: PresentationJob = {
      id: uuid(),
      template_id: templateId,
      template_slug: template.slug,
      template_snapshot: template,
      record_id: resolvedRecordId,
      record_model_id: recordModelId,
      record_snapshot: recordSnapshot,
      inputs,
      client_dedup_key: dedupKey,
      requested_by_user_id: s.currentUserId,
      status: 'queued',
      progress_stage: null,
      progress_message_ar: null,
      progress_message_en: null,
      claimed_by: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      result: null,
      drive_folder_url: null,
      drive_deck_url: null,
      error_code: null,
      error_message: null,
      error_detail: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    set((prev) => {
      const next = [job, ...prev.presentationJobs];
      saveLocal('wassell_presentation_jobs', next);
      // FK: presentation_jobs.template_id → presentation_templates.id
      supabaseUpsert(
        'presentation_jobs',
        job as unknown as Record<string, unknown>,
        { table: 'presentation_templates', id: templateId },
      );
      return { presentationJobs: next };
    });
    return job;
  },

  cancelPresentationJob: (jobId: string) => {
    set((s) => {
      const nowIso = new Date().toISOString();
      let changed = false;
      const next = s.presentationJobs.map((j) => {
        if (j.id !== jobId) return j;
        if (j.status !== 'queued') return j; // running/completed/failed can't be canceled here
        changed = true;
        const updated: PresentationJob = {
          ...j,
          status: 'canceled',
          finished_at: nowIso,
          updated_at: nowIso,
        };
        supabaseUpsert(
          'presentation_jobs',
          updated as unknown as Record<string, unknown>,
          { table: 'presentation_templates', id: updated.template_id },
        );
        return updated;
      });
      if (!changed) return {};
      saveLocal('wassell_presentation_jobs', next);
      return { presentationJobs: next };
    });
  },

  retryPresentationJob: async (jobId: string) => {
    const s = get();
    const source = s.presentationJobs.find((j) => j.id === jobId);
    if (!source) return null;
    return get().queuePresentationJob({
      templateId: source.template_id,
      recordId: source.record_id,
      inputs: source.inputs,
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
    set({ authEmail: initialEmail, authReady: true });

    // Subscribe to future events. The callback may fire many times
    // (sign-in, sign-out, token refresh, password-recovery).
    onAuthChange((session) => {
      const email = getSessionEmail(session);
      const prev = get().authEmail;
      if (email === prev) return; // token-refresh — no-op for us
      set({ authEmail: email });
      // If the user just signed in, re-run initialize so the user record,
      // permissions, and data all reflect the new identity.
      if (email && get().initialized) {
        // Reset the `initialized` flag so initialize runs fresh.
        set({ initialized: false });
        void get().initialize();
      }
      // If the user just signed out, wipe in-memory state. We keep
      // localStorage intact — the next sign-in will re-hydrate instantly.
      if (!email) {
        set({
          currentUserId: null,
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
    await authSignOut();
    // authEmail is cleared by the onAuthChange callback in bindAuth, but we
    // also do it synchronously here so the UI updates without waiting for the
    // subscription round-trip.
    set({ authEmail: null, currentUserId: null });
    saveLocal('wassell_current_user_id', '');
  },

  // ────────────────────────────────────────────────────────────────────
  // Marketing operations (reels + posts content pipeline)
  // ────────────────────────────────────────────────────────────────────
  // Replaces the old OMA Google Sheets system. Flow:
  //   createMarketingOperation → INSERT + fire marketing-research fn
  //   answerResearchQuestion → UPDATE; last answer fires resume fn
  //   saveReel / savePost → human edits to agent-generated drafts
  //   approveMarketingOperation → flip operation + all children to approved

  saveCompetitor: async (competitor: Competitor) => {
    set((s) => {
      const idx = s.competitors.findIndex((c) => c.id === competitor.id);
      const competitors = idx >= 0
        ? s.competitors.map((c) => (c.id === competitor.id ? competitor : c))
        : [...s.competitors, competitor];
      saveLocal('wassell_competitors', competitors);
      return { competitors };
    });
    await supabaseUpsert('competitors', competitor as unknown as Record<string, unknown>);
  },

  deleteCompetitor: async (competitorId: string) => {
    set((s) => {
      const competitors = s.competitors.filter((c) => c.id !== competitorId);
      saveLocal('wassell_competitors', competitors);
      return { competitors };
    });
    await supabaseDelete('competitors', competitorId);
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

    const merged = [...byId.values()];
    set((s) => {
      const nextRecords = { ...s.records, [chatsModel.id]: merged };
      // Persist the flat records array to localStorage so a refresh keeps
      // the list even if Haberchat is offline on next load.
      const allRecords = Object.values(nextRecords).flat();
      saveLocal('wassell_records', allRecords);
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

  sendChatMessage: async (chatWid: string, input: { body: string; quotedWid?: string }) => {
    const state = get();
    const chatsModel = state.models.find((m) => m.name === 'chats');
    if (!chatsModel) throw new Error('chats model not found');

    const record = (state.records[chatsModel.id] ?? []).find((r) => {
      const wid = (r.data as Record<string, unknown>).wid;
      return typeof wid === 'string' && wid === chatWid;
    });
    if (!record) throw new Error('conversation not found in records');

    const data = record.data as Record<string, unknown>;
    const kind = (data.kind as string | null) ?? 'user';
    if (kind !== 'user') {
      // v1 only supports direct chats. Groups/channels come later.
      throw new Error(get().language === 'ar'
        ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا'
        : 'Sending to groups and channels is not yet supported');
    }
    const phone = data.phone as string | null;
    if (!phone) throw new Error('conversation is missing the recipient phone');

    const recordDeviceId = (data.device_id as string | undefined) ?? null;
    const deviceId =
      recordDeviceId ??
      state.waDevices.find((d) => d.is_default && d.is_active)?.device_id ??
      state.waDevices.find((d) => d.is_active)?.device_id ??
      state.waDevicesLive[0]?.id ??
      '';
    if (!deviceId) throw new Error('no WhatsApp device configured to send from');

    // From-phone for the optimistic placeholder: whichever device is sending.
    const fromPhone =
      state.waDevicesLive.find((d) => d.id === deviceId)?.phone ??
      state.waDevices.find((d) => d.device_id === deviceId)?.phone ??
      null;

    // Optimistic placeholder — rendered immediately, swapped on server ack.
    const clientId = uuid();
    const placeholder: ChatMessage = {
      id: `pending:${clientId}`,
      chat_wid: chatWid,
      flow: 'out',
      kind: 'text',
      body: input.body,
      from_phone: fromPhone,
      to_phone: phone,
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
    set((s) => {
      const existing = s.chatMessages[chatWid] ?? [];
      return { chatMessages: { ...s.chatMessages, [chatWid]: [...existing, placeholder] } };
    });

    try {
      const result = await sendHaberchatMessage({
        deviceId,
        phone,
        body: input.body,
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

  createMarketingOperation: async (input) => {
    if (!supabase) throw new Error('Supabase is not configured');
    if (!input.reelsSettings && !input.postsSettings) {
      throw new Error('يجب اختيار نوع محتوى واحد على الأقل');
    }

    // Resolve the current auth user id for the FK.
    const session = await supabase.auth.getSession();
    const authUserId = session.data.session?.user.id ?? null;

    const operationId = uuid();
    const now = new Date().toISOString();
    const operationRow: MarketingOperation = {
      id: operationId,
      project_record_id: input.projectRecordId,
      status: 'research_pending',
      reels_settings: input.reelsSettings,
      posts_settings: input.postsSettings,
      research_output: null,
      research_error: null,
      created_at: now,
      updated_at: now,
      created_by: authUserId,
    };

    // Pre-create empty reels + posts rows so the agent has targets to UPDATE.
    const newReels: Reel[] = input.reelsSettings
      ? Array.from({ length: input.reelsSettings.count }, (_, i): Reel => ({
          id: uuid(),
          operation_id: operationId,
          project_record_id: input.projectRecordId,
          reel_number: i + 1,
          status: 'pending',
          type: input.reelsSettings!.type,
          duration: null,
          platform: input.reelsSettings!.platform,
          voiceover: input.reelsSettings!.voiceover,
          goal: null,
          scenes: [],
          created_at: now,
          updated_at: now,
        }))
      : [];

    const newPosts: Post[] = input.postsSettings
      ? Array.from({ length: input.postsSettings.count }, (_, i): Post => ({
          id: uuid(),
          operation_id: operationId,
          project_record_id: input.projectRecordId,
          post_number: i + 1,
          status: 'pending',
          type: input.postsSettings!.type,
          components: null,
          visual: null,
          usage: input.postsSettings!.usage,
          title: null,
          design_text_1: null,
          design_text_2: null,
          design_text_3: null,
          caption: null,
          created_at: now,
          updated_at: now,
        }))
      : [];

    // Persist parent → children in order (child FKs point at parent).
    const { error: opErr } = await supabase
      .from('marketing_operations')
      .insert(operationRow as unknown as Record<string, unknown>);
    if (opErr) throw new Error(`Could not create operation: ${opErr.message}`);

    if (newReels.length > 0) {
      const { error: reelsErr } = await supabase.from('reels').insert(
        newReels.map((r) => r as unknown as Record<string, unknown>),
      );
      if (reelsErr) throw new Error(`Could not create reels: ${reelsErr.message}`);
    }
    if (newPosts.length > 0) {
      const { error: postsErr } = await supabase.from('posts').insert(
        newPosts.map((p) => p as unknown as Record<string, unknown>),
      );
      if (postsErr) throw new Error(`Could not create posts: ${postsErr.message}`);
    }

    set((s) => ({
      marketingOperations: [...s.marketingOperations, operationRow],
      reels: [...s.reels, ...newReels],
      posts: [...s.posts, ...newPosts],
    }));
    saveLocal('wassell_marketing_operations', get().marketingOperations);
    saveLocal('wassell_reels', get().reels);
    saveLocal('wassell_posts', get().posts);

    // Fire the research edge function. Fire-and-forget — the agent writes back
    // to the DB, and the UI picks up the new status on the next refetch.
    void supabase.functions.invoke('marketing-research', {
      body: { operationId },
    }).catch((err: unknown) => {
      console.error('[createMarketingOperation] research invoke failed:', err);
    });

    return operationId;
  },

  answerResearchQuestion: async (questionId, answer) => {
    if (!supabase) throw new Error('Supabase is not configured');
    const state = get();
    const question = state.researchQuestions.find((q) => q.id === questionId);
    if (!question) throw new Error('Question not found');

    const now = new Date().toISOString();
    const session = await supabase.auth.getSession();
    const answeredBy = session.data.session?.user.id ?? null;

    const updated: ResearchQuestion = {
      ...question,
      answer,
      status: 'answered',
      answered_at: now,
      answered_by: answeredBy,
    };

    set((s) => ({
      researchQuestions: s.researchQuestions.map((q) => (q.id === questionId ? updated : q)),
    }));
    saveLocal('wassell_research_questions', get().researchQuestions);

    const { error } = await supabase
      .from('research_questions')
      .update({
        answer,
        status: 'answered',
        answered_at: now,
        answered_by: answeredBy,
      })
      .eq('id', questionId);
    if (error) throw new Error(`Could not save answer: ${error.message}`);

    // If this was the last unanswered question for the operation, fire resume.
    const operationQuestions = get().researchQuestions.filter(
      (q) => q.operation_id === question.operation_id,
    );
    const stillWaiting = operationQuestions.filter((q) => q.status !== 'answered');
    if (stillWaiting.length === 0 && operationQuestions.length > 0) {
      void supabase.functions.invoke('marketing-research-resume', {
        body: { operationId: question.operation_id },
      }).catch((err: unknown) => {
        console.error('[answerResearchQuestion] resume invoke failed:', err);
      });
    }
  },

  saveReel: async (reel: Reel) => {
    const updated = { ...reel, updated_at: new Date().toISOString() };
    set((s) => ({
      reels: s.reels.map((r) => (r.id === reel.id ? updated : r)),
    }));
    saveLocal('wassell_reels', get().reels);
    await supabaseUpsert('reels', updated as unknown as Record<string, unknown>);
  },

  savePost: async (post: Post) => {
    const updated = { ...post, updated_at: new Date().toISOString() };
    set((s) => ({
      posts: s.posts.map((p) => (p.id === post.id ? updated : p)),
    }));
    saveLocal('wassell_posts', get().posts);
    await supabaseUpsert('posts', updated as unknown as Record<string, unknown>);
  },

  updateOperationResearch: async (operationId, output) => {
    const now = new Date().toISOString();
    set((s) => ({
      marketingOperations: s.marketingOperations.map((o) =>
        o.id === operationId ? { ...o, research_output: output, updated_at: now } : o,
      ),
    }));
    saveLocal('wassell_marketing_operations', get().marketingOperations);
    if (!supabase) return;
    const { error } = await supabase
      .from('marketing_operations')
      .update({ research_output: output, updated_at: now })
      .eq('id', operationId);
    if (error) throw new Error(`Could not save research edits: ${error.message}`);
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

  approveMarketingOperation: async (operationId: string) => {
    const state = get();
    const op = state.marketingOperations.find((o) => o.id === operationId);
    if (!op) throw new Error('Operation not found');

    const now = new Date().toISOString();
    const reelsToApprove = state.reels.filter(
      (r) => r.operation_id === operationId && r.status === 'draft_ready',
    );
    const postsToApprove = state.posts.filter(
      (p) => p.operation_id === operationId && p.status === 'draft_ready',
    );

    const updatedReels = state.reels.map((r) =>
      reelsToApprove.some((x) => x.id === r.id)
        ? { ...r, status: 'approved' as const, updated_at: now }
        : r,
    );
    const updatedPosts = state.posts.map((p) =>
      postsToApprove.some((x) => x.id === p.id)
        ? { ...p, status: 'approved' as const, updated_at: now }
        : p,
    );
    const updatedOperation: MarketingOperation = { ...op, status: 'approved', updated_at: now };

    set({
      marketingOperations: state.marketingOperations.map((o) =>
        o.id === operationId ? updatedOperation : o,
      ),
      reels: updatedReels,
      posts: updatedPosts,
    });
    saveLocal('wassell_marketing_operations', get().marketingOperations);
    saveLocal('wassell_reels', get().reels);
    saveLocal('wassell_posts', get().posts);

    if (!supabase) return;
    await supabase
      .from('marketing_operations')
      .update({ status: 'approved', updated_at: now })
      .eq('id', operationId);
    for (const r of reelsToApprove) {
      await supabase.from('reels').update({ status: 'approved', updated_at: now }).eq('id', r.id);
    }
    for (const p of postsToApprove) {
      await supabase.from('posts').update({ status: 'approved', updated_at: now }).eq('id', p.id);
    }
  },

  markNotificationRead: async (id: string | null) => {
    const state = get();
    const now = new Date().toISOString();
    if (id === null) {
      const updated = state.marketingNotifications.map((n) =>
        n.read_at ? n : { ...n, read_at: now },
      );
      set({ marketingNotifications: updated });
      saveLocal('wassell_marketing_notifications', updated);
      if (supabase) {
        await supabase
          .from('marketing_notifications')
          .update({ read_at: now })
          .is('read_at', null);
      }
      return;
    }

    const notification = state.marketingNotifications.find((n) => n.id === id);
    if (!notification || notification.read_at) return;
    const updated = { ...notification, read_at: now };
    set({
      marketingNotifications: state.marketingNotifications.map((n) =>
        n.id === id ? updated : n,
      ),
    });
    saveLocal('wassell_marketing_notifications', get().marketingNotifications);
    if (supabase) {
      await supabase
        .from('marketing_notifications')
        .update({ read_at: now })
        .eq('id', id);
    }
  },
}));
