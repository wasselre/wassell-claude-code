/**
 * Multiple named PREFERENCE PROFILES per client (Option A — "active profile").
 *
 * A client can want two independent things at once — e.g. an investment
 * apartment AND a residential villa — each with its own complete set of
 * preferences (budget, unit type, area, age, amenities, location + the
 * location_items geo rules). This module lets a client hold several named
 * profiles while keeping the whole rest of the app unchanged.
 *
 * HOW IT WORKS (the "active profile" design):
 * - The ACTIVE profile's values ARE the flat top-level slugs on `clients.data`
 *   (`data.budget`, `data.preferred_unit_type`, `data.location_items`, …). So
 *   the Project Finder, the geo gate, the follow-up assistant, chat chips, the
 *   AI sales agent, analytics — every existing reader keeps working with ZERO
 *   changes, because it always reads the active profile.
 * - The full set of profiles lives in `data.preference_profiles[]`, and
 *   `data.active_profile_id` names the active one. Each stored profile carries a
 *   SNAPSHOT of its profile-key values.
 * - Switching profiles is one write: snapshot the current (active) values into
 *   the profile being left, load the target profile's snapshot into the flat
 *   slugs, and point `active_profile_id` at the target. The active profile's
 *   stored snapshot is deliberately allowed to go stale between switches — the
 *   flat slugs are the source of truth for the active profile, and the snapshot
 *   is refreshed from the live values the moment we switch away from it.
 *
 * MIGRATION-ON-READ: a client that has never used profiles has no
 * `preference_profiles` array. `readProfiles` synthesizes a single default
 * profile (id `default`) wrapping the current flat slugs, so nothing looks lost
 * and no data is touched until the rep actually adds/switches a profile.
 *
 * These helpers are PURE (no store, no React) so they are unit-tested and reused
 * by every preference-editing surface. `clients` is unfrozen JSONB, so the two
 * metadata keys ride along with an ordinary `record_save` — no DB migration.
 */
import { v4 as uuid } from 'uuid';
import type { AppModel } from '@/types';
import { PREFERENCE_EDIT_SLUGS, DERIVED_READONLY_SLUGS } from '@/pages/Clients/lib/clientView';

/** The two data keys that hold profile metadata on `clients.data`. */
export const PROFILES_KEY = 'preference_profiles';
export const ACTIVE_PROFILE_KEY = 'active_profile_id';

/** Stable id of the synthesized default profile (before it is ever persisted). */
export const DEFAULT_PROFILE_ID = 'default';

/**
 * Sidecar keys that ride with the profile snapshot but are NOT plain slugs:
 * the geo rules and the per-field strictness bands. Mirrors
 * PREFERENCE_SIDECAR_KEYS in `preferences.ts` (kept here to avoid a cycle).
 */
export const PROFILE_SIDECAR_KEYS = ['location_items', 'preference_constraints'] as const;

/**
 * Preference slugs a profile always captures, even when the live schema label
 * drifts. Superset of the editable set plus the goal tag (`purchase_objective`,
 * which lives in the Basic section but genuinely differs per goal) and legacy
 * geography slugs some records still carry.
 */
const KNOWN_PREFERENCE_SLUGS: readonly string[] = [
  ...PREFERENCE_EDIT_SLUGS,
  'preferred_max_unit_age',
  'preferred_bedrooms',
  'preferred_amenities',
  'preferred_neighborhoods',
  'preferred_city',
  'preferred_country',
  'preferred_districts',
  'preferred_units',
  'purchase_objective',
];

const isPrefSection = (labelAr: string, labelEn: string): boolean => {
  const ar = (labelAr ?? '').trim();
  const en = (labelEn ?? '').trim().toLowerCase();
  return ar.includes('تفضيلات') || en.includes('preference');
};

/**
 * Every field slug that belongs to a preference profile — the known set UNION
 * every field in the model's "Client Preferences" section (so a Builder-added
 * preference field is captured automatically), minus the derived/trigger-owned
 * slugs (which must never be swapped by a profile change).
 */
