/**
 * District names typed in LATIN letters («Malga», «Yasmeen», «Narjes»).
 *
 * Every district row carries an English name («Al Malqa Dist.», «An Narjis»),
 * but two things kept a Latin span from ever matching it (calib-003, 2026-09-27:
 * «Malga» stayed unresolved twice while «Yasmin» happened to hit):
 *   1. candidate generation is a byte-wise ILIKE, so «Malga» never reaches
 *      «Al Malqa» — ق is written q OR g depending on who is typing;
 *   2. the exact-selection gate compares the Arabic-folded key, and «malga» ≠
 *      «al malqa».
 *
 * `latinVariants` widens the ILIKE net (q↔g, k→q, ee↔i, oo↔u); `latinKey` is
 * the EXACT key for selection: article stripped (Al / An / Ar … — the sun-letter
 * assimilated forms too), «Dist.» suffix dropped, non-letters removed, and a
 * small transliteration fold (ق/g/k → k, ee → i, e → i, oo/ou/o → u, doubled
 * letters collapsed). It is still an exact key — HARD RULE 1 of the resolver
 * (no fuzzy pick) holds; two different districts only collide if their English
 * spellings differ by nothing but these folds, which the fixture set does not.
 */

/** True when the text is Latin script (and carries no Arabic letters). */
export function isLatinToken(s: string): boolean {
  const t = String(s ?? '');
  return /[A-Za-z]/.test(t) && !/[؀-ۿ]/.test(t);
}

const ARTICLE = /^(?:al|el|an|ar|as|ad|ash|ath|adh|az|at)(?:[\s-]+|(?=[A-Z]))/i;

/** Exact-comparison key for a Latin district name / span. Empty for non-Latin input. */
export function latinKey(s: string): string {
  const raw = String(s ?? '').trim();
  if (!isLatinToken(raw)) return '';
  let t = raw
    .replace(/\s*(?:dist\.?|district)\s*$/i, '')
    .trim()
    .replace(ARTICLE, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  t = t
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/ou/g, 'u')
    .replace(/e/g, 'i')
    .replace(/o/g, 'u')
    .replace(/[qg]/g, 'k')
    .replace(/(.)\1+/g, '$1');
  return t;
}

/** Spelling variants of a Latin token so the ILIKE candidate stage can reach the
 *  official English name. Over-generating is safe — selection stays exact. */
export function latinVariants(token: string): string[] {
  const base = String(token ?? '').trim().replace(/\s+/g, ' ');
  if (!base || !isLatinToken(base)) return [];
  const out = new Set<string>([base]);
  const folds: Array<(s: string) => string> = [
    (s) => s.replace(/g/gi, 'q'),
    (s) => s.replace(/q/gi, 'g'),
    (s) => s.replace(/k/gi, 'q'),
    (s) => s.replace(/ee/gi, 'i'),
    (s) => s.replace(/i/gi, 'ee'),
    (s) => s.replace(/oo/gi, 'u'),
    (s) => s.replace(/u/gi, 'oo'),
  ];
  for (const f of folds) for (const s of Array.from(out)) out.add(f(s));
  for (const s of Array.from(out)) {
    const stripped = s.replace(ARTICLE, '');
    if (stripped !== s && stripped.length >= 3) out.add(stripped);
  }
  return Array.from(out).filter((v) => v.length >= 3).slice(0, 16);
}
