import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hydrateClipGeometry, makeSupabaseBackfillDeps } from '../backfillPorts.js';
import { createSupabaseResolverDb } from '../resolverDb.js';
import { prepareEvidence } from '../anchorPrep.js';
import { applyCompanyRules } from '../companyRules.js';
import { sideClipState } from '../placementText.js';
import type { ProposalInput, ProposalRecord } from '../orchestrator.js';
import type { Conversation } from '../extractor.js';
import type { ResolverDb } from '../resolver.js';
import type { CardinalSide, GeoOperation, GeoPreference, Polarity } from '../ontology.js';
import { geoPreferenceToLocationItems } from '../../../geo-preference/review.js';

/**
 * LIVE GATE of the geo fix (RUN_GEOFIX=1) — design 2026-10-04 §6.7.
 *
 * Every sentence the fix was built around goes through the REAL pipeline:
 * extract (one metered LLM call per sentence, the live prompt) → runReviewFirst
 * over the LIVE map (the real resolver, the real checks, the customer's own
 * turns attached as `ctx.conversation`) → hydrateClipGeometry (so a
 * district_side_clip shows the shape the rep would see — an UNHYDRATED clip
 * prints `items: []`, because review.ts never saves a clip without its computed
 * shape) → geoPreferenceToLocationItems. The corpus: the 6 report texts of
 * 2026-10-01, the 6 other live sentences, the texts of the 15 open findings and
 * the §6.5 adversarial texts (54 extractions, ≈ $0.80).
 *
 * Each sentence ASSERTS its expected class (design §5): the exact recipe set
 * (operation, ids, side, radius, polarity) or «asks». Two failure lists:
 *  - WRONG  — a place was drawn that the design does not expect (a blocker);
 *  - MISSED — the design expects a place and the run asked instead.
 * The adversarial rows assert only "never wrong" (`neverWrongOnly`): their
 * expected classes are fake-map results (§6.5), not §5 rows.
 * Printed per sentence: the anchors, the resolutions with reason codes, the
 * compiled recipes, each clip's sideClipState, the location items; at the end
 * the structured / legacy mention counts (the Phase-B compliance number — 0
 * structured until geo-extract/v10).
 *
 * READ-ONLY: the proposal store is in memory (nothing is inserted), no
 * evidence is persisted, the client id is the all-zero uuid (no client record
 * exists, so the established city is the organisational default «الرياض»;
 * a "Jeddah client" row overrides it in memory), and the only RPCs called are
 * STABLE reads (the resolver's lookups, wassell_geo_road_axis,
 * wassell_geo_names_in_text, wassell_districts_side_of_road). Expected ids are
 * looked up through the same read-only resolver adapter BEFORE any extraction,
 * so a fixture that cannot be found fails the run before any money is spent.
 */

const ENV_FILE = fileURLToPath(new URL('../../../../.env.local', import.meta.url));
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

const RUN = process.env.RUN_GEOFIX === '1';
const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const NO_CLIENT = '00000000-0000-0000-0000-000000000000';

// ─────────────────────────────────────────────────────────────────────────────
// Expected classes, with ids named the way the live map names them.
// ─────────────────────────────────────────────────────────────────────────────

/** A literal id; every district of a city's zone; ONE district by Arabic name + city; ONE of the elements with that exact name in a city; a city record. */
type IdSpec = string | { zone: [string, string] } | { district: [string, string] } | { element: [string, string] } | { city: string };
interface ExpRec { ops: GeoOperation[]; ids: IdSpec[]; side: CardinalSide | null; radius: number | null; polarity: Polarity }
/** Alternatives; each is the exact recipe set the sentence may produce. `[]` = asks. */
type Expectation = ExpRec[][];

const exp = (op: GeoOperation | GeoOperation[], ids: IdSpec[], side: CardinalSide | null = null, radius: number | null = null): ExpRec =>
  ({ ops: Array.isArray(op) ? op : [op], ids, side, radius, polarity: 'include' });
