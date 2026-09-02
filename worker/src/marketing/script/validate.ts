/**
 * Deterministic validator — runs claims + entities + structural checks and
 * produces ReviewReport.validator. Auto-fixes are limited to on-screen
 * numerals (WARN); everything else is reported for the repair turn / judge.
 */
import { verifyClaims } from './claims.js';
import { detectEntities, normAr, tokenizeAr, type BlockEntry } from './entities.js';
import { toArabicIndic } from './generate.js';
import type { Brief, CallRole, ClaimVerdict, DraftScene, EntityHit, Exemplar, FactsPackage, GenerationOutput, RecipeRow, ScriptWriterRules, ValidatorCheck, ValidatorReport } from './types.js';

const READY_WORDS = /جاهز|جاهزه|استلام فوري|تستلم اليوم|تستلمها اليوم|استلم اليوم|سكن فوري/;
const OFF_PLAN_WORDS = /علي الخارطه|علي الخريطه|تحت الانشاء|قيد الانشاء|تحت التطوير|(موعد|تاريخ) التسليم|يتم (ال)?تسليم|تسليم(ها|كم)? (في|خلال|بعد|قبل|عام|سنه|20|14)|بعد الانشاء/;
const GREETING = /^(بسم الله|السلام عليكم|الله يبارك|يا متابعين|اهلا وسهلا|حياكم الله|مرحبا)/;
const CTA_WORDS = /للحجز|للاستفسار|تواصل|اتصل|راسل|احجز|كلّمنا|كلمنا|اضغط/;

export interface ValidateInput {
  brief: Brief;
  facts: FactsPackage;
  recipe: RecipeRow;
  rules: ScriptWriterRules;
  output: GenerationOutput;
  exemplars: Exemplar[];
  blocklist: BlockEntry[];
  /** null → residue stays `review` (legacy / offline). */
  callRole: CallRole | null;
}

export interface ValidateResult {
  validator: ValidatorReport;
  /** Scenes after auto-fixes (numerals). Same objects otherwise. */
  scenes: DraftScene[];
  hasFail: boolean;
  classifierCall?: Awaited<ReturnType<typeof verifyClaims>>['classifier'];
}

function grams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Longest run of consecutive shared words between a scene text and any exemplar transcript. */
export function longestSharedRun(text: string, exemplarTokens: string[][]): number {
  const t = tokenizeAr(text);
  if (t.length === 0) return 0;
  let best = 0;
  for (const e of exemplarTokens) {
    if (e.length === 0) continue;
    // DP over token equality — texts are short (scene ≤ ~40 words, exemplar ≤ ~150)
    const prev = new Array<number>(e.length + 1).fill(0);
    for (let i = 1; i <= t.length; i++) {
      let diagonal = 0;
      for (let j = 1; j <= e.length; j++) {
        const tmp = prev[j]!;
        prev[j] = t[i - 1] === e[j - 1] ? diagonal + 1 : 0;
        if (prev[j]! > best) best = prev[j]!;
        diagonal = tmp;
      }
    }
  }
  return best;
}

export function trigramOverlap(a: string, b: string): number {
  const ga = new Set(grams(tokenizeAr(a), 3));
  const gb = new Set(grams(tokenizeAr(b), 3));
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / Math.min(ga.size, gb.size);
}

