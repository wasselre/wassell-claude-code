import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { supabase } from '@/lib/supabase';
import { getSession, getSessionEmail, onAuthChange, signOut as authSignOut, isAuthAvailable } from '@/lib/auth';
import { SEED_MODELS, SEED_GROUPS } from '@/data/seedModels';
import { SEED_PROFILES, SEED_ROLES, SEED_USERS } from '@/data/seedUsers';
import { executeWorkflows } from '@/lib/workflowEngine';
import { assignAutoIds } from '@/lib/autoIdAssigner';
import { computeAllFormulas } from '@/lib/formulaEngine';
import { runMigrations, healSystemModelGroups, healClientsSchema, healResearchMultiProject, healResearchComparisonContainer, refreshSystemModels } from '@/lib/schemaMigrations';
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

// --- Supabase helpers (fire-and-forget) ---

async function supabaseUpsert(table: string, row: Record<string, unknown>): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from(table).upsert(row);
  } catch {
    // silent fail — data is safe in localStorage
  }
}

async function supabaseDelete(table: string, id: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from(table).delete().eq('id', id);
  } catch {
    // silent fail
  }
}

async function supabaseLoad<T>(table: string): Promise<T[] | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from(table).select('*');
    if (error) return null;
    return data as T[];
  } catch {
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
  initialized: false,

  // --- Initialize ---
  initialize: async () => {
    if (get().initialized) return;

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

    // Load profiles
    let profiles = await supabaseLoad<Profile>('profiles');
    if (!profiles) profiles = loadLocal<Profile[]>('wassell_profiles');
    if (!profiles || profiles.length === 0) profiles = SEED_PROFILES;

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
    for (const p of profiles) supabaseUpsert('profiles', p as unknown as Record<string, unknown>);

    // Load roles
    let roles = await supabaseLoad<Role>('roles');
    if (!roles) roles = loadLocal<Role[]>('wassell_roles');
    if (!roles || roles.length === 0) roles = SEED_ROLES;
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
    for (const r of roles) supabaseUpsert('roles', r as unknown as Record<string, unknown>);

    // Load users
    let users = await supabaseLoad<User>('users');
    if (!users) users = loadLocal<User[]>('wassell_users');
    if (!users || users.length === 0) users = SEED_USERS;
    saveLocal('wassell_users', users);

    // Load field templates (user-saved reusable field snapshots)
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
          supabaseUpsert('users', adopted as unknown as Record<string, unknown>);
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
      supabaseUpsert('models', model as unknown as Record<string, unknown>);
      return { models };
    });
  },
  deleteModel: (modelId: string) => {
    set((s) => {
      const models = s.models.filter((m) => m.id !== modelId);
      const records = { ...s.records };
      delete records[modelId];
      saveLocal('wassell_models', models);
      const allRecords = Object.values(records).flat();
      saveLocal('wassell_records', allRecords);
      supabaseDelete('models', modelId);
      return { models, records };
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
      for (const id of result.changedModelIds) {
        const m = finalModels.find((x) => x.id === id);
        if (m) supabaseUpsert('models', m as unknown as Record<string, unknown>);
      }
      for (const id of result.changedRecordIds) {
        const r = Object.values(result.records).flat().find((x) => x.id === id);
        if (r) supabaseUpsert('records', r as unknown as Record<string, unknown>);
      }
      for (const id of result.changedWorkflowIds) {
        const w = result.workflows.find((x) => x.id === id);
        if (w) supabaseUpsert('workflows', w as unknown as Record<string, unknown>);
      }
      for (const id of result.changedViewIds) {
        const v = result.views.find((x) => x.id === id);
        if (v) supabaseUpsert('model_views', v as unknown as Record<string, unknown>);
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
      const groups = s.groups.filter((g) => g.id !== groupId);
      saveLocal('wassell_groups', groups);
      supabaseDelete('model_groups', groupId);
      return { groups };
    });
  },

  // --- Records ---
  getRecords: (modelId: string) => {
    return get().records[modelId] ?? [];
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
      supabaseUpsert('records', finalRecord as unknown as Record<string, unknown>);

      if (modelChanged && enrichedModel) {
        const models = s.models.map((m) => (m.id === enrichedModel!.id ? enrichedModel! : m));
        saveLocal('wassell_models', models);
        supabaseUpsert('models', enrichedModel as unknown as Record<string, unknown>);
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

  // --- Workflows ---
  saveWorkflow: (workflow: Workflow) => {
    set((s) => {
      const idx = s.workflows.findIndex((w) => w.id === workflow.id);
      const workflows = idx >= 0
        ? s.workflows.map((w) => (w.id === workflow.id ? workflow : w))
        : [...s.workflows, workflow];
      saveLocal('wassell_workflows', workflows);
      supabaseUpsert('workflows', workflow as unknown as Record<string, unknown>);
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
      supabaseUpsert('model_views', view as unknown as Record<string, unknown>);
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
        supabaseUpsert('model_views', updated as unknown as Record<string, unknown>);
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
      supabaseUpsert('users', user as unknown as Record<string, unknown>);
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
        supabaseUpsert('users', next as unknown as Record<string, unknown>);
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
