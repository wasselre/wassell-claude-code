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
  /**
   * HOW the match was made — the reader (skill + validator) needs this, not
   * just a number:
   *   full_name  the project's whole name (or a parenthesised / dash-segment
   *              variant of it) appears verbatim in the evidence — strong
   *   number     a distinctive project number (≥3 digits alone, or a short
   *              number glued to its series word: "ريفييرا 44") — strong
   *   word       ONE distinctive word of the name — WEAK. A lone word is never
   *              enough on its own; the decision step must find a concrete
   *              project reference or decline.
   */
  strength: 'full_name' | 'number' | 'word';
}

export interface AttributionOptions {
  publisherProjectIds?: string[];
  commonTokens?: Set<string>;
  /**
   * Tokens that can NEVER be project evidence on their own: the publishing
   * organization's own name words (its brand sits on every post, including the
   * ones about sofas), place names (a district mentioned in passing is not a
   * project), and generic real-estate words. They still serve as the SERIES
   * word of a "<series> <number>" phrase ("ريفييرا 44") and still count inside
   * a full-name match ("عزوم النرجس") — but a name made of nothing but generic
   * and place words is a full-name match only for its own publisher (see
   * attributeCaption rule 1).
   */
  excludedTokens?: Set<string>;
  /** Normalized full organization names — a project "name" equal to the brand
   *  itself is not evidence of a project. Their words are also what tells an
   *  organization's name apart from a place inside excludedTokens, which holds
   *  both (attributeCaption rule 1). */
  brandPhrases?: string[];
}

/**
 * Real-estate words that name a KIND of thing, not a project. Matched as lone
 * words they would make "أدوار" evidence for "أدوار جديل الرمال" on every
 * apartments-vs-floors post. Kept small and obvious; the catalog-frequency rule
 * (computeCommonTokens) catches the rest.
 */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'مشروع', 'مشاريع', 'شقق', 'شقه', 'فلل', 'فيلا', 'ادوار', 'دور', 'اراضي', 'ارض',
  'تاون', 'فيلج', 'بارك', 'سكوير', 'ريزيدنس', 'ريزيدنسيز', 'ريزيدنسز',
  'تاور', 'برج', 'ابراج', 'مجمع', 'كمباوند', 'سكني', 'سكنيه', 'هوم', 'هومز', 'هيلز',
  'فيو', 'جاردن', 'جاردنز', 'بلازا', 'سيتي', 'سنتر', 'مول', 'بوليفارد', 'افنيو',
  'ليفينج', 'لاند', 'لاندز', 'العقاريه', 'العقاري', 'للتطوير', 'التطوير', 'للاستثمار',
  'residence', 'residences', 'tower', 'towers', 'park', 'square', 'village', 'town',
  'villas', 'villa', 'apartments', 'homes', 'home', 'hills', 'view', 'garden', 'gardens',
  'plaza', 'city', 'center', 'centre', 'mall', 'boulevard', 'avenue', 'living', 'land',
  'project', 'projects', 'real', 'estate', 'development', 'developments', 'investment',
]);

/**
 * Everyday Arabic words that the catalog also uses as a whole project name
 * («بعد», «بناء», «دام»). Bare, they are grammar, not a reference: «بعد» was a
 * full-name candidate for an Almajdiah post saying «على بعد خطوات من الكورنيش».
 * Such a name counts only right after a project marker («مشروع بعد»), and it
 * is never a lone-word hint. Normalised (normalizeAr) form.
 */
export const EVERYDAY_WORDS: ReadonlySet<string> = new Set([
  'بعد', 'قبل', 'عند', 'بين', 'فوق', 'تحت', 'حول', 'ضمن', 'نحو', 'منذ', 'حتي', 'لدي',
  'غير', 'دون', 'بناء', 'دام', 'كل', 'مع', 'عن', 'علي', 'الي', 'هذا', 'هذه', 'هنا',
  'هناك', 'اول', 'اخر', 'جديد', 'جديده',
]);

/** Words that, placed right before a single-word name, make it a project
 *  reference: «مشروع مدار» names a project; «مدار» alone may be anything
 *  («العالم لك مدار» is a Dar Al Arkan slogan). */
