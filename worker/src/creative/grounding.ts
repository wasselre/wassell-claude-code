/**
 * Grounding validators — contracts §8. PURE module (no I/O, no network):
 * every check is deterministic and unit-tested. Three entry points, one per
 * generation stage:
 *
 *   validateConcepts     — stage 1 (concept cards)
 *   validateBase         — stage 2 (the base creative package)
 *   validateDerivatives  — stage 3 (per-target derivatives)
 *
 * All three return { ok, errors, warnings }; `buildViolationFeedback` renders
 * the errors as a bilingual bullet list for the orchestrator's one retry
 * prompt. Unresolved errors → the package is saved with warnings + status
 * 'draft' and the job result flags needs_attention (never silently dropped).
 *
 * Claim gating REUSES the sibling script pipeline: extractMentions →
 * classifyMention → gateByClass (worker/src/marketing/script/claims.ts) and
 * the entity gate detectEntities (worker/src/marketing/script/entities.ts).
 * Numbers are allowed anywhere ONLY when a claimable fact matches AND the
 * field's fact_refs cites that fact's id (contracts §0 rule 3).
 */
import { classifyMention, extractMentions, gateByClass } from '../marketing/script/claims.js';
import { detectEntities, normAr } from '../marketing/script/entities.js';
import type { BlockEntry } from '../marketing/script/entities.js';
import type { FactsPackage } from '../marketing/script/types.js';
import type {
  AiRecommendation,
  AssetNature,
  BasePackage,
  BrandKit,
  ConceptsOutput,
  Derivative,
  DerivativeTarget,
  DerivativesOutput,
  FactRef,
  OrganicCopy,
  PaidCopy,
  UsageRights,
  WriterRules,
} from './contracts.js';
import type { PlacementSpec } from './placementSpecs.js';

// ── Result types ─────────────────────────────────────────────────────────────
export interface Violation {
  /** Dot path to the offending field, e.g. `design_text.headlines` or `derivatives.2.copy.caption`. */
  path: string;
  /** Stable machine rule key (claim_unverified, entity_phone, caption_max, …). */
  rule: string;
  /** Human-readable detail (Arabic quotes kept verbatim so the model can find the text). */
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Violation[];
  warnings: Violation[];
}

export interface AssetMetaEntry {
  rights: UsageRights | string | null;
  rights_verified: boolean;
  nature: AssetNature | string | null;
}

export interface GroundingCtx {
  facts: FactsPackage;
  refs: FactRef[];
  /** mos_content.language — strategy.language must equal it. */
  language: string;
  selectedTargets: DerivativeTarget[];
  specs: PlacementSpec[];
  brandKit: BrandKit | null;
  rules: WriterRules;
  blocklist: BlockEntry[];
  /** Terms the entity gate must NOT flag (e.g. the developer name when allowed). */
  allowedTerms: string[];
  /** Competitor media/post ids — reference-only, never selectable as assets. */
  competitorMediaIds: Set<string>;
  /** file_id → rights trust snapshot (creative_candidate_assets). */
  assetMeta: Map<string, AssetMetaEntry>;
  /** §7 image-policy gate (A-GEN policy.ts). Injected so this module stays pure. */
  policyCheck?: (rec: AiRecommendation) => { ok: boolean; reason: string };
}

// ── Constants ────────────────────────────────────────────────────────────────
/** contracts §7 ALLOWED modes — anything else is a policy violation. */
const ALLOWED_AI_MODES: ReadonlySet<string> = new Set([
  'cleanup', 'crop', 'color_correct', 'extend_background', 'remove_clutter',
  'combine', 'supporting_visual', 'remove_text', 'request_photo',
]);

/** Readiness wording (checked on the RAW text — both scripts, pre-normalisation). */
const READY_WORDS = /جاهز|استلام\s*فوري|تسليم\s*فوري/;
const OFFPLAN_WORDS = /على\s*الخارطة|على\s*المخطط|تحت\s*الإنشاء|قيد\s*الإنشاء|تحت\s*التطوير/;

/** Lines that read as prohibitions — quoted phrases inside them are banned verbatim. */
const PROHIBITIVE_LINE = /ممنوع|يُمنع|لا\s*تستخدم|لا\s*تستعمل|لا\s*تكتب|تجنّب|تجنب|يُتجنّب|محظور|تُحظر|never|avoid|prohibit|do\s*not|don't/i;

