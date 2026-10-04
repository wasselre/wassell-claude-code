import { describe, it, expect } from 'vitest';
import { buildGeoRows, type GeoCardDTO } from '../geoRows';
import type { Placement } from '@/pages/GeoGrade/lib/shared';

const narjis: Placement = { polarity: 'include', operation: 'district_polygon', element_ids: ['narjis'], resolved: true, label: 'النرجس' };
const rawda: Placement = { polarity: 'exclude', operation: 'district_polygon', element_ids: ['rawda'], resolved: true, label: 'الروضة' };

const card = (byEvidence: Record<string, Placement>): GeoCardDTO => ({
  status: 'pending', checkpoint_id: 'cp',
  proposal: {
    id: 'p', version: 1, status: 'pending', proposed_action: 'confirm',
    expression: { groups: [] } as unknown as NonNullable<GeoCardDTO['proposal']>['expression'],
    by_evidence: byEvidence, items: [], items_by_evidence: {}, verifier: null,
  },
  mentions: Object.keys(byEvidence).map((id) => ({ evidence_id: id, mention_span: id, preference_role: 'primary' })),
  names: {}, analyzed_at: null, stale: false, graded: false, can_reanalyze: true, customer_messages: 2,
});

describe('buildGeoRows — a place named twice is one row', () => {
  it('merges same place / side / rule, keeping every mention id', () => {
    const rows = buildGeoRows(card({ e1: narjis, e2: rawda, e3: { ...narjis } }), true);
    expect(rows.map((r) => r.evidenceId)).toEqual(['e1', 'e2']);
    expect(rows[0]!.evidenceIds).toEqual(['e1', 'e3']);
    expect(rows[1]!.evidenceIds).toEqual(['e2']);
  });
  it('the same district with opposite polarity stays two rows', () => {
    const rows = buildGeoRows(card({ e1: narjis, e2: { ...narjis, polarity: 'exclude' } }), true);
    expect(rows).toHaveLength(2);
  });
});
