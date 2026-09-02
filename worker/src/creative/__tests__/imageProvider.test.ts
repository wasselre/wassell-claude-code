import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createImageProvider,
  mapAspectToFal,
  resolveImageProvider,
  type ImageTransport,
} from '../imageProvider';
import { resetCreativeRolesState, type SettingsClient } from '../roles';
import type { ImageGenPollResult, ImageGenStartResult } from '../../imageGen';

const START: ImageGenStartResult = { requestId: 'r1', statusUrl: 'https://x/status', responseUrl: 'https://x/resp' };
const OK: ImageGenPollResult = { status: 'completed', imageUrls: ['https://img/1.png', 'https://img/2.png'] };

interface CapturedCall {
  fn: 'chat' | 'textRemoval';
  opts: Record<string, unknown>;
  /** Env vars as seen synchronously inside the transport call — proves withModelEnv honoured the configured model. */
  env: Record<string, string | undefined>;
}

function fakeTransport(poll: ImageGenPollResult = OK): { transport: ImageTransport; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const envKeys = ['FAL_CHAT_MODEL_ID', 'FAL_CHAT_T2I_MODEL_ID', 'FAL_CLEAN_TEXT_MODEL_ID', 'FAL_CLEAN_TEXT_PROMPT'];
  const capture = (fn: CapturedCall['fn'], opts: Record<string, unknown>): ImageGenStartResult => {
    const env: Record<string, string | undefined> = {};
    for (const k of envKeys) env[k] = process.env[k];
    calls.push({ fn, opts, env });
    return START;
  };
  return {
    calls,
    transport: {
      chat: async (opts) => capture('chat', opts as unknown as Record<string, unknown>),
      textRemoval: async (opts) => capture('textRemoval', opts as unknown as Record<string, unknown>),
      poll: async () => poll,
    },
  };
}

const FAL_CFG = { provider: 'fal' as const, model: 'fal-ai/test-model' };
const EDIT_CFG = { provider: 'fal' as const, model: 'fal-ai/test-edit' };
const CLEAN_CFG = { provider: 'fal' as const, model: 'fal-ai/test-klein' };

function fakeSb(value: unknown): SettingsClient {
  return {
    from: (_t: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { value }, error: null }) }),
      }),
    }),
  } as unknown as SettingsClient;
}

beforeEach(() => {
  resetCreativeRolesState();
  delete process.env.FAL_CHAT_MODEL_ID;
  delete process.env.FAL_CHAT_T2I_MODEL_ID;
  delete process.env.FAL_CLEAN_TEXT_MODEL_ID;
  delete process.env.FAL_CLEAN_TEXT_PROMPT;
});
afterEach(() => vi.restoreAllMocks());

describe('mapAspectToFal', () => {
  it('passes native ratios through', () => {
    expect(mapAspectToFal('1:1')).toBe('1:1');
    expect(mapAspectToFal('9:16')).toBe('9:16');
    expect(mapAspectToFal('16:9')).toBe('16:9');
  });
  it('approximates creative-only ratios loudly', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mapAspectToFal('4:5')).toBe('3:4');
    expect(mapAspectToFal('1.91:1')).toBe('16:9');
    expect(err).toHaveBeenCalledTimes(2);
  });
  it('unknown aspect → 1:1 + error log', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mapAspectToFal('7:3')).toBe('1:1');
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('createImageProvider — config validation', () => {
  it('refuses a non-fal role config', () => {
    expect(() => createImageProvider({ provider: 'anthropic', model: 'claude-sonnet-5' })).toThrow(
      /^provider:anthropic .*requires a role with provider 'fal'/,
    );
  });
});