/**
 * Clause boundaries WITHIN a rule line. Rules routinely pair a PRESCRIBED phrase
 * with a PROHIBITED one across one of these ("use «A» — never «B»", "«ready» when
 * ready; never «off-plan»"). Splitting on them lets us ban only the span the
 * prohibition actually introduces. Plain hyphen-minus is deliberately EXCLUDED
 * (it appears inside words like "all-unit"/"off-plan" and inside quoted phrases).
 */
const CLAUSE_SEP = /[—–:;،؛]/;

// ── Prohibited phrases (from writer_rules) ───────────────────────────────────
/**
 * Extract the banned verbatim phrases from the rules: quoted spans («…» or
 * "…") that a prohibition marker INTRODUCES (marker to the left of the span,
 * within the same clause). This is how «بدون سعي» in «NEVER say «بدون سعي»…»
 * becomes a hard validator — WITHOUT also banning the prescribed «تبدأ من» in
 * «Use the AVAILABLE price range as the «تبدأ من» — never the all-unit range»,
 * where the quoted phrase sits in a different clause from the "never".
 */
export function prohibitedPhrases(rules: WriterRules): string[] {
  const out = new Set<string>();
  const addBanned = (clause: string): void => {
    const markerIdx = clause.search(PROHIBITIVE_LINE);
    if (markerIdx < 0) return;
    for (const m of clause.matchAll(/«([^»\n]{2,60})»/g)) if (m.index! > markerIdx) out.add(m[1]!.trim());
    for (const m of clause.matchAll(/"([^"\n]{2,60})"/g)) if (m.index! > markerIdx) out.add(m[1]!.trim());
  };
  for (const line of [...rules.shared, ...rules.post]) {
    for (const clause of line.split(CLAUSE_SEP)) addBanned(clause);
  }
  return [...out].filter((p) => normAr(p).length >= 2);
}

// ── Shared per-text checks ───────────────────────────────────────────────────
interface Scan {
  errors: Violation[];
  warnings: Violation[];
  phrases: string[];
  ctx: GroundingCtx;
}

/**
 * Fact-reference codes (F1, F12, ranges like F8-F11 or F30-F39) are the internal
 * citation handles the facts pack presents to the model — never customer claims.
 * They must be stripped before claim extraction, or their digits (8, 11, 30…) get
 * read as unverified price/area numbers (a validator false-positive seen live on
 * أكنان 25: «5/7/8/11» flagged, all from F-codes the model wrote in its rationale).
 */
const FACT_CODE = /\bF\d+(?:\s*[-–]\s*F?\d+)?\b/g;

/** Claim gate: every numeric mention must resolve to a claimable fact AND be cited. */
function gateClaims(text: string, factRefs: string[], path: string, s: Scan, opts: { requireCitation: boolean }): void {
  const cited = Array.isArray(factRefs) ? factRefs : []; // never throw on a malformed fact_refs
  const items = extractMentions(text.replace(FACT_CODE, ' ')).map((m) => ({ scene: 0, field: 'voiceover' as const, mention: classifyMention(m) }));
  if (items.length === 0) return;
  const verdicts = gateByClass(items, s.ctx.facts.facts, { forbidden_claim_classes: [] });
  for (const v of verdicts) {
    if (v.verdict === 'fail') {
      s.errors.push({ path, rule: 'claim_unverified', detail: `«${v.mention}» (${v.class}): ${v.reason}` });
    } else if (v.verdict === 'review') {
      s.warnings.push({ path, rule: 'claim_review', detail: `«${v.mention}» (${v.class}): ${v.reason}` });
    } else if (opts.requireCitation && v.fact_id && !cited.includes(v.fact_id)) {
      s.errors.push({
        path,
        rule: 'fact_ref_missing',
        detail: `«${v.mention}» matches ${v.fact_id} but ${v.fact_id} is not cited in this field's fact_refs`,
      });
    }
  }
}

/** fact_refs entries must be real fact ids; citing a context-only fact is a warning. */
function checkFactRefs(factRefs: string[], path: string, s: Scan): void {
  const known = new Map(s.ctx.refs.map((r) => [r.id, r]));
  for (const id of Array.isArray(factRefs) ? factRefs : []) {
    const ref = known.get(id);
    if (!ref) s.errors.push({ path, rule: 'fact_ref_unknown', detail: `fact_refs cites unknown fact id '${id}'` });
    else if (!ref.claimable) {
      s.warnings.push({ path, rule: 'fact_ref_not_claimable', detail: `fact_refs cites ${id}, which is context-only (not claimable as a number)` });
    }
  }
}

