/**
 * runCreativeImageJob tests — fake io + fake image provider, no network.
 *
 * Covered: the ai_image_execution flag gate (policy_blocked), the §7 policy
 * re-check, competitor/restricted source refusal (rights_blocked), the happy
 * paths (generate → ai_generated, edit → ai_edited) where the output becomes a
 * needs_review candidate linked role='reference' — NEVER 'final' — and the
 * execution/status patches on the package.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env';
import {
  parseCreativeImageParams,
  roleForMode,
  runCreativeImageJob,
  type CreativeImageIo,
  type CreativeImageJob,
  type PackageForImage,
  type SourceFileRow,
} from '../runCreativeImageJob';
import type { ImageProvider, ImageResult } from '../imageProvider';
import type { BasePackage } from '../contracts';

const SB = {} as SupabaseClient;
const ENV = {} as WorkerEnv;
const PACKAGE_ID = '44444444-4444-4444-4444-444444444444';
const CONTENT_ID = '11111111-1111-1111-1111-111111111111';
const APPROVER = '33333333-3333-3333-3333-333333333333';
const AUTH_USER = '55555555-5555-5555-5555-555555555555';

const PKG: PackageForImage = {
  id: PACKAGE_ID,
  content_id: CONTENT_ID,
  base: {
    ai_recommendations: [{
      index: 0, mode: 'supporting_visual', source_file_ids: [], prompt: 'p', must_keep: [], must_change: [],
      aspect: '1:1', constraints: [], policy_check: '', status: 'approved',
    }],
  } as unknown as BasePackage,
};

const SOURCE_FILE: SourceFileRow = {
  id: 'file-src-1',
  original_name: 'hero.jpg',
  title: 'Hero',
  storage_bucket: 'wassel-files',
  storage_path: 'u/hero.jpg',
  usage_rights: 'approved',
  acquisition_source: 'developer',
};

function job(params: Record<string, unknown>): CreativeImageJob {
  return { id: 'gjob-1', recordId: 'rec-1', userId: AUTH_USER, params, attempts: 1 };
}

const VALID_GENERATE_PARAMS = {
  package_id: PACKAGE_ID,
  index: 0,
  mode: 'supporting_visual',
  prompt: 'خلفية لايف ستايل دافئة بألوان الهوية',
  source_file_ids: [],
  aspect: '1:1',
  must_keep: [],
  must_change: [],
  approved_by: APPROVER,
};

interface IoSpies {
  io: CreativeImageIo;
  executions: Array<{ packageId: string; index: number; execution: Record<string, unknown> }>;
  statuses: Array<{ packageId: string; index: number; status: string }>;
  files: Array<Record<string, unknown>>;
  mediaAssets: Array<Record<string, unknown>>;
  links: Array<{ assetId: string; contentId: string; role: string }>;
  uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }>;
}

function fakeIo(over: Partial<CreativeImageIo> = {}): IoSpies {
  const spies: IoSpies = { io: {} as CreativeImageIo, executions: [], statuses: [], files: [], mediaAssets: [], links: [], uploads: [] };
  spies.io = {
    readAiExecutionEnabled: async () => true,
    loadPackage: async () => PKG,
    loadContentTitle: async () => 'منشور تجريبي',
    loadSourceFiles: async (_sb, ids) => ids.map((id) => ({ ...SOURCE_FILE, id })),
    resolveSourceUrl: async (_sb, bucket, path) => `https://files.test/${bucket}/${path}?sig=1`,
    uploadOutput: async (_sb, path, bytes, contentType) => {
      spies.uploads.push({ path, bytes, contentType });
      return `https://pub.test/${path}`;
    },
    insertMediaAsset: async (_sb, row) => { spies.mediaAssets.push(row); return 'ma-1'; },
    insertFile: async (_sb, row) => { spies.files.push(row); return 'file-out-1'; },
    findOrCreateMosAsset: async () => 'asset-1',
    linkAsset: async (_sb, assetId, contentId, role) => { spies.links.push({ assetId, contentId, role }); },
    patchExecution: async (_sb, packageId, index, execution) => { spies.executions.push({ packageId, index, execution }); },
    patchStatus: async (_sb, packageId, index, status) => { spies.statuses.push({ packageId, index, status }); },
    ...over,
  };
  return spies;
}

function imageResult(urls: string[]): ImageResult {
  return { urls, provider: 'stub', model: 'fal-ai/test', cost_usd: null, latency_ms: 5 };
}

function fakeProvider(over: Partial<ImageProvider> = {}): ImageProvider {
  return {
    kind: 'stub',
    model: 'fal-ai/test',
    generate: vi.fn(async () => imageResult(['https://fal.test/out.png'])),
    edit: vi.fn(async () => imageResult(['https://fal.test/edited.png'])),
    combine: vi.fn(async () => imageResult(['https://fal.test/combined.png'])),
    removeText: vi.fn(async () => imageResult(['https://fal.test/clean.png'])),
    ...over,
  };
}

const fakeFetchOutput = async (_url: string) => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });

afterEach(() => vi.restoreAllMocks());

describe('parseCreativeImageParams', () => {
  it('parses a valid payload', () => {
    const p = parseCreativeImageParams(VALID_GENERATE_PARAMS);
    expect(p.package_id).toBe(PACKAGE_ID);
    expect(p.mode).toBe('supporting_visual');
    expect(p.aspect).toBe('1:1');
  });
  it('rejects missing essentials', () => {
    expect(() => parseCreativeImageParams({ ...VALID_GENERATE_PARAMS, package_id: '' })).toThrow(/package_id/);
    expect(() => parseCreativeImageParams({ ...VALID_GENERATE_PARAMS, approved_by: '' })).toThrow(/approved_by/);
    expect(() => parseCreativeImageParams({ ...VALID_GENERATE_PARAMS, prompt: '  ' })).toThrow(/prompt/);
  });
});

describe('roleForMode', () => {
  it('routes modes to the configured image roles', () => {
    expect(roleForMode('remove_text')).toBe('image_remove_text');
    expect(roleForMode('supporting_visual')).toBe('image_generate');
    expect(roleForMode('cleanup')).toBe('image_edit');
    expect(roleForMode('combine')).toBe('image_edit');
  });
});

describe('flag gate', () => {
  it('refuses with policy_blocked when ai_image_execution is off, and marks the execution failed', async () => {
    const io = fakeIo({ readAiExecutionEnabled: async () => false });
    const provider = fakeProvider();
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV, job: job(VALID_GENERATE_PARAMS),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/^policy_blocked: ai image execution disabled/);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(io.executions).toHaveLength(1);
    expect(String(io.executions[0]!.execution.error)).toMatch(/^policy_blocked:/);
    expect(io.statuses).toEqual([{ packageId: PACKAGE_ID, index: 0, status: 'failed' }]);
    expect(io.files).toHaveLength(0);
  });
});

describe('policy re-check', () => {
  it('refuses a fabrication prompt (§7) and never calls the provider', async () => {
    const io = fakeIo();
    const provider = fakeProvider();
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'extend_background', source_file_ids: ['file-src-1'], prompt: 'create a new building tower behind the existing one' }),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/^policy_blocked:/);
    expect(provider.edit).not.toHaveBeenCalled();
    expect(io.statuses).toEqual([{ packageId: PACKAGE_ID, index: 0, status: 'failed' }]);
  });

  it('request_photo is never executed', async () => {
    const io = fakeIo();
    const provider = fakeProvider();
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'request_photo' }),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/^policy_blocked: request_photo/);
    expect(provider.generate).not.toHaveBeenCalled();
  });
});

describe('source rights', () => {
  it('refuses a competitor source with rights_blocked', async () => {
    const io = fakeIo({ loadSourceFiles: async () => [{ ...SOURCE_FILE, acquisition_source: 'competitor' }] });
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'cleanup', source_file_ids: ['file-src-1'] }),
      io: io.io, providerFactory: async () => fakeProvider(), fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/^rights_blocked:/);
  });

  it('refuses a restricted/do_not_use source with rights_blocked', async () => {
    const io = fakeIo({ loadSourceFiles: async () => [{ ...SOURCE_FILE, usage_rights: 'do_not_use' }] });
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'cleanup', source_file_ids: ['file-src-1'] }),
      io: io.io, providerFactory: async () => fakeProvider(), fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/^rights_blocked:/);
  });
});

describe('happy paths', () => {
  it('supporting_visual → generate → ai_generated needs_review candidate, linked reference (never final)', async () => {
    const io = fakeIo();
    const provider = fakeProvider();
    const outcome = await runCreativeImageJob({
      supabase: SB, env: ENV, job: job(VALID_GENERATE_PARAMS),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    });

    expect(provider.generate).toHaveBeenCalledWith({ prompt: VALID_GENERATE_PARAMS.prompt, aspect: '1:1', n: 1 });
    expect(io.uploads).toHaveLength(1);
    expect(io.uploads[0]!.path).toMatch(new RegExp(`^creative/${CONTENT_ID}/.+\\.png$`));

    expect(io.mediaAssets).toHaveLength(1);
    const ma = io.mediaAssets[0]!;
    expect(ma.kind).toBe('image');
    expect(ma.prompt).toBe(VALID_GENERATE_PARAMS.prompt);
    expect(ma.created_by_user_id).toBe(AUTH_USER);
    expect((ma.settings as Record<string, unknown>).package_id).toBe(PACKAGE_ID);

    expect(io.files).toHaveLength(1);
    const f = io.files[0]!;
    expect(f.kind).toBe('image');
    expect(f.asset_nature).toBe('ai_generated');
    expect(f.usage_rights).toBe('needs_review');
    expect(f.production_state).toBe('edited');
    expect(f.acquisition_source).toBe('internal');
    expect(f.primary_category).toBe('ai_content');
    expect(f.uploaded_by_user_id).toBe(APPROVER);
    expect(String(f.title)).toContain('AI · supporting_visual · منشور تجريبي');
    expect(f.storage_bucket).toBe('marketing-assets');

    expect(io.links).toEqual([{ assetId: 'asset-1', contentId: CONTENT_ID, role: 'reference' }]);
    expect(io.links.some((l) => l.role === 'final')).toBe(false);

    expect(io.executions).toHaveLength(1);
    expect(io.executions[0]!.execution.output_file_id).toBe('file-out-1');
    expect(io.executions[0]!.execution.error).toBeNull();
    expect(io.executions[0]!.execution.approved_by).toBe(APPROVER);
    expect(io.statuses).toEqual([{ packageId: PACKAGE_ID, index: 0, status: 'completed' }]);

    expect(outcome.file_id).toBe('file-out-1');
    expect(outcome.asset_id).toBe('asset-1');
  });

  it('cleanup with one source → edit with keepFraming, asset_nature ai_edited', async () => {
    const io = fakeIo();
    const provider = fakeProvider();
    await runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'cleanup', source_file_ids: ['file-src-1'] }),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    });
    expect(provider.edit).toHaveBeenCalledWith({
      prompt: VALID_GENERATE_PARAMS.prompt,
      sources: ['https://files.test/wassel-files/u/hero.jpg?sig=1'],
      aspect: '1:1',
      keepFraming: true,
    });
    expect(io.files[0]!.asset_nature).toBe('ai_edited');
  });

  it('remove_text routes to provider.removeText', async () => {
    const io = fakeIo();
    const provider = fakeProvider();
    await runCreativeImageJob({
      supabase: SB, env: ENV,
      job: job({ ...VALID_GENERATE_PARAMS, mode: 'remove_text', source_file_ids: ['file-src-1'] }),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    });
    expect(provider.removeText).toHaveBeenCalledWith({ source: 'https://files.test/wassel-files/u/hero.jpg?sig=1' });
    expect(provider.edit).not.toHaveBeenCalled();
  });

  it('a missing package fails before any provider call', async () => {
    const io = fakeIo({ loadPackage: async () => null });
    const provider = fakeProvider();
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV, job: job(VALID_GENERATE_PARAMS),
      io: io.io, providerFactory: async () => provider, fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/not found or has no base/);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('a persist failure marks the execution failed and rethrows', async () => {
    const io = fakeIo({ insertFile: async () => { throw new Error('provider:supabase files insert failed: dup'); } });
    await expect(runCreativeImageJob({
      supabase: SB, env: ENV, job: job(VALID_GENERATE_PARAMS),
      io: io.io, providerFactory: async () => fakeProvider(), fetchOutput: fakeFetchOutput,
    })).rejects.toThrow(/files insert failed/);
    expect(io.statuses).toEqual([{ packageId: PACKAGE_ID, index: 0, status: 'failed' }]);
    expect(String(io.executions[0]!.execution.error)).toMatch(/files insert failed/);
  });
});
