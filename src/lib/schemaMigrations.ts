import { v4 as uuid } from 'uuid';
import { SEED_MODELS, SEED_GROUPS, PROJECTS_GROUP_ID, RETIRED_SYSTEM_MODEL_NAMES } from '@/data/seedModels';
import { MAPS_CONFIG_DEFAULT } from '@/types';
import type { AppModel, AppRecord, Workflow, Dashboard, ModelView, ModelGroup, NoteEntry } from '@/types';

/**
 * System models that belong under the Projects group. Used by the heal pass below
 * and by legacy migrations 2→3 / 4→5.
 */
const PROJECTS_SYSTEM_NAMES = new Set([
  'all_projects',
  'targeted_projects',
  'our_projects',
  'developers',
  'units',
]);

/**
 * Schema versioning for the Wassell CRM.
 *
 * Seeds only run on first load (when `wassell_models` is empty). That means edits
 * to system models in `seedModels.ts` are invisible to returning users. This module
 * runs pending migrations each time the app starts.
 *
 * Bump SCHEMA_VERSION whenever you add a new migration. Each migration is numbered
 * starting at 1; we run the ones between the user's stored version and SCHEMA_VERSION.
 */
export const SCHEMA_VERSION = 10;

const VERSION_KEY = 'wassell_schema_version';

export interface MigrationInput {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
  workflows: Workflow[];
  dashboards: Dashboard[];
  views: ModelView[];
  groups: ModelGroup[];
}

export interface MigrationOutput extends MigrationInput {}

type Migration = (state: MigrationInput) => MigrationOutput;

/**
 * Migration 1 → 2: Refresh system models (re-apply SEED_MODELS for models flagged
 * `is_system`), introduce the new `developers` model, and clear orphaned research
 * records whose schema has been replaced.
 */
const migration_1_to_2: Migration = (state) => {
  const seededByName = new Map(SEED_MODELS.map((m) => [m.name, m]));
  const existingByName = new Map(state.models.map((m) => [m.name, m]));

  // For each seed model: if a same-named model exists, replace its schema/card_config in place
  // (preserve id AND group_id so the Sidebar's group lookup still resolves — seed group_ids
  // are fresh UUIDs per module load, but the user's stored group has the ORIGINAL seed id).
  const out: AppModel[] = state.models.map((m) => {
    const seed = seededByName.get(m.name);
    if (!seed || !m.is_system) return m;
    return {
      ...m,
      icon: seed.icon,
      color: seed.color,
      label_ar: seed.label_ar,
      label_en: seed.label_en,
      schema: seed.schema,
      card_config: seed.card_config,
      is_system: true,
      updated_at: new Date().toISOString(),
    };
  });

  // For a newly inserted system model, find the matching existing group by its label
  // (seed.group_id is a fresh UUID each module load, so we can't use it directly).
  // Fall back to no group if no match — user can re-assign in the Builder.
  const projectsGroupId =
    state.groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects')?.id ?? null;

  // Insert any system models missing from the install (new: developers).
  for (const seed of SEED_MODELS) {
    if (!seed.is_system) continue;
    if (existingByName.has(seed.name)) continue;
    out.push({ ...seed, group_id: seed.group_id ? projectsGroupId : null });
  }

  // Clear records for models whose schema just changed meaningfully.
  // Audit fix M10: archive the records to a localStorage bucket BEFORE
  // dropping them. A user who edited the seed model definition between
  // deploys (or restored from a backup) used to lose data with only a
  // console.warn. The archive key is human-readable so support can
  // recover the rows manually if needed.
  const researchModel = out.find((m) => m.name === 'projects_research');
  const newRecords = { ...state.records };
  if (researchModel && newRecords[researchModel.id]?.length) {
    const archiveKey = `wassell_archive_v1_${researchModel.name}_${Date.now()}`;
    const archived = newRecords[researchModel.id]!;
    try {
      localStorage.setItem(
        archiveKey,
        JSON.stringify({
          model_name: researchModel.name,
          archived_at: new Date().toISOString(),
          reason: 'schema migration v1→v2: field slugs changed',
          records: archived,
        }),
      );
      console.warn(
        `[schemaMigrations] Cleared ${archived.length} projects_research record(s); ` +
          `archived to localStorage["${archiveKey}"] for recovery.`,
      );
    } catch (archiveErr) {
      // If the archive write fails (quota), we still drop the records,
      // but at least surface the loss loudly.
      console.error(
        `[schemaMigrations] Could NOT archive ${archived.length} projects_research record(s) ` +
          `before clearing them. Reason: ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}`,
      );
    }
    delete newRecords[researchModel.id];
  }

  // Surface dangling references — views/widgets referencing fields that no longer exist.
  const validFieldIds = new Set(
    out.flatMap((m) => m.schema.sections.flatMap((s) => s.fields.map((f) => f.id))),
  );
  const danglingViews = state.views.filter((v) => v.field_ids.some((id) => !validFieldIds.has(id)));
  if (danglingViews.length) {
    console.warn(
      `[schemaMigrations] ${danglingViews.length} saved view(s) reference removed fields — ` +
        `reconfigure from Records UI.`,
    );
  }
  const danglingDashboards = state.dashboards.filter((d) =>
    d.widgets.some((w) => {
      const cfg = w.config as unknown as { field_ids?: string[] };
      return Array.isArray(cfg.field_ids) && cfg.field_ids.some((id) => !validFieldIds.has(id));
    }),
  );
  if (danglingDashboards.length) {
    console.warn(
      `[schemaMigrations] ${danglingDashboards.length} dashboard(s) have widgets with stale field IDs — ` +
        `reconfigure from Dashboard editor.`,
    );
  }

  return { ...state, models: out, records: newRecords };
};

