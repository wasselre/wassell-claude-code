import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import { getSession, getSessionEmail, onAuthChange, signOut as authSignOut, isAuthAvailable } from '@/lib/auth';
import { SEED_MODELS, SEED_GROUPS } from '@/data/seedModels';
import { SEED_PROFILES, SEED_ROLES, SEED_USERS } from '@/data/seedUsers';
import { executeWorkflows } from '@/lib/workflowEngine';
import { assignAutoIds } from '@/lib/autoIdAssigner';
import { applyFieldFallbacks } from '@/lib/fieldFallbackResolver';
import { computeAllFormulas } from '@/lib/formulaEngine';
import { runMigrations, healSystemModelGroups, healClientsSchema, healResearchMultiProject, healResearchComparisonContainer, healMapsConfigForModels, refreshSystemModels } from '@/lib/schemaMigrations';
import { applyFieldRename } from '@/lib/fieldRename';
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
      currentUserId,
      initialized: true,
    });
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
}));
