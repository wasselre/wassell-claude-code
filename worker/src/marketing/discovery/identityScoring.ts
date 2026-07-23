// ============================================================================
// Deterministic multi-platform identity scoring for discovered account
// candidates. Generalizes advertiserScoring beyond Meta: the DECISIVE signals
// are link-backs — the org's own website links to the account, or the account
// links back to the org's domain. Those are near-certain ownership proofs a
// name collision can't fake. Marketplaces/brokers are penalized. Auto-confirm
// requires a strong anchor + non-marketplace + a clear margin over rivals.
//
// Pure + dependency-free apart from the shared normalizers in advertiserScoring.
// ============================================================================
import { normalizeName, nameTokens, registrableDomain, SCORING_CONSTANTS } from '../advertiserScoring.js';

export interface OrgIdentity {
  nameAr?: string | null; nameEn?: string | null; website?: string | null;
  aliases?: string[]; orgType?: string | null;
}

export interface IdentityCandidateInput {
  platform: string;                // instagram | tiktok | youtube | facebook | x | linkedin | snapchat
  handle: string;
  url?: string | null;
  accountId?: string | null;       // stable id (page/channel id) when resolved
  pageName?: string | null;        // display name from the profile
  bioText?: string | null;         // profile bio/about text
  bioLinks?: string[];             // links in the profile bio/about
  siteLinksToThis?: boolean;       // the org's OWN website links to this account (STRONG)
  sources: string[];               // discovery sources that surfaced it (site_crawl, google, crosslink)
}

export interface IdentityReason { code: string; label_en: string; label_ar: string; delta: number }
export interface ScoredIdentity {
  platform: string; handle: string; url?: string | null; accountId?: string | null;
  pageName?: string | null; score: number; confidence: 'high' | 'medium' | 'low';
  isMarketplace: boolean; accountClass: string; reasons: IdentityReason[]; sources: string[];
}

const W = {
  site_links_to_account: 60,   // the org's website endorses this account — near-certain
  account_links_to_domain: 55, // the account's bio links back to the org's domain
  official_domain_match: 45,   // a bio/landing link is the org's registered domain
  multi_source: 18,            // independently surfaced by ≥2 discovery sources
  exact_ar_name: 46, exact_en_name: 40, name_similarity: 24, alias_exact: 42,
  marketplace_detected: -80, broker_detected: -50, domain_mismatch: -18, weak_keyword_only: -10,
} as const;

const AUTO_MIN = 60, AUTO_MARGIN = 22;

const BROKER_TOKENS = ['broker', 'وسيط', 'وساطة', 'عقاري معتمد', 'مسوق معتمد', 'مستشار عقاري'];

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let i = 0; for (const x of sa) if (sb.has(x)) i++;
  return i / new Set([...sa, ...sb]).size;
}
function isMarketplaceName(name?: string | null): boolean {
  const n = (name ?? '').toLowerCase();
  return SCORING_CONSTANTS.MARKETPLACE_NAME_TOKENS.some((t) => n.includes(t));
}
function domainsFrom(links: string[] | undefined): string[] {
  return (links ?? []).map((l) => registrableDomain(l)).filter((d): d is string => !!d);
}
function sameDomain(a: string, b: string): boolean { return a === b || a.endsWith('.' + b) || b.endsWith('.' + a); }