/**
 * Migration 2 → 3: Recovery for an earlier bug in migration_1_to_2 that overwrote
 * system-model `group_id` with a fresh UUID (from seedModels.ts module-load),
 * causing project models to disappear from the Sidebar (which filters by group_id).
 *
 * For every model whose `group_id` no longer matches any existing group, try to
 * re-attach it to the "Projects" group by label. If no match, null out the group_id
 * so the model at least shows up as ungrouped.
 */
const migration_2_to_3: Migration = (state) => {
  const groupIds = new Set(state.groups.map((g) => g.id));
  const projectsGroup =
    state.groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects') ?? null;

  let healed = 0;
  const out = state.models.map((m) => {
    if (!m.group_id || groupIds.has(m.group_id)) return m;
    // Orphan. Try to recover.
    if (PROJECTS_SYSTEM_NAMES.has(m.name) && projectsGroup) {
      healed++;
      return { ...m, group_id: projectsGroup.id };
    }
    healed++;
    return { ...m, group_id: null };
  });

  if (healed > 0) {
    console.warn(`[schemaMigrations] Healed ${healed} model(s) with orphaned group_id.`);
  }

  return { ...state, models: out };
};

/**
 * Migration 3 → 4: Rebuild the `clients` system model against the new schema
 * (Basic + Client Preferences sections; new `notes` and `range` field types).
 * Existing client records are migrated in place — kept slugs are preserved,
 * `phone` moves to `phone_number`, a numeric `budget` is wrapped as a range,
 * and a textarea `notes` string is converted to a single Notes entry so history
 * isn't lost. Data under removed slugs (`status`, `source`, `email`, `city`,
 * `address`) is dropped because the new options/types don't cleanly map.
 */
const migration_3_to_4: Migration = (state) => {
  const seededByName = new Map(SEED_MODELS.map((m) => [m.name, m]));
  const clientsSeed = seededByName.get('clients');
  if (!clientsSeed) return state;

  const out: AppModel[] = state.models.map((m) => {
    if (m.name !== 'clients' || !m.is_system) return m;
    return {
      ...m,
      schema: clientsSeed.schema,
      card_config: clientsSeed.card_config,
      updated_at: new Date().toISOString(),
    };
  });

  const clientsModel = out.find((m) => m.name === 'clients');
  const newRecords = { ...state.records };
  if (clientsModel && newRecords[clientsModel.id]?.length) {
    let migrated = 0;
    newRecords[clientsModel.id] = newRecords[clientsModel.id]!.map((rec) => {
      const oldData = rec.data;
      const newData: Record<string, unknown> = {};

      if (oldData.client_name !== undefined) newData.client_name = oldData.client_name;

      const phone = oldData.phone_number ?? oldData.phone;
      if (phone !== undefined) newData.phone_number = phone;

      if (typeof oldData.budget === 'number') {
        newData.budget = { min: oldData.budget, max: oldData.budget };
      } else if (oldData.budget && typeof oldData.budget === 'object') {
        newData.budget = oldData.budget;
      }

      if (typeof oldData.notes === 'string' && oldData.notes.trim()) {
        const entry: NoteEntry = {
          id: uuid(),
          text: oldData.notes,
          author_id: null,
          created_at: rec.created_at,
        };
        newData.notes = [entry];
      } else if (Array.isArray(oldData.notes)) {
        newData.notes = oldData.notes;
      }

      migrated++;
      return { ...rec, data: newData, updated_at: new Date().toISOString() };
    });
    if (migrated) {
      console.warn(
        `[schemaMigrations] Migrated ${migrated} clients record(s) to the new schema. ` +
          `Dropped fields: status, source, email, city, address.`,
      );
    }
  }

  return { ...state, models: out, records: newRecords };
};