export function profileFieldSlugs(model: AppModel | null | undefined): string[] {
  const set = new Set<string>(KNOWN_PREFERENCE_SLUGS);
  for (const section of model?.schema?.sections ?? []) {
    if (!isPrefSection(section.label_ar, section.label_en)) continue;
    for (const f of section.fields ?? []) set.add(f.name);
  }
  for (const d of DERIVED_READONLY_SLUGS) set.delete(d);
  return [...set];
}

/** Field slugs + sidecar keys — the complete key set a profile snapshot holds. */
export function profileKeys(model: AppModel | null | undefined): string[] {
  return [...profileFieldSlugs(model), ...PROFILE_SIDECAR_KEYS];
}

export interface PreferenceProfile {
  id: string;
  name: string;
  created_at: string;
  /** Snapshot of this profile's values, keyed by profile key. */
  data: Record<string, unknown>;
}

function isProfile(v: unknown): v is PreferenceProfile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string';
}

/** Read a value, mapping `undefined` (absent) to `null` so it is set explicitly. */
const readKey = (data: Record<string, unknown> | undefined, key: string): unknown =>
  data?.[key] === undefined ? null : data[key];

/** The subset of `data` covering exactly `keys` (absent → null). */
export function pickProfileValues(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = readKey(data, k);
  return out;
}

const defaultProfileName = (isAr: boolean): string => (isAr ? 'التفضيل الرئيسي' : 'Main profile');
const newProfileName = (isAr: boolean, index: number): string =>
  isAr ? `تفضيل ${index}` : `Profile ${index}`;

export interface ProfilesState {
  profiles: PreferenceProfile[];
  activeId: string;
}

/**
 * Resolve the client's profiles (migration-on-read). When no profiles have been
 * saved yet, returns a single synthesized default profile wrapping the current
 * flat slugs — id `default`, stable across renders.
 */
export function readProfiles(
  data: Record<string, unknown>,
  keys: readonly string[],
  isAr: boolean,
): ProfilesState {
  const raw = data[PROFILES_KEY];
  if (Array.isArray(raw)) {
    const profiles = raw.filter(isProfile);
    if (profiles.length) {
      const activeRaw = typeof data[ACTIVE_PROFILE_KEY] === 'string' ? (data[ACTIVE_PROFILE_KEY] as string) : null;
      const activeId = profiles.some((p) => p.id === activeRaw) ? (activeRaw as string) : profiles[0]!.id;
      return { profiles, activeId };
    }
  }
  const def: PreferenceProfile = {
    id: DEFAULT_PROFILE_ID,
    name: defaultProfileName(isAr),
    created_at: '',
    data: pickProfileValues(data, keys),
  };
  return { profiles: [def], activeId: def.id };
}

/** True once the client has a materialized profiles array (≥1 saved profile). */
export function hasProfiles(data: Record<string, unknown>): boolean {
  const raw = data[PROFILES_KEY];
  return Array.isArray(raw) && raw.filter(isProfile).length > 0;
}

/** Refresh the active profile's stored snapshot from the live (draft) values. */
function withActiveSnapshot(
  profiles: PreferenceProfile[],
  activeId: string,
  currentValues: Record<string, unknown>,
): PreferenceProfile[] {
  return profiles.map((p) => (p.id === activeId ? { ...p, data: { ...currentValues } } : p));
}

/** All profile keys set to null — a blank flat projection for a new profile. */
function blankValues(keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = null;
  return out;
}

/** A profile snapshot filled out across every key (absent → null). */
function fillValues(pdata: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = readKey(pdata, k);
  return out;
}

export interface ProfileMutation {
  /** The `data` patch to merge onto `clients.data` and persist via saveRecord. */
  patch: Record<string, unknown>;
  /**
   * The flat profile-key values now active, to sync into the host's edit draft
   * (undefined when the flat slugs are unchanged — e.g. rename, or removing a
   * non-active profile).
   */
  flat?: Record<string, unknown>;
  /** Id of the profile that is active after the mutation. */
  activeId: string;
}

