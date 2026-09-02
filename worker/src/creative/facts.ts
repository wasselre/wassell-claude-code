/**
 * Creative facts — the Post Creative Director's view of the sibling facts
 * pipeline (worker/src/marketing/script/facts.ts, REUSED, never edited).
 *
 * `loadCreativeFacts` reads one all_projects record, resolves the developer
 * name (from `record.developer` unless the caller passes one), builds the
 * FactsPackage with the sibling `buildFactsPackage`, and renders the prompt
 * catalog the director prompts cite (`F1 · key · rendered (source) [flag]`).
 *
 * Numbers policy (contracts §0 rule 3): any fact with `claimable=true` may be
 * used anywhere (headlines, design text, captions, ad copy) as long as the
 * field's `fact_refs` cites its Fact id. Non-claimable facts are context-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFactsPackage, loadProjectRecord, resolveLookupName } from '../marketing/script/facts.js';
import type { Fact, FactsPackage } from '../marketing/script/types.js';
import type { FactRef } from './contracts.js';

export type NumeralStyle = 'arabic_indic' | 'western';

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Convert every Western digit in `n` to an Arabic-Indic digit (١٢٣…). */
export function toArabicIndic(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => ARABIC_INDIC_DIGITS[Number(d)] ?? d);
}

/**
 * Render a fact for display in the requested numeral style. Facts are stored
 * with Western digits (fmtNum is en-US); on-screen Arabic design usually wants
 * Arabic-Indic numerals — this is the ONE place that conversion happens.
 */
export function renderFactAr(fact: Pick<Fact, 'rendered_ar'>, opts: { numerals: NumeralStyle }): string {
  return opts.numerals === 'arabic_indic' ? toArabicIndic(fact.rendered_ar) : fact.rendered_ar;
}

/** One catalog line, e.g. `F1 · price_from · تبدأ من 1,050,000 ر.س (available_price_range.min) [claimable]`. */
export function catalogLine(fact: Fact, opts: { numerals?: NumeralStyle } = {}): string {
  const rendered = renderFactAr(fact, { numerals: opts.numerals ?? 'western' });
  const flag = fact.claimable ? 'claimable' : 'context-only';
  const note = fact.note ? ` — ${fact.note}` : '';
  return `${fact.id} · ${fact.key} · ${rendered} (${fact.source_field}) [${flag}]${note}`;
}

/** The full prompt catalog, one line per fact, in package order (F1..). */
export function factsCatalog(facts: Fact[], opts: { numerals?: NumeralStyle } = {}): string {
  return facts.map((f) => catalogLine(f, opts)).join('\n');
}

export interface CreativeFacts {
  package: FactsPackage;
  /** Prompt-ready catalog — one `F# · key · rendered (source) [flag]` line per fact. */
  catalog: string;
  /** The citable subset of fact metadata (what a field's fact_refs references). */
  refs: FactRef[];
}

/**
 * Load + package the facts for one project. Throws `facts_insufficient:` when
 * the record does not exist (loud, stable prefix — contracts §0 rule 15).
 *
 * `opts.developerName`: pass an explicit name to skip the lookup (tests,
 * caller already resolved it); pass nothing to resolve `record.developer`
 * (uuid → unified_records name, inline text → as-is).
 */
export async function loadCreativeFacts(
  sb: SupabaseClient,
  projectId: string,
  opts: { developerName?: string | null } = {},
): Promise<CreativeFacts> {
  const record = await loadProjectRecord(sb, projectId);
  if (!record) throw new Error(`facts_insufficient: project ${projectId} not found in all_projects`);
  const developerName = opts.developerName !== undefined
    ? opts.developerName
    : await resolveLookupName(sb, record.developer);
  const pkg = buildFactsPackage(record, { developerName });
  const refs: FactRef[] = pkg.facts.map((f) => ({
    id: f.id,
    key: f.key,
    rendered_ar: f.rendered_ar,
    source_field: f.source_field,
    claimable: f.claimable,
  }));
  return { package: pkg, catalog: factsCatalog(pkg.facts), refs };
}