const PROJECT_MARKERS = ['مشروع', 'مشاريع', 'برج', 'ابراج', 'مجمع', 'كمباوند', 'مخطط', 'project', 'tower', 'compound'];
/** English puts its marker AFTER the name: «Madar Tower», not «Tower Madar». */
const ENGLISH_MARKERS = ['project', 'tower', 'compound'];
/** Quote marks a name may sit in next to its marker («مشروع «مدار»»,
 *  'Discover "Madar" Tower'). normalizeAr keeps punctuation. */
const QUOTE_CLASS = `[«»"“”‘’']`;

export function normalizeAr(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ـً-ْ]/g, '') // tatweel + harakat
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/_/g, ' ')
    // Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII. Captions write
    // «مينا ٣٩» while the catalog stores «مينا 39»; without this the number
    // rules never fire on them (41 unlinked posts used only these digits,
    // measured 2026-10-03). One char → one char, so offsets are unchanged.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

/**
 * Per-project derived data, memoised. The catalog-wide pass (2026-09-13)
 * runs the matcher over ~1,000 projects per post; rebuilding tokens, name
 * variants and compiled regexes for each of them on every post cost ~8 s a
 * post on a shared-cpu machine and failed its health checks. Keyed on the
 * name fields, so a renamed project simply gets a new entry.
 */
const PROJECT_CACHE = new Map<string, { tokens: string[]; variants: string[] }>();
const REGEX_CACHE = new Map<string, RegExp>();
function projectKey(a: ProjectAlias): string {
  return `${a.projectId}|${a.nameAr ?? ''}|${a.nameEn ?? ''}|${a.tokens.join(',')}`;
}
function projectDerived(a: ProjectAlias): { tokens: string[]; variants: string[] } {
  const k = projectKey(a);
  let d = PROJECT_CACHE.get(k);
  if (!d) {
    d = { tokens: computeAliasTokens(a), variants: projectNameVariants(a) };
    if (PROJECT_CACHE.size > 20_000) PROJECT_CACHE.clear();
    PROJECT_CACHE.set(k, d);
  }
  return d;
}

/** All candidate tokens from a project name: numbers + words ≥3 chars. */
function computeAliasTokens(a: ProjectAlias): string[] {
  const out = new Set<string>();
  for (const raw of [a.nameAr, a.nameEn, ...a.tokens]) {
    const n = normalizeAr(raw);
    for (const num of n.match(/\d{1,4}/g) ?? []) out.add(num);
    for (const w of n.split(/\s+/)) if (w.length >= 3 && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}
function aliasTokens(a: ProjectAlias): string[] { return projectDerived(a).tokens; }

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
/**
 * A snippet that actually CONTAINS the matched text, centred on the first match
 * rather than taken from the head of the caption.
 *
 * The old `caption.slice(0, 140)` was a head preview: when a project was named
 * late in a caption — after the hook, emoji block, or several lines of ad copy —
 * the stored snippet did not contain the evidence for its own match. That
 * snippet is shown to reviewers AND fed back into the enrichment evidence
 * package, so a correct attribution looked unsupported. (A real review call was
 * reversed on exactly this: judged from the first 45 characters, while the
 * caption named the project further in.)
 *
 * Matching itself has always scanned the full text — this only fixes what gets
 * QUOTED as the reason.
 */
export function matchSnippet(caption: string, matched: string[], radius = 90): string {
  const text = caption ?? '';
  if (!text) return '';
  const nt = normalizeAr(text);
  // Find the earliest position of any matched token in the normalized text.
  // normalizeAr preserves length (it only substitutes/removes diacritics), so
  // indexes map closely enough for a human-readable window.
  let at = -1;
  for (const m of matched) {
    const nm = normalizeAr(m);
    // A phrase is located whole first: «مشروع بعد» anchored on its first word
    // would centre on whichever «مشروع» the caption mentions first. Phrases
    // whose text form differs (punctuation, an attached prefix) fall back to
    // anchoring on the first word.
    let i = nm.includes(' ') ? nt.indexOf(nm) : -1;
    if (i < 0) {
      const needle = nm.split(/\s+/)[0];
      if (!needle) continue;
      i = nt.indexOf(needle);
    }
    if (i >= 0 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, radius * 2); // no locatable match — head is all we have
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The full-name VARIANTS a project can be recognised by, all normalized:
 *   - the whole Arabic / English name
 *   - each parenthesised alternate ("الماجدية فيلج (Al Majdiah Village)")
 *   - the segment before a " - " / " | " separator when it has ≥2 words
 *     ("سديم تاون - شقق" → "سديم تاون")
 *   - every explicit alias in `tokens`
 * Punctuation is dropped so "ريفييرا-44" and "ريفييرا 44" are the same phrase.
 */
export function projectNameVariants(a: ProjectAlias): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    const cleaned = v.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 3) out.add(cleaned);
  };
  for (const raw of [a.nameAr, a.nameEn, ...a.tokens]) {
    if (!raw) continue;
    const n = normalizeAr(raw);
    for (const m of n.match(/\(([^)]+)\)/g) ?? []) add(m.slice(1, -1));
    const bare = n.replace(/\([^)]*\)/g, ' ');
    add(bare);
    const seg = bare.split(/\s+[-–|]\s+/)[0] ?? '';
    if (seg && seg.trim() !== bare.trim() && seg.trim().split(/\s+/).length >= 2) add(seg);
  }
  return [...out];
}

