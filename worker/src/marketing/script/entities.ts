/**
 * Entity gate — the ONLY company a script may name is Wassel (plus the
 * developer when rules.allow_developer_name). Everything that identifies an
 * exemplar's organisation (names, handles, hashtags, CTAs, phones, URLs,
 * licence numbers) or the project's marketer is blocklisted and detected
 * after Arabic normalisation.
 *
 * `normAr` is the TS twin of SQL `mkt_norm_ar` per contract §12: folds
 * أإآٱ→ا, ة→ه, ى→ي, drops tatweel + diacritics, unifies Arabic-Indic / Persian
 * digits to Western, collapses whitespace, lower-cases. Keep both in sync.
 */
import type { Brief, DraftScene, EntityHit, Exemplar, ScriptWriterRules } from './types.js';

const DIACRITICS = /[ً-ْٰـ]/g; // tanween/harakat/shadda/sukun + dagger alef + tatweel
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

export function unifyDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    out += ch;
  }
  return out;
}

export function normAr(s: string | null | undefined): string {
  if (!s) return '';
  return unifyDigits(s)
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Tokens after normalisation — punctuation stripped, keeps letters/digits/@/#. */
export function tokenizeAr(s: string): string[] {
  return normAr(s)
    .replace(/[^\p{L}\p{N}@#_]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

export type BlockKind = 'org' | 'marketer' | 'competitor' | 'handle' | 'hashtag' | 'cta' | 'phone' | 'url' | 'license';

export interface BlockEntry {
  /** Normalised phrase (for names/CTAs) or exact token (handles/hashtags) or raw digits (phones). */
  term: string;
  kind: BlockKind;
  source: string;
  /** Original, human-readable form for the report. */
  display: string;
}

/**
 * Words that are too generic to identify an organisation on their own — a
 * company called «الرياض للتطوير» must not flag the word «الرياض». Only the
 * FULL phrase of such a name is matched. Normalised forms.
 */
export const GENERIC_ORG_WORDS: ReadonlySet<string> = new Set([
  'شركه', 'شركة', 'مجموعه', 'مؤسسه', 'العقاريه', 'العقاري', 'العقارات', 'عقار', 'عقارات', 'عقاريه',
  'للتطوير', 'التطوير', 'تطوير', 'للاستثمار', 'الاستثمار', 'استثمار', 'للعقارات', 'للتسويق', 'التسويق',
  'القابضه', 'الدوليه', 'السعوديه', 'الوطنيه', 'المتحده', 'الحديثه', 'الاولي', 'العالميه',
  'الرياض', 'جده', 'الدمام', 'مكه', 'المدينه', 'الخبر', 'الشرقيه', 'الغربيه', 'الشماليه', 'الجنوبيه',
  'دار', 'بيت', 'بيوت', 'منازل', 'مساكن', 'سكن', 'اسكان', 'الاسكان', 'ديار', 'روابي', 'مشاريع', 'مشروع',
  'الحياه', 'المستقبل', 'الامل', 'النخبه', 'الرواد', 'البناء', 'للبناء', 'الانشاء', 'للانشاء', 'المقاولات', 'للمقاولات',
  'real', 'estate', 'realestate', 'development', 'developments', 'group', 'company', 'co', 'holding', 'properties',
  'property', 'homes', 'living', 'saudi', 'riyadh', 'jeddah', 'the', 'and', 'of',
]);

/**
 * Curated marketers / portals that must never appear in a Wassel script even
 * when they are not among the exemplars. Developers are NOT listed (they may be
 * named when rules.allow_developer_name). Phrases only — no generic words.
 */
export const CURATED_COMPETITORS: ReadonlyArray<string> = [
  'ريفا العقارية', 'ريفا', 'riva', 'riva.sa',
  'عقار ماب', 'عقارماب', 'aqarmap',
  'bayut', 'بيوت دوت كوم',
  'property finder', 'propertyfinder',
  'عقار دوت كوم', 'aqar.fm', 'aqar.sa',
  'دلال', 'dalal',
  'سكن دوت كوم',
  'هوم لاند', 'homeland',
];

const PHONE_RE = /(?:\+?966|00966|0)?\s?5\d(?:[\s-]?\d){7}\b|\b9200\d{5}\b|\b920\d{6}\b|\b800\d{7}\b/g;
const LICENSE_RE = /\bFAL\s?-?\s?\d{5,}\b|\b\d{10,}\b(?=[^\n]{0,20}(?:رخصه|رخصة|ترخيص|فال))|(?:رخصه|رخصة|ترخيص|فال|رقم الاعلان|رقم الإعلان|رقم ترخيص)\s*(?:رقم|:)?\s*[:#]?\s*(\d{4,})/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:sa|com|net|org|io|me|co)(?:\.[a-z]{2})?(?:\/[^\s]*)?\b/gi;
const HANDLE_RE = /@[a-z0-9_.]{3,}/gi;
const HASHTAG_RE = /#[\p{L}\p{N}_]{3,}/gu;

export interface BlocklistInput {
  brief: Pick<Brief, 'cta'>;
  exemplars: Array<Pick<Exemplar, 'org_name' | 'organization_id'>>;
  /** Extra per-org identifiers fetched from mkt_organizations / mkt_social_accounts / post rows. */
  orgs?: Array<{ id: string | null; name_ar?: string | null; name_en?: string | null; website?: string | null; handles?: string[]; hashtags?: string[]; mentions?: string[]; ctas?: string[]; phones?: string[]; urls?: string[] }>;
  projectRecord: Record<string, unknown>;
  developerName?: string | null;
  marketerName?: string | null;
  rules: Pick<ScriptWriterRules, 'allow_developer_name' | 'marketer_name'>;
}

function addPhrase(list: BlockEntry[], seen: Set<string>, raw: string | null | undefined, kind: BlockKind, source: string): void {
  if (!raw) return;
  const term = normAr(raw).replace(/[^\p{L}\p{N}@#_. ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (term.length < 4) return; // never block short words
  if (GENERIC_ORG_WORDS.has(term)) return;
  const key = `${kind}:${term}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ term, kind, source, display: raw.trim() });
}

/** Distinctive single tokens of a name (skip generic words + short tokens). */
function distinctiveTokens(name: string): string[] {
  return tokenizeAr(name).filter((t) => t.length >= 4 && !GENERIC_ORG_WORDS.has(t) && !/^\d+$/.test(t));
}

function mineIdentifiers(text: string): { phones: string[]; urls: string[]; licenses: string[]; handles: string[]; hashtags: string[] } {
  const t = unifyDigits(text);
  const phones = (t.match(PHONE_RE) ?? []).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 9);
  const urls = (t.match(URL_RE) ?? []).map((u) => u.toLowerCase());
  const licenses: string[] = [];
  for (const m of t.matchAll(LICENSE_RE)) licenses.push((m[1] ?? m[0]).replace(/\s/g, ''));
  const handles = (t.match(HANDLE_RE) ?? []).map((h) => h.toLowerCase());
  const hashtags = (t.match(HASHTAG_RE) ?? []).map((h) => normAr(h));
  return { phones, urls, licenses, handles, hashtags };
}

export function buildBlocklist(input: BlocklistInput): BlockEntry[] {
  const list: BlockEntry[] = [];
  const seen = new Set<string>();
  const wassel = normAr(input.rules.marketer_name);
  const developer = input.rules.allow_developer_name && input.developerName ? normAr(input.developerName) : null;

  const isAllowed = (term: string): boolean => {
    if (!term) return true;
    if (term === wassel || wassel.includes(term) || term.includes('وصل العقاري')) return true;
    if (developer && (term === developer || developer.includes(term) || term.includes(developer))) return true;
    return false;
  };
  const addName = (raw: string | null | undefined, kind: BlockKind, source: string): void => {
    if (!raw) return;
    const full = normAr(raw);
    if (isAllowed(full)) return;
    addPhrase(list, seen, raw, kind, source);
    for (const tok of distinctiveTokens(raw)) {
      if (isAllowed(tok)) continue;
      addPhrase(list, seen, tok, kind, `${source}:token`);
    }
  };

  // 1. Exemplar organisations (names from the RPC rows + richer org rows).
  for (const e of input.exemplars) addName(e.org_name, 'org', `exemplar:${e.organization_id ?? '?'}`);
  for (const o of input.orgs ?? []) {
    const src = `org:${o.id ?? '?'}`;
    addName(o.name_ar, 'org', src);
    addName(o.name_en, 'org', src);
    if (o.website) for (const u of mineIdentifiers(o.website).urls) addPhrase(list, seen, u, 'url', src);
    for (const h of o.handles ?? []) addPhrase(list, seen, h.startsWith('@') ? h : `@${h}`, 'handle', src);
    for (const h of o.hashtags ?? []) addPhrase(list, seen, h.startsWith('#') ? h : `#${h}`, 'hashtag', src);
    for (const m of o.mentions ?? []) addPhrase(list, seen, m.startsWith('@') ? m : `@${m}`, 'handle', src);
    for (const c of o.ctas ?? []) {
      // Only CTAs that carry an identifier (name/number/url) — generic «تواصل معنا» is fine to reuse.
      const ids = mineIdentifiers(c);
      for (const p of ids.phones) addPhrase(list, seen, p, 'phone', src);
      for (const u of ids.urls) addPhrase(list, seen, u, 'url', src);
      if (o.name_ar && normAr(c).includes(normAr(o.name_ar))) addPhrase(list, seen, c, 'cta', src);
    }
    for (const p of o.phones ?? []) addPhrase(list, seen, p.replace(/\D/g, ''), 'phone', src);
    for (const u of o.urls ?? []) addPhrase(list, seen, u, 'url', src);
  }

  // 2. The project's marketer + identifiers mined from its text fields.
  if (input.marketerName) addName(input.marketerName, 'marketer', 'project.marketer');
  if (!input.rules.allow_developer_name && input.developerName) addName(input.developerName, 'org', 'project.developer');
  const textFields = ['marketing_document', 'project_analysis', 'source_notes', 'internal_sales_notes', 'update_source_notes', 'ai_audit_notes', 'project_page_url', 'broucher_developer', 'update_source_url'];
  for (const f of textFields) {
    const v = input.projectRecord[f];
    if (typeof v !== 'string' || !v) continue;
    const ids = mineIdentifiers(v);
    for (const p of ids.phones) addPhrase(list, seen, p, 'phone', `project.${f}`);
    for (const u of ids.urls) addPhrase(list, seen, u, 'url', `project.${f}`);
    for (const l of ids.licenses) addPhrase(list, seen, l, 'license', `project.${f}`);
    for (const h of ids.handles) addPhrase(list, seen, h, 'handle', `project.${f}`);
  }

  // 3. Curated competitors.
  for (const c of CURATED_COMPETITORS) addPhrase(list, seen, c, 'competitor', 'curated');

  return list;
}

/** Whole-token / whole-phrase containment on tokenised text. */
function containsPhrase(tokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) return false;
  outer: for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

export interface EntityScanOptions { allowedTerms?: string[] }

/**
 * Scan every scene field for blocklisted entities + regex-detected contact
 * channels (phones / licences / URLs / handles / competitor hashtags).
 * Never substring-matches inside words: names are compared token-by-token.
 */
export function detectEntities(
  scenes: Array<Pick<DraftScene, 'order' | 'voiceover' | 'on_screen_text' | 'visual'>>,
  blocklist: BlockEntry[],
  opts: EntityScanOptions = {},
): EntityHit[] {
  const hits: EntityHit[] = [];
  const allowed = new Set((opts.allowedTerms ?? []).map(normAr).filter(Boolean));
  const seen = new Set<string>();
  const push = (h: EntityHit): void => {
    const k = `${h.scene}:${h.field}:${h.kind}:${normAr(h.mention)}`;
    if (seen.has(k)) return;
    seen.add(k);
    hits.push(h);
  };

  const fields: Array<'voiceover' | 'on_screen_text' | 'visual'> = ['voiceover', 'on_screen_text', 'visual'];
  for (const s of scenes) {
    for (const field of fields) {
      const text = s[field] ?? '';
      if (!text.trim()) continue;
      const tokens = tokenizeAr(text);
      const norm = normAr(text);

      for (const b of blocklist) {
        if (allowed.has(b.term)) continue;
        switch (b.kind) {
          case 'org': case 'marketer': case 'competitor': case 'cta': {
            const pt = b.term.split(' ').filter(Boolean);
            const single = pt.length === 1;
            // Single generic-looking tokens were never added; for phrases require the whole phrase.
            if (containsPhrase(tokens, pt) && !(single && GENERIC_ORG_WORDS.has(pt[0]!))) {
              push({ scene: s.order, field, mention: b.display, kind: b.kind });
            }
            break;
          }
          case 'handle': case 'hashtag': {
            if (tokens.includes(b.term) || norm.includes(b.term)) push({ scene: s.order, field, mention: b.display, kind: b.kind });
            break;
          }
          case 'phone': {
            const digits = unifyDigits(text).replace(/[\s-]/g, '');
            if (b.term.length >= 9 && digits.includes(b.term.slice(-9))) push({ scene: s.order, field, mention: b.display, kind: 'phone' });
            break;
          }
          case 'url': case 'license': {
            if (norm.replace(/\s/g, '').includes(b.term.replace(/\s/g, ''))) push({ scene: s.order, field, mention: b.display, kind: b.kind });
            break;
          }
          default: break;
        }
      }

      // Regex channels — ANY contact channel other than Wassel's CTA is a leak.
      const ids = mineIdentifiers(text);
      for (const p of ids.phones) push({ scene: s.order, field, mention: p, kind: 'phone' });
      for (const u of ids.urls) if (!/wassel\.re|wassel\.sa/i.test(u)) push({ scene: s.order, field, mention: u, kind: 'url' });
      for (const l of ids.licenses) push({ scene: s.order, field, mention: l, kind: 'license' });
      for (const h of ids.handles) if (!/wassel/i.test(h)) push({ scene: s.order, field, mention: h, kind: 'handle' });
    }
  }
  return hits;
}
