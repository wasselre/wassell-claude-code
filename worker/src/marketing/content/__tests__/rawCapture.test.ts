import { describe, expect, it } from 'vitest';
import { buildRawCapturePrompt, RAW_CAPTURE_SCHEMA, RAW_CAPTURE_SCHEMA_VERSION } from '../rawCapture.js';

const walk = (s: unknown, visit: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(s)) { s.forEach((x) => walk(x, visit)); return; }
  if (s && typeof s === 'object') { visit(s as Record<string, unknown>); Object.values(s).forEach((v) => walk(v, visit)); }
};

describe('raw capture schema', () => {
  it('is valid for OpenAI strict mode: every object closed and every property required', () => {
    walk(RAW_CAPTURE_SCHEMA, (o) => {
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
    });
  });
  it('captures the words and the visuals, not categories', () => {
    const props = Object.keys((RAW_CAPTURE_SCHEMA as { properties: object }).properties);
    for (const k of ['text_elements', 'scene', 'composition', 'colors', 'branding', 'designer_description', 'how_to_recreate', 'uncertain']) expect(props).toContain(k);
    walk(RAW_CAPTURE_SCHEMA, (o) => expect(o).not.toHaveProperty('enum'));
  });
  it('has a version, so a changed schema re-captures instead of mixing shapes', () => {
    expect(RAW_CAPTURE_SCHEMA_VERSION).toMatch(/^raw-v\d+$/);
  });
});

describe('buildRawCapturePrompt', () => {
  it('asks for exact text and gives context without asking to extract it', () => {
    const p = buildRawCapturePrompt({ org: 'Hermès', platform: 'instagram', slide: 2, of: 10, caption: 'Spring' });
    expect(p).toContain('EXACTLY');
    expect(p).toContain('image 2 of 10');
    expect(p).toContain('Hermès');
    expect(p).toContain('do not extract it');
  });
});
