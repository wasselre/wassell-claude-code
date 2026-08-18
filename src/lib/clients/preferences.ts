/**
 * ONE persist path for a client's PREFERENCE fields.
 *
 * Four surfaces let a rep edit the same preferences — the Clients page
 * (`PreferencesTab`), the Follow-up Workspace (`PreferenceSummary`), the
 * embedded/full-page finder (`SuggestedProjectsView`, which is what the
 * WhatsApp Client-Options popup renders), and the standalone Project Finder
 * page. Before 2026-08-18 each one hand-rolled its own patch + dirty check, and
 * the two finder surfaces had NO independent save at all: the finder persisted
 * as a side effect of pressing Search, and the standalone page never persisted
 * at all. This module is the single implementation all four call, so "what
 * counts as a preference edit", "what a save writes", and "how a failure is
 * reported" can't drift between them.
 *
 * Rules encoded here:
 * - The save is VERSION-AWARE (`expectedVersion`), so a concurrent edit from
 *   another tab / the WhatsApp popup surfaces as a conflict instead of silently
 *   overwriting (same posture as RecordFormPage).
 * - Failures are NEVER swallowed: every outcome returns a bilingual message +
 *   toast tone the caller must surface (see CLAUDE.md "Silent Failures").
 * - Field bounds/options are NEVER hardcoded — this module only moves values
 *   between the draft and the record; the pickers read the live model schema.
 */

import type { AppRecord, SaveRecordOpts, SaveResult, ToastType } from '@/types';

/**
 * Keys that ride along with every preference save but are NOT plain preference
 * slugs on the model:
 * - `location_items` — the district + geo-element include/exclude rules edited
 *   inside the unified location field (ClientLocationField writes them through
 *   the sibling `onPatch`). The server geo-gate compiles from these.
 * - `preference_constraints` — the per-field strictness bands (hard/soft + ±)
 *   edited by the band control that renders inside DynamicField.
 *
 * A sidecar key is written ONLY when the draft actually carries it, so a
 * surface whose draft was never seeded with it can't wipe the saved value.
 */
export const PREFERENCE_SIDECAR_KEYS = ['location_items', 'preference_constraints'] as const;

export type SaveRecordFn = (record: AppRecord, opts?: SaveRecordOpts) => Promise<SaveResult>;

const eq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const has = (draft: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(draft, key);

/**
 * The `data` patch a preference save writes: every listed slug (even when
 * cleared — clearing a preference is a real edit), plus any sidecar key the
 * draft carries.
 */
export function buildPreferencePatch(
  draft: Record<string, unknown>,
  slugs: readonly string[],
  sidecarKeys: readonly string[] = PREFERENCE_SIDECAR_KEYS,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const slug of slugs) patch[slug] = draft[slug];
  for (const key of sidecarKeys) {
    if (has(draft, key)) patch[key] = draft[key];
  }
  return patch;
}

/** True when the draft differs from the SAVED record data on any tracked key. */
export function preferencesDirty(
  saved: Record<string, unknown> | null | undefined,
  draft: Record<string, unknown>,
  slugs: readonly string[],
  sidecarKeys: readonly string[] = PREFERENCE_SIDECAR_KEYS,
): boolean {
  if (!saved) return false;
  if (slugs.some((slug) => !eq(draft[slug], saved[slug]))) return true;
  return sidecarKeys.some((key) => has(draft, key) && !eq(draft[key], saved[key]));
}

export interface SaveClientPreferencesArgs {
  /** The client record as currently held by the store. */
  client: AppRecord;
  /** The edit buffer the rep has been typing into. */
  draft: Record<string, unknown>;
  /** Preference field slugs this surface owns (read from the live model). */
  slugs: readonly string[];
  /** `useAppStore(s => s.saveRecord)`. */
  saveRecord: SaveRecordFn;
  /**
   * The version the surface LOADED with. Pass the ref-pinned snapshot when the
   * surface stays mounted across saves; `client.version` is the sane default.
   */
  expectedVersion?: number | null;
  isAr: boolean;
  sidecarKeys?: readonly string[];
}

export interface SaveClientPreferencesResult {
  /** True only when the write reached (or was queued for) the database. */
  ok: boolean;
  status: SaveResult['status'];
  /** Bilingual, ready to hand straight to `addToast`. */
  message: string;
  tone: ToastType;
  /** The version to pin for the NEXT save (bumped on a successful write). */
  nextVersion: number | null;
}

/**
 * Persist ONLY the preference fields onto the client record. Runs no search and
 * touches nothing else on the record.
 */
export async function saveClientPreferences(
  args: SaveClientPreferencesArgs,
): Promise<SaveClientPreferencesResult> {
  const { client, draft, slugs, saveRecord, isAr, sidecarKeys = PREFERENCE_SIDECAR_KEYS } = args;
  const expectedVersion = args.expectedVersion === undefined ? client.version ?? null : args.expectedVersion;
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const patch = buildPreferencePatch(draft, slugs, sidecarKeys);
  const next: AppRecord = {
    ...client,
    data: { ...client.data, ...patch },
    updated_at: new Date().toISOString(),
  };

  const res = await saveRecord(next, { expectedVersion });

  if (res.status === 'conflict') {
    return {
      ok: false,
      status: 'conflict',
      message: L(
        'تم تعديل بيانات العميل في مكان آخر — أعد تحميل الصفحة قبل الحفظ.',
        'Client was edited elsewhere — reload before saving.',
      ),
      tone: 'error',
      nextVersion: expectedVersion,
    };
  }

  if (res.status === 'queued') {
    return {
      ok: true,
      status: 'queued',
      message: L('تم الحفظ محلياً — سيُزامن لاحقاً.', 'Saved locally — will sync later.'),
      tone: 'info',
      // The DB row was NOT bumped (the write is sitting in the retry queue), so
      // the next save must still send the version we loaded with.
      nextVersion: expectedVersion,
    };
  }

  return {
    ok: true,
    status: 'saved',
    message: L('تم حفظ التفضيلات', 'Preferences saved'),
    tone: 'success',
    nextVersion: expectedVersion === null ? null : expectedVersion + 1,
  };
}
