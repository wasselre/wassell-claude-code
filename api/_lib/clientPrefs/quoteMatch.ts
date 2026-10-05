/**
 * "Did the CUSTOMER say this?" — deterministic quote matching against the
 * customer's own turns of a conversation. PURE (no IO).
 *
 * Shared by the call audit's preference guard (`callAudit.ts`, a suggestion's
 * quote) and the geography CALL SPEAKER GUARD (`geoPreference/companyRules.ts`,
 * a mention's `mention_span`). It lives in its own module so the geography
 * pipeline can use it without importing the call audit (which imports the
 * geography pipeline — a cycle).
 */

import type { Conversation } from '../geoPreference/extractor.js';

/** Fold a quote / transcript for matching: diacritics, tatweel, alef forms,
 *  ta marbuta, alef maqsura, punctuation and hesitation dashes all drop out. */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * PURE — was this quote said by the CUSTOMER? Every fragment of the quote
 * (split on «...» / «…» / « / » / « | »; bracketed editor notes like «[العميل لم ينفِ]»
 * removed) must appear in the customer's own turns. The prompt already asks for
 * the customer's words, but measured 2026-09-29 the model still quoted the
 * salesperson in 3 of 14 audit suggestions («أنتِ تبحثين عن شقة…», «أبديت
 * اهتمامك تملك وحدة…») — this deterministic check is what makes "the customer
 * said it" true. A suggestion with no quote fails (nothing to verify).
 */
export function customerSaidIt(conversation: Conversation, quote: string | null): boolean {
  if (!quote) return false;
  const customerText = ` ${normalizeForQuote(conversation.turns.filter((t) => t.speaker === 'client').map((t) => t.text).join(' '))} `;
  const fragments = quote
    .replace(/\[[^\]]*\]/g, ' ')
    // «…» / «...» between fragments; « / » or « | » when the reader joins what the
    // customer said in two messages («ميزانيتي حدود مليون ونص / المهم ما تتعدى ٣
    // مليون» — dropped as unverified in the live test 2026-10-05). Every part
    // must still be the customer's own words.
    .split(/\.{2,}|…|\s[\/|]\s/)
    .map(normalizeForQuote)
    .filter((f) => f.length >= 2);
  if (fragments.length === 0) return false;
  return fragments.every((f) => customerText.includes(` ${f} `) || customerText.includes(f));
}