/** All of `words` present as whole words inside some window of `span`
 *  consecutive text words (any order). Returns the matched window text. */
function wordsWithinWindow(normalizedText: string, words: string[], span: number): string | null {
  const strip = (w: string) => w.replace(/^(?:[وبلفك]|لل)(?=.{3})/, '');
  const toks = normalizedText.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const want = new Set(words);
  for (let i = 0; i < toks.length; i++) {
    const seen = new Set<string>();
    for (let j = i; j < Math.min(toks.length, i + span); j++) {
      const t = toks[j]!;
      if (want.has(t)) seen.add(t);
      else if (want.has(strip(t))) seen.add(strip(t));
      if (seen.size === want.size) return toks.slice(i, j + 1).join(' ');
    }
  }
  return null;
}

/** Whole-phrase presence with word boundaries. Spaces in the variant match any
 *  run of whitespace; a single attached Arabic prefix letter (بربوة، وستون، للماجدية)
 *  is tolerated before the first word; a trailing number must end at a
 *  non-digit so "ريفييرا 4" cannot hit "ريفييرا 44". */
function phrasePresent(normalizedText: string, variant: string): boolean {
  let re = REGEX_CACHE.get(variant);
  if (!re) {
  const body = variant.split(' ').map(escapeRe).join('\\s+');
    re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:[وبلفك]|لل)?${body}(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (REGEX_CACHE.size > 50_000) REGEX_CACHE.clear();
    REGEX_CACHE.set(variant, re);
  }
  return re.test(normalizedText);
}

/** A single-word name directly after a project marker («مشروع بعد», «ببرج
 *  دام», «مشروع «مدار»»), or before an English one («Madar Tower»).
 *  The marker may carry ONE attached prefix letter; «لل» is not one — it is
 *  «ل» + the article, and «للمشروع بعد الإطلاق» is "for THE project, after the
 *  launch", the same definite form as «المشروع بعد», which never matches.
 *  The name itself takes no prefix («مشروع لبناء» is "a project for
 *  building", not بناء). Returns the reference as written (normalised,
 *  whitespace collapsed, quotes kept), so the stored alias is a verbatim
 *  excerpt the runner's validator can find in the evidence. */