/** Entity gate: blocklisted names + regex contact channels (phones, URLs, handles, licences). */
function scanEntities(text: string, path: string, s: Scan): void {
  const hits = detectEntities(
    [{ order: 0, voiceover: text, on_screen_text: '', visual: '' }],
    s.ctx.blocklist,
    { allowedTerms: s.ctx.allowedTerms },
  );
  for (const h of hits) {
    s.errors.push({ path, rule: `entity_${h.kind}`, detail: `«${h.mention}» (${h.kind}) must never appear in our copy` });
  }
}

/** Prohibited verbatim phrases from writer_rules (e.g. «بدون سعي»). */
function scanProhibited(text: string, path: string, s: Scan): void {
  if (s.phrases.length === 0) return;
  const n = normAr(text);
  for (const p of s.phrases) {
    if (n.includes(normAr(p))) {
      s.errors.push({ path, rule: 'prohibited_phrase', detail: `«${p}» is prohibited by writer_rules` });
    }
  }
}

/** Readiness wording must agree with facts.package.readiness. */
function scanReadiness(text: string, path: string, s: Scan): void {
  const readiness = s.ctx.facts.readiness;
  if (readiness === 'ready' && OFFPLAN_WORDS.test(text)) {
    s.errors.push({ path, rule: 'readiness_mismatch', detail: 'facts say the project is READY but the copy says off-plan / under construction' });
  } else if (readiness === 'off_plan' && READY_WORDS.test(text)) {
    s.errors.push({ path, rule: 'readiness_mismatch', detail: 'facts say the project is OFF-PLAN but the copy says ready / immediate handover' });
  }
}

/** The full battery for one copy field. `factRefs=null` disables the citation requirement (concepts). */
function checkCopy(text: string, factRefs: string[] | null, path: string, s: Scan): void {
  if (!text || !text.trim()) return;
  gateClaims(text, factRefs ?? [], path, s, { requireCitation: factRefs !== null });
  scanEntities(text, path, s);
  scanProhibited(text, path, s);
  scanReadiness(text, path, s);
}

function mkScan(ctx: GroundingCtx): Scan {
  return { errors: [], warnings: [], phrases: prohibitedPhrases(ctx.rules), ctx };
}

function result(s: Scan): ValidationResult {
  return { ok: s.errors.length === 0, errors: s.errors, warnings: s.warnings };
}

// ── Stage 1: concepts ────────────────────────────────────────────────────────
export function validateConcepts(out: ConceptsOutput, ctx: GroundingCtx): ValidationResult {
  const s = mkScan(ctx);
  // NEVER throw (contracts §8): a malformed model output (concepts not an array)
  // must become a clean concept_count error → needs_attention, not a job crash.
  // `?? []` does NOT catch a non-array truthy value, so normalise explicitly.
  const concepts = Array.isArray(out.concepts) ? out.concepts : [];
  if (concepts.length < 2 || concepts.length > 3) {
    s.errors.push({ path: 'concepts', rule: 'concept_count', detail: `expected 2–3 concepts, got ${Array.isArray(out.concepts) ? out.concepts.length : 'none (concepts is not an array)'}` });
  }
  const ids = new Set(concepts.map((c) => c.id));
  if (out.recommended && !ids.has(out.recommended)) {
    s.warnings.push({ path: 'recommended', rule: 'recommended_unknown', detail: `recommended concept '${out.recommended}' is not one of the concept ids` });
  }
  for (const c of concepts) {
    const path = `concepts.${c.id}`;
    // Gate only the CUSTOMER-FACING concept copy — the concept title and the
    // one-line design idea (what actually reaches the design). `angle` and `why`
    // are internal rationale shown to the reviewer but never published, and they
    // legitimately cite fact codes (F5, F8-F11) and quote rule phrases — gating
    // them produced false claim/prohibited flags with no bearing on the output.
    // Concepts carry no fact_refs — numbers are gated but the citation rule
    // applies only from the base package onward. Hard claim failures still error.
    checkCopy(`${c.title}\n${c.one_line_design_idea}`, null, path, s);
  }
  return result(s);
}

