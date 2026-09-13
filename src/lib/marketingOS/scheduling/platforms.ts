/**
 * Per-platform PUBLISHING rules — the only place a genuine platform difference
 * lives. Everything else (workflow, approvals, capacity, preview, routing) is
 * global, exactly as the brief requires: "we do not want separate, duplicated
 * campaign systems for every platform".
 *
 * These are DEFAULTS. Each child campaign (`mos_campaign_executions.publishing_rules`)
 * may override any field, so a platform's behaviour is data, not a deploy.
 *
 * Note the separation from `src/lib/marketingOS/platformRules.ts`, which is the
 * MEDIA rulebook (caption ceilings, file sizes, aspect ratios, carousel shape)
 * used at publish time. This file is the DISTRIBUTION rulebook (how many per
 * day, which project may sit next to which). They never overlap.
 *
 * PURE.
 */
import type { PlatformRules } from './types';

const BASE: Omit<PlatformRules, 'platform'> = {
  gridColumns: null,
  maxPerDay: null,
  allowSameProjectSameDay: true,
  allowConsecutiveSameProject: true,
  distinctProjectsPerGridRow: false,
  buckets: ['post', 'video'],
  defaultTimes: ['20:00'],
  videosOccupyGrid: true,
};

/**
 * Instagram: the grid platform. Three cells to a row, and the operator's rules —
 * never the same project twice in one day, never two of the same project back to
 * back, three DIFFERENT projects in a row. Reels count as grid cells (decision
 * 8, default yes); stories are a different content type and never reach here.
 */
const INSTAGRAM: PlatformRules = {
  ...BASE,
  platform: 'instagram',
  gridColumns: 3,
  allowSameProjectSameDay: false,
  allowConsecutiveSameProject: false,
  distinctProjectsPerGridRow: true,
  defaultTimes: ['13:00', '17:00', '20:30'],
};

/** TikTok: a stream, not a grid. Video-led; one project per day is still sane. */
const TIKTOK: PlatformRules = {
  ...BASE,
  platform: 'tiktok',
  allowSameProjectSameDay: false,
  buckets: ['video', 'post'],
  defaultTimes: ['19:00', '21:30'],
};

const SNAPCHAT: PlatformRules = { ...BASE, platform: 'snapchat', defaultTimes: ['18:00'] };
const X: PlatformRules = { ...BASE, platform: 'x', defaultTimes: ['12:00', '20:00'] };
const YOUTUBE: PlatformRules = { ...BASE, platform: 'youtube', buckets: ['video'], defaultTimes: ['20:00'] };
const WEBSITE: PlatformRules = { ...BASE, platform: 'website', defaultTimes: ['10:00'] };

/** Paid channels never take an organic distribution; they get creative slots instead. */
const META: PlatformRules = { ...BASE, platform: 'meta', defaultTimes: ['09:00'] };

const REGISTRY: Record<string, PlatformRules> = {
  instagram: INSTAGRAM,
  tiktok: TIKTOK,
  snapchat: SNAPCHAT,
  x: X,
  youtube: YOUTUBE,
  website: WEBSITE,
  meta: META,
};

export const ORGANIC_PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'website'] as const;
export const PAID_PLATFORMS = ['meta', 'google'] as const;

export function platformRulesFor(platform: string, overrides?: Partial<PlatformRules> | null): PlatformRules {
  const base = REGISTRY[platform] ?? { ...BASE, platform };
  if (!overrides) return base;
  // Only known keys are honoured — an unknown key in the DB never silently
  // becomes a rule.
  const merged: PlatformRules = { ...base };
  const keys: Array<keyof PlatformRules> = [
    'gridColumns', 'maxPerDay', 'allowSameProjectSameDay', 'allowConsecutiveSameProject',
    'distinctProjectsPerGridRow', 'buckets', 'defaultTimes', 'videosOccupyGrid',
  ];
  const bag = merged as unknown as Record<string, unknown>;
  const src = overrides as unknown as Record<string, unknown>;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) bag[k] = v;
  }
  return merged;
}

/** `HH:MM` for slot `index` of a day, repeating hourly past the configured list. */
export function slotTime(rules: PlatformRules, index: number, override?: string[]): string {
  const times = (override && override.length ? override : rules.defaultTimes).slice();
  const exact = times[index];
  if (exact) return exact;
  const last = times[times.length - 1] ?? '20:00';
  const parts = last.split(':').map(Number);
  const h = parts[0] ?? 20;
  const m = parts[1] ?? 0;
  const hh = Math.min(23, h + (index - times.length + 1));
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
