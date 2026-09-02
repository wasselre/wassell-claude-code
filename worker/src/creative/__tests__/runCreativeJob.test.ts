/**
 * runCreativeJob tests — fake io + fake director, no network, no supabase.
 *
 * Covered: concepts→package→derivatives happy paths, regenerate (old version
 * superseded), derivatives-on-existing-package (old version NOT superseded),
 * a failed job leaving packages untouched, the persist_failed → rejected
 * guard, and the error-kind classification (provider: requeue mapping).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env';
import {
  classifyCreativeError,
  runCreativeJob,
  type CreativeDirector,
  type CreativeJobIo,
} from '../runCreativeJob';
import type { CreativeJobContext, CreativeJobLike } from '../io';
import type { DirectorStageResult } from '../director/runDirector';
import type {
  BasePackage,
  ConceptsOutput,
  CreativePackageRow,
  DerivativesOutput,
  DerivativeTarget,
  WriterRules,
} from '../contracts';

const SB = {} as SupabaseClient;
const ENV = {} as WorkerEnv;
const CONTENT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';

const TARGET: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'feed', target_ref: {} };

const CONCEPTS: ConceptsOutput = {
  concepts: [
    { id: 'c1', title: 'زاوية ١', angle: 'a', format: 'single', one_line_design_idea: 'd', leans_on_reference: null, suggested_targets: ['instagram:feed'], why: 'w' },
    { id: 'c2', title: 'زاوية ٢', angle: 'b', format: 'carousel', one_line_design_idea: 'd', leans_on_reference: null, suggested_targets: [], why: 'w' },
  ],
  recommended: 'c1',
  warnings: [],
  missing: [],
};

const BASE: BasePackage = {
  strategy: { intended_use: 'organic' },
  design_text: { project_name_lead: 'مشروع الاختبار', fact_refs: ['F1'] },
  slides: [],
  assets: [],
  references: [],
  ai_recommendations: [],
  facts_used: ['F1'],
  warnings: [],
  missing: [],
} as unknown as BasePackage;

const DERIVATIVES: DerivativesOutput = {
  derivatives: [{
    target: TARGET,
    dimensions: { aspect: '4:5', px: [1080, 1350] },
    adaptation: {},
    copy: { caption: 'كابشن', hashtags: ['#وصل_العقارية'], char_count: 6, fact_refs: ['F2'] },
    limits: {},
    warnings: [],
  } as unknown as DerivativesOutput['derivatives'][number]],
};

function stageResult<T>(output: T, over: Partial<DirectorStageResult<T>> = {}): DirectorStageResult<T> {
  return {
    output,
    validation: { ok: true, errors: [], warnings: [] },
    needs_attention: false,
    retried: false,
    rolesJson: { calls: 1 },
    cost_usd: 0.01,
    ...over,
  };
}

function fakeContext(over: Partial<CreativeJobContext> = {}): CreativeJobContext {
  const rules: WriterRules = { shared: [], post: [], decisions_log: [] };
  const ctx: CreativeJobContext = {
    content: { id: CONTENT_ID, title: 'منشور تجريبي', language: 'ar', content_type_key: 'post', project_id: 'p', project_ids: ['p'], campaign_id: null, organic_platforms: ['instagram'] },
    brief: null,
    facts: { package: { project_name: 'مشروع الاختبار', viable: true, facts: [] } as never, catalog: '', refs: [] },
    brandKit: null,
    writerRules: rules,
    flags: { post_enabled: true, ai_image_execution: false, design_reads_enabled: false, asset_enrich_v2: false, backfill_enabled: false },
    targets: [TARGET],
    specs: [],
    referenceRows: [],
    assetRows: [],
    qvec: null,
    recipe: 'offer',
    intendedUse: null,
    toDirectorInput(extra) {
      return {
        brief: null,
        content: { language: 'ar', title: 'منشور تجريبي', content_type_key: 'post' },
        facts: ctx.facts,
        brandKit: null,
        rules,
        targets: ctx.targets,
        specs: [],
        referenceRows: [],
        assetRows: [],
        recipe: 'offer',
        ...extra,
      };
    },
    ...over,
  };
  return ctx;
}

interface IoSpies {
  io: CreativeJobIo;
  insertedPackages: Array<Record<string, unknown>>;
  insertedDerivatives: Array<{ packageId: string; count: number }>;
  insertedRefs: string[];
  superseded: string[];
  rejected: Array<{ id: string; note: string }>;
  notified: Array<{ stage: string }>;
  stages: string[];
}

function fakeIo(over: Partial<CreativeJobIo> = {}): IoSpies {
  const spies: IoSpies = {
    io: {} as CreativeJobIo,
    insertedPackages: [],
    insertedDerivatives: [],
    insertedRefs: [],
    superseded: [],
    rejected: [],
    notified: [],
    stages: [],
  };
  spies.io = {
    loadJobContext: async () => fakeContext(),
    loadPackageRow: async () => null,
    loadPackageTargets: async () => [TARGET],
    nextVersion: async () => 3,
    insertPackage: async (_sb, args) => {
      spies.insertedPackages.push(args as unknown as Record<string, unknown>);
      return `pkg-v${args.version}`;
    },
    insertDerivatives: async (_sb, packageId, ders) => {
      spies.insertedDerivatives.push({ packageId, count: ders.length });
    },
    insertRefs: async (_sb, packageId) => {
      spies.insertedRefs.push(packageId);
    },
    supersedePackage: async (_sb, id) => { spies.superseded.push(id); },
    rejectPackage: async (_sb, id, note) => { spies.rejected.push({ id, note }); },
    notifyRequester: async (_sb, args) => { spies.notified.push({ stage: args.stage }); },
    setStage: async (_sb, _job, stage) => { spies.stages.push(stage); },
    ...over,
  };
  return spies;
}

function fakeDirector(over: Partial<CreativeDirector> = {}): CreativeDirector {
  return {
    runConcepts: async () => stageResult(CONCEPTS),
    runPackage: async () => stageResult(BASE),
    runRegenerate: async () => stageResult(BASE),
    runDerivatives: async () => stageResult(DERIVATIVES),
    ...over,
  };
}

function job(kind: CreativeJobLike['kind'], params: Record<string, unknown> = {}): CreativeJobLike {
  return { id: 'job-1', content_id: CONTENT_ID, kind, params, requested_by: USER_ID, attempts: 1 };
}

afterEach(() => vi.restoreAllMocks());

describe('post_concepts', () => {
  it('persists a concepts package and notifies', async () => {
    const io = fakeIo();
    const outcome = await runCreativeJob({ supabase: SB, env: ENV, job: job('post_concepts', { targets: [TARGET] }), io: io.io, director: fakeDirector() });
    expect(io.insertedPackages).toHaveLength(1);
    const pkg = io.insertedPackages[0]!;
    expect(pkg.stage).toBe('concepts');
    expect(pkg.concepts).toEqual(CONCEPTS as unknown as Record<string, unknown>);
    expect(pkg.base).toBeNull();
    expect(pkg.version).toBe(3);
    expect(io.insertedDerivatives).toHaveLength(0);
    expect(io.notified).toEqual([{ stage: 'concepts' }]);
    expect(outcome.result.package_id).toBe('pkg-v3');
    expect(outcome.result.needs_attention).toBe(false);
    expect(Object.keys(outcome.roles)).toEqual(['concepts']);
    expect(outcome.cost_usd).toBe(0.01);
    expect(io.stages).toContain('concepts');
    expect(io.stages).toContain('persist');
  });

  it('a failed stage leaves packages untouched', async () => {
    const io = fakeIo();
    const director = fakeDirector({ runConcepts: async () => { throw new Error('facts_insufficient: not viable'); } });
    await expect(runCreativeJob({ supabase: SB, env: ENV, job: job('post_concepts'), io: io.io, director })).rejects.toThrow(/^facts_insufficient:/);
    expect(io.insertedPackages).toHaveLength(0);
    expect(io.insertedDerivatives).toHaveLength(0);
    expect(io.superseded).toHaveLength(0);
    expect(io.notified).toHaveLength(0);
  });
});

describe('post_package', () => {
  const conceptsRow = { id: 'cpkg', concepts: CONCEPTS } as CreativePackageRow;

  it('runs package + derivatives and persists a full version', async () => {
    const io = fakeIo({ loadPackageRow: async () => conceptsRow });
    const outcome = await runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_package', { package_id: 'cpkg', concept_id: 'c1', targets: [TARGET] }),
      io: io.io, director: fakeDirector(),
    });
    const pkg = io.insertedPackages[0]!;
    expect(pkg.stage).toBe('package');
    expect(pkg.base).toEqual(BASE as unknown as Record<string, unknown>);
    expect(pkg.concept_id).toBe('c1');
    expect(pkg.facts_used).toEqual(['F1', 'F2']); // base + derivative copy refs
    expect(io.insertedDerivatives).toEqual([{ packageId: 'pkg-v3', count: 1 }]);
    expect(io.insertedRefs).toEqual(['pkg-v3']);
    expect(io.notified).toEqual([{ stage: 'package' }]);
    expect(Object.keys(outcome.roles)).toEqual(['package', 'derivatives']);
    expect(outcome.cost_usd).toBe(0.02);
  });

  it('rejects when neither concept_id nor custom is given — no writes', async () => {
    const io = fakeIo({ loadPackageRow: async () => conceptsRow });
    await expect(runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_package', { package_id: 'cpkg' }),
      io: io.io, director: fakeDirector(),
    })).rejects.toThrow(/concept_id or params\.custom/);
    expect(io.insertedPackages).toHaveLength(0);
  });

  it('marks the package rejected when derivatives insert fails after the package insert', async () => {
    const io = fakeIo({
      loadPackageRow: async () => conceptsRow,
      insertDerivatives: async () => { throw new Error('provider:supabase insert blew up'); },
    });
    await expect(runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_package', { package_id: 'cpkg', concept_id: 'c1' }),
      io: io.io, director: fakeDirector(),
    })).rejects.toThrow(/insert blew up/);
    expect(io.insertedPackages).toHaveLength(1);
    expect(io.rejected).toHaveLength(1);
    expect(io.rejected[0]!.id).toBe('pkg-v3');
    expect(io.rejected[0]!.note).toMatch(/^persist_failed: /);
    expect(io.notified).toHaveLength(0);
  });
});

describe('post_regenerate', () => {
  const prevRow = { id: 'prev-1', base: BASE, concept_id: 'c2', intended_use: 'both' } as CreativePackageRow;

  it('regenerates into a new version and supersedes the old one', async () => {
    const io = fakeIo({ loadPackageRow: async () => prevRow });
    // No params.targets → inherited from the previous package's derivatives.
    const ctx = fakeContext({ targets: [] });
    io.io.loadJobContext = async () => ctx;
    const outcome = await runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_regenerate', { package_id: 'prev-1', revision_note: 'غيّر الزاوية' }),
      io: io.io, director: fakeDirector(),
    });
    expect(io.insertedPackages).toHaveLength(1);
    const pkg = io.insertedPackages[0]!;
    expect(pkg.stage).toBe('package');
    expect(pkg.revision_note).toBe('غيّر الزاوية');
    expect(pkg.concept_id).toBe('c2');
    expect(pkg.intended_use).toBe('both');
    expect(io.superseded).toEqual(['prev-1']);
    expect(io.insertedDerivatives).toEqual([{ packageId: 'pkg-v3', count: 1 }]);
    expect(outcome.result.needs_attention).toBe(false);
  });
});

describe('post_derivatives', () => {
  const prevRow = { id: 'prev-1', base: BASE, concept_id: 'c2', intended_use: 'organic' } as CreativePackageRow;

  it('creates a new version with the same base + new derivatives, WITHOUT superseding', async () => {
    const io = fakeIo({ loadPackageRow: async () => prevRow });
    await runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_derivatives', { package_id: 'prev-1', targets: [TARGET] }),
      io: io.io, director: fakeDirector(),
    });
    const pkg = io.insertedPackages[0]!;
    expect(pkg.base).toEqual(BASE as unknown as Record<string, unknown>);
    expect(io.insertedDerivatives).toEqual([{ packageId: 'pkg-v3', count: 1 }]);
    expect(io.superseded).toHaveLength(0);
  });

  it('refuses without params.targets — no writes', async () => {
    const io = fakeIo({ loadPackageRow: async () => prevRow });
    io.io.loadJobContext = async () => fakeContext({ targets: [] });
    await expect(runCreativeJob({
      supabase: SB, env: ENV,
      job: job('post_derivatives', { package_id: 'prev-1' }),
      io: io.io, director: fakeDirector(),
    })).rejects.toThrow(/params\.targets/);
    expect(io.insertedPackages).toHaveLength(0);
  });
});

describe('validation_needs_attention', () => {
  it('completes with needs_attention when validation is unrepaired (never throws)', async () => {
    const io = fakeIo();
    const director = fakeDirector({
      runConcepts: async () => stageResult(CONCEPTS, {
        validation: { ok: false, errors: [{ path: 'concepts[0]', rule: 'x', detail: 'd' }], warnings: [] },
        needs_attention: true,
        retried: true,
      }),
    });
    const outcome = await runCreativeJob({ supabase: SB, env: ENV, job: job('post_concepts'), io: io.io, director });
    expect(outcome.result.needs_attention).toBe(true);
    expect(outcome.result.retried).toBe(true);
    expect(io.insertedPackages).toHaveLength(1); // draft persisted with warnings
  });
});

describe('classifyCreativeError', () => {
  it('maps the stable prefixes', () => {
    expect(classifyCreativeError(new Error('provider:anthropic 529 overloaded')).kind).toBe('provider');
    expect(classifyCreativeError(new Error('facts_insufficient: no project')).kind).toBe('facts_insufficient');
    expect(classifyCreativeError(new Error('validation_unrepaired: 3 errors')).kind).toBe('validation_unrepaired');
    expect(classifyCreativeError(new Error('rights_blocked: competitor')).kind).toBe('rights_blocked');
    expect(classifyCreativeError(new Error('policy_blocked: fabrication')).kind).toBe('policy_blocked');
    expect(classifyCreativeError(new Error('budget_exceeded: cap')).kind).toBe('budget_exceeded');
  });
  it('maps network-ish failures to transient', () => {
    expect(classifyCreativeError(new Error('fetch failed')).kind).toBe('transient');
    expect(classifyCreativeError(new Error('upstream request timeout')).kind).toBe('transient');
  });
  it('maps a max_tokens truncation to output_truncated (NON-retryable), not provider', () => {
    // Live regression (أكنان 25 package): the model call exceeded max_tokens.
    // It arrives prefixed `provider:` but is DETERMINISTIC — must not requeue,
    // or the job loops burning an opus-5 call each attempt.
    const err = new Error('provider:anthropic max_tokens reached before the JSON was complete (model=claude-opus-5, max_tokens=8000)');
    expect(classifyCreativeError(err).kind).toBe('output_truncated');
  });
  it('everything else is unknown (terminal)', () => {
    expect(classifyCreativeError(new Error('post_package job is missing params.package_id')).kind).toBe('unknown');
    expect(classifyCreativeError('a string throw').kind).toBe('unknown');
  });
});