describe('createImageProvider — operations', () => {
  it('generate → t2i chat path with the configured model in FAL_CHAT_T2I_MODEL_ID', async () => {
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(FAL_CFG, { transport, now: () => 100 });
    const res = await p.generate({ prompt: 'villa at dusk', aspect: '4:5', n: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('chat');
    expect(calls[0].opts.imageUrls).toEqual([]);
    expect(calls[0].opts.numVariations).toBe(2);
    expect(calls[0].env.FAL_CHAT_T2I_MODEL_ID).toBe('fal-ai/test-model');
    expect(calls[0].env.FAL_CHAT_MODEL_ID).toBeUndefined();
    expect(res.urls).toEqual(OK.imageUrls);
    expect(res.model).toBe('fal-ai/test-model');
    expect(res.cost_usd).toBeNull();
    expect(res.latency_ms).toBe(0);
  });
  it('generate clamps n to 1..4 and restores env after the call', async () => {
    const { transport } = fakeTransport();
    const p = createImageProvider(FAL_CFG, { transport });
    await p.generate({ prompt: 'x', aspect: '1:1', n: 9 });
    expect(process.env.FAL_CHAT_T2I_MODEL_ID).toBeUndefined();
    await expect(p.generate({ prompt: '', aspect: '1:1', n: 1 })).rejects.toThrow(/^provider:fal generate: prompt is empty/);
  });
  it('edit → chat path with sources + FAL_CHAT_MODEL_ID', async () => {
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(EDIT_CFG, { transport });
    await p.edit({ prompt: 'clean the sky', sources: ['https://a/1.jpg'], aspect: '16:9' });
    expect(calls[0].fn).toBe('chat');
    expect(calls[0].opts.imageUrls).toEqual(['https://a/1.jpg']);
    expect(calls[0].env.FAL_CHAT_MODEL_ID).toBe('fal-ai/test-edit');
  });
  it('edit requires at least one source', async () => {
    const { transport } = fakeTransport();
    const p = createImageProvider(EDIT_CFG, { transport });
    await expect(p.edit({ prompt: 'x', sources: [] })).rejects.toThrow(/^provider:fal edit: sources is empty/);
  });
  it('edit keepFraming with a single source → textRemoval path carrying OUR prompt', async () => {
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(EDIT_CFG, { transport });
    await p.edit({ prompt: 'remove the scaffolding', sources: ['https://a/1.jpg'], keepFraming: true });
    expect(calls[0].fn).toBe('textRemoval');
    expect(calls[0].opts.imageUrl).toBe('https://a/1.jpg');
    expect(calls[0].env.FAL_CLEAN_TEXT_MODEL_ID).toBe('fal-ai/test-edit');
    expect(calls[0].env.FAL_CLEAN_TEXT_PROMPT).toBe('remove the scaffolding');
    expect(process.env.FAL_CLEAN_TEXT_PROMPT).toBeUndefined();
  });
  it('edit keepFraming with multiple sources warns loudly and re-aspects via chat', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(EDIT_CFG, { transport });
    await p.edit({ prompt: 'x', sources: ['https://a/1.jpg', 'https://a/2.jpg'], keepFraming: true, aspect: '9:16' });
    expect(calls[0].fn).toBe('chat');
    expect(calls[0].opts.aspectRatio).toBe('9:16');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('keepFraming');
  });
  it('combine → chat path with role-annotated prompt, sources in order', async () => {
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(EDIT_CFG, { transport });
    await p.combine({
      prompt: 'composite the post',
      sources: [
        { url: 'https://a/hero.jpg', role: 'hero building photo' },
        { url: 'https://a/layout.jpg', role: 'layout reference' },
      ],
    });
    expect(calls[0].fn).toBe('chat');
    expect(calls[0].opts.imageUrls).toEqual(['https://a/hero.jpg', 'https://a/layout.jpg']);
    expect(String(calls[0].opts.prompt)).toContain('image 1: hero building photo');
    expect(String(calls[0].opts.prompt)).toContain('image 2: layout reference');
  });
  it('removeText → textRemoval path with the configured model but the DEFAULT prompt', async () => {
    const { transport, calls } = fakeTransport();
    const p = createImageProvider(CLEAN_CFG, { transport });
    await p.removeText({ source: 'https://a/listing.jpg' });
    expect(calls[0].fn).toBe('textRemoval');
    expect(calls[0].env.FAL_CLEAN_TEXT_MODEL_ID).toBe('fal-ai/test-klein');
    expect(calls[0].env.FAL_CLEAN_TEXT_PROMPT).toBeUndefined();
  });
  it('fal failure → provider:fal error with the raw detail', async () => {
    const { transport } = fakeTransport({ status: 'failed', rawError: 'queue exploded' });
    const p = createImageProvider(FAL_CFG, { transport });
    await expect(p.generate({ prompt: 'x', aspect: '1:1', n: 1 })).rejects.toThrow(/^provider:fal generate.*failed.*queue exploded/);
  });
  it('completed-with-no-urls → provider:fal error', async () => {
    const { transport } = fakeTransport({ status: 'completed', imageUrls: [] });
    const p = createImageProvider(FAL_CFG, { transport });
    await expect(p.generate({ prompt: 'x', aspect: '1:1', n: 1 })).rejects.toThrow(/^provider:fal .*no image URLs/);
  });
  it('kind is stub when FAL_KEY=stub, fal otherwise; result provider mirrors it', async () => {
    const { transport } = fakeTransport();
    const stub = createImageProvider(FAL_CFG, { transport, falKey: 'stub' });
    expect(stub.kind).toBe('stub');
    const res = await stub.generate({ prompt: 'x', aspect: '1:1', n: 1 });
    expect(res.provider).toBe('stub');
    const real = createImageProvider(FAL_CFG, { transport, falKey: 'real-key' });
    expect(real.kind).toBe('fal');
  });
});

describe('resolveImageProvider — reads ai_roles', () => {
  it('builds the provider from the resolved role config', async () => {
    const { transport } = fakeTransport();
    const sb = fakeSb({ image_generate: { model: 'fal-ai/configured-model' } });
    const p = await resolveImageProvider('image_generate', sb, { transport, falKey: 'k' });
    expect(p.model).toBe('fal-ai/configured-model');
    expect(p.kind).toBe('fal');
  });
  it('throws when the role is not pointed at fal', async () => {
    const sb = fakeSb({ image_edit: { provider: 'anthropic', model: 'claude-sonnet-5' } });
    await expect(resolveImageProvider('image_edit', sb)).rejects.toThrow(/^provider:anthropic .*must use provider 'fal'/);
  });
});
