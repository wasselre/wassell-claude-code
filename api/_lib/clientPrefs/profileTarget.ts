/**
 * Preference PROFILES on the server — which of a client's profiles an AI save
 * goes to. PURE (no IO).
 *
 * Same data shape as the app (src/lib/clients/preferenceProfiles.ts, which the
 * server cannot import — it pulls browser-only modules):
 *   - the ACTIVE profile's values are the flat slugs on `clients.data`;
 *   - every profile lives in `data.preference_profiles[]` ({id, name,
 *     created_at, data: snapshot}); `data.active_profile_id` names the active one;
 *   - a client that never used profiles has no array — its one profile is the
 *     flat slugs (id `default`).
 *
 * The AI never switches the active profile (operator, 2026-10-05: separate
 * profiles get their own process). It writes the flat slugs when the target is
 * the active profile, and the target's snapshot otherwise.
 */
// globalThis.crypto (not node:crypto): edge functions import this file too (api/ai-actions → autoSave).

export const PROFILES_KEY = 'preference_profiles';
export const ACTIVE_PROFILE_KEY = 'active_profile_id';
export const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = 'التفضيل الرئيسي';

export interface StoredProfile {
  id: string;
  name: string;
  created_at: string;
  data: Record<string, unknown>;
  /** Set when the AI created it (from a customer's separate second wish). */
  created_by?: 'ai';
}

function isProfile(v: unknown): v is StoredProfile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string';
}

/** The client's profiles and which is active; a client without the array has one (`default`). */
export function readStoredProfiles(data: Record<string, unknown>): { profiles: StoredProfile[]; activeId: string; materialized: boolean } {
  const raw = data[PROFILES_KEY];
  const profiles = Array.isArray(raw) ? raw.filter(isProfile).map((p) => ({ ...p, data: p.data && typeof p.data === 'object' ? p.data : {} })) : [];
  if (!profiles.length) {
    return { profiles: [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, created_at: '', data: {} }], activeId: DEFAULT_PROFILE_ID, materialized: false };
  }
  const want = typeof data[ACTIVE_PROFILE_KEY] === 'string' ? (data[ACTIVE_PROFILE_KEY] as string) : null;
  const activeId = profiles.some((p) => p.id === want) ? want! : profiles[0]!.id;
  return { profiles, activeId, materialized: true };
}

/** Resolve a target id: null / unknown / the active one → the active profile (null). */
export function resolveTarget(data: Record<string, unknown>, profileId: string | null | undefined): string | null {
  if (!profileId) return null;
  const { profiles, activeId } = readStoredProfiles(data);
  if (profileId === activeId || !profiles.some((p) => p.id === profileId)) return null;
  return profileId;
}

/** The target profile's current values (the flat slugs for the active one). */
export function profileValues(data: Record<string, unknown>, profileId: string | null): Record<string, unknown> {
  if (!profileId) return data;
  return readStoredProfiles(data).profiles.find((p) => p.id === profileId)?.data ?? {};
}

/** `data` with `patch` written into the target profile (flat slugs for the active one). */
export function writeProfileValues(data: Record<string, unknown>, profileId: string | null, patch: Record<string, unknown>): Record<string, unknown> {
  if (!profileId) return { ...data, ...patch };
  const { profiles, activeId } = readStoredProfiles(data);
  return {
    ...data,
    [PROFILES_KEY]: profiles.map((p) => (p.id === profileId ? { ...p, data: { ...p.data, ...patch } } : p)),
    [ACTIVE_PROFILE_KEY]: activeId,
  };
}

/**
 * `data` with a new EMPTY profile appended (never made active). A client that
 * never used profiles gets its current one materialized as `default` first —
 * its snapshot may be empty: the app refreshes the active profile's snapshot
 * from the flat slugs the moment a rep switches away from it.
 */
export function addAiProfile(data: Record<string, unknown>, name: string, now: string): { data: Record<string, unknown>; profileId: string } {
  const { profiles, activeId } = readStoredProfiles(data);
  const id = globalThis.crypto.randomUUID();
  const next: StoredProfile = { id, name: name.trim() || `تفضيل ${profiles.length + 1}`, created_at: now, data: {}, created_by: 'ai' };
  return { data: { ...data, [PROFILES_KEY]: [...profiles, next], [ACTIVE_PROFILE_KEY]: activeId }, profileId: id };
}

/** `data` without an AI-created profile. Refuses (null) for the active one or one a rep made. */
export function removeAiProfile(data: Record<string, unknown>, profileId: string): Record<string, unknown> | null {
  const { profiles, activeId } = readStoredProfiles(data);
  const p = profiles.find((x) => x.id === profileId);
  if (!p || p.created_by !== 'ai' || profileId === activeId) return null;
  return { ...data, [PROFILES_KEY]: profiles.filter((x) => x.id !== profileId), [ACTIVE_PROFILE_KEY]: activeId };
}

/** One line per profile for the router prompt: id, name, active, the values it holds. */
export function describeProfiles(data: Record<string, unknown>, summarize: (values: Record<string, unknown>) => string): Array<{ id: string; line: string }> {
  const { profiles, activeId } = readStoredProfiles(data);
  return profiles.map((p) => {
    const values = p.id === activeId ? data : p.data;
    return { id: p.id, line: `id=${p.id} · «${p.name}»${p.id === activeId ? ' (active)' : ''} · ${summarize(values) || 'nothing saved yet'}` };
  });
}