/**
 * Migration 4 → 5: Re-heal orphaned project-model `group_id`s AND insert any missing
 * system models (catches users whose `developers` never got seeded because the
 * groups array briefly held a stale id when migration_1_to_2 first ran).
 *
 * Idempotent — no-op for users whose data is already consistent.
 */
const migration_4_to_5: Migration = (state) => {
  const groupIds = new Set(state.groups.map((g) => g.id));
  const projectsGroup =
    state.groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects') ?? null;

  // 1. Heal orphaned group_ids (same logic as migration_2_to_3, in case it missed).
  let healed = 0;
  let out = state.models.map((m) => {
    if (!m.group_id || groupIds.has(m.group_id)) return m;
    if (PROJECTS_SYSTEM_NAMES.has(m.name) && projectsGroup) {
      healed++;
      return { ...m, group_id: projectsGroup.id };
    }
    healed++;
    return { ...m, group_id: null };
  });

  // 2. Insert any missing system models (developers, or anything else added to seeds since).
  const existingNames = new Set(out.map((m) => m.name));
  let inserted = 0;
  for (const seed of SEED_MODELS) {
    if (!seed.is_system) continue;
    if (existingNames.has(seed.name)) continue;
    const groupId = seed.group_id
      ? PROJECTS_SYSTEM_NAMES.has(seed.name)
        ? (projectsGroup?.id ?? null)
        : null
      : null;
    out = [...out, { ...seed, group_id: groupId }];
    inserted++;
  }

  if (healed > 0) {
    console.warn(`[schemaMigrations v5] Re-healed ${healed} model(s) with orphaned group_id.`);
  }
  if (inserted > 0) {
    console.warn(`[schemaMigrations v5] Inserted ${inserted} missing system model(s).`);
  }

  return { ...state, models: out };
};

/**
 * Migration 5 → 6: Safety-net re-apply of the clients seed schema.
 *
 * Why this exists: when the clients rebuild (2026-04-18) first shipped, it was
 * packaged as migration_3_to_4 with SCHEMA_VERSION=4. A concurrent change then
 * bumped SCHEMA_VERSION to 5 for an unrelated heal pass (migration_4_to_5).
 * Users who happened to run the intermediate build only once saved
 * `wassell_schema_version=5` without ever executing migration_3_to_4 in the
 * right order — so their stored clients model is still the pre-rebuild shape
 * (sections "General Info" + "Contact Details" + "Additional Notes", fields
 * `status`, `source`, `budget` as currency, textarea `notes`, etc.).
 *
 * This migration detects that stale shape by looking for a `client_stage` field
 * (only present in the new seed) and, if absent, re-applies the clients seed
 * schema + remigrates records (same logic as migration_3_to_4). Idempotent:
 * users already on the new schema are a no-op.
 */
const migration_5_to_6: Migration = (state) => {
  const seededByName = new Map(SEED_MODELS.map((m) => [m.name, m]));
  const clientsSeed = seededByName.get('clients');
  if (!clientsSeed) return state;

  const clientsIdx = state.models.findIndex((m) => m.name === 'clients' && m.is_system);
  if (clientsIdx === -1) return state;

  const existingClients = state.models[clientsIdx]!;
  const allFieldSlugs = new Set(
    existingClients.schema.sections.flatMap((s) => s.fields.map((f) => f.name)),
  );
  const alreadyNewShape = allFieldSlugs.has('client_stage') && allFieldSlugs.has('preferred_area');
  if (alreadyNewShape) return state;

  const out = state.models.slice();
  out[clientsIdx] = {
    ...existingClients,
    schema: clientsSeed.schema,
    card_config: clientsSeed.card_config,
    updated_at: new Date().toISOString(),
  };

  const newRecords = { ...state.records };
  const existingRecords = newRecords[existingClients.id] ?? [];
  if (existingRecords.length) {
    let migrated = 0;
    newRecords[existingClients.id] = existingRecords.map((rec) => {
      const oldData = rec.data;
      const newData: Record<string, unknown> = {};

      if (oldData.client_name !== undefined) newData.client_name = oldData.client_name;

      const phone = oldData.phone_number ?? oldData.phone;
      if (phone !== undefined) newData.phone_number = phone;

      if (typeof oldData.budget === 'number') {
        newData.budget = { min: oldData.budget, max: oldData.budget };
      } else if (oldData.budget && typeof oldData.budget === 'object') {
        newData.budget = oldData.budget;
      }

      if (typeof oldData.notes === 'string' && oldData.notes.trim()) {
        const entry: NoteEntry = {
          id: uuid(),
          text: oldData.notes,
          author_id: null,
          created_at: rec.created_at,
        };
        newData.notes = [entry];
      } else if (Array.isArray(oldData.notes)) {
        newData.notes = oldData.notes;
      }

      migrated++;
      return { ...rec, data: newData, updated_at: new Date().toISOString() };
    });
    if (migrated) {
      console.warn(
        `[schemaMigrations v6] Re-migrated ${migrated} clients record(s). ` +
          `Dropped: status, source, email, city, address.`,
      );
    }
  }

  console.warn('[schemaMigrations v6] Re-applied clients seed (safety-net for v4 skip).');
  return { ...state, models: out, records: newRecords };
};

