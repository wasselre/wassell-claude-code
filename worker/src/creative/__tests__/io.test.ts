/**
 * io.ts tests — fake Supabase client, no network.
 *
 * Covered: parseTargets/specsForTargets/enrichTargetRefs, the package write
 * helpers (insertPackage/insertDerivatives/insertRefs incl. the rights
 * snapshot on selected assets, supersede/reject/patch), notifyRequester
 * (event 'post_creative_ready', best-effort), and a full loadJobContext
 * assembly against canned rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enrichTargetRefs,
  insertDerivatives,
  insertPackage,
  insertRefs,
  loadCreativeFlags,
  loadJobContext,
  loadWriterRules,
  nextVersion,
  notifyRequester,
  parseTargets,
  patchPackage,
  rejectPackage,
  specsForTargets,
  supersedePackage,
  type CreativeJobLike,
} from '../io';
import type { BasePackage, Derivative, DerivativeTarget } from '../contracts';

// ── Fake supabase ────────────────────────────────────────────────────────────

type Resp = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });

interface RecordedCall { table: string | null; method: string; args: unknown[] }
type Resolver = (q: { table: string | null; method: string; args: unknown[]; calls: RecordedCall[] }) => Resp;

interface FakeSb extends SupabaseClient { calls: RecordedCall[] }

function fakeSb(resolver: Resolver): FakeSb {
  const calls: RecordedCall[] = [];
  function makeChain(table: string | null, pending: string | null): unknown {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          const resp = resolver({ table, method: pending ?? 'select', args: [], calls });
          return (resolve: (v: Resp) => unknown) => Promise.resolve(resp).then(resolve);
        }
        return (...args: unknown[]) => {
          const method = String(prop);
          calls.push({ table, method, args });
          if (method === 'maybeSingle' || method === 'single') {
            return Promise.resolve(resolver({ table, method, args, calls }));
          }
          if (method === 'insert' || method === 'update' || method === 'upsert' || method === 'delete') {
            return makeChain(table, method);
          }
          return makeChain(table, pending);
        };
      },
    });
  }
  const sb = {
    calls,
    from: (table: string) => makeChain(table, null),
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ table: null, method: `rpc:${fn}`, args: [args] });
      return Promise.resolve(resolver({ table: null, method: `rpc:${fn}`, args: [args], calls }));
    },
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://pub.test/${bucket}/${path}` } }),
        createSignedUrl: async (path: string, _ttl: number) => ({ data: { signedUrl: `https://sig.test/${bucket}/${path}` }, error: null }),
        upload: async (path: string) => ({ data: { path }, error: null }),
      }),
    },
  };
  return sb as unknown as FakeSb;
}

// ── Canned rows ──────────────────────────────────────────────────────────────

const CONTENT_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

const CONTENT_ROW = {
  id: CONTENT_ID,
  title: 'منشور تجريبي',
  language: 'ar',
  content_type_key: 'post',
  project_id: PROJECT_ID,
  project_ids: [PROJECT_ID],
  campaign_id: null,
  organic_platforms: ['instagram'],
};

const PROJECT_RECORD = {
  project_name: 'مشروع الاختبار',
  construction_status: 'ready',
  available_units: 5,
  available_price_range: { min: 1_000_000, max: 2_000_000 },
  developer: 'مطور الاختبار',
};

const BRAND_KIT = {
  version: 3,
  status: 'reviewed',
  mode: 'constraint',
  palette: [{ name: 'copper', hex: '#B8734F', roles: ['primary'] }],
  typography: {}, logo: {}, character: {}, image_treatment: {}, prohibited: [],
};

const WRITER_RULES = { shared: ['s1'], post: ['p1'], video: ['v1'], decisions_log: [{ date: '2026-09-01', note: 'n' }] };

const TARGET: DerivativeTarget = {
  target_kind: 'organic',
  platform: 'instagram',
  placement_type: 'feed',
  target_ref: {},
};

function resolverWith(overrides: Partial<Record<string, Resp>> = {}): Resolver {
  return ({ table, method }) => {
    const key = method.startsWith('rpc:') ? method : `${table}:${method}`;
    const hit = overrides[key] ?? overrides[method];
    if (hit) return hit;
    if (table === 'mos_content_v' && method === 'maybeSingle') return ok(CONTENT_ROW);
    if (method === 'rpc:mos_script_brief') return ok({ content_id: CONTENT_ID, project_id: PROJECT_ID, language: 'ar', platforms: ['instagram'] });
    if (table === 'unified_records' && method === 'maybeSingle') return ok({ data: PROJECT_RECORD });
    if (table === 'mos_settings' && method === 'maybeSingle') return ok(null);
    if (method === 'rpc:creative_candidate_assets') return ok([]);
    if (method === 'rpc:mkt_creative_references') return ok([]);
    if (method === 'rpc:mos_creative_package_next_version') return ok(7);
    if (table === 'mos_publications') return ok([]);
    if (table === 'mos_execution_ads') return ok([]);
    return ok(null);
  };
}

/** Settings-aware resolver: distinguishes the three mos_settings keys by inspecting the .eq('key', …) call. */
function settingsResolver(settingsByKey: Record<string, unknown>, base: Resolver): Resolver {
  return (q) => {
    if (q.table === 'mos_settings' && q.method === 'maybeSingle') {
      const eqCall = q.calls.filter((c) => c.table === 'mos_settings' && c.method === 'eq').at(-1);
      const key = eqCall?.args[1] as string | undefined;
      return ok(key && key in settingsByKey ? { value: settingsByKey[key] } : null);
    }
    return base(q);
  };
}