// ── Stage 2: base package ────────────────────────────────────────────────────
export function validateBase(base: BasePackage, ctx: GroundingCtx): ValidationResult {
  const s = mkScan(ctx);
  // NEVER throw (contracts §8): the model can hand back a non-array where the
  // schema asks for one. Spreading / iterating that would crash the whole job
  // instead of degrading to a validation error — normalise the model-supplied
  // arrays we spread or iterate below.
  const headlines = Array.isArray(base.design_text.headlines) ? base.design_text.headlines : [];
  const slides = Array.isArray(base.slides) ? base.slides : [];

  // Language = the record's language (contracts §0 rule 5).
  if (base.strategy.language !== ctx.language) {
    s.errors.push({
      path: 'strategy.language',
      rule: 'language_mismatch',
      detail: `strategy.language is '${base.strategy.language}' but the content record is '${ctx.language}' — no automatic second language`,
    });
  }

  // design_text.project_name_lead = the project name (or its known Latin form).
  const lead = base.design_text.project_name_lead?.trim() ?? '';
  const projectName = ctx.facts.project_name;
  const latin = base.design_text.latin_name?.trim() ?? '';
  const leadOk = lead.length > 0
    && (normAr(lead) === normAr(projectName) || (latin.length > 0 && normAr(lead) === normAr(latin)));
  if (!leadOk) {
    s.errors.push({
      path: 'design_text.project_name_lead',
      rule: 'project_name_lead',
      detail: lead.length === 0
        ? 'project_name_lead is empty — the project name must lead the design'
        : `project_name_lead «${lead}» does not equal the project name «${projectName}»${latin ? ` or its Latin «${latin}»` : ''}`,
    });
  }

  // Headline counts: single 1–4; carousel cover 1–3 + a headline on every slide.
  const format = base.strategy.format;
  const headlineCount = headlines.length;
  if (format === 'single') {
    if (headlineCount < 1 || headlineCount > 4) {
      s.errors.push({ path: 'design_text.headlines', rule: 'headline_count', detail: `a single post needs 1–4 headline lines, got ${headlineCount}` });
    }
  } else {
    if (headlineCount < 1 || headlineCount > 3) {
      s.errors.push({ path: 'design_text.headlines', rule: 'headline_count', detail: `a carousel cover needs 1–3 headline lines, got ${headlineCount}` });
    }
    if (slides.length === 0) {
      s.errors.push({ path: 'slides', rule: 'slides_missing', detail: 'format is carousel but the slide plan is empty' });
    }
    for (const slide of slides) {
      if (!slide.headline || !slide.headline.trim()) {
        s.errors.push({ path: `slides.${slide.index}.headline`, rule: 'slide_headline', detail: `slide ${slide.index} has no headline — every carousel slide needs one` });
      }
    }
  }

  // Copy battery: design text + every slide.
  const dt = base.design_text;
  checkCopy([...headlines, dt.cta_on_design ?? ''].join('\n'), dt.fact_refs, 'design_text', s);
  checkFactRefs(dt.fact_refs, 'design_text.fact_refs', s);
  for (const slide of slides) {
    checkCopy([slide.headline, slide.support ?? ''].join('\n'), slide.fact_refs, `slides.${slide.index}`, s);
    checkFactRefs(slide.fact_refs, `slides.${slide.index}.fact_refs`, s);
  }

  // Assets: rights + provenance gates (contracts §0 rule 9).
  base.assets.forEach((a, i) => {
    const path = `assets.${i}`;
    if (ctx.competitorMediaIds.has(a.file_id)) {
      s.errors.push({ path, rule: 'asset_competitor', detail: `asset ${a.file_id} is competitor media — reference-only, never a production asset` });
    }
    const meta = ctx.assetMeta.get(a.file_id);
    if (!meta) {
      s.warnings.push({ path, rule: 'asset_unknown', detail: `asset ${a.file_id} has no rights metadata in the candidate set — confirm rights manually` });
      return;
    }
    if (meta.rights === 'restricted' || meta.rights === 'do_not_use') {
      s.errors.push({ path, rule: 'rights_blocked', detail: `asset ${a.file_id} has usage_rights='${meta.rights}' — never selectable for production` });
    }
    if (!meta.rights_verified && !a.needs_rights_confirmation) {
      const v: Violation = {
        path,
        rule: 'rights_confirmation',
        detail: `asset ${a.file_id} rights are unverified but needs_rights_confirmation is false — a human must confirm before final approval`,
      };
      if (a.is_production) s.errors.push(v);
      else s.warnings.push(v);
    }
  });

  // Palette ⊂ brand kit, or listed in deviations (advisory) / hard error (constraint).
  if (ctx.brandKit) {
    const kitHexes = new Set(ctx.brandKit.palette.map((p) => p.hex.toLowerCase()));
    const deviations = base.brand_kit.deviations.map((d) => d.toLowerCase());
    base.palette.forEach((p, i) => {
      const hex = p.hex.toLowerCase();
      if (kitHexes.has(hex)) return;
      const deviated = deviations.some((d) => d.includes(hex) || (p.name && d.includes(normAr(p.name))));
      if (deviated) return;
      const v: Violation = {
        path: `palette.${i}`,
        rule: 'palette_off_brand',
        detail: `${p.hex} (${p.name || 'unnamed'}) is not in the brand kit and not listed in brand_kit.deviations`,
      };
      if (ctx.brandKit!.mode === 'constraint') s.errors.push(v);
      else s.warnings.push(v);
    });
  }

  // AI recommendations: allowed modes, known sources, §7 policy (contracts §0 rule 8).
  const knownAssetIds = new Set<string>([...ctx.assetMeta.keys(), ...base.assets.map((a) => a.file_id)]);
  base.ai_recommendations.forEach((rec, i) => {
    const path = `ai_recommendations.${rec.index ?? i}`;
    if (!ALLOWED_AI_MODES.has(rec.mode)) {
      s.errors.push({ path, rule: 'ai_mode', detail: `mode '${rec.mode}' is not one of the §7 allowed modes` });
    }
    for (const id of rec.source_file_ids) {
      if (ctx.competitorMediaIds.has(id)) {
        s.errors.push({ path, rule: 'asset_competitor', detail: `AI source ${id} is competitor media — never an AI input` });
      } else if (!knownAssetIds.has(id)) {
        s.errors.push({ path, rule: 'ai_source_unknown', detail: `AI source ${id} is not one of the package assets / candidate files` });
      }
    }
    if (ctx.policyCheck) {
      const verdict = ctx.policyCheck(rec);
      if (!verdict.ok) s.errors.push({ path, rule: 'policy_blocked', detail: verdict.reason });
    }
    // The recommendation prompt itself is copy the model wrote — gate it too.
    scanProhibited(rec.prompt, `${path}.prompt`, s);
  });

  return result(s);
}

