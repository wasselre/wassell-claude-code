/**
 * Capture advertising attribution off the landing URL. Applicants arrive from a
 * paid ad (Instagram / Meta), so we grab UTM params + the platform click ids and
 * stash them once — they survive step navigation and an accidental refresh even
 * if the applicant later reloads a bare URL.
 */

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const CLICK_ID_KEYS = [
  'fbclid', 'gclid', 'ttclid', 'msclkid', 'twclid', 'li_fat_id',
  'igshid', 'wbraid', 'gbraid', 'yclid', 'sccid',
] as const;

export interface Attribution {
  sourceUrl: string;
  utm: Record<string, string>;
  clickIds: Record<string, string>;
}

const STORAGE_KEY = 'wassel_careers_attribution_v1';

function fromSearch(): Attribution {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  const clickIds: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) utm[k] = v.slice(0, 500);
  }
  for (const k of CLICK_ID_KEYS) {
    const v = params.get(k);
    if (v) clickIds[k] = v.slice(0, 500);
  }
  return { sourceUrl: window.location.href.slice(0, 2000), utm, clickIds };
}

/**
 * Returns attribution for this session, preferring params present on the current
 * URL and otherwise falling back to what was captured on first landing. The
 * merged result is persisted so it is stable across refreshes.
 */
export function captureAttribution(): Attribution {
  const current = fromSearch();
  let stored: Attribution | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Attribution;
  } catch {
    stored = null; // private mode / disabled storage — attribution is best-effort
  }

  const hasCurrent = Object.keys(current.utm).length > 0 || Object.keys(current.clickIds).length > 0;
  const merged: Attribution = hasCurrent || !stored
    ? { ...current, utm: { ...(stored?.utm ?? {}), ...current.utm }, clickIds: { ...(stored?.clickIds ?? {}), ...current.clickIds } }
    : stored;
  // Always keep the freshest source URL for debugging.
  merged.sourceUrl = current.sourceUrl;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore — best-effort persistence only
  }
  return merged;
}