export function scoreIdentity(c: IdentityCandidateInput, org: OrgIdentity): ScoredIdentity {
  const reasons: IdentityReason[] = [];
  const add = (code: keyof typeof W, en: string, ar: string, d?: number) =>
    reasons.push({ code, label_en: en, label_ar: ar, delta: d ?? W[code] });

  const orgDomain = registrableDomain(org.website);
  const candNorm = normalizeName(c.pageName ?? c.handle);
  const candTokens = nameTokens(c.pageName ?? c.handle);
  const bioDomains = domainsFrom(c.bioLinks);
  const nameBlob = `${c.pageName ?? ''} ${c.handle} ${c.bioText ?? ''}`;

  const marketplace = isMarketplaceName(c.pageName) || isMarketplaceName(c.handle)
    || bioDomains.some((d) => SCORING_CONSTANTS.MARKETPLACE_DOMAINS.some((m) => sameDomain(d, m)));
  const broker = BROKER_TOKENS.some((t) => nameBlob.toLowerCase().includes(t.toLowerCase()));

  // ── decisive link-back anchors ──
  if (c.siteLinksToThis) add('site_links_to_account', 'The organization’s website links to this account', 'موقع المؤسسة الرسمي يرتبط بهذا الحساب');
  const linksBack = !!orgDomain && bioDomains.some((d) => sameDomain(d, orgDomain));
  if (linksBack) add('account_links_to_domain', 'The account bio links back to the official domain', 'الحساب يرتبط بنطاق المؤسسة الرسمي في نبذته');
  else if (!!orgDomain && bioDomains.length > 0) add('official_domain_match', 'Bio links to the official website', 'نبذة الحساب تشير للموقع الرسمي', 0); // neutral placeholder; real domain match handled above

  // ── name / alias ──
  if (arname(org) && candNorm && normalizeName(org.nameAr) === candNorm) add('exact_ar_name', 'Exact Arabic-name match', 'مطابقة تامة للاسم العربي');
  else if (jaccard(candTokens, nameTokens(org.nameAr)) >= 0.5) add('name_similarity', 'Arabic-name similarity', 'تشابه الاسم العربي', Math.round(W.name_similarity * jaccard(candTokens, nameTokens(org.nameAr))));
  if (enname(org) && candNorm && normalizeName(org.nameEn) === candNorm) add('exact_en_name', 'Exact English-name match', 'مطابقة تامة للاسم الإنجليزي');
  else if (jaccard(candTokens, nameTokens(org.nameEn)) >= 0.5) add('name_similarity', 'English-name similarity', 'تشابه الاسم الإنجليزي', Math.round(W.name_similarity * jaccard(candTokens, nameTokens(org.nameEn))));
  if ((org.aliases ?? []).some((al) => normalizeName(al) && normalizeName(al) === candNorm)) add('alias_exact', 'Exact alias match', 'مطابقة تامة لاسم بديل');

  // ── corroboration & penalties ──
  if (c.sources.length >= 2) add('multi_source', `Surfaced by ${c.sources.length} independent sources`, `ظهر عبر ${c.sources.length} مصادر مستقلة`);
  if (marketplace) add('marketplace_detected', 'Marketplace/portal account', 'حساب سوق/بوابة عقارية');
  if (broker && !marketplace) add('broker_detected', 'Broker/agent account', 'حساب وسيط/مسوّق فردي');
  if (orgDomain && bioDomains.length > 0 && !linksBack) add('domain_mismatch', 'Bio links to a different domain', 'الحساب يرتبط بنطاق مختلف');
  const anyStrong = c.siteLinksToThis || linksBack || reasons.some((r) => ['exact_ar_name', 'exact_en_name', 'alias_exact'].includes(r.code));
  if (!anyStrong && !marketplace) add('weak_keyword_only', 'Only a weak keyword match', 'تطابق ضعيف على الكلمة المفتاحية');

  const score = reasons.reduce((s, r) => s + r.delta, 0);
  const hardAnchor = c.siteLinksToThis || linksBack;
  let confidence: ScoredIdentity['confidence'] = 'low';
  if (!marketplace && !broker && score >= AUTO_MIN && hardAnchor) confidence = 'high';
  else if (score >= 35) confidence = 'medium';

  const accountClass = marketplace ? 'marketplace' : broker ? 'broker' : confidence === 'low' ? 'unknown' : 'organization';

  return { platform: c.platform, handle: c.handle, url: c.url, accountId: c.accountId, pageName: c.pageName,
    score, confidence, isMarketplace: marketplace, accountClass, reasons, sources: [...new Set(c.sources)] };
}
function arname(o: OrgIdentity) { return nameTokens(o.nameAr).length > 0; }
function enname(o: OrgIdentity) { return nameTokens(o.nameEn).length > 0; }

export interface AutoConfirmDecision { confirm: boolean; reason: string }
/** Auto-confirm ONLY a high-confidence, non-marketplace, link-back-anchored winner that clearly beats rivals. */
export function decideIdentityAutoConfirm(scored: ScoredIdentity[], platform: string): AutoConfirmDecision {
  const on = scored.filter((s) => s.platform === platform).sort((a, b) => b.score - a.score);
  if (on.length === 0) return { confirm: false, reason: 'no_candidates' };
  const top = on[0]!;
  if (top.isMarketplace) return { confirm: false, reason: 'top_is_marketplace' };
  if (top.confidence !== 'high') return { confirm: false, reason: 'low_confidence' };
  const anchored = top.reasons.some((r) => ['site_links_to_account', 'account_links_to_domain'].includes(r.code));
  if (!anchored) return { confirm: false, reason: 'no_linkback_anchor' };
  const rival = on.slice(1).find((c) => !c.isMarketplace);
  if (rival && top.score - rival.score < AUTO_MARGIN) return { confirm: false, reason: 'ambiguous_rival' };
  return { confirm: true, reason: 'linkback_anchored' };
}