/**
 * Migration 6 → 7: Follow-Ups restructure + new Appointments and Units models.
 *
 * What changes:
 * - Follow-Ups schema is replaced (new sections: Basic Info, Client Preferences
 *   mirrored from clients, Call, Appointment Confirmation, Post-Visit, WhatsApp).
 *   All old follow-up records are wiped — their field slugs (call_duration,
 *   meeting_summary, contract_value, etc.) no longer exist in the new schema.
 * - Clients schema refreshed so `preferred_projects` and `preferred_units` gain
 *   `is_multi: true`. Scalar IDs are wrapped into single-element arrays.
 * - `preferred_units` now points at the new Units model; old values that
 *   referenced all_projects are cleared (the IDs don't exist in Units).
 * - The Appointments and Units system models are inserted if missing.
 */
const migration_6_to_7: Migration = (state) => {
  const seededByName = new Map(SEED_MODELS.map((m) => [m.name, m]));
  let models = state.models.slice();
  let records = { ...state.records };
  const now = new Date().toISOString();

  // 1. Refresh the Follow-Ups system model schema.
  const followupsSeed = seededByName.get('followups');
  const fuIdx = models.findIndex((m) => m.name === 'followups' && m.is_system);
  if (followupsSeed && fuIdx !== -1) {
    const existing = models[fuIdx]!;
    models[fuIdx] = {
      ...existing,
      schema: followupsSeed.schema,
      card_config: followupsSeed.card_config,
      label_ar: followupsSeed.label_ar,
      label_en: followupsSeed.label_en,
      icon: followupsSeed.icon,
      color: followupsSeed.color,
      updated_at: now,
    };
    // Wipe old follow-up records — slugs changed too much to remap.
    const oldRecords = records[existing.id] ?? [];
    if (oldRecords.length) {
      console.warn(
        `[schemaMigrations v7] Wiped ${oldRecords.length} follow-up record(s) ` +
          `— schema replaced and old slugs are gone.`,
      );
      delete records[existing.id];
    }
  }

  // 2. Refresh the Clients system model schema (picks up is_multi + new lookup_model_id on preferred_units).
  const clientsSeed = seededByName.get('clients');
  const clientsIdx = models.findIndex((m) => m.name === 'clients' && m.is_system);
  if (clientsSeed && clientsIdx !== -1) {
    const existing = models[clientsIdx]!;
    models[clientsIdx] = {
      ...existing,
      schema: clientsSeed.schema,
      card_config: clientsSeed.card_config,
      updated_at: now,
    };
    // Migrate client records: wrap scalar preferred_projects into arrays; clear preferred_units
    // (old values pointed at all_projects; new field points at units, IDs don't match).
    const clientRecords = records[existing.id] ?? [];
    if (clientRecords.length) {
      let changed = 0;
      records[existing.id] = clientRecords.map((rec) => {
        const data = { ...rec.data };
        let dirty = false;
        if (typeof data.preferred_projects === 'string' && data.preferred_projects) {
          data.preferred_projects = [data.preferred_projects];
          dirty = true;
        }
        if (data.preferred_units !== undefined && !Array.isArray(data.preferred_units)) {
          data.preferred_units = [];
          dirty = true;
        } else if (Array.isArray(data.preferred_units) && data.preferred_units.length > 0) {
          // Old IDs referred to all_projects — clear them; user re-picks from Units.
          data.preferred_units = [];
          dirty = true;
        }
        if (dirty) {
          changed++;
          return { ...rec, data, updated_at: now };
        }
        return rec;
      });
      if (changed) {
        console.warn(
          `[schemaMigrations v7] Normalized ${changed} client record(s): wrapped preferred_projects to array, cleared preferred_units.`,
        );
      }
    }
  }

  // 3. Insert new system models (appointments, units) if missing.
  const projectsGroup =
    state.groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects') ?? null;
  const existingNames = new Set(models.map((m) => m.name));
  let inserted = 0;
  for (const seed of SEED_MODELS) {
    if (!seed.is_system) continue;
    if (existingNames.has(seed.name)) continue;
    const groupId = seed.group_id
      ? (PROJECTS_SYSTEM_NAMES.has(seed.name) || seed.name === 'units'
          ? (projectsGroup?.id ?? PROJECTS_GROUP_ID)
          : null)
      : null;
    models = [...models, { ...seed, group_id: groupId }];
    inserted++;
  }
  if (inserted > 0) {
    console.warn(`[schemaMigrations v7] Inserted ${inserted} new system model(s) (appointments, units).`);
  }

  return { ...state, models, records };
};