const excl = (r: ExpRec): ExpRec => ({ ...r, polarity: 'exclude' });
const band = (side: CardinalSide, road: IdSpec, m = 5000): ExpRec => exp('directional_band', [road], side, m);
const clip = (side: CardinalSide, districts: IdSpec[], road: IdSpec): ExpRec => exp('district_side_clip', [...districts, road], side);
const zone = (cityAr: string, z: string): ExpRec => exp('zone_union', [{ zone: [cityAr, z] }]);
const poly = (d: IdSpec): ExpRec => exp('district_polygon', [d]);
const union = (ids: IdSpec[]): ExpRec => exp('district_union', ids);
/** A distance from a polygon venue / road is within_distance; from a point venue within_radius — the same meaning. */
const near = (id: IdSpec, m: number): ExpRec => exp(['within_distance', 'within_radius'], [id], null, m);
const ASKS: ExpRec[] = [];
const only = (...recs: ExpRec[]): Expectation => [recs];

// Ids measured live (read-only) on 2026-10-03/04.
const KFR = 'RUH-ROAD-0694';
const KSR = 'RUH-ROAD-0681';
const RING = 'RUH-RING-0853';
const NARJIS = '5d788587-4219-7ad2-a6b6-e0bbfebde16d';
const ruhZone = (z: string): ExpRec => zone('الرياض', z);

interface Case {
  name: string;
  /** The customer's messages (one turn each). */
  turns: string[];
  expect: Expectation;
  /** A client whose city on record is this one (in memory only). */
  established?: string;
  /** Assert only that nothing WRONG is drawn (a fake-map adversarial row). */
  neverWrongOnly?: boolean;
}
const c = (name: string, text: string, expect: Expectation, extra: Partial<Case> = {}): Case => ({ name, turns: [text], expect, ...extra });