// ── Stage 3: derivatives ─────────────────────────────────────────────────────
function targetKey(t: Pick<DerivativeTarget, 'target_kind' | 'platform' | 'placement_type'>): string {
  return `${t.target_kind}:${t.platform}:${t.placement_type}`;
}

function isOrganicCopy(copy: Derivative['copy']): copy is OrganicCopy {
  return typeof (copy as OrganicCopy).caption === 'string';
}

function validateDerivative(d: Derivative, i: number, ctx: GroundingCtx, s: Scan): void {
  const path = `derivatives.${i}`;
  const selected = ctx.selectedTargets.some((t) => targetKey(t) === targetKey(d.target));
  if (!selected) {
    s.errors.push({
      path: `${path}.target`,
      rule: 'target_not_selected',
      detail: `${targetKey(d.target)} is not among the selected targets — copy exists only for selected targets (contracts §0 rule 6)`,
    });
  }
  const spec = ctx.specs.find((sp) => sp.platform === d.target.platform && sp.placement_type === d.target.placement_type);
  if (!spec) {
    s.warnings.push({ path: `${path}.target`, rule: 'spec_missing', detail: `no PLACEMENT_SPECS entry for ${d.target.platform}:${d.target.placement_type} — limits unverifiable` });
  } else {
    if (!spec.aspects.includes(d.dimensions.aspect)) {
      s.errors.push({
        path: `${path}.dimensions.aspect`,
        rule: 'aspect_not_allowed',
        detail: `aspect ${d.dimensions.aspect} is not allowed for ${spec.platform}:${spec.placement_type} (${spec.aspects.join(', ')})`,
      });
    } else {
      const want = spec.px[d.dimensions.aspect];
      if (want && (d.dimensions.px[0] !== want[0] || d.dimensions.px[1] !== want[1])) {
        s.errors.push({
          path: `${path}.dimensions.px`,
          rule: 'px_mismatch',
          detail: `${d.dimensions.aspect} for ${spec.platform}:${spec.placement_type} is ${want[0]}×${want[1]}, not ${d.dimensions.px[0]}×${d.dimensions.px[1]}`,
        });
      }
    }
    if (spec.max_slides !== undefined && d.adaptation.slide_mapping.length > spec.max_slides) {
      s.errors.push({
        path: `${path}.adaptation.slide_mapping`,
        rule: 'max_slides',
        detail: `${spec.platform}:${spec.placement_type} allows at most ${spec.max_slides} slides — the mapping has ${d.adaptation.slide_mapping.length}`,
      });
    }
  }

  if (d.target.target_kind === 'organic') {
    if (!isOrganicCopy(d.copy)) {
      s.errors.push({ path: `${path}.copy`, rule: 'copy_kind', detail: 'organic target carries paid-shaped copy (primary_text) instead of a caption' });
      return;
    }
    const copy = d.copy;
    if (spec?.caption_max !== undefined && copy.caption.length > spec.caption_max) {
      s.errors.push({
        path: `${path}.copy.caption`,
        rule: 'caption_max',
        detail: `caption is ${copy.caption.length} chars — ${spec.platform}:${spec.placement_type} allows ${spec.caption_max}`,
      });
    }
    if (spec?.hashtags_max !== undefined && copy.hashtags.length > spec.hashtags_max) {
      s.errors.push({
        path: `${path}.copy.hashtags`,
        rule: 'hashtags_max',
        detail: `${copy.hashtags.length} hashtags — ${spec.platform}:${spec.placement_type} allows ${spec.hashtags_max}`,
      });
    }
    for (const tag of copy.hashtags) {
      const norm = normAr(tag.startsWith('#') ? tag : `#${tag}`);
      const blocked = ctx.blocklist.find((b) => (b.kind === 'hashtag' || b.kind === 'org') && norm.includes(b.term));
      if (blocked) {
        s.errors.push({
          path: `${path}.copy.hashtags`,
          rule: 'hashtag_blocked',
          detail: `hashtag ${tag} matches blocklisted ${blocked.kind} «${blocked.display}» (${blocked.source}) — competitor hashtags never`,
        });
      }
    }
    checkCopy([copy.caption, ...copy.hashtags].join('\n'), copy.fact_refs, `${path}.copy`, s);
    checkFactRefs(copy.fact_refs, `${path}.copy.fact_refs`, s);
  } else {
    if (isOrganicCopy(d.copy)) {
      s.errors.push({ path: `${path}.copy`, rule: 'copy_kind', detail: 'paid target carries organic-shaped copy (caption) instead of ad copy' });
      return;
    }
    const copy = d.copy as PaidCopy;
    // destination_url is a URL by design — excluded from the entity battery.
    checkCopy([copy.primary_text, copy.headline, copy.description].join('\n'), copy.fact_refs, `${path}.copy`, s);
    checkFactRefs(copy.fact_refs, `${path}.copy.fact_refs`, s);
  }
}

export function validateDerivatives(out: DerivativesOutput, ctx: GroundingCtx): ValidationResult {
  const s = mkScan(ctx);
  out.derivatives.forEach((d, i) => validateDerivative(d, i, ctx, s));
  return result(s);
}

// ── Retry feedback ───────────────────────────────────────────────────────────
/**
 * Render the violation list for the orchestrator's ONE retry prompt — Arabic
 * first, then English, both carrying the same bullets (path + rule + detail)
 * so the model can locate every offending field regardless of output language.
 */
export function buildViolationFeedback(errors: Violation[]): string {
  const bullets = errors.map((e) => `- [${e.rule}] ${e.path}: ${e.detail}`);
  return [
    `الناتج السابق فيه ${errors.length} مخالفة. أعد توليد الناتج كاملًا مع تصحيح كل بند من البنود التالية (لا تتجاهل أي بند):`,
    ...bullets,
    '',
    `The previous output had ${errors.length} violation(s). Regenerate the full output and fix EVERY item below — do not ignore any of them:`,
    ...bullets,
  ].join('\n');
}