/**
 * Migration 7 → 8: Projects Research becomes multi-project.
 *
 * The research model previously linked one project per record via a single-select
 * `project_name` lookup. To support side-by-side comparison, that field is now
 * multi-select. Users have typically customized this model in the Builder, so we
 * CAN'T replace the whole schema — that would wipe their field IDs and break the
 * mirror references that depend on them. Instead:
 *
 * 1. Flip `is_multi: true` on the existing field named `project_name` inside the
 *    stored `projects_research` model. Match by slug, not ID, since user edits can
 *    move IDs around. Leaves every other field / section / slug untouched.
 * 2. Wrap every stored `projects_research` record's scalar `project_name` value
 *    into a single-element array so the multi-select renderer reads a `string[]`.
 *    Already-array values and undefined/empty values are left alone.
 *
 * Idempotent for records that are already `string[]`.
 */
const migration_7_to_8: Migration = (state) => {
  const researchIdx = state.models.findIndex((m) => m.name === 'projects_research');
  if (researchIdx === -1) return state;

  const research = state.models[researchIdx]!;
  let modelChanged = false;
  const nextSections = research.schema.sections.map((section) => {
    const nextFields = section.fields.map((field) => {
      if (field.name === 'project_name' && field.type === 'lookup' && !field.is_multi) {
        modelChanged = true;
        return { ...field, is_multi: true as const };
      }
      return field;
    });
    return { ...section, fields: nextFields };
  });

  const models = state.models.slice();
  if (modelChanged) {
    models[researchIdx] = {
      ...research,
      schema: { ...research.schema, sections: nextSections },
      updated_at: new Date().toISOString(),
    };
    console.warn('[schemaMigrations v8] Flipped project_name.is_multi on projects_research.');
  }

  const records = { ...state.records };
  const researchRecords = records[research.id] ?? [];
  if (researchRecords.length) {
    let wrapped = 0;
    records[research.id] = researchRecords.map((rec) => {
      const v = rec.data.project_name;
      if (typeof v === 'string' && v) {
        wrapped++;
        return { ...rec, data: { ...rec.data, project_name: [v] }, updated_at: new Date().toISOString() };
      }
      return rec;
    });
    if (wrapped) {
      console.warn(`[schemaMigrations v8] Wrapped ${wrapped} research record(s) project_name into arrays.`);
    }
  }

  return { ...state, models, records };
};

/**
 * Migration 8 → 9: Was inserting the `project_comparison` section_mirror
 * container into projects_research. The projects_research model + its
 * associated UI was removed in 2026-05-06; this migration is now a no-op
 * but kept so the version chain stays unbroken for any user whose stored
 * `wassell_schema_version` is still below 10.
 */
const migration_8_to_9: Migration = (state) => state;

/**
 * Migration 9 → 10: Add the default `maps_config` object to every model that
 * predates the Maps view feature. Idempotent.
 */
const migration_9_to_10: Migration = (state) => {
  let changed = 0;
  const models = state.models.map((m) => {
    if (m.maps_config) return m;
    changed++;
    return { ...m, maps_config: { ...MAPS_CONFIG_DEFAULT } };
  });
  if (changed > 0) {
    console.warn(`[schemaMigrations v10] Added default maps_config to ${changed} model(s).`);
  }
  return { ...state, models };
};

/**
 * Always-run, idempotent heal that ensures every model has a `maps_config`.
 * Catches version-drift users whose marker advanced past 10 without running
 * the migration (see migration_5_to_6 for the class of bug).
 */
export function healMapsConfigForModels(models: AppModel[]): { models: AppModel[]; changed: boolean } {
  let changed = false;
  const next = models.map((m) => {
    if (m.maps_config) return m;
    changed = true;
    return { ...m, maps_config: { ...MAPS_CONFIG_DEFAULT } };
  });
  if (changed) console.warn('[healMapsConfig] Backfilled maps_config on one or more models.');
  return { models: next, changed };
}

const MIGRATIONS: Record<number, Migration> = {
  2: migration_1_to_2,
  3: migration_2_to_3,
  4: migration_3_to_4,
  5: migration_4_to_5,
  6: migration_5_to_6,
  7: migration_6_to_7,
  8: migration_7_to_8,
  9: migration_8_to_9,
  10: migration_9_to_10,
};

/**
 * Run any pending migrations up to SCHEMA_VERSION. Persists the new version on success.
 */
