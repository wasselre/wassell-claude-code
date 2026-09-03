import { describe, it, expect, beforeAll } from 'vitest';
import { runReviewFirst, type RunContext, type OrchestratorPorts, type ProposalRecord, type ProposalInput } from '../orchestrator.js';
import { extract, type Conversation } from '../extractor.js';
import type { ResolverDb, ResolutionContext, DistrictCandidate } from '../resolver.js';
import type { SatUniverse } from '../satisfiability.js';
import type { GateConfig } from '../gate.js';
import type { Evidence, AnchorToken, EvidenceRelation } from '../ontology.js';

/**
 * END-TO-END integration for the Geography Understanding Ability.
 *
 * Wires the SIX real modules — extractor → resolver → compiler → satisfiability →
 * gate → orchestrator — with the extractor in stub mode and DB ports seeded with
 * تركي's real geography (المهدية resolves; الجبيلة must NOT resolve to the Eastern-
 * Province الجبيل; شمال الرياض → a curated zone). Proves the whole chain runs and
 * that its ONLY side effect is a review-first proposal — never a client write.
 *
 * This is a LOGIC-level e2e (no live Postgres, no live LLM). Extraction accuracy
 * and DB-adapter fidelity are validated elsewhere (gold set / live smoke).
 */

// ── تركي's districts (same fixture shape the resolver's own tests use). ──────────
const DISTRICTS: DistrictCandidate[] = [
  mk('d-mahdiyah', 'المهدية', 'Al Mahdiyah', 'الرياض', 'منطقة الرياض', 24.63, 46.55),
  mk('d-irqah', 'عرقة', 'Irqah', 'الرياض', 'منطقة الرياض', 24.68, 46.55),
  // The Eastern-Province الجبيل — a NEAR-STRING to الجبيلة that must NEVER be picked.
  mk('d-jubail', 'الجبيل', 'Al Jubail', 'الجبيل', 'المنطقة الشرقية', 27.0, 49.66),
];
function mk(id: string, name_ar: string, name_en: string, city: string, region: string, lat: number, lng: number): DistrictCandidate {
  return { id, name_ar, name_en, aliases: [], city_id: city, city_name_ar: city, city_name_en: '', region_name_ar: region, region_name_en: '', country_code: 'SA', centroid_lat: lat, centroid_lng: lng };
}
function fold(s: string): string {
  return s.replace(/^\s*حي\s+/, '').replace(/ـ/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim().toLowerCase();
}
function fakeDb(): ResolverDb {
  return {
    async findDistricts(token) {
      const t = fold(token);
      return DISTRICTS.filter((r) => { const n = fold(r.name_ar); return n.includes(t) || t.includes(n); });
    },
    async findCities() { return []; },
    async findElements() { return []; },
    async zoneDistricts(city, zone) {
      if (fold(city) === fold('الرياض') && zone === 'north') {
        return [{ district_id: 'd-narjis', district_name: 'النرجس' }, { district_id: 'd-arid', district_name: 'العارض' }];
      }
      return [];
    },
    async districtForPoint() { return null; },
  };
}

// ── Deterministic supporting context. ───────────────────────────────────────────
const universe: SatUniverse = {
  universe: ['c1', 'c2', 'c3'],
  cellsOf: () => ['c1'],
  inventoryIn: (cells) => (cells.size > 0 ? 5 : 0),
  narrowThreshold: 2,
};
const REVIEW_FIRST_CONFIG: GateConfig = {
  auto_write_enabled: false, // the master switch, off — as in prod
  t_lexical_margin: 0.9, t_geo_margin: 0.9, t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};
function ports(): { ports: OrchestratorPorts; created: ProposalRecord[] } {
  const created: ProposalRecord[] = [];
  return {
    created,
    ports: {
      proposals: {
        async createProposal(input: ProposalInput): Promise<ProposalRecord> {
          const rec: ProposalRecord = { ...input, id: `prop-${created.length + 1}`, status: 'pending' };
          created.push(rec);
          return rec;
        },
      },
    },
  };
}
function anchor(span: string): AnchorToken { return { anchor_type: 'district', span, normalized_token: fold(span) }; }
function ev(id: string, span: string, over: Partial<Evidence> = {}): Evidence {
  return {
    id, mention_span: span, anchors: [anchor(span)],
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: 'positive', commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'call', ref: `seg-${id}`, timestamp: '2026-07-24T12:00:00Z' },
    ...over,
  };
}
const runCtx = (over: Partial<RunContext> = {}): RunContext => ({
  client_id: 'client-turki', checkpoint_id: null, maximum_safe_action: 'write_soft',
  resolution: { db: fakeDb(), preferCountry: 'SA', established_city: 'الرياض' } as ResolutionContext,
  universe, config: REVIEW_FIRST_CONFIG, ...over,
});