/**
 * Add a new BLANK profile and make it active. The current (active) values are
 * snapshotted into the profile being left; the flat slugs are cleared for the
 * fresh goal. `currentValues` = the live draft values for the profile keys.
 */
export function addProfile(
  data: Record<string, unknown>,
  keys: readonly string[],
  currentValues: Record<string, unknown>,
  name: string,
  isAr: boolean,
): ProfileMutation {
  const { profiles, activeId } = readProfiles(data, keys, isAr);
  const snapshotted = withActiveSnapshot(profiles, activeId, currentValues);
  const np: PreferenceProfile = {
    id: uuid(),
    name: name.trim() || newProfileName(isAr, snapshotted.length + 1),
    created_at: new Date().toISOString(),
    data: blankValues(keys),
  };
  const nextProfiles = [...snapshotted, np];
  const flat = blankValues(keys);
  return {
    patch: { [PROFILES_KEY]: nextProfiles, [ACTIVE_PROFILE_KEY]: np.id, ...flat },
    flat,
    activeId: np.id,
  };
}

/**
 * Switch the active profile. Snapshots the current values into the profile
 * being left, loads the target's snapshot into the flat slugs, and repoints
 * `active_profile_id`. Returns null when the target is already active/missing.
 */
export function switchProfile(
  data: Record<string, unknown>,
  keys: readonly string[],
  currentValues: Record<string, unknown>,
  targetId: string,
  isAr: boolean,
): ProfileMutation | null {
  const { profiles, activeId } = readProfiles(data, keys, isAr);
  if (targetId === activeId) return null;
  const target = profiles.find((p) => p.id === targetId);
  if (!target) return null;
  const snapshotted = withActiveSnapshot(profiles, activeId, currentValues);
  const flat = fillValues(target.data, keys);
  return {
    patch: { [PROFILES_KEY]: snapshotted, [ACTIVE_PROFILE_KEY]: targetId, ...flat },
    flat,
    activeId: targetId,
  };
}

/** Rename a profile. Snapshots the active values so materialization stays fresh. */
export function renameProfile(
  data: Record<string, unknown>,
  keys: readonly string[],
  currentValues: Record<string, unknown>,
  id: string,
  name: string,
  isAr: boolean,
): ProfileMutation | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { profiles, activeId } = readProfiles(data, keys, isAr);
  if (!profiles.some((p) => p.id === id)) return null;
  const snapshotted = withActiveSnapshot(profiles, activeId, currentValues).map((p) =>
    p.id === id ? { ...p, name: trimmed } : p,
  );
  return { patch: { [PROFILES_KEY]: snapshotted, [ACTIVE_PROFILE_KEY]: activeId }, activeId };
}

/**
 * Delete a profile. Never removes the last one (caller disables the control).
 * Deleting the active profile switches to the first remaining and loads its
 * values into the flat slugs; deleting a non-active profile leaves the flat
 * slugs untouched.
 */
export function deleteProfile(
  data: Record<string, unknown>,
  keys: readonly string[],
  currentValues: Record<string, unknown>,
  id: string,
  isAr: boolean,
): ProfileMutation | null {
  const { profiles, activeId } = readProfiles(data, keys, isAr);
  if (profiles.length <= 1) return null;
  if (!profiles.some((p) => p.id === id)) return null;
  const snapshotted = withActiveSnapshot(profiles, activeId, currentValues);
  const remaining = snapshotted.filter((p) => p.id !== id);
  if (id !== activeId) {
    return { patch: { [PROFILES_KEY]: remaining, [ACTIVE_PROFILE_KEY]: activeId }, activeId };
  }
  const target = remaining[0]!;
  const flat = fillValues(target.data, keys);
  return {
    patch: { [PROFILES_KEY]: remaining, [ACTIVE_PROFILE_KEY]: target.id, ...flat },
    flat,
    activeId: target.id,
  };
}
