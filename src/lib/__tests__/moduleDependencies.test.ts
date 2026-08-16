import { describe, it, expect } from 'vitest';
import { resolveModelDataDependencies } from '../moduleDependencies';
import type { AppModel, ModelField } from '@/types';

/** Minimal AppModel factory — the resolver only reads id + field type +
 *  lookup_model_id, so we build just enough shape and cast. */
function model(id: string, fields: Partial<ModelField>[]): AppModel {
  return {
    id,
    name: id,
    label_ar: id,
    label_en: id,
    schema: {
      sections: [
        {
          id: `${id}-sec`,
          label_ar: 's',
          label_en: 's',
          order: 0,
          fields: fields.map((f, i) => ({
            id: `${id}-f${i}`,
            name: `f${i}`,
            label_ar: 'f',
            label_en: 'f',
            type: 'text',
            required: false,
            order: i,
            ...f,
          })),
        },
      ],
    },
  } as unknown as AppModel;
}

function lookup(target: string, extra: Partial<ModelField> = {}): Partial<ModelField> {
  return { type: 'lookup', lookup_model_id: target, ...extra };
}

describe('resolveModelDataDependencies', () => {
  it('returns direct lookup targets', () => {
    const models = [
      model('our_projects', [lookup('all_projects')]),
      model('all_projects', []),
    ];
    expect(resolveModelDataDependencies('our_projects', models)).toEqual(['all_projects']);
  });

  it('walks the transitive chain (our_projects → all_projects → units + geography)', () => {
    const models = [
      model('our_projects', [lookup('all_projects')]),
      model('all_projects', [lookup('units'), lookup('developers')]),
      model('units', [lookup('geography')]),
      model('developers', []),
      model('geography', []),
    ];
    const deps = resolveModelDataDependencies('our_projects', models).sort();
    expect(deps).toEqual(['all_projects', 'developers', 'geography', 'units']);
  });

  it('excludes the root model even when a cycle points back at it', () => {
    const models = [
      model('a', [lookup('b')]),
      model('b', [lookup('a')]), // cycle
    ];
    expect(resolveModelDataDependencies('a', models)).toEqual(['b']);
    // no infinite loop, root not included
  });

  it('captures mirror/section_mirror targets via their sibling lookup', () => {
    // A section_mirror hops through a sibling lookup that already lives on the
    // model, so scanning lookup_model_id is sufficient — the mirror field itself
    // carries no target and must not add a phantom dependency.
    const models = [
      model('our_projects', [
        lookup('all_projects'),
        { type: 'section_mirror', section_mirror_via_lookup_field_id: 'our_projects-f0' },
      ]),
      model('all_projects', []),
    ];
    expect(resolveModelDataDependencies('our_projects', models)).toEqual(['all_projects']);
  });

  it('skips dangling lookup targets that reference a deleted model', () => {
    const models = [model('our_projects', [lookup('deleted_model')])];
    expect(resolveModelDataDependencies('our_projects', models)).toEqual([]);
  });

  it('dedupes a target reachable by multiple paths', () => {
    const models = [
      model('root', [lookup('a'), lookup('b')]),
      model('a', [lookup('shared')]),
      model('b', [lookup('shared')]),
      model('shared', []),
    ];
    const deps = resolveModelDataDependencies('root', models);
    expect(deps.filter((d) => d === 'shared')).toHaveLength(1);
    expect(deps.sort()).toEqual(['a', 'b', 'shared']);
  });

  it('returns [] for an unknown root', () => {
    expect(resolveModelDataDependencies('nope', [model('a', [])])).toEqual([]);
  });
});