beforeEach(() => {
  delete process.env.MODAL_CV_URL; // intent vector off in tests
});
afterEach(() => vi.restoreAllMocks());

// ── parseTargets / specsForTargets ───────────────────────────────────────────

describe('parseTargets', () => {
  it('parses valid targets', () => {
    const out = parseTargets({ targets: [TARGET] });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(TARGET);
  });
  it('returns [] when absent', () => {
    expect(parseTargets({})).toEqual([]);
  });
  it('throws on a malformed entry (terminal, never retried)', () => {
    expect(() => parseTargets({ targets: [{ target_kind: 'weird', platform: 'instagram', placement_type: 'feed' }] })).toThrow(/not a DerivativeTarget/);
  });
});

describe('specsForTargets', () => {
  it('dedupes and resolves real specs', () => {
    const specs = specsForTargets([TARGET, { ...TARGET }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.platform).toBe('instagram');
    expect(specs[0]!.placement_type).toBe('feed');
  });
  it('logs loudly for an unknown placement and continues', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const specs = specsForTargets([{ target_kind: 'organic', platform: 'myspace', placement_type: 'feed', target_ref: {} } as DerivativeTarget]);
    expect(specs).toHaveLength(0);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

// ── enrichTargetRefs ─────────────────────────────────────────────────────────

describe('enrichTargetRefs', () => {
  it('fills a missing publication_id from the latest matching publication', async () => {
    const sb = fakeSb(({ table }) => {
      if (table === 'mos_publications') return ok([
        { id: 'pub-old', platform: 'instagram', created_at: '2026-01-01T00:00:00Z' },
        { id: 'pub-new', platform: 'instagram', created_at: '2026-02-01T00:00:00Z' },
        { id: 'pub-other', platform: 'tiktok', created_at: '2026-03-01T00:00:00Z' },
      ]);
      return ok([]);
    });
    const out = await enrichTargetRefs(sb, CONTENT_ID, [TARGET]);
    expect(out[0]!.target_ref.publication_id).toBe('pub-new');
  });

  it('fills paid ids only when exactly one non-archived ad row exists', async () => {
    const paid: DerivativeTarget = { target_kind: 'paid', platform: 'meta', placement_type: 'ad_feed', target_ref: {} };
    const one = fakeSb(({ table }) => (table === 'mos_execution_ads' ? ok([{ id: 'ad-1', execution_id: 'ex-1', ad_set_id: 'set-1' }]) : ok([])));
    const filled = await enrichTargetRefs(one, CONTENT_ID, [paid]);
    expect(filled[0]!.target_ref).toEqual({ execution_id: 'ex-1', ad_set_id: 'set-1', ad_id: 'ad-1' });

    const many = fakeSb(({ table }) => (table === 'mos_execution_ads' ? ok([{ id: 'ad-1', execution_id: 'ex-1', ad_set_id: null }, { id: 'ad-2', execution_id: 'ex-2', ad_set_id: null }]) : ok([])));
    const untouched = await enrichTargetRefs(many, CONTENT_ID, [paid]);
    expect(untouched[0]!.target_ref).toEqual({});
  });

  it('never overwrites an already-stamped target_ref', async () => {
    const sb = fakeSb(({ table }) => (table === 'mos_publications' ? ok([{ id: 'pub-new', platform: 'instagram', created_at: '2026-02-01T00:00:00Z' }]) : ok([])));
    const out = await enrichTargetRefs(sb, CONTENT_ID, [{ ...TARGET, target_ref: { publication_id: 'pub-orig' } }]);
    expect(out[0]!.target_ref.publication_id).toBe('pub-orig');
  });
});

// ── settings readers ─────────────────────────────────────────────────────────

describe('loadCreativeFlags / loadWriterRules', () => {
  it('reads flags', async () => {
    const sb = fakeSb(settingsResolver({ creative_writer: { post_enabled: true, ai_image_execution: false } }, resolverWith()));
    const flags = await loadCreativeFlags(sb);
    expect(flags.post_enabled).toBe(true);
    expect(flags.ai_image_execution).toBe(false);
  });
  it('reads writer rules and degrades loudly when missing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = fakeSb(settingsResolver({}, resolverWith()));
    const rules = await loadWriterRules(sb);
    expect(rules).toEqual({ shared: [], post: [], decisions_log: [] });
    expect(err).toHaveBeenCalledTimes(1);
  });
});

// ── package writes ───────────────────────────────────────────────────────────

describe('package writes', () => {
  const insertArgs = {
    content_id: CONTENT_ID,
    version: 7,
    stage: 'package' as const,
    intended_use: 'organic' as const,
    language: 'ar',
    recipe: 'offer',
    concept_id: 'c1',
    concepts: null,
    base: { strategy: {} },
    facts: { package: {} },
    facts_used: ['F1'],
    brand_kit_version: 3,
    brand_kit_mode: 'constraint' as const,
    roles: { package: {} },
    cost_usd: 0.02,
    job_id: 'job-1',
    created_by_user_id: USER_ID,
    revision_note: null,
  };

  it('insertPackage writes the row and returns the id', async () => {
    const sb = fakeSb(({ table, method }) => (table === 'mos_creative_packages' && method === 'single' ? ok({ id: 'pkg-new' }) : ok(null)));
    const id = await insertPackage(sb, insertArgs);
    expect(id).toBe('pkg-new');
    const insert = sb.calls.find((c) => c.table === 'mos_creative_packages' && c.method === 'insert');
    const row = (insert!.args[0] as Record<string, unknown>);
    expect(row.version).toBe(7);
    expect(row.stage).toBe('package');
    expect(row.status).toBe('draft');
    expect(row.generated_by).toBe('ai');
    expect(row.facts_used).toEqual(['F1']);
  });

  it('nextVersion reads the RPC', async () => {
    const sb = fakeSb(resolverWith());
    expect(await nextVersion(sb, CONTENT_ID)).toBe(7);
    expect(sb.calls.some((c) => c.method === 'rpc:mos_creative_package_next_version')).toBe(true);
  });

  it('insertDerivatives writes one row per derivative', async () => {
    const sb = fakeSb(() => ok(null));
    const d = {
      target: TARGET,
      dimensions: { aspect: '4:5', px: [1080, 1350] as [number, number] },
      adaptation: { aspect: '4:5' },
      copy: { caption: 'c', hashtags: [], char_count: 1, fact_refs: ['F1'] },
      limits: {},
      warnings: [],
    } as unknown as Derivative;
    await insertDerivatives(sb, 'pkg-1', [d]);
    const insert = sb.calls.find((c) => c.table === 'mos_creative_derivatives' && c.method === 'insert');
    const rows = insert!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.package_id).toBe('pkg-1');
    expect(rows[0]!.platform).toBe('instagram');
    expect(rows[0]!.status).toBe('draft');
  });

  it('insertRefs snapshots rights on selected assets and rationale on references', async () => {
    const sb = fakeSb(() => ok(null));
    const base = {
      references: [{
        ref_kind: 'competitor_media', ref_id: 'r1', post_id: 'p1', slide_index: 0, level: 'slide',
        preview_url: 'https://x', aspect: 'composition', why: 'w', study: 's', adapt: 'a', do_not_copy: 'd', differ: 'df',
      }],
      assets: [{
        file_id: 'f1', nature: 'real', source: 'developer', rights: 'approved', rights_verified: true,
        production_state: 'raw', placement: 'slide 1 primary', usage: 'direct', treatment: 'none',
        why: 'hero', is_production: true, needs_rights_confirmation: false,
      }],
    } as unknown as BasePackage;
    await insertRefs(sb, 'pkg-1', base);
    const insert = sb.calls.find((c) => c.table === 'mos_creative_refs' && c.method === 'insert');
    const rows = insert!.args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const ref = rows.find((r) => r.role === 'reference')!;
    expect(ref.ref_kind).toBe('competitor_media');
    expect((ref.rationale as Record<string, unknown>).why).toBe('w');
    const asset = rows.find((r) => r.role === 'selected_asset')!;
    expect(asset.ref_kind).toBe('file');
    expect(asset.ref_id).toBe('f1');
    expect((asset.rights_snapshot as Record<string, unknown>).usage_rights).toBe('approved');
    expect((asset.rights_snapshot as Record<string, unknown>).rights_verified).toBe(true);
    expect(asset.usage).toBe('direct');
  });

  it('supersedePackage / rejectPackage flip status, never delete', async () => {
    const sb = fakeSb(() => ok(null));
    await supersedePackage(sb, 'pkg-1');
    await rejectPackage(sb, 'pkg-2', 'persist_failed: boom');
    const updates = sb.calls.filter((c) => c.table === 'mos_creative_packages' && c.method === 'update');
    expect(updates).toHaveLength(2);
    expect((updates[0]!.args[0] as Record<string, unknown>).status).toBe('superseded');
    expect((updates[1]!.args[0] as Record<string, unknown>).status).toBe('rejected');
    expect((updates[1]!.args[0] as Record<string, unknown>).revision_note).toBe('persist_failed: boom');
    expect(sb.calls.some((c) => c.method === 'delete')).toBe(false);
  });

  it('patchPackage calls the surgical RPC', async () => {
    const sb = fakeSb(() => ok(null));
    await patchPackage(sb, 'pkg-1', ['ai_recommendations', '0', 'execution'], { job_id: 'j' });
    const rpc = sb.calls.find((c) => c.method === 'rpc:mos_creative_package_patch');
    expect(rpc).toBeDefined();
    expect(rpc!.args[0]).toEqual({ p_package_id: 'pkg-1', p_path: ['ai_recommendations', '0', 'execution'], p_value: { job_id: 'j' } });
  });
});

// ── notifyRequester ──────────────────────────────────────────────────────────

describe('notifyRequester', () => {
  it('emits post_creative_ready to the requester', async () => {
    const sb = fakeSb(() => ok(null));
    await notifyRequester(sb, { requestedBy: USER_ID, contentId: CONTENT_ID, contentTitle: 'منشور تجريبي', stage: 'concepts' });
    const rpc = sb.calls.find((c) => c.method === 'rpc:notify_emit');
    expect(rpc).toBeDefined();
    const args = rpc!.args[0] as Record<string, unknown>;
    expect(args.p_event).toBe('post_creative_ready');
    expect(args.p_workspace).toBe('marketing');
    expect(args.p_user_ids).toEqual([USER_ID]);
    expect(args.p_url).toBe(`/m/content/${CONTENT_ID}`);
  });

  it('is best-effort — an RPC failure is logged, never thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = fakeSb(({ method }) => (method === 'rpc:notify_emit' ? { data: null, error: { message: 'boom' } } : ok(null)));
    await expect(notifyRequester(sb, { requestedBy: USER_ID, contentId: CONTENT_ID, contentTitle: null, stage: 'package' })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});

// ── loadJobContext ───────────────────────────────────────────────────────────

describe('loadJobContext', () => {
  const job: CreativeJobLike = {
    id: 'job-1',
    content_id: CONTENT_ID,
    kind: 'post_concepts',
    params: { recipe: 'offer', targets: [TARGET] },
    requested_by: USER_ID,
    attempts: 1,
  };

  it('assembles the full director bag', async () => {
    const stages: string[] = [];
    const sb = fakeSb(settingsResolver(
      { brand_kit: BRAND_KIT, writer_rules: WRITER_RULES, creative_writer: { post_enabled: true } },
      resolverWith(),
    ));
    const ctx = await loadJobContext(sb, job, { onStage: (s) => stages.push(s) });
    expect(ctx.content.title).toBe('منشور تجريبي');
    expect(ctx.content.language).toBe('ar');
    expect(ctx.facts.package.project_name).toBe('مشروع الاختبار');
    expect(ctx.facts.package.viable).toBe(true);
    expect(ctx.brandKit?.version).toBe(3);
    expect(ctx.writerRules.post).toEqual(['p1']);
    expect(ctx.flags.post_enabled).toBe(true);
    expect(ctx.recipe).toBe('offer');
    expect(ctx.targets).toHaveLength(1);
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.qvec).toBeNull(); // MODAL_CV_URL unset
    expect(stages).toEqual(['brief', 'facts', 'brand', 'references', 'assets', 'targets']);

    const input = ctx.toDirectorInput();
    expect(input.content.language).toBe('ar');
    expect(input.recipe).toBe('offer');
    expect(input.targets).toHaveLength(1);
    expect(input.rules.post).toEqual(['p1']);
  });

  it('throws facts_insufficient when the content has no project', async () => {
    const sb = fakeSb(settingsResolver({}, resolverWith({
      'mos_content_v:maybeSingle': ok({ ...CONTENT_ROW, project_id: null, project_ids: [] }),
    })));
    await expect(loadJobContext(sb, job)).rejects.toThrow(/^facts_insufficient:/);
  });

  it('throws facts_insufficient when the project record is missing', async () => {
    const sb = fakeSb(settingsResolver({}, resolverWith({
      'unified_records:maybeSingle': ok(null),
    })));
    await expect(loadJobContext(sb, job)).rejects.toThrow(/^facts_insufficient:/);
  });
});