export function runMigrations(state: MigrationInput): MigrationOutput {
  let current = 1;
  try {
    const raw = localStorage.getItem(VERSION_KEY);
    if (raw) current = Math.max(1, Number(JSON.parse(raw)) || 1);
  } catch {
    // Treat unreadable version as fresh install — but also don't wipe a returning user's data.
  }

  let next = state;
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    next = step(next);
  }

  try {
    localStorage.setItem(VERSION_KEY, JSON.stringify(SCHEMA_VERSION));
  } catch {
    // ignore
  }
  return next;
}

/**
 * Idempotent: inserts any `is_system` models from `SEED_MODELS` that don't yet
 * exist in the user's store. Runs on every init but only acts on brand-new
 * system models (ones this install has never seen).
 *
 * Does NOT overwrite existing system models. Once a system model exists in the
 * user's store, Builder edits are authoritative — seed changes in code do not
 * propagate. To push a structural change to existing installs, add a versioned
 * migration (see the `migration_N_to_M` pattern above).
 *
 * Non-system models are untouched.
 */
export function refreshSystemModels(state: MigrationInput): MigrationOutput {
  const existingByName = new Map(state.models.map((m) => [m.name, m]));
  const projectsGroup =
    state.groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects') ?? null;

  const finalModels = [...state.models];
  let inserted = 0;
  for (const seed of SEED_MODELS) {
    if (!seed.is_system) continue;
    if (existingByName.has(seed.name)) continue;
    const groupId = seed.group_id
      ? (PROJECTS_SYSTEM_NAMES.has(seed.name)
          ? (projectsGroup?.id ?? PROJECTS_GROUP_ID)
          : null)
      : null;
    finalModels.push({ ...seed, group_id: groupId });
    inserted++;
  }

  if (inserted > 0) {
    console.warn(`[refreshSystemModels] Inserted ${inserted} new system model(s) from seed.`);
  }

  return { ...state, models: finalModels };
}

/**
 * Counterpart to `refreshSystemModels`. Drops any `is_system: true` model
 * whose `name` is in the explicit `RETIRED_SYSTEM_MODEL_NAMES` set.
 * Records, workflows, views, and workflow runs keyed by the dropped model
 * ids are removed from the in-memory map too — they're orphans once the
 * parent model is gone, and stale workflows in particular can fire
 * against a model that no longer exists.
 *
 * Returns the dropped IDs so the caller can fan out a `supabaseDelete`
 * for each one. That's the propagation path from "retired in code" →
 * "deleted in Supabase" — without it, a stale browser session can
 * re-upsert the row from localStorage and the ghost comes back across
 * the entire installation.
 *
 * Two reasons we use the explicit `RETIRED_SYSTEM_MODEL_NAMES` set
 * instead of "absent from SEED_MODELS":
 *
 *   1. Safety. A developer mid-refactor who temporarily removes a model
 *      from `SEED_MODELS` would otherwise nuke production data.
 *      Explicit retirement is git-auditable and intentional.
 *   2. Distinction. A model "not in SEED_MODELS" can mean "user built
 *      it in the Builder" — those are user-owned and must not be
 *      touched. The retirement set narrows the action to system rows
 *      we explicitly retired.
 *
 * Non-system models are NEVER pruned — those are user-built and we
 * don't own their lifecycle.
 */
export interface PruneResult extends MigrationOutput {
  /** Model IDs the caller should `supabaseDelete('models', id)` for. */
  retiredModelIds: string[];
  retiredNames: string[];
}

export function pruneRemovedSystemModels(state: MigrationInput): PruneResult {
  const dropped: string[] = [];
  const dropIds = new Set<string>();
  const filteredModels = state.models.filter((m) => {
    if (!m.is_system) return true;
    if (!RETIRED_SYSTEM_MODEL_NAMES.has(m.name)) return true;
    dropped.push(m.name);
    dropIds.add(m.id);
    return false;
  });
  if (dropped.length === 0) {
    return { ...state, retiredModelIds: [], retiredNames: [] };
  }

  // Drop orphaned records, workflows, views, and workflow runs whose
  // parent model is being retired. Same posture as the regular
  // `deleteModel` action — keep the cascade tight so a workflow doesn't
  // fire against a model that's about to disappear.
  const filteredRecords: typeof state.records = {};
  for (const [modelId, list] of Object.entries(state.records)) {
    if (!dropIds.has(modelId)) filteredRecords[modelId] = list;
  }
  const filteredWorkflows = state.workflows.filter(
    (w) => !dropIds.has(w.trigger_model_id),
  );
  const filteredViews = state.views.filter((v) => !dropIds.has(v.model_id));

  console.warn(
    `[pruneRemovedSystemModels] Retired ${dropped.length} system model(s): ${dropped.join(', ')}. ` +
      `Cascading delete to Supabase + dropping ${state.workflows.length - filteredWorkflows.length} workflow(s) ` +
      `and ${state.views.length - filteredViews.length} view(s).`,
  );

  return {
    ...state,
    models: filteredModels,
    records: filteredRecords,
    workflows: filteredWorkflows,
    views: filteredViews,
    retiredModelIds: Array.from(dropIds),
    retiredNames: dropped,
  };
}