function markedNamePresent(normalizedText: string, word: string): string | null {
  const key = `marker:${word}`; // ':' never survives projectNameVariants, so no collision with a variant key
  let re = REGEX_CACHE.get(key);
  if (!re) {
    const w = escapeRe(word);
    const before = `(?:${PROJECT_MARKERS.map(escapeRe).join('|')})(?:\\s+|\\s*${QUOTE_CLASS}\\s*)${w}${QUOTE_CLASS}?`;
    const after = `${w}${QUOTE_CLASS}?\\s+(?:${ENGLISH_MARKERS.join('|')})`;
    re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:[وبلفك]?(${before})|(${after}))(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (REGEX_CACHE.size > 50_000) REGEX_CACHE.clear();
    REGEX_CACHE.set(key, re);
  }
  const m = re.exec(normalizedText);
  return m ? (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ') : null;
}

/**
 * Attribute a caption to projects by NAME/NUMBER content only. Account ownership
 * (publisherProjectIds) RAISES confidence but never creates a match on its own —
 * a caption with no project reference returns [] (stays organization-level).
 *
 * Match order per project, strongest first:
 *   1. full name (any variant) present as a phrase          → strong, 0.90
 *      (a one-word name: in scope, or next to a marker — «مشروع/برج/…» before
 *      it, «Tower/Project/Compound» after it)
 *   2. a LONG number (≥3 digits) standalone                  → strong, 0.85
 *   3. a SHORT number glued to its series word ("ريفييرا 44") → strong, 0.85
 *   4. ONE distinctive word of the name                      → WEAK,   0.55
 * Distinctive = not common across the catalog (series/developer names shared by
 * ≥2 projects), not an excluded token (the publisher's own brand, a place name,
 * a generic real-estate word), not an everyday word (EVERYDAY_WORDS). Only
 * strong, unambiguous matches auto-accept.
 *
 * "In scope" below = the project id is in publisherProjectIds. The content
 * pipeline (narrowProjects) runs this twice: once for the publisher's own
 * projects, once for the rest of the catalog with an EMPTY scope — so a rule
 * that needs scope is a rule that never fires for another company's project.
 *
 * Why 4 is weak: "ربوة" matched 47 posts for ربوة الرمز — including "جنوب
 * الربوة" in a سديم تاون post — and "عزوم" (a single-project developer's own
 * name) matched 156 furniture posts. A lone word is a hint for the reader, not
 * an answer.
 */
export function attributeCaption(
  caption: string,
  index: ProjectAlias[],
  opts: AttributionOptions = {},
): AttributionCandidate[] {
  const nt = normalizeAr(caption);
  if (!nt.trim()) return [];
  const pub = new Set(opts.publisherProjectIds ?? []);
  const excluded = opts.excludedTokens ?? new Set<string>();
  const brandPhrases = new Set((opts.brandPhrases ?? []).map((b) => normalizeAr(b).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()));
  // Distinctiveness: prefer a GLOBAL common-token set (computed over the full
  // catalog); fall back to local doc-frequency when not supplied (unit tests).
  const common = opts.commonTokens;
  const df = common ? null : tokenDocFreq(index);
  const isCommon = (w: string) => (common ? common.has(w) : (df!.get(w) ?? 0) > 1);
  const isExcluded = (w: string) => excluded.has(w) || GENERIC_TOKENS.has(w);
  // A name that says nothing a different company's caption cannot also say is
  // evidence only from its own publisher: Dar Wa Emaar's «مشروع النرجس
  // كوميونيتيز» was LINKED to Nahda's «مشروع النرجس» (generic + place), and
  // Ocean's «3 ادوار 9 غرف» spells «ادوار 9» (generic + a short number).
  //
  // excludedTokens cannot draw that line alone: it holds organization name
  // words beside the places, and an organization's name inside a whole name
  // IS the project — «عزوم النرجس», «وشاح العارض», «بيات هيلز». Counting them
  // as shared refused 169 catalog names, 119 of them only for an
  // organization's name (measured 2026-10-03), so a marketer's post naming
  // one in full lost the candidate. brandPhrases carries the same
  // organization names, so their words are told apart here. A word that is
  // both an organization's name and a place («الياسمين», «النهضه») counts as
  // the organization's — the merged set cannot say which — so 28 names of
  // generic + place words still match in their own order («ديار النهضه»).
  const brandWords = new Set([...brandPhrases].flatMap((b) => b.split(' ')));
  const sharedWord = (w: string, orgNameIsOwn: boolean) =>
    GENERIC_TOKENS.has(w) || (excluded.has(w) && !(orgNameIsOwn && brandWords.has(w)));
  // rule 1's test — the name in its own order, numbers included. A number
  // makes it the project's own, except a short one after nothing but generic
  // words (rule 3 refuses «ادوار 9» as a series reference for the same reason).
  const nameIsShared = (vw: string[]) => {
    const named = vw.filter((w) => !/^\d+$/.test(w));
    const numbers = vw.filter((w) => /^\d+$/.test(w));
    if (numbers.length === 0) return named.every((w) => sharedWord(w, true));
    return named.every((w) => GENERIC_TOKENS.has(w)) && numbers.every((n) => n.length < 3);
  };
  const hits: AttributionCandidate[] = [];

  for (const a of index) {
    const derived = projectDerived(a);
    const toks = derived.tokens;
    // Cheap gate: every rule needs at least one name token (word or number)
    // to occur somewhere in the text. A plain substring test skips the ~95%
    // of catalog projects that cannot match before any regex runs.
    if (!toks.some((t) => nt.includes(t))) continue;
    const nums = toks.filter((t) => /^\d+$/.test(t));
    const words = toks.filter((t) => !/^\d+$/.test(t));
    const inScope = pub.has(a.projectId);
    const distinctiveWords = words.filter((w) => !isCommon(w) && !isExcluded(w) && !EVERYDAY_WORDS.has(w));
    // the series/developer/brand word a short number attaches to — never a
    // generic word: «ادوار 9» in an Ocean villa post ("floors: 9 …") became a
    // number match for Yamam's «أدوار - يمام 9». «يمام 9» still is one.
    const seriesWords = words.filter((w) => (isCommon(w) || isExcluded(w)) && !GENERIC_TOKENS.has(w));
    const matched: string[] = [];
    // the bare name behind a «مشروع X» hit, so the method label still says
    // which name language matched
    const markedNames: string[] = [];
    let strength: AttributionCandidate['strength'] | null = null;

    // 1. the whole name.
    //    A single-word name counts only when that word is itself distinctive
    //    (a project called just "الملقا" is not evidence every time the
    //    district is mentioned), and then only for the publisher's own project
    //    or next to a project marker (markedNamePresent): a one-word name outside the
    //    publisher's scope is too easy to meet by chance, and an everyday word
    //    («بعد», «بناء», «دام») needs the marker even in scope.
    //    A multi-word name counts unless it is literally the brand, or — out of
    //    scope — says nothing of its own (nameIsShared above).
    for (const v of derived.variants) {
      const vw = v.split(' ');
      if (brandPhrases.has(v)) continue;
      if (vw.length === 1) {
        if (/^\d+$/.test(v)) continue; // a bare number is handled by rule 2
        if (isCommon(v) || isExcluded(v)) continue;
        if (inScope && !EVERYDAY_WORDS.has(v)) {
          if (phrasePresent(nt, v)) { matched.push(v); strength = 'full_name'; }
        } else {
          const marked = markedNamePresent(nt, v);
          if (marked) { matched.push(marked); markedNames.push(v); strength = 'full_name'; }
        }
        continue;
      }
      if (!inScope && nameIsShared(vw)) continue;
      if (phrasePresent(nt, v)) { matched.push(v); strength = 'full_name'; }
    }
    // 1b. a PARTIAL name — two consecutive words of a longer name that include
    //     a distinctive word ("أدوار جديل" for "أدوار جديل الرمال", "جديل
    //     الرمال"). People shorten names; the pair is still a concrete
    //     reference, unlike a lone word. Two common/excluded words together
    //     ("أدوار الرمال") are not.
    if (!strength) {
      for (const v of derived.variants) {
        const vw = v.split(' ');
        if (vw.length < 3) continue;
        for (let i = 0; i + 1 < vw.length; i++) {
          const pair = `${vw[i]} ${vw[i + 1]}`;
          if (/^\d+$/.test(vw[i]!) || /^\d+$/.test(vw[i + 1]!)) continue;
          if (!(distinctiveWords.includes(vw[i]!) || distinctiveWords.includes(vw[i + 1]!))) continue;
          if (brandPhrases.has(pair)) continue;
          if (phrasePresent(nt, pair)) { matched.push(pair); strength = 'full_name'; }
        }
      }
    }
    // 1c. the whole name with its words in ANY order, ADJACENT — people write
    //     "فلل سديم" for "سديم فلل". Every word of the name must appear as a
    //     whole word inside a window exactly as wide as the name (a contiguous
    //     permutation), so "سديم تاون فلل" cannot become سديم فلل. Same policy
    //     as rule 1: a multi-word name counts on its own unless it is the brand
    //     or nothing but generic words — and, out of scope, unless it is
    //     nothing but generic / excluded words, an organization's name
    //     included. This rule drops the number and the order, so it asks more
    //     of the name than rule 1: «مشروع عزوم النرجس مسكن يليق بك» holds
    //     «النرجس مسكن», which made it a candidate for «مسكن النرجس»; and
    //     «شقق إشراقة 20» became «شقق إشراقة 16». In its own order an
    //     organization's name still counts (rule 1).
    if (!strength) {
      for (const v of derived.variants) {
        const all = v.split(' ');
        const vw = all.filter((w) => !/^\d+$/.test(w));
        if (vw.length < 2 || vw.length > 4) continue;
        if (brandPhrases.has(v)) continue;
        if (!vw.some((w) => !GENERIC_TOKENS.has(w))) continue;
        if (!inScope && vw.every((w) => sharedWord(w, false))) continue;
        // The window holds the name's NUMBER too. A numbered project is
        // identified by its number: dropping it made «أدوار - يمام 9» a
        // full-name candidate for «يمام 16 | أدوار مستقلة» — 260 such
        // candidates on 2026-10-03, each one a sibling with the wrong number.
        const hit = wordsWithinWindow(nt, all, all.length);
        if (hit) { matched.push(hit); strength = 'full_name'; break; }
      }
    }
    // 2. a LONG number (≥3 digits) standalone — distinctive on its own (174, 163)
    if (!strength) {
      for (const num of nums) if (num.length >= 3 && new RegExp(`(^|\\D)${num}(\\D|$)`).test(nt)) { matched.push(num); strength = 'number'; }
    }
    // 3. a SHORT number (1–2 digits) ONLY as a phrase with its series word ("ريفييرا 44",
    //    "المشرقية 2") — never alone, so a stray "2" in another caption can't match,
    //    and never after a generic word (seriesWords above), so "ادوار 9" can't either.
    if (!strength) {
      for (const num of nums) if (num.length < 3) for (const cw of seriesWords) {
        if (new RegExp(`${escapeRe(cw)}\\s*${num}(\\D|$)`).test(nt)) { matched.push(`${cw} ${num}`); strength = 'number'; }
      }
    }
    // 4. a project-unique word — weak. An everyday word is never one
    //    (distinctiveWords), so «على بعد خطوات» is no hint for «بعد» either.
    if (!strength) {
      for (const w of distinctiveWords) if (phrasePresent(nt, w)) { matched.push(w); strength = 'word'; }
    }
    if (!strength || matched.length === 0) continue;

    let confidence = strength === 'full_name' ? 0.9 : strength === 'number' ? 0.85 : 0.55;
    if (pub.has(a.projectId)) confidence = Math.min(0.95, confidence + (strength === 'word' ? 0.05 : 0.1)); // ownership boosts, doesn't prove
    const nameArNorm = normalizeAr(a.nameAr);
    hits.push({
      projectId: a.projectId,
      method: strength === 'full_name' ? ([...matched, ...markedNames].some((m) => nameArNorm.includes(m)) ? 'name_ar' : 'name_en') : 'caption',
      confidence,
      evidence: { matched: matched.join(','), snippet: matchSnippet(caption, matched) },
      matchedAliases: matched,
      autoAccept: false,
      strength,
    });
  }
  // A distinctive single STRONG match auto-accepts; ambiguity (≥2 projects) and
  // lone-word matches never do.
  const distinct = new Set(hits.map((h) => h.projectId));
  for (const h of hits) h.autoAccept = distinct.size === 1 && h.strength !== 'word' && h.confidence >= 0.85;
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
  | 'not_configured' | 'connected' | 'auth_failed' | 'rate_limited' | 'unavailable' | 'config_invalid' | 'budget_exhausted';

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
  // budget_exhausted: a fallback scraper would not make the budget come back,
  // and paying a second vendor to cover a spent first one is a decision, not a retry.
  if (['auth_failed', 'rate_limited', 'not_configured', 'config_invalid', 'budget_exhausted'].includes(input.primaryHealth)) {
    return { eligible: false, reason: `no_fallback_on_${input.primaryHealth}` };
  }
  if (input.primaryHealth === 'unavailable' && input.attemptsExhausted) {
    return { eligible: true, reason: 'outage_after_retries' };
  }
  return { eligible: false, reason: 'retries_not_exhausted' };
}
