import { describe, expect, it } from 'vitest';
import { buildDesignPrompt, designSchema, geminiSafeSchema } from '../geminiDesign.js';

const walk = (s: unknown, visit: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(s)) { s.forEach((x) => walk(x, visit)); return; }
  if (s && typeof s === 'object') { visit(s as Record<string, unknown>); Object.values(s).forEach((v) => walk(v, visit)); }
};

describe('geminiSafeSchema', () => {
  it('drops keys Gemini refuses and keeps the rest', () => {
    const out = geminiSafeSchema({ type: 'object', additionalProperties: false, properties: { hex: { type: 'string', pattern: '^#' } }, required: ['hex'] });
    expect(out).toEqual({ type: 'object', properties: { hex: { type: 'string' } }, required: ['hex'] });
  });
  it('turns a nullable type into anyOf and an integer enum into a range', () => {
    expect(geminiSafeSchema({ type: ['string', 'null'], enum: ['small', 'large', null] })).toEqual({ anyOf: [{ type: 'string', enum: ['small', 'large'] }, { type: 'null' }] });
    expect(geminiSafeSchema({ type: 'integer', enum: [0, 1, 2, 3] })).toEqual({ type: 'integer', minimum: 0, maximum: 3 });
  });
  it('the combined schema has no additionalProperties, pattern, type arrays or open objects', () => {
    walk(designSchema(), (o) => {
      expect(o).not.toHaveProperty('additionalProperties');
      expect(o).not.toHaveProperty('pattern');
      expect(Array.isArray(o.type)).toBe(false);
      if (o.type === 'object') expect(o.properties).toBeTruthy();
    });
  });
});

describe('buildDesignPrompt', () => {
  it('asks for one slide read per image and names the format', () => {
    expect(buildDesignPrompt(3, { platform: 'instagram' })).toContain('exactly 3 SlideRead');
    expect(buildDesignPrompt(3, {})).toContain('format "carousel"');
    expect(buildDesignPrompt(1, {})).toContain('format "single"');
  });
});