export interface HealInput {
  models: AppModel[];
  groups: ModelGroup[];
}

export interface HealOutput {
  models: AppModel[];
  groups: ModelGroup[];
  changed: boolean;
}

export interface HealSchemaInput {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
}

export interface HealSchemaOutput {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
  changed: boolean;
}

/**
 * Always-run, idempotent heal for the Clients system model's schema.
 *
 * Why this exists on top of migration_3_to_4 / _5_to_6 / _6_to_7: a user whose
 * stored `wassell_schema_version` was bumped to 7 at some intermediate point
 * BEFORE the clients rebuild actually landed in their localStorage won't re-run
 * any of those migrations — runMigrations only runs versions strictly greater
 * than `current`. Their clients model stays stuck on the pre-rebuild shape
 * (`status`, `source`, `email`, `city`, `address`, textarea `notes`, no
 * `client_stage` / `preferred_area` / ranges).
 *
 * This heal runs on every `initialize()`. It fingerprints the stored clients
 * model: if it lacks `client_stage` OR `preferred_area` (both guaranteed by the
 * new seed), it re-applies the seed schema + card_config and remigrates records
 * using the same rules as migration_3_to_4 (preserve client_name, phone →
 * phone_number, wrap numeric budget as range, textarea notes → single NoteEntry).
 * No-op once the stored model has the new shape — so user customizations made
 * AFTER the rebuild are never overwritten.
 */
export function healClientsSchema(state: HealSchemaInput): HealSchemaOutput {
  const clientsSeed = SEED_MODELS.find((m) => m.name === 'clients');
  if (!clientsSeed) return { models: state.models, records: state.records, changed: false };

  const clientsIdx = state.models.findIndex((m) => m.name === 'clients' && m.is_system);
  if (clientsIdx === -1) return { models: state.models, records: state.records, changed: false };

  const existing = state.models[clientsIdx]!;
  const slugs = new Set(existing.schema.sections.flatMap((s) => s.fields.map((f) => f.name)));
  const newShape = slugs.has('client_stage') && slugs.has('preferred_area');
  if (newShape) return { models: state.models, records: state.records, changed: false };

  const models = state.models.slice();
  models[clientsIdx] = {
    ...existing,
    schema: clientsSeed.schema,
    card_config: clientsSeed.card_config,
    updated_at: new Date().toISOString(),
  };

  const records = { ...state.records };
  const existingRecords = records[existing.id] ?? [];
  if (existingRecords.length) {
    records[existing.id] = existingRecords.map((rec) => {
      const oldData = rec.data;
      const newData: Record<string, unknown> = {};

      if (oldData.client_name !== undefined) newData.client_name = oldData.client_name;

      const phone = oldData.phone_number ?? oldData.phone;
      if (phone !== undefined) newData.phone_number = phone;

      if (typeof oldData.budget === 'number') {
        newData.budget = { min: oldData.budget, max: oldData.budget };
      } else if (oldData.budget && typeof oldData.budget === 'object') {
        newData.budget = oldData.budget;
      }

      if (typeof oldData.notes === 'string' && oldData.notes.trim()) {
        const entry: NoteEntry = {
          id: uuid(),
          text: oldData.notes,
          author_id: null,
          created_at: rec.created_at,
        };
        newData.notes = [entry];
      } else if (Array.isArray(oldData.notes)) {
        newData.notes = oldData.notes;
      }

      return { ...rec, data: newData, updated_at: new Date().toISOString() };
    });
    console.warn(
      `[healClientsSchema] Re-migrated ${existingRecords.length} client record(s) to the new shape.`,
    );
  }

  console.warn(
    '[healClientsSchema] Re-applied clients seed schema (version marker was ahead of stored shape).',
  );
  return { models, records, changed: true };
}

/**
 * Always-run, idempotent heal for the Decks system model's schema.
 *
 * The decks model gains fields over time (originally just title/brief/status,
 * later language + model + filename + URL + path + anthropic_file_id +
 * error_message; 2026-05-10 we add `size` for output orientation and the
 * UI also writes `attachments` into record.data even though we don't
 * declare it as a schema field — the page is custom UI so JSONB is free).
 * Existing installs already have the row in Supabase from earlier seeding,
 * so refreshSystemModels() is a no-op for them. This heal patches the
 * existing schema by appending any missing-by-name fields from the seed
 * shape (in seed order), preserving every other Builder edit the user
 * may have made. Idempotent: if all seed slugs are present, returns
 * unchanged. Targeted at the `size` rollout, but generic enough that
 * future single-field additions to decks won't need another heal.
 */
