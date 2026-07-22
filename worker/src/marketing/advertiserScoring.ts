// ============================================================================
// Deterministic multi-signal scoring for Meta advertiser discovery candidates.
//
// The keyword Ad-Library search returns every PAGE that runs ads mentioning the
// term — which includes marketplaces (Bayut, Aqar) advertising the target's
// listings, and unrelated pages. Auto-confirming the first/only hit is how
// "Almajdiah → Bayut KSA" happened. This module scores each candidate against
// the organization's real identity (names, official domain, known Facebook URL,
// aliases) and REFUSES to auto-confirm unless a strong, unambiguous identity
// anchor is present and the top candidate is not a marketplace/portal.
//
// Pure + dependency-free (worker-only; discovery runs in the worker). Every
// score carries bilingual reason explanations that are stored on the candidate
// and surfaced in the UI.
// ============================================================================

export interface OrgIdentity {
  nameAr?: string | null;
  nameEn?: string | null;
  website?: string | null;       // official domain source (e.g. https://almajdiah.com/)
  aliases?: string[];            // extra known names/handles
  facebookUrls?: string[];       // known official Facebook page URLs (identity anchor)
  orgType?: string | null;       // 'developer' | 'marketer'
}

export interface AdvertiserCandidate {
  pageId: string;
  pageName?: string | null;
  pageUrl?: string | null;
  adCount?: number;
  landingDomains?: string[];     // registrable domains seen in this page's sample ads
  sampleHeadlines?: string[];
}

export interface ScoreReason { code: string; label_en: string; label_ar: string; delta: number }
export interface ScoredCandidate extends AdvertiserCandidate {
  score: number;
  confidence: 'high' | 'medium' | 'low';
  isMarketplace: boolean;
  reasons: ScoreReason[];
}

// Saudi real-estate portals / marketplaces / listing aggregators. A DEVELOPER's
// own advertiser is never one of these; when they appear for a developer search
// they are advertising the developer's listings, not the developer.
const MARKETPLACE_NAME_TOKENS = [
  'bayut', 'aqar', 'propertyfinder', 'property finder', 'wasalt', 'sakani', 'dari',
  'aqarmap', 'bezaat', 'opensooq', 'haraj', 'gathern', 'deala', 'remax', 're/max',
  'century 21', 'century21', 'portal', 'marketplace', 'listings',
];
const MARKETPLACE_DOMAINS = [
  'bayut.sa', 'bayut.com', 'aqar.fm', 'sa.aqar.fm', 'propertyfinder.sa', 'propertyfinder.ae',
  'wasalt.com', 'wasalt.sa', 'sakani.sa', 'dari.sa', 'aqarmap.com', 'bezaat.com',
  'opensooq.com', 'haraj.com.sa', 'gathern.co', 'remax-saudiarabia.com',
];

const WEIGHTS = {
  exact_ar_name: 50,
  exact_en_name: 42,
  en_name_similarity: 25,        // scaled by Jaccard
  ar_name_similarity: 22,        // scaled by Jaccard
  official_domain_match: 45,
  existing_social_url_match: 60,
  exact_alias_match: 45,
  marketplace_detected: -80,
  advertiser_domain_mismatch: -22,
  unrelated_domain: -14,
  weak_keyword_only: -10,
} as const;

// High confidence needs a HARD identity anchor (ads link to the org's own
// registered domain, a known Facebook URL, an exact alias, or an exact name)
// AND a total score at/above this floor. A name-only match (≤50) stays medium,
// so it never auto-confirms without a domain/URL anchor. An ad linking to the
// org's official domain is decisive — a marketplace links to its own portal, so
// domain-match + any name signal is a safe high-confidence combination.
const AUTO_CONFIRM_MIN_SCORE = 55;
const AUTO_CONFIRM_MARGIN = 25;  // top must beat the next non-marketplace candidate by this

