// ============================================================================
// Marketing collection — pure pipeline decision logic (no I/O, unit-tested).
// Used by runCollectionJob. Kept side-effect-free so the rules are testable.
// ============================================================================

// ── Attribution ─────────────────────────────────────────────────────────────
export interface ProjectAlias {
  projectId: string;
  nameAr: string | null;
  nameEn: string | null;
  /** Extra distinctive tokens (numbers, sub-brand names) to match on. */
  tokens: string[];
}
export interface AttributionCandidate {
  projectId: string;
  method: 'name_ar' | 'name_en' | 'alias' | 'caption';
  confidence: number;
  evidence: { matched: string; snippet: string };
  matchedAliases: string[];
  autoAccept: boolean;
}

export function normalizeAr(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ـً-ْ]/g, '') // tatweel + harakat
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/_/g, ' ')
    .toLowerCase();
}

/** All candidate tokens from a project name: numbers + words ≥3 chars. */
function aliasTokens(a: ProjectAlias): string[] {
  const out = new Set<string>();
  for (const raw of [a.nameAr, a.nameEn, ...a.tokens]) {
    const n = normalizeAr(raw);
    for (const num of n.match(/\d{1,4}/g) ?? []) out.add(num);
    for (const w of n.split(/\s+/)) if (w.length >= 3 && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}

/**
 * Document frequency of each token across a project set. Tokens shared by ≥2
 * projects (the developer/series name, e.g. "الماجديه", "ريفييرا", "يمام") are
 * NOT distinctive and must not trigger a match on their own — only the number or
 * a project-unique word does. This is what stops a brand post from being assigned
 * to every project a developer owns.
 */
function tokenDocFreq(index: ProjectAlias[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const a of index) for (const tok of new Set(aliasTokens(a))) df.set(tok, (df.get(tok) ?? 0) + 1);
  return df;
}

/**
 * Non-distinctive tokens = those appearing in ≥2 projects across the FULL catalog
 * (developer/series names). Compute this over ALL projects, then match only within
 * a publisher's own projects — otherwise a series name that happens to be unique
 * inside a small scoped set (e.g. only 1 of a developer's 6 projects contains
 * "الماجديه") would wrongly become "distinctive". Numbers are always allowed.
 */
export function computeCommonTokens(catalog: ProjectAlias[]): Set<string> {
  const df = tokenDocFreq(catalog);
  const common = new Set<string>();
  for (const [tok, n] of df) if (n >= 2 && !/^\d+$/.test(tok)) common.add(tok);
  return common;
}

/**
 * Attribute a caption to projects by NAME/NUMBER content only. Account ownership
 * (publisherProjectIds) RAISES confidence but never creates a match on its own —
 * a caption with no project reference returns [] (stays organization-level).
 * Auto-accept only a single, high-confidence, distinctive match.
 */
export function attributeCaption(
  caption: string,
  index: ProjectAlias[],
  opts: { publisherProjectIds?: string[]; commonTokens?: Set<string> } = {},
): AttributionCandidate[] {
  const nt = normalizeAr(caption);
  if (!nt.trim()) return [];
  const pub = new Set(opts.publisherProjectIds ?? []);
  // Distinctiveness: prefer a GLOBAL common-token set (computed over the full
  // catalog); fall back to local doc-frequency when not supplied (unit tests).
  const common = opts.commonTokens;
  const df = common ? null : tokenDocFreq(index);
  const hits: AttributionCandidate[] = [];

  const isCommon = (w: string) => (common ? common.has(w) : (df!.get(w) ?? 0) > 1);
  for (const a of index) {
    const toks = aliasTokens(a);
    const nums = toks.filter((t) => /^\d+$/.test(t));
    const words = toks.filter((t) => !/^\d+$/.test(t));
    const distinctiveWords = words.filter((w) => !isCommon(w));
    const commonWords = words.filter((w) => isCommon(w)); // the series/developer name
    const matched: string[] = [];
    // 1. a project-unique word
    for (const w of distinctiveWords) if (nt.includes(w)) matched.push(w);
    // 2. a LONG number (≥3 digits) standalone — distinctive on its own (174, 163)
    for (const num of nums) if (num.length >= 3 && new RegExp(`(^|\\D)${num}(\\D|$)`).test(nt)) matched.push(num);
    // 3. a SHORT number (1–2 digits) ONLY as a phrase with its series word ("ريفييرا 44",
    //    "المشرقية 2") — never alone, so a stray "2" in another caption can't match.
    for (const num of nums) if (num.length < 3) for (const cw of commonWords) {
      if (new RegExp(`${cw}\\s*${num}(\\D|$)`).test(nt)) matched.push(`${cw} ${num}`);
    }
    if (matched.length === 0) continue;
    const strong = matched.some((m) => /\d/.test(m) || m.length >= 4);
    let confidence = strong ? 0.85 : 0.5; // distinctive number/unique word = deterministic
    if (pub.has(a.projectId)) confidence = Math.min(0.95, confidence + 0.1); // ownership boosts, doesn't prove
    hits.push({
      projectId: a.projectId,
      method: 'caption',
      confidence,
      evidence: { matched: matched.join(','), snippet: caption.slice(0, 140) },
      matchedAliases: matched,
      autoAccept: false,
    });
  }
  // A distinctive single match auto-accepts; ambiguity (≥2 projects) never does.
  const distinct = new Set(hits.map((h) => h.projectId));
  for (const h of hits) h.autoAccept = distinct.size === 1 && h.confidence >= 0.85;
  return hits;
}

// ── Metric snapshot suppression ─────────────────────────────────────────────
export type Metrics = Record<string, number | undefined>;

/**
 * Append-only + time-aware. Snapshot when a tracked metric CHANGED, or the
 * interval elapsed. `undefined` = unavailable (not zero) — an available→undefined
 * or undefined→undefined transition is NOT a change.
 */
export function shouldSnapshot(
  prev: Metrics | null,
  next: Metrics,
  lastCapturedAt: string | null,
  minIntervalHours: number,
  now: number,
): { snapshot: boolean; reason: 'first' | 'changed' | 'interval' | 'suppressed' } {
  if (!prev || !lastCapturedAt) return { snapshot: true, reason: 'first' };
  for (const k of Object.keys(next)) {
    const nv = next[k];
    if (nv === undefined) continue;                 // unavailable ≠ change
    if (prev[k] !== nv) return { snapshot: true, reason: 'changed' };
  }
  const elapsedH = (now - new Date(lastCapturedAt).getTime()) / 3.6e6;
  if (elapsedH >= minIntervalHours) return { snapshot: true, reason: 'interval' };
  return { snapshot: false, reason: 'suppressed' };
}

// ── Browserbase fallback eligibility ────────────────────────────────────────
export type ProviderHealthCode =
  | 'not_configured' | 'connected' | 'auth_failed' | 'rate_limited' | 'unavailable' | 'config_invalid';

/**
 * Browserbase is a strict fallback. Eligible ONLY when the primary failed with a
 * genuine outage AFTER retries are exhausted, an unsupported source, or a manual
 * admin request. NEVER on auth/rate-limit/not-configured/invalid-config, and never
 * before retries are exhausted.
 */
export function browserbaseFallbackEligible(input: {
  primaryHealth: ProviderHealthCode;
  attemptsExhausted: boolean;
  unsupportedSource?: boolean;
  manualRequest?: boolean;
}): { eligible: boolean; reason: string } {
  if (input.manualRequest) return { eligible: true, reason: 'manual_request' };
  if (input.unsupportedSource) return { eligible: true, reason: 'unsupported_source' };
  if (['auth_failed', 'rate_limited', 'not_configured', 'config_invalid'].includes(input.primaryHealth)) {
    return { eligible: false, reason: `no_fallback_on_${input.primaryHealth}` };
  }
  if (input.primaryHealth === 'unavailable' && input.attemptsExhausted) {
    return { eligible: true, reason: 'outage_after_retries' };
  }
  return { eligible: false, reason: 'retries_not_exhausted' };
}