describe('geo-preference ability — end to end (تركي)', () => {
  it('an unresolvable place (الجبيلة) drives the whole pipeline to a CONFIRM proposal, never a client write', async () => {
    const evidence = [
      ev('e1', 'المهدية', { commitment: 'preferred' }),            // resolves
      ev('e2', 'الجبيلة', { commitment: 'considered' }),           // must → needs_confirm
    ];
    const relations: EvidenceRelation[] = [];
    const { ports: p, created } = ports();

    const res = await runReviewFirst(evidence, relations, runCtx(), p);

    // المهدية resolved; الجبيلة did NOT (and did NOT become الجبيل).
    expect(res.resolutions.some((r) => r.status === 'resolved')).toBe(true);
    expect(res.resolutions.some((r) => r.status === 'needs_confirm' || r.status === 'unresolvable')).toBe(true);
    // The unresolved reference forces confirmation, not a silent write.
    expect(res.decision).toBe('confirm');
    expect(res.decision).not.toBe('auto_write');
    // Exactly one pending proposal — the ONLY side effect.
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe('pending');
    expect(created[0]!.proposed_action).toBe('confirm');
    expect(created[0]!.client_id).toBe('client-turki');
  });

  it('even a fully-resolved, clean case cannot auto-write while the master switch is off', async () => {
    const evidence = [ev('e1', 'المهدية', { commitment: 'preferred' })]; // resolves cleanly
    const { ports: p, created } = ports();

    const res = await runReviewFirst(evidence, [], runCtx(), p);

    expect(res.decision).not.toBe('auto_write'); // auto_write_enabled=false ⇒ unreachable
    expect(res.decision).toBe('confirm');
    expect(created[0]!.proposed_action).toBe('confirm');
  });

  it('runs the REAL extractor (stub) → pipeline without throwing, producing only proposals', async () => {
    const convo: Conversation = {
      channel: 'call',
      turns: [
        { speaker: 'agent', text: 'أي حي يناسبك؟', ref: 's1' },
        { speaker: 'client', text: 'أبي فيلا بالمهدية، وأقارنها بالجبيلة. وإذا مو شمال الرياض ما يناسبني.', ref: 's2' },
        { speaker: 'client', text: 'عندكم فلل بالنرجس؟', ref: 's3' },
      ],
    };
    const { evidence, relations } = await extract(convo);
    expect(Array.isArray(evidence)).toBe(true);
    expect(Array.isArray(relations)).toBe(true);

    const { ports: p, created } = ports();
    const res = await runReviewFirst(evidence, relations, runCtx(), p);

    // Whatever the stub emits, the chain runs to a decision and writes at most a proposal.
    expect(['confirm', 'human_review', 'ignore', 'auto_write']).toContain(res.decision);
    expect(res.decision).not.toBe('auto_write'); // master switch off
    if (res.decision !== 'ignore') expect(created.length).toBeGreaterThanOrEqual(1);
    for (const prop of created) expect(prop.status).toBe('pending');
  });
});

beforeAll(() => { process.env.WA_EXTRACT_STUB = '1'; });
