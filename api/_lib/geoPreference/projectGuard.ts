/**
 * Project-name guard — OUR project names are not places.
 *
 * calib-003 (graded 2026-09-27): 6 of the 8 mentions the operator marked wrong
 * were project names the extractor had read as map anchors — «مينا 52» and
 * «مشروع مينا 52» became a `pin`, and «الشقه هذي» was pinned to «الماجدية 163».
 * The extractor had no idea what our projects are called, and a project name
 * looks exactly like a place name.
 *
 * The guard has two halves, both fed by the SAME list of project "heads":
 *   • the PROMPT names the project heads that occur in this conversation, so the
 *     model records them as project interest rather than geography;
 *   • the PARSER drops any anchor whose span is one of those heads, so a slip by
 *     the model cannot reach the resolver. Belt and braces, deterministic.
 *
 * What a "head" is: the project name before its qualifier — «مينا 52 - النرجس»
 * → «مينا 52», «الماجدية فيلج (Al Majdiah Village)» → «الماجدية فيلج». Digits are
 * folded to ASCII, a leading «مشروع» dropped, the whole thing normalized like an
 * anchor token.
 *
 * THE TRAP this file exists to avoid: 106 of our ~1,000 project names are a
 * single word, and some of those ARE district names («الفلاح», «الضواحي»). A
 * naive "drop anything that matches a project name" would erase real district
 * mentions. So `deriveProjectHeads` removes every head whose place key equals a
 * district name, and `isProjectMention` only does substring matching for STRONG
 * heads (two or more tokens, or a digit) — a single-word head must equal the
 * whole span.
 */

const AR_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** One normalization for names, heads and spans: ASCII digits, Arabic folds
 *  (أإآ→ا, ة→ه, ى→ي, no tatweel), no leading «حي»/«مشروع», lower-case, one space. */
export function normalizeProjectText(s: string): string {
  return String(s ?? '')
    .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] ?? d)
    .replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // harakat
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:مشروع|حي)\s+/, '')
    .trim();
}

/** The place key used to test a head against district names: normalized, no
 *  leading «ال» — the same article-insensitive idea as the resolver's placeKey. */
export function projectPlaceKey(s: string): string {
  return normalizeProjectText(s).replace(/^ال(?=\S)/, '');
}

/** «مينا 52 - النرجس» → «مينا 52». Empty when the name is not a usable head
 *  (a URL, a code shorter than 3 characters). */
export function projectHead(name: string): string {
  const raw = String(name ?? '').trim();
  if (!raw || /https?:\/\/|www\./i.test(raw)) return '';
  const cut = raw.split(/\s+[-–—|/]\s+|[()\[\]|_\n]/)[0] ?? '';
  const head = normalizeProjectText(cut);
  // Three real characters, spaces not counted — «م ش» is a code fragment, not a name.
  return head.replace(/\s/g, '').length >= 3 ? head : '';
}

/**
 * Unique project heads that are SAFE to treat as "not a place": every head
 * whose place key equals a district name is dropped, because for that word the
 * district reading must win («الفلاح» is a district before it is our project).
 */
export function deriveProjectHeads(projectNames: string[], districtNames: string[]): string[] {
  const districtKeys = new Set(districtNames.map(projectPlaceKey).filter(Boolean));
  const out = new Set<string>();
  for (const n of projectNames) {
    const h = projectHead(n);
    if (!h) continue;
    if (districtKeys.has(projectPlaceKey(h))) continue;
    out.add(h);
  }
  return Array.from(out).sort();
}

/** A head is STRONG when it cannot be an accidental substring: it has a digit or
 *  more than one token. Weak (single-word) heads must equal the whole span. */
function isStrongHead(head: string): boolean {
  return /\d/.test(head) || head.includes(' ');
}

/** Does this anchor span / mention span name one of our projects? */
export function isProjectMention(span: string, heads: readonly string[]): boolean {
  const s = normalizeProjectText(span);
  if (!s) return false;
  for (const h of heads) {
    if (s === h) return true;
    if (!isStrongHead(h)) continue;
    if (s.includes(h)) return true;
    // «مينا 52» said for the project «مينا 52 برج الياسمين»: the span is a
    // multi-token / numbered prefix of the head.
    if (isStrongHead(s) && h.startsWith(s)) return true;
  }
  return false;
}

/** The heads that occur in a conversation's text — what the prompt lists. */
export function projectMentionsIn(text: string, heads: readonly string[]): string[] {
  const t = normalizeProjectText(text);
  if (!t) return [];
  const tokens = new Set(t.split(' '));
  return heads.filter((h) => (isStrongHead(h) ? t.includes(h) : tokens.has(h)));
}
