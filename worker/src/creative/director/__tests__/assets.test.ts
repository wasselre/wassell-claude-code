import { describe, expect, it } from 'vitest';
import {
  isCandidateAllowed,
  rankCandidateAssets,
  sanitizeAssetPicks,
  type CandidateAssetRow,
  type ModelAssetPick,
} from '../assets.js';

function mkRow(id: string, over: Partial<CandidateAssetRow> = {}): CandidateAssetRow {
  return {
    file_id: id,
    original_name: `${id}.jpg`,
    primary_category: 'project_photo',
    document_type: null,
    link_role: null,
    asset_nature: 'real',
    acquisition_source: 'developer',
    usage_rights: 'approved',
    rights_provenance: 'human_approved',
    rights_verified: true,
    production_state: 'raw',
    aspect_ratio: '4:5',
    width_px: 1080,
    height_px: 1350,
    ai_description: 'واجهة المشروع',
    tags: null,
    subjects: null,
    dominant_colors: ['#B8734F'],
    has_text: false,
    headline_space: 'top',
    ...over,
  };
}

function mkPick(file_id: string, over: Partial<ModelAssetPick> = {}): ModelAssetPick {
  return { file_id, placement: 'slide 1 primary', usage: 'direct', treatment: '', why: '', is_production: true, ...over };
}

describe('rankCandidateAssets', () => {
  it('excludes competitor media and restricted/do_not_use rows entirely', () => {
    const rows = [
      mkRow('good'),
      mkRow('comp', { acquisition_source: 'competitor' }),
      mkRow('blocked', { usage_rights: 'restricted' }),
      mkRow('dnu', { usage_rights: 'do_not_use' }),
    ];
    expect(isCandidateAllowed(rows[0]!)).toBe(true);
    expect(isCandidateAllowed(rows[1]!)).toBe(false);
    expect(isCandidateAllowed(rows[2]!)).toBe(false);
    expect(isCandidateAllowed(rows[3]!)).toBe(false);
    expect(rankCandidateAssets(rows).map((r) => r.file_id)).toEqual(['good']);
  });

  it('verified + approved rights rank above unverified', () => {
    const rows = [
      mkRow('unverified', { usage_rights: 'needs_review', rights_verified: false }),
      mkRow('verified'),
    ];
    expect(rankCandidateAssets(rows).map((r) => r.file_id)).toEqual(['verified', 'unverified']);
  });

  it('caps to the intent limit, keeping RPC order on ties', () => {
    const rows = ['a', 'b', 'c'].map((id) => mkRow(id));
    expect(rankCandidateAssets(rows, { limit: 2 }).map((r) => r.file_id)).toEqual(['a', 'b']);
  });
});

describe('sanitizeAssetPicks', () => {
  const rows = [
    mkRow('f1'),
    mkRow('f2', { usage_rights: 'needs_review', rights_verified: false, asset_nature: 'cgi_render', acquisition_source: 'internal' }),
    mkRow('comp1', { acquisition_source: 'competitor', usage_rights: 'approved' }),
  ];

  it('drops hallucinated ids (hallucination guard)', () => {
    const r = sanitizeAssetPicks([mkPick('f1'), mkPick('ghost-999')], rows);
    expect(r.assets.map((a) => a.file_id)).toEqual(['f1']);
    expect(r.dropped).toEqual([{ file_id: 'ghost-999', reason: 'unknown_id' }]);
    expect(r.warnings.some((w) => w.includes('ghost-999'))).toBe(true);
  });

  it('rejects competitor ids even when the row has good rights', () => {
    const r = sanitizeAssetPicks([mkPick('comp1')], rows);
    expect(r.assets).toHaveLength(0);
    expect(r.dropped).toEqual([{ file_id: 'comp1', reason: 'competitor_media' }]);
  });

  it('copies rights from the ROW — the model never decides rights', () => {
    // The model claims f2 is approved + production; the row says needs_review + unverified.
    const r = sanitizeAssetPicks([mkPick('f2', { is_production: true })], rows);
    expect(r.assets[0]).toMatchObject({
      file_id: 'f2',
      rights: 'needs_review',
      rights_verified: false,
      nature: 'cgi_render',
      source: 'internal',
      needs_rights_confirmation: true,
      is_production: true, // the model's suggestion stands, but a human must confirm rights
    });
  });

  it('drops duplicate picks (first wins)', () => {
    const r = sanitizeAssetPicks([mkPick('f1'), mkPick('f1', { placement: 'background' })], rows);
    expect(r.assets).toHaveLength(1);
    expect(r.dropped).toEqual([{ file_id: 'f1', reason: 'duplicate' }]);
  });
});
