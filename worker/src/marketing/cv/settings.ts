// ============================================================================
// mkt_settings reader for the cv system (`cv.enabled`, `cv.daily_budget_usd`,
// `cv.max_frames_per_video`). Values are raw jsonb (`false`, `30`, `2000`).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CvSettings {
  enabled: boolean;
  dailyBudgetUsd: number;
  maxFramesPerVideo: number;
}

export const CV_SETTINGS_DEFAULTS: CvSettings = { enabled: false, dailyBudgetUsd: 30, maxFramesPerVideo: 2000 };

const KEYS = ['cv.enabled', 'cv.daily_budget_usd', 'cv.max_frames_per_video'] as const;

/** Read the three cv settings in one query. Missing rows fall back to the seeded
 *  defaults; a query ERROR throws (a broken settings read must not silently
 *  read as "cv is off"). */
export async function readCvSettings(sb: SupabaseClient): Promise<CvSettings> {
  const { data, error } = await sb.from('mkt_settings').select('key, value').in('key', [...KEYS]);
  if (error) throw new Error(`cv settings read failed: ${error.message}`);
  const out: CvSettings = { ...CV_SETTINGS_DEFAULTS };
  for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
    if (row.key === 'cv.enabled') out.enabled = row.value === true || row.value === 'true';
    else if (row.key === 'cv.daily_budget_usd') { const n = Number(row.value); if (Number.isFinite(n)) out.dailyBudgetUsd = n; }
    else if (row.key === 'cv.max_frames_per_video') { const n = Number(row.value); if (Number.isFinite(n) && n > 0) out.maxFramesPerVideo = Math.floor(n); }
  }
  return out;
}

/** Cheap boolean gate via the SQL helper (used by the content pipeline + sweep). */
export async function cvEnabled(sb: SupabaseClient): Promise<boolean> {
  const { data, error } = await sb.rpc('mkt_cv_enabled');
  if (error) throw new Error(`mkt_cv_enabled failed: ${error.message}`);
  return data === true;
}