// ── normalization helpers ───────────────────────────────────────────────────
const AR_DIACRITICS = /[ً-ْٰـ]/g; // harakat + tatweel
const NAME_STOPWORDS = new Set([
  'العقارية', 'العقاريه', 'عقارية', 'للعقارات', 'العقارات', 'للتطوير', 'والاستثمار', 'الاستثمار',
  'التطوير', 'العقاري', 'شركة', 'مجموعة', 'ريل', 'استيت',
  'real', 'estate', 'realestate', 'company', 'co', 'llc', 'group', 'holding', 'development',
  'developments', 'investment', 'properties', 'property', 'ksa', 'sa', 'saudi', 'arabia', 'the',
]);

export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKC')
    .replace(AR_DIACRITICS, '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا') // hamza-alef → alef
    .replace(/ة/g, 'ه')               // taa marbuta → haa (ة→ه)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(raw: string | null | undefined): string[] {
  return normalizeName(raw).split(' ').filter((t) => t && !NAME_STOPWORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

/** Registrable-ish domain from a URL or bare host (drops scheme, path, leading www.). */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!host || !host.includes('.')) return null;
  return host;
}
function sameDomain(a: string, b: string): boolean {
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function isMarketplaceName(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  return MARKETPLACE_NAME_TOKENS.some((t) => n.includes(t));
}
function isMarketplaceDomain(domains: string[]): boolean {
  return domains.some((d) => MARKETPLACE_DOMAINS.some((m) => sameDomain(d, m)));
}

// ── scoring ─────────────────────────────────────────────────────────────────
export function scoreCandidate(candidate: AdvertiserCandidate, org: OrgIdentity): ScoredCandidate {
  const reasons: ScoreReason[] = [];
  const add = (code: keyof typeof WEIGHTS, label_en: string, label_ar: string, deltaOverride?: number) =>
    reasons.push({ code, label_en, label_ar, delta: deltaOverride ?? WEIGHTS[code] });

  const candTokens = nameTokens(candidate.pageName);
  const arTokens = nameTokens(org.nameAr);
  const enTokens = nameTokens(org.nameEn);
  const candNorm = normalizeName(candidate.pageName);
  const domains = (candidate.landingDomains ?? []).map((d) => registrableDomain(d)).filter((d): d is string => !!d);
  const orgDomain = registrableDomain(org.website);
  const isDeveloper = (org.orgType ?? '').toLowerCase() === 'developer';

  const marketplace = isMarketplaceName(candidate.pageName) || isMarketplaceDomain(domains);

  // identity anchors
  const fbMatch = (org.facebookUrls ?? []).some((u) => {
    const a = (u ?? '').toLowerCase();
    const b = (candidate.pageUrl ?? '').toLowerCase();
    // match by numeric page-id substring or vanity path equality
    return (!!candidate.pageId && a.includes(candidate.pageId)) || (!!a && !!b && (a === b || a.replace(/\/$/, '') === b.replace(/\/$/, '')));
  });
  if (fbMatch) add('existing_social_url_match', 'Matches the official Facebook page URL', 'مطابقة رابط صفحة فيسبوك الرسمية');

  const domainMatch = !!orgDomain && domains.some((d) => sameDomain(d, orgDomain));
  if (domainMatch) add('official_domain_match', 'Ads link to the official website domain', 'الإعلانات تشير إلى نطاق الموقع الرسمي');

  const aliasExact = (org.aliases ?? []).some((al) => normalizeName(al) && normalizeName(al) === candNorm);
  if (aliasExact) add('exact_alias_match', 'Exact match to a known alias', 'مطابقة تامة لاسم بديل معروف');

  if (arTokens.length && candNorm && normalizeName(org.nameAr) === candNorm) add('exact_ar_name', 'Exact Arabic-name match', 'مطابقة تامة للاسم العربي');
  else {
    const arSim = jaccard(candTokens, arTokens);
    if (arSim >= 0.5) add('ar_name_similarity', `Arabic-name similarity ${(arSim * 100) | 0}%`, `تشابه الاسم العربي ${(arSim * 100) | 0}%`, Math.round(WEIGHTS.ar_name_similarity * arSim));
  }
  if (enTokens.length && candNorm && normalizeName(org.nameEn) === candNorm) add('exact_en_name', 'Exact English-name match', 'مطابقة تامة للاسم الإنجليزي');
  else {
    const enSim = jaccard(candTokens, enTokens);
    if (enSim >= 0.5) add('en_name_similarity', `English-name similarity ${(enSim * 100) | 0}%`, `تشابه الاسم الإنجليزي ${(enSim * 100) | 0}%`, Math.round(WEIGHTS.en_name_similarity * enSim));
  }

  // penalties
  if (marketplace && isDeveloper) add('marketplace_detected', 'Marketplace/portal advertiser (promotes the developer’s listings, not the developer)', 'معلن سوق/بوابة عقارية (يروّج قوائم المطوّر لا المطوّر نفسه)');
  else if (marketplace) add('marketplace_detected', 'Marketplace/portal advertiser', 'معلن سوق/بوابة عقارية', Math.round(WEIGHTS.marketplace_detected / 2));

  if (orgDomain && domains.length > 0 && !domainMatch) add('advertiser_domain_mismatch', 'Ad landing domains differ from the official domain', 'نطاقات الإعلانات تختلف عن النطاق الرسمي');

  const anyStrong = fbMatch || domainMatch || aliasExact || reasons.some((r) => r.code === 'exact_ar_name' || r.code === 'exact_en_name');
  if (!anyStrong && !marketplace) add('weak_keyword_only', 'Only a weak keyword-content match', 'تطابق ضعيف على الكلمة المفتاحية فقط');

  const score = reasons.reduce((s, r) => s + r.delta, 0);
  // A HARD anchor is an identity signal a name-collision can't fake: ads linking
  // to the org's own domain, a known Facebook URL, or an exact alias. Name-only
  // matches (even AR+EN) do NOT count — two different companies can share a name,
  // so they stay ≤ medium and never auto-confirm without a domain/URL anchor.
  const hasHardAnchor = fbMatch || domainMatch || aliasExact;
  let confidence: ScoredCandidate['confidence'] = 'low';
  if (!marketplace && score >= AUTO_CONFIRM_MIN_SCORE && hasHardAnchor) confidence = 'high';
  else if (score >= 40) confidence = 'medium';

  return { ...candidate, landingDomains: domains, score, confidence, isMarketplace: marketplace, reasons };
}

/** Score + sort all candidates, best first. */
export function scoreCandidates(candidates: AdvertiserCandidate[], org: OrgIdentity): ScoredCandidate[] {
  return candidates.map((c) => scoreCandidate(c, org)).sort((a, b) => b.score - a.score);
}

export interface AutoConfirmDecision { confirm: boolean; reason: string; winner: ScoredCandidate | null }

/**
 * Deterministic, conservative auto-confirm gate. Confirms ONLY when the top
 * candidate is high-confidence, non-marketplace, anchored by a real identity
 * signal (official domain / Facebook URL / exact name / alias), and clearly
 * ahead of any other non-marketplace candidate. Otherwise: leave unconfirmed.
 */
export function decideAutoConfirm(scored: ScoredCandidate[]): AutoConfirmDecision {
  if (scored.length === 0) return { confirm: false, reason: 'no_candidates', winner: null };
  const top = scored[0]!;
  if (top.isMarketplace) return { confirm: false, reason: 'top_is_marketplace', winner: top };
  if (top.confidence !== 'high') return { confirm: false, reason: 'low_confidence', winner: top };
  const anchored = top.reasons.some((r) =>
    ['official_domain_match', 'existing_social_url_match', 'exact_alias_match'].includes(r.code));
  if (!anchored) return { confirm: false, reason: 'no_identity_anchor', winner: top };
  const rival = scored.slice(1).find((c) => !c.isMarketplace);
  if (rival && top.score - rival.score < AUTO_CONFIRM_MARGIN) return { confirm: false, reason: 'ambiguous_rival', winner: top };
  return { confirm: true, reason: 'high_confidence_anchored', winner: top };
}

export const SCORING_CONSTANTS = { WEIGHTS, AUTO_CONFIRM_MIN_SCORE, AUTO_CONFIRM_MARGIN, MARKETPLACE_DOMAINS, MARKETPLACE_NAME_TOKENS };