export function healDecksSchema(state: HealSchemaInput): HealSchemaOutput {
  const decksSeed = SEED_MODELS.find((m) => m.name === 'decks');
  if (!decksSeed) return { models: state.models, records: state.records, changed: false };

  const decksIdx = state.models.findIndex((m) => m.name === 'decks' && m.is_system);
  if (decksIdx === -1) return { models: state.models, records: state.records, changed: false };

  const existing = state.models[decksIdx]!;
  const existingBase = existing.schema.sections[0];
  const seedBase = decksSeed.schema.sections[0];
  if (!existingBase || !seedBase) return { models: state.models, records: state.records, changed: false };

  const existingSlugs = new Set(existingBase.fields.map((f) => f.name));
  const missingSeedFields = seedBase.fields.filter((f) => !existingSlugs.has(f.name));
  if (missingSeedFields.length === 0) {
    return { models: state.models, records: state.records, changed: false };
  }

  // Re-target each missing field's section_id to the EXISTING base section's
  // id (the seed's section id is regenerated per module-load, so the seed's
  // section_id won't match the persisted one). Order is preserved as-seeded.
  const appended = missingSeedFields.map((f) => ({ ...f, section_id: existingBase.id }));
  const newBaseFields = [...existingBase.fields, ...appended];

  const models = state.models.slice();
  models[decksIdx] = {
    ...existing,
    schema: {
      ...existing.schema,
      sections: [
        { ...existingBase, fields: newBaseFields },
        ...existing.schema.sections.slice(1),
      ],
    },
    updated_at: new Date().toISOString(),
  };

  console.warn(
    `[healDecksSchema] Added missing field(s) to decks model: ${missingSeedFields.map((f) => f.name).join(', ')}`,
  );
  return { models, records: state.records, changed: true };
}

/**
 * Always-run, idempotent heal for the Projects group and its system models.
 *
 * Runs on every `initialize()` (not gated by schema version) because orphaning
 * can happen outside of version bumps — e.g., the user deletes the Projects
 * group in the Builder, which removes the group but leaves `group_id` set on
 * its member models, turning them into invisible orphans in the Sidebar.
 *
 * Steps:
 * 1. Locate the Projects group (by stable id, then by label).
 * 2. If it's missing entirely, re-seed it using PROJECTS_GROUP_ID and seed labels.
 * 3. Re-attach any orphaned project-system models to the Projects group.
 * 4. Insert any missing project-system seed models.
 *
 * No-op when everything is consistent.
 */
export function healSystemModelGroups(state: HealInput): HealOutput {
  let groups = state.groups;
  let models = state.models;
  let changed = false;

  let projectsGroup =
    groups.find((g) => g.id === PROJECTS_GROUP_ID) ??
    groups.find((g) => g.label_ar === 'المشاريع' || g.label_en === 'Projects') ??
    null;

  if (!projectsGroup) {
    const seedProjectsGroup = SEED_GROUPS.find((g) => g.id === PROJECTS_GROUP_ID);
    if (seedProjectsGroup) {
      projectsGroup = seedProjectsGroup;
      groups = [...groups, seedProjectsGroup];
      changed = true;
      console.warn('[healSystemModelGroups] Re-seeded missing Projects group.');
    }
  }

  if (projectsGroup) {
    const targetId = projectsGroup.id;
    const groupIds = new Set(groups.map((g) => g.id));
    let reattached = 0;
    models = models.map((m) => {
      if (!PROJECTS_SYSTEM_NAMES.has(m.name)) return m;
      if (m.group_id === targetId) return m;
      // Reassign if orphaned (group_id doesn't match any existing group) or if it
      // drifted onto a different group than Projects.
      if (m.group_id && groupIds.has(m.group_id) && m.group_id !== targetId) {
        // User intentionally moved this model to another group — respect that.
        return m;
      }
      reattached++;
      return { ...m, group_id: targetId };
    });
    if (reattached > 0) {
      changed = true;
      console.warn(
        `[healSystemModelGroups] Re-attached ${reattached} orphaned project model(s) to the Projects group.`,
      );
    }

    const existingNames = new Set(models.map((m) => m.name));
    let inserted = 0;
    for (const seed of SEED_MODELS) {
      if (!seed.is_system) continue;
      if (!PROJECTS_SYSTEM_NAMES.has(seed.name)) continue;
      if (existingNames.has(seed.name)) continue;
      models = [...models, { ...seed, group_id: targetId }];
      inserted++;
    }
    if (inserted > 0) {
      changed = true;
      console.warn(`[healSystemModelGroups] Inserted ${inserted} missing project system model(s).`);
    }
  }

  return { models, groups, changed };
}