/** Pure structural checks (no model). Exported for tests. */
export function structuralChecks(i: Omit<ValidateInput, 'callRole' | 'blocklist'>, scenes: DraftScene[], claims: ClaimVerdict[], entities: EntityHit[]): ValidatorCheck[] {
  const checks: ValidatorCheck[] = [];
  const push = (key: string, level: ValidatorCheck['level'], detail: string): void => { checks.push({ key, level, detail }); };
  const allText = (s: DraftScene): string => normAr(`${s.voiceover} ${s.on_screen_text}`);

  // readiness consistency (both ways)
  const readyHits = scenes.filter((s) => READY_WORDS.test(allText(s))).map((s) => s.order);
  const offHits = scenes.filter((s) => OFF_PLAN_WORDS.test(allText(s))).map((s) => s.order);
  if (i.facts.readiness === 'off_plan' && readyHits.length) push('readiness_consistency', 'fail', `project is OFF-PLAN but scenes ${readyHits.join(',')} say ready/immediate handover`);
  else if (i.facts.readiness === 'ready' && offHits.length) push('readiness_consistency', 'fail', `project is READY but scenes ${offHits.join(',')} imply off-plan/delivery`);
  else if (i.facts.readiness === 'off_plan' && offHits.length === 0) push('readiness_consistency', 'warn', 'off-plan project but no scene states it clearly');
  else push('readiness_consistency', 'pass', 'readiness wording matches the facts');

  // sold out → no price / availability wording
  if (i.facts.sold_out) {
    const priceHits = claims.filter((c) => (c.class === 'price' || c.class === 'availability') && c.verdict !== 'fail');
    if (priceHits.length) push('sold_out', 'fail', `project is sold out but a price/availability is mentioned in scenes ${priceHits.map((c) => c.scene).join(',')}`);
    else push('sold_out', 'pass', 'no price/availability quoted for a sold-out project');
  }

  // CTA present in the last scene, Wassel-only
  const last = scenes[scenes.length - 1];
  const lastText = last ? allText(last) : '';
  const wassel = normAr(i.rules.marketer_name);
  if (!last || !(lastText.includes(wassel) && CTA_WORDS.test(lastText))) push('cta_present', 'fail', `last scene must carry the Wassel CTA («${i.rules.cta_default}»)`);
  else push('cta_present', 'pass', 'Wassel CTA present in the last scene');
  const contactLeaks = entities.filter((e) => e.kind === 'phone' || e.kind === 'url' || e.kind === 'handle' || e.kind === 'license' || e.kind === 'cta');
  if (contactLeaks.length) push('contact_channel', 'fail', `other contact channels found: ${contactLeaks.map((e) => `scene ${e.scene} ${e.kind} «${e.mention}»`).join('; ')}`);
  else push('contact_channel', 'pass', 'no contact channel other than Wassel');
  const nameLeaks = entities.filter((e) => e.kind === 'org' || e.kind === 'marketer' || e.kind === 'competitor' || e.kind === 'hashtag');
  if (nameLeaks.length) push('entity_leak', 'fail', `third-party names found: ${nameLeaks.map((e) => `scene ${e.scene} «${e.mention}» (${e.kind})`).join('; ')}`);
  else push('entity_leak', 'pass', 'only Wassel (and the allowed developer) are named');

  // bounds
  const hint = i.brief.scene_count_hint;
  if (Math.abs(scenes.length - hint) > 2) push('scene_count', 'warn', `${scenes.length} scenes vs hint ${hint} (±2)`);
  else push('scene_count', 'pass', `${scenes.length} scenes`);
  const total = scenes.reduce((a, s) => a + s.duration_sec, 0);
  const dev = Math.abs(total - i.brief.duration_sec) / i.brief.duration_sec;
  if (dev > 0.2) push('total_duration', 'warn', `${total}s vs requested ${i.brief.duration_sec}s (±20%)`);
  else push('total_duration', 'pass', `${total}s`);
  const badDur = scenes.filter((s) => s.duration_sec < 2 || s.duration_sec > 15).map((s) => s.order);
  if (badDur.length) push('scene_duration', 'warn', `scenes ${badDur.join(',')} outside 2–15 s`);
  else push('scene_duration', 'pass', 'every scene 2–15 s');

  // hook
  const first = scenes[0];
  if (first && GREETING.test(normAr(first.voiceover))) push('hook_greeting', 'warn', 'first scene opens with a greeting — the hook must be a question, product variety or the price');
  else push('hook_greeting', 'pass', 'hook is not a greeting');

  // repetition between scenes
  const reps: string[] = [];
  for (let a = 0; a < scenes.length; a++) {
    for (let b = a + 1; b < scenes.length; b++) {
      if (trigramOverlap(scenes[a]!.voiceover, scenes[b]!.voiceover) > 0.5) reps.push(`${scenes[a]!.order}↔${scenes[b]!.order}`);
    }
  }
  if (reps.length) push('repetition', 'warn', `scenes repeat each other: ${reps.join(', ')}`);
  else push('repetition', 'pass', 'no repeated scenes');

  // exemplar leakage
  const exTokens = i.exemplars.map((e) => tokenizeAr(`${e.transcript} ${e.ocr}`));
  const maxRun = Math.max(5, i.rules.max_exemplar_overlap_words);
  const leaks = scenes.map((s) => ({ order: s.order, run: longestSharedRun(`${s.voiceover} ${s.on_screen_text}`, exTokens) })).filter((x) => x.run >= maxRun);
  if (leaks.length) push('exemplar_leakage', 'fail', `verbatim overlap with exemplars (≥${maxRun} words): ${leaks.map((l) => `scene ${l.order} (${l.run} words)`).join(', ')}`);
  else push('exemplar_leakage', 'pass', 'no verbatim exemplar copying');

  // fact_refs validity
  const ids = new Set(i.facts.facts.map((f) => f.id));
  const badRefs = scenes.flatMap((s) => s.fact_refs.filter((r) => !ids.has(r)).map((r) => `scene ${s.order} ${r}`));
  if (badRefs.length) push('fact_refs', 'warn', `unknown fact ids: ${badRefs.join(', ')}`);
  else push('fact_refs', 'pass', 'all fact_refs resolve');
  const unclaimable = scenes.flatMap((s) => s.fact_refs.filter((r) => { const f = i.facts.facts.find((x) => x.id === r); return f && !f.claimable; }).map((r) => `scene ${s.order} ${r}`));
  if (unclaimable.length) push('fact_refs_claimable', 'warn', `references to non-claimable (qualitative) facts — must not carry numbers: ${unclaimable.join(', ')}`);

  // claims rollup
  const fails = claims.filter((c) => c.verdict === 'fail');
  const reviews = claims.filter((c) => c.verdict === 'review');
  if (fails.length) push('claims', 'fail', `${fails.length} unsupported claim(s): ${fails.map((c) => `scene ${c.scene} «${c.mention}» — ${c.reason}`).join('; ')}`);
  else if (reviews.length) push('claims', 'warn', `${reviews.length} claim(s) need human review: ${reviews.map((c) => `scene ${c.scene} «${c.mention}»`).join('; ')}`);
  else push('claims', 'pass', `${claims.length} mention(s) verified`);

  // recipe requirements
  for (const req of i.recipe.requires_facts) {
    if (!i.facts.facts.some((f) => f.class === req && f.claimable)) push('recipe_requirements', 'fail', `recipe '${i.recipe.key}' requires a claimable '${req}' fact`);
  }
  return checks;
}