const CASES: Case[] = [
  // ── §5.1 the six report texts ──────────────────────────────────────────────
  c('report #1', 'ابي فيلا غرب الملك فهد', only(band('west', KFR))),
  c('report #2', 'ابي فيلا غرب طريق الملك فهد', only(band('west', KFR))),
  c('report #3', 'ابي بالنرجس شمال طريق الملك سلمان', only(clip('north', [NARJIS], KSR))),
  c('report #4', 'النرجس شمال سلمان', only(clip('north', [NARJIS], KSR))),
  c('report #5', 'ابي قريب من الرياض بارك', [ASKS]),
  c('report #6', 'ابي في شمال الرياض بس مو النرجس', only(ruhZone('north'), excl(poly(NARJIS)))),
  // ── §5.2 the other six live sentences ──────────────────────────────────────
  c('live L1', 'شمال الرياض على طريق الملك فهد', [ASKS]),
  c('live L2', 'ابي قريب من طريق الملك فهد تقريبا 2 كيلو', only(near(KFR, 2000))),
  c('live corridor', 'بين طريق الملك فهد وطريق العليا', [ASKS]),
  c('live ring', 'جنوب الدائري الشمالي', only(band('south', RING))),
  c('live PNU', 'قريب من جامعة الأميرة نورة بحدود 3 كيلو', [ASKS]),
  c('live zone', 'شمال الرياض تقريبا', only(ruhZone('north'))),
  // ── §5.3 the texts of the 15 open findings ─────────────────────────────────
  c('#0 «شمال او شرق جدة»', 'ابي شمال او شرق جدة', [ASKS]),
  c('#0 «شمال مدينة جدة»', 'ابي شمال مدينة جدة', only(zone('جدة', 'north'))),
  // Live there are two «طريق الدمام» elements (0727, 0731): the design allows the ask.
  c('#1 «الروابي جنوب طريق الدمام»', 'الروابي جنوب طريق الدمام',
    [[clip('south', [{ district: ['حي الروابي', 'الرياض'] }], { element: ['طريق الدمام', 'الرياض'] })], ASKS]),
  c('#1 «شمال طريق الملك عبدالله»', 'ابي شمال طريق الملك عبدالله', only(band('north', { element: ['طريق الملك عبدالله', 'الرياض'] }))),
  c('#2 «شمال او جنوب انس بن مالك»', 'ابي شمال او جنوب انس بن مالك', [ASKS]),
  c('#3 quotes', 'ابي بيت قريب من "الرياض بارك"', [ASKS]),
  c('#3 parens', 'ابي بيت قريب من (الرياض بارك)', [ASKS]),
  c('#3 guillemets', 'ابي بيت قريب من «الرياض بارك»', [ASKS]),
  c('#3 the', 'I want a house near the Riyadh Park', [ASKS]),
  c('#4 «النرجس وجنوب سلمان»', 'ابي النرجس وجنوب سلمان', only(clip('south', [NARJIS], KSR))),
  c('#5 «شمال القصيم»', 'ابي شمال القصيم', [ASKS]),
  c('#6 road side + region', 'شمال طريق الملك فهد بالمنطقة الشرقية', [ASKS]),
  c('#6 near road + region', 'قريب من طريق الملك فهد بالمنطقة الشرقية خلال 2 كيلو', [ASKS]),
  c('#6 venue + region', 'قريب من النخيل مول في المنطقة الشرقية خلال 2 كيلو', [ASKS]),
  // «العليا» stays plain — or, since the 2026-10-04 corpus change, asks: the
  // conversation names the Eastern Province (I9) and العليا has namesakes there.
  {
    name: '#6 a held region band is never spread onto «العليا»',
    turns: ['ابي العليا', 'او شمال طريق الملك فهد بالمنطقة الشرقية'],
    expect: [[poly({ district: ['حي العليا', 'الرياض'] })], ASKS],
  },
  c('#7a «في جدة بالشمال» (Riyadh client)', 'في جدة بالشمال', [ASKS]),
  c('#7a «في جدة بالشمال» (Jeddah client)', 'في جدة بالشمال', only(zone('جدة', 'north')), { established: 'جدة' }),
  c('#7b «شمال المنطقة الشرقية»', 'ابي شمال المنطقة الشرقية', [ASKS]),
  c('#7c «الروضة شمال جدة»', 'الروضة شمال جدة',
    only(union([{ district: ['حي الروضة', 'جدة'] }, { zone: ['جدة', 'north'] }]))),
  c('#7d «الروضة بجدة»', 'الروضة بجدة', only(union([{ district: ['حي الروضة', 'جدة'] }]))),
  c('#8 «شرق طريق الدمام»', 'ابي شرق طريق الدمام', [ASKS]),
  c('#8 «شمال جدة»', 'ابي فيلا شمال جدة', only(zone('جدة', 'north'))),
  // The live map names Riyadh's park «منتزه الملك عبدالله» (RUH-PARK-0462; aliases
  // «منتزه الملك عبدالله», «King Abdullah Park» — no «حديقة …» form, measured
  // 2026-10-04), so the expected id is looked up by that name.
  c('#9 folded venue', 'خلال 2 كيلو من حديقة الملك عبدالله', only(near({ element: ['منتزه الملك عبدالله', 'الرياض'] }, 2000))),
  c('#9 «غرب طريق مكة»', 'ابي غرب طريق مكة', [ASKS]),
  c('#10 «ابي في جدة بالشمال» (Riyadh client)', 'ابي في جدة بالشمال', [ASKS]),
  c('#10 «ابي بالشمال في جدة» (Riyadh client)', 'ابي بالشمال في جدة', [ASKS]),
  c('#10 «ابي بالشمال في جدة» (Jeddah client)', 'ابي بالشمال في جدة', only(zone('جدة', 'north')), { established: 'جدة' }),
  c('#10 «شمال منطقة القصيم»', 'ابي شمال منطقة القصيم', [ASKS]),
  c('#11 north Riyadh', 'I want a villa in north Riyadh', only(ruhZone('north'))),
  c('#12 not south Riyadh', 'not south Riyadh', only(excl(ruhZone('south')))),
  c('#13 «بالشمال وغرب الملك فهد» (accepted ask)', 'ابي بالشمال وغرب الملك فهد', [ASKS]),
  // ── §6.5 adversarial texts (never wrong; an ask is always allowed) ─────────
  c('adv «حول الرياض بارك»', 'ابي حول الرياض بارك', [ASKS], { neverWrongOnly: true }),
  c("adv «قريب من 'الرياض بارك'»", "ابي قريب من 'الرياض بارك'", [ASKS], { neverWrongOnly: true }),
  c('adv «النخيل مول»', 'ابي شقة في النخيل مول', [ASKS], { neverWrongOnly: true }),
  c('adv «شمال الرياض بارك»', 'ابي شمال الرياض بارك', [ASKS], { neverWrongOnly: true }),
  {
    name: 'adv two cities in two messages plus a bare direction',
    turns: ['ابي في جدة', 'او الدمام', 'بالشمال'],
    expect: [
      [union([{ city: 'جدة' }]), union([{ city: 'الدمام' }])],
      [union([{ city: 'جدة' }, { city: 'الدمام' }])],
    ],
    neverWrongOnly: true,
  },
  c('adv «Jeddah north» (Riyadh client)', 'Jeddah north', [ASKS], { neverWrongOnly: true }),
  c('adv «Jeddah north» (Jeddah client)', 'Jeddah north', only(zone('جدة', 'north')), { established: 'جدة', neverWrongOnly: true }),
  c('adv a travel time is not a distance', 'ابي قريب من طريق الملك فهد 10 دقايق', [ASKS], { neverWrongOnly: true }),
  {
    name: 'adv a distance said in another message',
    turns: ['ابي قريب من طريق الملك فهد', 'تقريبا 2 كيلو'],
    expect: [ASKS, only(near(KFR, 2000))[0]!],
    neverWrongOnly: true,
  },
  // Two separate mentions are a correct «or»; ONE mention must ask (V8) — never a clip.
  c('adv «النرجس او شمال طريق الملك سلمان»', 'النرجس او شمال طريق الملك سلمان',
    [ASKS, [poly(NARJIS), band('north', KSR)]], { neverWrongOnly: true }),
  c('adv «النرجس، الشمال منه»', 'النرجس، الشمال منه', [ASKS], { neverWrongOnly: true }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Resolving the expected ids (read-only, through the live adapter).
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedExp { ops: Set<string>; required: Set<string>; oneOf: Array<Set<string>>; side: CardinalSide | null; radius: number | null; polarity: Polarity }

async function resolveSpec(db: ResolverDb, spec: IdSpec, cache: Map<string, { all?: string[]; one?: string[] }>): Promise<{ all?: string[]; one?: string[] }> {
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  let out: { all?: string[]; one?: string[] };
  if (typeof spec === 'string') out = { all: [spec] };
  else if ('zone' in spec) {
    const rows = await db.zoneDistricts(spec.zone[0], spec.zone[1]);
    out = { all: rows.map((r) => r.district_id) };
  } else if ('district' in spec) {
    const [name, cityAr] = spec.district;
    const rows = (await db.findDistricts(name, 'SA')).filter((d) => d.name_ar === name && d.city_name_ar === cityAr);
    out = { one: rows.map((d) => d.id) };
  } else if ('element' in spec) {
    const [name, cityAr] = spec.element;
    const rows = (await db.findElements(name, { preferCountry: 'SA', city: cityAr })).filter((e) => e.name_ar === name);
    out = { one: rows.map((e) => e.external_id) };
  } else {
    const rows = (await db.findCities(spec.city, 'SA')).filter((x) => x.name_ar === spec.city);
    out = { one: rows.map((x) => x.id) };
  }
  if ((out.all ?? out.one ?? []).length === 0) throw new Error(`[GEOFIX] expected-id lookup found nothing for ${key} — fix the fixture before spending on extraction`);
  cache.set(key, out);
  return out;
}

async function resolveExpectation(db: ResolverDb, e: Expectation, cache: Map<string, { all?: string[]; one?: string[] }>): Promise<ResolvedExp[][]> {
  const alts: ResolvedExp[][] = [];
  for (const alt of e) {
    const recs: ResolvedExp[] = [];
    for (const r of alt) {
      const required = new Set<string>();
      const oneOf: Array<Set<string>> = [];
      for (const spec of r.ids) {
        const s = await resolveSpec(db, spec, cache);
        if (s.all) s.all.forEach((id) => required.add(id));
        if (s.one) oneOf.push(new Set(s.one));
      }
      recs.push({ ops: new Set(r.ops), required, oneOf, side: r.side, radius: r.radius, polarity: r.polarity });
    }
    alts.push(recs);
  }
  return alts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Judging a run.
// ─────────────────────────────────────────────────────────────────────────────

interface Rec { op: string; ids: string[]; side: CardinalSide | null; radius: number | null; polarity: Polarity; clip_state?: string }

function resolvedRecs(pref: GeoPreference): Rec[] {
  const out: Rec[] = [];
  for (const g of pref.groups) {
    for (const cl of g.clauses) {
      for (const ref of cl.anyOf) {
        const x = ref.recipe;
        if (!x || x.geo_data_version === 'stub') continue;
        out.push({
          op: x.operation, ids: [...x.resolved_element_ids].sort(), side: x.side ?? null,
          radius: typeof x.radius_or_band_m === 'number' ? x.radius_or_band_m : null, polarity: cl.op,
          ...(x.operation === 'district_side_clip' ? { clip_state: sideClipState(x) } : {}),
        });
      }
    }
  }
  return out;
}

function recMatches(r: Rec, e: ResolvedExp): boolean {
  if (!e.ops.has(r.op) || e.side !== r.side || e.radius !== r.radius || e.polarity !== r.polarity) return false;
  const ids = new Set(r.ids);
  for (const id of e.required) if (!ids.has(id)) return false;
  const allowed = new Set(e.required);
  for (const set of e.oneOf) {
    const hits = [...set].filter((id) => ids.has(id));
    if (hits.length !== 1) return false;
    allowed.add(hits[0]!);
  }
  return [...ids].every((id) => allowed.has(id));
}

/** Every actual recipe matched to a DIFFERENT expected one (backtracking; sets are tiny). */
function subMatch(actual: readonly Rec[], alt: readonly ResolvedExp[], used: ReadonlySet<number> = new Set()): boolean {
  if (actual.length === 0) return true;
  const [head, ...rest] = actual;
  for (let i = 0; i < alt.length; i++) {
    if (used.has(i) || !recMatches(head!, alt[i]!)) continue;
    if (subMatch(rest, alt, new Set([...used, i]))) return true;
  }
  return false;
}

type Verdict = 'right' | 'asked' | 'partly_asked' | 'wrong';
function judge(actual: readonly Rec[], alts: readonly ResolvedExp[][]): Verdict {
  const rank: Record<Verdict, number> = { wrong: 0, asked: 1, partly_asked: 2, right: 3 };
  let best: Verdict = 'wrong';
  for (const alt of alts) {
    if (!subMatch(actual, alt)) continue;
    const v: Verdict = actual.length === alt.length ? 'right' : actual.length === 0 ? 'asked' : 'partly_asked';
    if (rank[v] > rank[best]) best = v;
  }
  return best;
}

const recText = (r: Rec): string =>
  `${r.polarity === 'exclude' ? 'NOT ' : ''}${r.op}${r.side ? `/${r.side}` : ''}[${r.ids.length > 6 ? `${r.ids.slice(0, 6).join(', ')}, … (${r.ids.length})` : r.ids.join(', ')}]${r.radius !== null ? `@${r.radius}` : ''}${r.clip_state ? ` clip:${r.clip_state}` : ''}`;

// ─────────────────────────────────────────────────────────────────────────────
// The run.
// ─────────────────────────────────────────────────────────────────────────────

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

describe.skipIf(!RUN || !URL_ || !KEY)('geo fix LIVE gate (read-only; one metered extraction per sentence)', () => {
  it('every sentence gives its expected class — never a wrong place', async () => {
    const lookups = createSupabaseResolverDb(supabase);
    const specCache = new Map<string, { all?: string[]; one?: string[] }>();
    // Every expected id first: a missing fixture fails here, before any LLM spend.
    const expected = new Map<string, ResolvedExp[][]>();
    for (const k of CASES) expected.set(k.name, await resolveExpectation(lookups, k.expect, specCache));

    const deps = makeSupabaseBackfillDeps(supabase, 'geofix-gate');
    const created: ProposalRecord[] = [];
    const proposals = {
      async createProposal(input: ProposalInput): Promise<ProposalRecord> {
        const rec: ProposalRecord = { ...input, id: `mem-${created.length + 1}`, status: 'pending' };
        created.push(rec);
        return rec;
      },
    };

    const wrong: string[] = [];
    const missed: string[] = [];
    let structured = 0;
    let legacy = 0;
    const tally: Record<Verdict, number> = { right: 0, asked: 0, partly_asked: 0, wrong: 0 };
    for (const [n, k] of CASES.entries()) {
      const conv: Conversation = {
        channel: 'chat', id: `geofix-gate-${n + 1}`,
        turns: k.turns.map((text, i) => ({ speaker: 'client', text, ref: `geofix-${n + 1}-t${i + 1}`, timestamp: `2026-10-04T10:0${i}:00Z` })),
      };
      const ex = await deps.extract(conv);
      const ctx = await deps.buildRunContext(NO_CLIENT, ex.evidence.length);
      if (k.established) ctx.resolution = { ...ctx.resolution, established_city: k.established };
      ctx.conversation = conv;
      const res = await deps.runReviewFirst(ex.evidence, ex.relations, ctx, { proposals });
      // Read-only STABLE RPC; writes the clip shapes into the in-memory expression only.
      await hydrateClipGeometry(supabase, res.compiled);
      const items = geoPreferenceToLocationItems(res.compiled);
      const modes = prepareEvidence(applyCompanyRules(ex.evidence), { conversation: conv }).prepared.map((p) => p.mode);
      structured += modes.filter((m) => m === 'structured').length;
      legacy += modes.filter((m) => m === 'legacy').length;

      const actual = resolvedRecs(res.compiled);
      const verdict = judge(actual, expected.get(k.name)!);
      tally[verdict] += 1;
      const expText = k.expect.map((alt) => (alt.length ? alt.map((e) => `${e.polarity === 'exclude' ? 'NOT ' : ''}${e.ops.join('|')}${e.side ? `/${e.side}` : ''}`).join(' + ') : 'asks')).join('  OR  ');
      const got = actual.length ? actual.map(recText).join(' + ') : 'asks';
      if (verdict === 'wrong') wrong.push(`${k.name} «${k.turns.join(' / ')}» — expected ${expText}; got ${got}`);
      else if (verdict !== 'right' && !k.neverWrongOnly) missed.push(`${k.name} «${k.turns.join(' / ')}» — expected ${expText}; got ${got}`);
      console.log([
        `[GEOFIX] ── ${k.name}: «${k.turns.join(' / ')}» ── ${verdict.toUpperCase()}`,
        `  extraction: ${ex.evidence[0]?.extraction_version ?? '(no evidence)'}; mentions ${modes.join(', ') || '(none)'}`,
        `  anchors: ${ex.evidence.map((e) => `[${e.anchors.map((a) => `${a.anchor_type} «${a.span}»${a.normalized_token && a.normalized_token !== a.span ? `→«${a.normalized_token}»` : ''}${a.distance_m ? ` ${a.distance_m}m` : ''}${a.role_in_relation ? ` (${a.role_in_relation})` : ''}`).join(', ')}] ${e.preference_role}`).join(' ; ') || '(none)'}`,
        `  resolutions: ${res.resolutions.map((r) => (r.status === 'resolved' ? `${r.recipe?.operation}(${r.recipe?.resolved_element_ids.length})` : `${r.status}:${r.reason}`)).join(', ') || '(none)'}`,
        `  expected: ${expText}`,
        `  got: ${got}`,
        `  ambiguity: ${res.ambiguity.join(', ') || '(none)'}; decision: ${res.decision}`,
        `  items: ${items.map((li) => JSON.stringify(li.kind === 'element_rule' ? { kind: li.kind, polarity: li.polarity, conditions: li.conditions, label: li.element_label } : { kind: li.kind, polarity: li.polarity, ...(li.kind === 'district' ? { district_id: li.district_id } : {}) })).join(' ') || '[]'}`,
      ].join('\n'));
    }
    console.log(`[GEOFIX] SUMMARY right ${tally.right} · asked ${tally.asked} · partly asked ${tally.partly_asked} · WRONG ${tally.wrong} of ${CASES.length}`);
    console.log(`[GEOFIX] mentions: structured ${structured} · legacy ${legacy} (structured share ${structured + legacy ? Math.round((100 * structured) / (structured + legacy)) : 0}%)`);
    for (const w of wrong) console.log(`[GEOFIX] WRONG  ${w}`);
    for (const m of missed) console.log(`[GEOFIX] MISSED ${m}`);

    expect(created.every((p) => p.id.startsWith('mem-'))).toBe(true);
    expect.soft(wrong, 'a place the design does not expect was drawn').toEqual([]);
    expect.soft(missed, 'the design expects a place here and the run asked').toEqual([]);
  }, 1_800_000);
});
