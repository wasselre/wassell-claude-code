import { describe, expect, it } from 'vitest';
import { BASE_PACKAGE_SCHEMA, CONCEPTS_OUTPUT_SCHEMA, DERIVATIVES_OUTPUT_SCHEMA } from '../schemas.js';

type SchemaObj = { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };

const props = (s: unknown): string[] => Object.keys((s as SchemaObj).properties ?? {});
const required = (s: unknown): string[] => [...((s as SchemaObj).required ?? [])].sort();

describe('schemas mirror contracts.ts', () => {
  it('ConceptsOutput keys + required arrays', () => {
    expect(required(CONCEPTS_OUTPUT_SCHEMA)).toEqual(['concepts', 'missing', 'recommended', 'warnings']);
    const concept = (CONCEPTS_OUTPUT_SCHEMA.properties!.concepts as { items: unknown }).items;
    expect(required(concept)).toEqual([
      'angle', 'format', 'id', 'leans_on_reference', 'one_line_design_idea', 'suggested_targets', 'title', 'why',
    ]);
    const format = (concept as SchemaObj).properties!.format as { enum: string[] };
    expect(format.enum).toEqual(['single', 'carousel']);
  });

  it('BasePackage keys + required arrays', () => {
    expect(required(BASE_PACKAGE_SCHEMA)).toEqual([
      'ai_recommendations', 'assets', 'brand_kit', 'confidence', 'design_text', 'facts_used', 'missing',
      'palette', 'palette_rationale', 'rationale', 'references', 'slides', 'strategy', 'visual_direction', 'warnings',
    ]);
    const designText = BASE_PACKAGE_SCHEMA.properties!.design_text as SchemaObj;
    expect(required(designText)).toEqual(['cta_on_design', 'fact_refs', 'headlines', 'latin_name', 'project_name_lead']);
    const strategy = BASE_PACKAGE_SCHEMA.properties!.strategy as SchemaObj;
    expect(props(strategy)).toContain('master_aspect');
    expect(props(strategy)).toContain('intended_use');
    const asset = (BASE_PACKAGE_SCHEMA.properties!.assets as { items: unknown }).items as SchemaObj;
    expect(required(asset)).toEqual([
      'file_id', 'is_production', 'nature', 'needs_rights_confirmation', 'placement', 'production_state',
      'rights', 'rights_verified', 'source', 'treatment', 'usage', 'why',
    ]);
  });

  it('DerivativesOutput keys + adaptation completeness', () => {
    expect(required(DERIVATIVES_OUTPUT_SCHEMA)).toEqual(['derivatives']);
    const derivative = (DERIVATIVES_OUTPUT_SCHEMA.properties!.derivatives as { items: unknown }).items as SchemaObj;
    expect(required(derivative)).toEqual(['adaptation', 'copy', 'dimensions', 'limits', 'target', 'warnings']);
    const adaptation = derivative.properties!.adaptation as SchemaObj;
    expect(required(adaptation)).toEqual([
      'aspect', 'asset_substitutions', 'element_scaling', 'image_change', 'image_instructions',
      'layout_changes', 'logo_reposition', 'px', 'requires_separate_design', 'safe_zones',
      'slide_mapping', 'text_reposition',
    ]);
  });

  it('every object is closed (additionalProperties: false)', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const o = node as SchemaObj;
      if (o.type === 'object' && o.properties) {
        expect(o.additionalProperties).toBe(false);
        for (const v of Object.values(o.properties)) walk(v);
      }
      const items = (node as { items?: unknown }).items;
      if (items) walk(items);
      const anyOf = (node as { anyOf?: unknown[] }).anyOf;
      if (anyOf) anyOf.forEach(walk);
    };
    walk(CONCEPTS_OUTPUT_SCHEMA);
    walk(BASE_PACKAGE_SCHEMA);
    walk(DERIVATIVES_OUTPUT_SCHEMA);
  });

  it('nullable enums use anyOf, never a union type+enum (Anthropic structured-output rejects the latter)', () => {
    // Live أكنان 25: `{type:['string','null'], enum:[...]}` was rejected by the
    // structured-output validator ("Enum value 'real' does not match declared
    // type '['string','null']'"), forcing a lossy forced-tool fallback.
    const asset = (BASE_PACKAGE_SCHEMA.properties!.assets as { items: unknown }).items as SchemaObj;
    for (const key of ['nature', 'source', 'rights', 'production_state']) {
      const field = asset.properties![key] as { anyOf?: unknown[]; type?: unknown; enum?: unknown };
      expect(Array.isArray(field.anyOf), `${key} should be a nullable-enum anyOf`).toBe(true);
      // must NOT be the rejected shape: a union `type` array carrying an `enum`
      expect(Array.isArray(field.type) && field.enum !== undefined).toBe(false);
      const branch = (field.anyOf as SchemaObj[]).find((b) => Array.isArray((b as { enum?: unknown }).enum)) as { type?: unknown };
      expect(branch?.type).toBe('string'); // the enum branch is a plain string, not a union
    }
  });

  it('AiRecommendation.execution is NOT in the schema (the model never emits it)', () => {
    const rec = (BASE_PACKAGE_SCHEMA.properties!.ai_recommendations as { items: unknown }).items as SchemaObj;
    expect(props(rec)).not.toContain('execution');
  });
});