export async function validateScript(i: ValidateInput): Promise<ValidateResult> {
  // 1. Auto-fix numerals on screen (WARN when changed).
  const scenes: DraftScene[] = i.output.scenes.map((s) => {
    const fixed = i.rules.numerals_on_screen === 'arabic_indic' ? toArabicIndic(s.on_screen_text) : s.on_screen_text;
    if (fixed !== s.on_screen_text) return { ...s, on_screen_text: fixed, warnings: [...s.warnings, 'on_screen_text numerals converted to Arabic-Indic'] };
    return s;
  });
  const numeralFixes = scenes.filter((s) => s.warnings.some((w) => w.startsWith('on_screen_text numerals'))).map((s) => s.order);

  // 2. Claims + entities.
  const claimsRes = await verifyClaims(scenes, i.facts.facts, i.rules, i.callRole);
  const allowed = [i.rules.marketer_name, ...(i.rules.allow_developer_name && i.facts.developer_name ? [i.facts.developer_name] : [])];
  const entities = detectEntities(scenes, i.blocklist, { allowedTerms: allowed });

  // 3. Structure.
  const checks = structuralChecks(i, scenes, claimsRes.verdicts, entities);
  checks.push(numeralFixes.length
    ? { key: 'numerals_on_screen', level: 'warn', detail: `converted digits to Arabic-Indic in scenes ${numeralFixes.join(',')}` }
    : { key: 'numerals_on_screen', level: 'pass', detail: 'on-screen numerals already Arabic-Indic' });

  // Attach per-scene warnings for the UI.
  for (const c of claimsRes.verdicts) {
    if (c.verdict === 'pass') continue;
    const s = scenes.find((x) => x.order === c.scene);
    if (s) s.warnings.push(`${c.verdict.toUpperCase()} claim «${c.mention}»: ${c.reason}`);
  }
  for (const e of entities) {
    const s = scenes.find((x) => x.order === e.scene);
    if (s) s.warnings.push(`forbidden ${e.kind}: «${e.mention}»`);
  }

  const validator: ValidatorReport = { claims: claimsRes.verdicts, entities, checks };
  const result: ValidateResult = { validator, scenes, hasFail: checks.some((c) => c.level === 'fail') };
  if (claimsRes.classifier) result.classifierCall = claimsRes.classifier;
  return result;
}
