/**
 * Exemplar retrieval — relevance-based competitor examples for the writer.
 *
 * Vector path: build a query text from the brief + facts + recipe, embed it
 * (role embed_text via Modal bge-m3), call RPC mkt_script_exemplars (filters +
 * cosine in SQL), then in TS: boosts → MMR (λ 0.7) with shingle diversity →
 * per-org cap (2) → near-duplicate drop (5-gram overlap > 60%) → 8–12 rows.
 *
 * Lexical fallback (LOUD — console.error + brief warning): when the embedding
 * store is empty or Modal is unreachable, score recent transcripts by token
 * overlap with the same boosts + diversity. Never the old "12 longest".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normAr, tokenizeAr } from './entities.js';
import type { Brief, EmbedFn, Exemplar, ExemplarRow, FactsPackage, RecipeRow } from './types.js';

export const MMR_LAMBDA = 0.7;
export const MAX_PER_ORG = 2;
export const MIN_EXEMPLARS = 8;
export const MAX_EXEMPLARS = 12;
export const TRANSCRIPT_MAX_CHARS = 700;
const DUP_5GRAM_OVERLAP = 0.6;
const RPC_LIMIT = 48;
const LEXICAL_SCAN = 400;

export interface RetrievalResult {
  exemplars: Exemplar[];
  warnings: string[];
  mode: 'vector' | 'lexical';
  embedding?: { model: string; version: string; dim: number };
  query_text: string;
}

function toStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ordered transcript from segments (start_ms asc), capped at TRANSCRIPT_MAX_CHARS. */
export function orderedTranscript(segments: unknown, fallbackText: string | null): string {
  let text = '';
  if (Array.isArray(segments) && segments.length > 0) {
    const segs = segments
      .filter((s): s is { start_ms?: unknown; text?: unknown } => !!s && typeof s === 'object')
      .map((s) => ({ start: toNum(s.start_ms) ?? 0, text: typeof s.text === 'string' ? s.text.trim() : '' }))
      .filter((s) => s.text)
      .sort((a, b) => a.start - b.start);
    text = segs.map((s) => s.text).join(' ');
  }
  if (!text) text = (fallbackText ?? '').trim();
  text = text.replace(/\s+/g, ' ');
  return text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_MAX_CHARS).replace(/\s\S*$/, '')} …` : text;
}

/** Query text for the embedding — what a "good exemplar" would talk about. */
export function buildQueryText(brief: Brief, facts: FactsPackage, recipe: RecipeRow): string {
  const unitTypes = facts.facts.filter((f) => f.class === 'unit_type').map((f) => f.rendered_ar);
  const loc = facts.facts.find((f) => f.class === 'location')?.rendered_ar ?? '';
  const readiness = facts.readiness === 'off_plan' ? 'مشروع على الخارطة تحت الإنشاء' : facts.readiness === 'ready' ? 'وحدات جاهزة للسكن استلام فوري' : '';
  const features = facts.facts.filter((f) => f.class === 'feature').slice(0, 6).map((f) => f.rendered_ar);
  return [
    `إعلان فيديو عقاري: ${recipe.label_ar}. ${recipe.guidance}`,
    brief.objective ? `الهدف: ${brief.objective}` : '',
    brief.audience ? `الجمهور: ${brief.audience}` : '',
    brief.core_message ? `الرسالة: ${brief.core_message}` : '',
    brief.campaign?.offer ? `العرض: ${brief.campaign.offer}` : '',
    unitTypes.length ? `أنواع الوحدات: ${unitTypes.join('، ')}` : '',
    loc ? `الموقع: ${loc}` : '',
    readiness,
    features.length ? `المزايا: ${features.join('، ')}` : '',
  ].filter(Boolean).join('\n');
}

// ── scoring helpers ──────────────────────────────────────────────────────────
function shingles(tokens: string[], n: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) s.add(tokens.slice(i, i + n).join(' '));
  return s;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
/** Fraction of A's n-grams that also appear in B (asymmetric containment). */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / a.size;
}

interface Candidate {
  row: ExemplarRow;
  transcript: string;
  tokens: string[];
  tri: Set<string>;
  five: Set<string>;
  base: number;   // similarity (vector) or lexical score in [0,1]
  score: number;  // base + boosts
  readiness: 'off_plan' | 'ready' | null;
}

function inferReadiness(text: string): 'off_plan' | 'ready' | null {
  const n = normAr(text);
  const off = /علي الخارطه|تحت الانشاء|قيد الانشاء|تسليم\s+\d|off.?plan/.test(n);
  const ready = /جاهز|استلام فوري|تستلم اليوم|ready to move|جاهزه/.test(n);
  if (off && !ready) return 'off_plan';
  if (ready && !off) return 'ready';
  return null;
}

export interface BoostContext {
  platforms: string[];
  language: 'ar' | 'en';
  unitTypes: string[];   // normalised Arabic labels
  district: string | null;
  readiness: FactsPackage['readiness'];
  wantOffer: boolean;
}

export function boostFor(row: ExemplarRow, transcript: string, ctx: BoostContext): number {
  let b = 0;
  if (row.platform && ctx.platforms.includes(row.platform)) b += 0.05;
  if (row.language === ctx.language) b += 0.05;
  const rowTypes = toStrArr(row.unit_types).map(normAr);
  if (rowTypes.length && ctx.unitTypes.some((t) => rowTypes.some((r) => r.includes(t) || t.includes(r)))) b += 0.08;
  if (ctx.district && row.district && normAr(row.district) === normAr(ctx.district)) b += 0.08;
  const r = inferReadiness(transcript);
  if (r && r === ctx.readiness) b += 0.06;
  if (ctx.wantOffer && row.offer) b += 0.08;
  const views = toNum(row.views);
  if (views !== null && views > 0) b += 0.04 * Math.min(1, Math.log10(views + 1) / 7);
  return b;
}

function toCandidate(row: ExemplarRow, base: number, ctx: BoostContext): Candidate | null {
  const transcript = orderedTranscript(row.transcript_segments, row.transcript_text);
  const ocr = (row.ocr_text ?? '').trim();
  if (!transcript && !ocr) return null;
  const tokens = tokenizeAr(`${transcript} ${ocr}`);
  return {
    row, transcript, tokens, tri: shingles(tokens, 3), five: shingles(tokens, 5),
    base, score: base + boostFor(row, transcript, ctx), readiness: inferReadiness(transcript),
  };
}

/**
 * MMR (λ) with per-org cap, org-spread preference (≥3 orgs when possible) and
 * near-duplicate rejection. Pure — unit-tested with fake rows.
 */
export function selectDiverse(cands: Candidate[], max = MAX_EXEMPLARS): Candidate[] {
  const pool = [...cands].sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  const perOrg = new Map<string, number>();
  while (chosen.length < max && pool.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    const orgsSoFar = new Set(chosen.map((c) => c.row.organization_id ?? 'null'));
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const org = c.row.organization_id ?? 'null';
      if ((perOrg.get(org) ?? 0) >= MAX_PER_ORG) continue;
      const maxSim = chosen.reduce((m, s) => Math.max(m, jaccard(c.tri, s.tri)), 0);
      let val = MMR_LAMBDA * c.score - (1 - MMR_LAMBDA) * maxSim;
      if (orgsSoFar.size < 3 && orgsSoFar.has(org) && chosen.length > 0) val -= 0.1; // spread across ≥3 orgs first
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const pick = pool.splice(bestIdx, 1)[0]!;
    const dup = chosen.some((s) => containment(pick.five, s.five) > DUP_5GRAM_OVERLAP || containment(s.five, pick.five) > DUP_5GRAM_OVERLAP);
    if (dup) continue;
    chosen.push(pick);
    const org = pick.row.organization_id ?? 'null';
    perOrg.set(org, (perOrg.get(org) ?? 0) + 1);
  }
  return chosen;
}

function toExemplar(c: Candidate, i: number): Exemplar {
  const r = c.row;
  const ex: Exemplar = {
    id: `E${i + 1}`,
    content_post_id: r.content_post_id,
    organization_id: r.organization_id ?? null,
    org_name: r.org_name ?? null,
    platform: r.platform ?? null,
    content_type: r.content_type ?? null,
    language: r.language ?? null,
    views: toNum(r.views),
    similarity: Number(c.base.toFixed(4)),
    transcript: c.transcript,
    ocr: (r.ocr_text ?? '').slice(0, 300),
    campaign_message: r.campaign_message ?? null,
    selling_points: toStrArr(r.selling_points).slice(0, 8),
    score: Number(c.score.toFixed(4)),
    post_url: r.post_url ?? null,
    district: r.district ?? null,
    offer: r.offer ?? null,
    unit_types: toStrArr(r.unit_types),
  };
  return ex;
}

function boostContext(brief: Brief, facts: FactsPackage, recipe: RecipeRow): BoostContext {
  const loc = facts.facts.find((f) => f.class === 'location')?.value as { district?: string } | undefined;
  return {
    platforms: brief.platforms,
    language: brief.language,
    unitTypes: facts.facts.filter((f) => f.class === 'unit_type').map((f) => normAr(f.rendered_ar)),
    district: loc?.district ?? null,
    readiness: facts.readiness,
    wantOffer: recipe.key === 'offer' || Boolean(brief.campaign?.offer),
  };
}

/** Lexical score in [0,1]: fraction of distinct query tokens present in the text. */
export function lexicalScore(queryTokens: string[], textTokens: Set<string>): number {
  const q = Array.from(new Set(queryTokens.filter((t) => t.length >= 3)));
  if (q.length === 0) return 0;
  let hit = 0;
  for (const t of q) if (textTokens.has(t)) hit += 1;
  return hit / q.length;
}

interface LexicalTranscriptRow {
  content_post_id: string;
  text: string | null;
  segments: unknown;
  language: string | null;
  mkt_content_posts: {
    organization_id: string | null; platform: string | null; post_type: string | null; engagement: Record<string, unknown> | null;
    published_at: string | null; post_url: string | null; mkt_organizations: { name_ar: string | null } | null;
  } | null;
}

async function lexicalCandidates(sb: SupabaseClient, queryText: string, recipe: RecipeRow, brief: Brief, ctx: BoostContext): Promise<Candidate[]> {
  const t = await sb
    .from('mkt_transcripts')
    .select('content_post_id, text, segments, language, mkt_content_posts!inner(organization_id, platform, post_type, engagement, published_at, post_url, mkt_organizations(name_ar))')
    .eq('status', 'done')
    .in('mkt_content_posts.post_type', ['video', 'reel', 'short'])
    .order('created_at', { ascending: false })
    .limit(LEXICAL_SCAN);
  if (t.error) throw new Error(`lexical transcripts read failed: ${t.error.message}`);
  const rows = (t.data ?? []) as unknown as LexicalTranscriptRow[];
  const ids = rows.map((r) => r.content_post_id);
  const enrichment = new Map<string, Record<string, unknown>>();
  // Chunk the id filter: a single `.in()` over LEXICAL_SCAN (400) uuids builds a
  // ~15KB GET URL that undici rejects as "fetch failed". 100/req stays well under.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const e = await sb.from('mkt_content_enrichment').select('content_post_id, result').eq('status', 'done').in('content_post_id', chunk);
    if (e.error) throw new Error(`lexical enrichment read failed: ${e.error.message}`);
    for (const r of (e.data ?? []) as Array<{ content_post_id: string; result: Record<string, unknown> | null }>) enrichment.set(r.content_post_id, r.result ?? {});
  }
  const qTokens = tokenizeAr(queryText);
  const wantTypes = new Set(recipe.retrieval_content_types);
  const out: Candidate[] = [];
  const seenPost = new Set<string>();
  for (const r of rows) {
    if (seenPost.has(r.content_post_id)) continue;
    const en = enrichment.get(r.content_post_id) ?? {};
    const ctype = typeof en.content_type === 'string' ? en.content_type : null;
    if (wantTypes.size && (!ctype || !wantTypes.has(ctype))) continue;
    if (en.is_general_branding === true) continue;
    const lang = (typeof en.language === 'string' ? en.language : r.language) ?? null;
    if (lang && lang !== brief.language && lang !== 'mixed') continue;
    const post = r.mkt_content_posts;
    if (post?.platform && brief.platforms.length && !brief.platforms.includes(post.platform)) continue;
    if (!r.text || r.text.length <= 80) continue;
    seenPost.add(r.content_post_id);
    const row: ExemplarRow = {
      content_post_id: r.content_post_id, organization_id: post?.organization_id ?? null, org_name: post?.mkt_organizations?.name_ar ?? null,
      platform: post?.platform ?? null, post_type: post?.post_type ?? null, content_type: ctype, language: lang,
      views: toNum(post?.engagement?.views), similarity: null, transcript_text: r.text, transcript_segments: r.segments, ocr_text: null,
      campaign_message: typeof en.campaign_message === 'string' ? en.campaign_message : null, selling_points: en.selling_points ?? null,
      offer: typeof en.offer === 'string' ? en.offer : null, unit_types: en.unit_types ?? null, district: typeof en.district === 'string' ? en.district : null,
      published_at: post?.published_at ?? null, post_url: post?.post_url ?? null,
    };
    const transcript = orderedTranscript(row.transcript_segments, row.transcript_text);
    const tokens = tokenizeAr(transcript);
    const base = lexicalScore(qTokens, new Set(tokens));
    const c = toCandidate(row, base, ctx);
    if (c) out.push(c);
  }
  return out;
}

export interface RetrieveDeps { sb: SupabaseClient; embed: EmbedFn | null }

export async function retrieveExemplars(
  deps: RetrieveDeps,
  brief: Brief,
  facts: FactsPackage,
  recipe: RecipeRow,
  opts: { excludeOrgId?: string | null } = {},
): Promise<RetrievalResult> {
  const queryText = buildQueryText(brief, facts, recipe);
  const ctx = boostContext(brief, facts, recipe);
  const warnings: string[] = [];
  let candidates: Candidate[] | null = null;
  let embedding: RetrievalResult['embedding'];

  if (deps.embed) {
    // Empty store → fall back BEFORE spending an embedding call.
    const cnt = await deps.sb.from('mkt_content_embeddings').select('content_post_id', { count: 'exact', head: true });
    if (cnt.error) throw new Error(`embeddings count failed: ${cnt.error.message}`);
    if ((cnt.count ?? 0) === 0) {
      const w = 'mkt_content_embeddings is EMPTY — exemplar retrieval fell back to the lexical path (run the embedding backfill)';
      console.error(`[script] ${w}`);
      warnings.push(w);
    } else {
      try {
        const e = await deps.embed('embed_text', { texts: [queryText] });
        const vec = e.vectors[0];
        if (!vec || vec.length !== 1024) throw new Error(`embed_text returned dim ${vec?.length ?? 0}, expected 1024`);
        embedding = { model: e.model, version: e.version, dim: e.dim };
        const { data, error } = await deps.sb.rpc('mkt_script_exemplars', {
          p_query: JSON.stringify(vec),
          p_content_types: recipe.retrieval_content_types,
          p_platforms: brief.platforms,
          p_language: brief.language,
          p_exclude_org: opts.excludeOrgId ?? null,
          p_limit: RPC_LIMIT,
        });
        if (error) throw new Error(`mkt_script_exemplars failed: ${error.message}`);
        const rows = (data ?? []) as ExemplarRow[];
        candidates = rows.map((r) => toCandidate(r, toNum(r.similarity) ?? 0, ctx)).filter((c): c is Candidate => c !== null);
        if (candidates.length === 0) {
          const w = `vector retrieval returned 0 candidates for content types [${recipe.retrieval_content_types.join(',')}] / platforms [${brief.platforms.join(',')}] — lexical fallback`;
          console.error(`[script] ${w}`);
          warnings.push(w);
          candidates = null;
        }
      } catch (err) {
        // Modal unreachable / RPC failure: loud, then degrade. Never silent.
        const msg = err instanceof Error ? err.message : String(err);
        const w = `vector retrieval unavailable (${msg}) — lexical fallback`;
        console.error(`[script] ${w}`);
        warnings.push(w);
        candidates = null;
        embedding = undefined;
      }
    }
  } else {
    const w = 'no embed function bound — lexical exemplar retrieval';
    console.error(`[script] ${w}`);
    warnings.push(w);
  }

  let mode: RetrievalResult['mode'] = 'vector';
  if (!candidates) {
    mode = 'lexical';
    candidates = await lexicalCandidates(deps.sb, queryText, recipe, brief, ctx);
    if (candidates.length === 0 && recipe.retrieval_content_types.length) {
      // widen: any content type
      candidates = await lexicalCandidates(deps.sb, queryText, { ...recipe, retrieval_content_types: [] }, brief, ctx);
      if (candidates.length) warnings.push('no transcripts matched the recipe content types — widened to all content types');
    }
  }

  const chosen = selectDiverse(candidates, MAX_EXEMPLARS);
  if (chosen.length < MIN_EXEMPLARS) warnings.push(`only ${chosen.length} diverse exemplars available (target ${MIN_EXEMPLARS}–${MAX_EXEMPLARS})`);
  const orgs = new Set(chosen.map((c) => c.row.organization_id ?? 'null'));
  if (chosen.length >= 3 && orgs.size < 3) warnings.push(`exemplars span only ${orgs.size} organisation(s)`);
  const result: RetrievalResult = { exemplars: chosen.map(toExemplar), warnings, mode, query_text: queryText };
  if (embedding) result.embedding = embedding;
  return result;
}

export type { Candidate as RetrievalCandidate };
export function candidateFromRow(row: ExemplarRow, base: number, ctx: BoostContext): Candidate | null {
  return toCandidate(row, base, ctx);
}
