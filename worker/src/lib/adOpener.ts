/**
 * COPY of `isAdOpenerTemplate` in api/_lib/clientPrefs/keywordGate.ts (the worker
 * is a standalone package and cannot import api/). Change BOTH together.
 *
 * The ad's prefilled opener buttons — «مهتم بمشروع يمام 17» and «مهتم بمشاريع
 * سكنية اخرى في شمال الرياض» — are the AD's words, not the customer's: read as
 * the customer's they made «أكنان 25» a client's main project only because the
 * ad was for it (2026-10-04).
 */
function normalize(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(.)\1{2,}/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
const AD_REPLY_RE = /^مهتم بمشروع(?: [^ ]+){1,4}$/;
const AD_OTHER_PROJECTS_RE = /^مهتم بمشاريع سكنيه اخري في (?:شمال|شرق|غرب|جنوب|وسط) الرياض$/;

export function isAdOpenerTemplate(body: string | null | undefined): boolean {
  if (!body) return false;
  const n = normalize(body);
  return AD_REPLY_RE.test(n) || AD_OTHER_PROJECTS_RE.test(n);
}
