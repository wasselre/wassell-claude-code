import { describe, it, expect } from 'vitest';
import {
  groupOfKind, nameFromUrl, buildPickerItems, orderSelectedRefs,
  orderSelectedRefsBulk, defaultBulkSelection,
} from '../projectFilePicker';
import type { RecordFileEntry } from '@/lib/files/recordFiles';
import type { BusinessFileRow, FilePreviewKind } from '@/types';

function entry(id: string, kind: FilePreviewKind, over: Partial<BusinessFileRow> = {}): RecordFileEntry {
  const file = {
    id, kind, title: '', original_name: `${id}.bin`, mime_type: '', size_bytes: 0,
    document_type: '', origin: 'user_upload', status: 'active', confidentiality: 'internal',
    tags: [], description: null, owner_user_id: 'u', uploaded_by_user_id: 'u',
    created_at: '', updated_at: '', valid_from: null, valid_until: null, archived_at: null,
    folder_id: null, storage_bucket: 'b', storage_path: 'p', link_count: 1, ...over,
  } as BusinessFileRow;
  return { link_id: `l-${id}`, file, role: 'gallery_image', origins: ['field'], removable: false, survivesRemoval: false, sourceField: null };
}

describe('groupOfKind', () => {
  it('maps kinds to picker groups', () => {
    expect(groupOfKind('image')).toBe('photo');
    expect(groupOfKind('video')).toBe('video');
    expect(groupOfKind('pdf')).toBe('document');
    expect(groupOfKind('document')).toBe('document');
    expect(groupOfKind('audio')).toBe('document');
    expect(groupOfKind('other')).toBe('document');
  });
});

describe('nameFromUrl', () => {
  it('takes the last path segment, decoded', () => {
    expect(nameFromUrl('https://cdn.x.com/videos/tour%20clip.mp4')).toBe('tour clip.mp4');
  });
  it('falls back to the whole string when unparseable', () => {
    expect(nameFromUrl('not a url')).toBe('not a url');
  });
});

describe('buildPickerItems', () => {
  it('dedups a file linked via several edges, keeping the first', () => {
    const items = buildPickerItems([entry('a', 'image'), entry('a', 'image')], []);
    expect(items.map((i) => i.ref)).toEqual(['a']);
  });

  it('groups by kind and prefers title over original_name', () => {
    const items = buildPickerItems(
      [entry('img', 'image', { title: 'Hero' }), entry('doc', 'pdf', { title: '' })],
      [],
    );
    expect(items.find((i) => i.ref === 'img')).toMatchObject({ group: 'photo', name: 'Hero', isUrl: false });
    expect(items.find((i) => i.ref === 'doc')).toMatchObject({ group: 'document', name: 'doc.bin' });
  });

  it('appends external video URLs as video tiles, deduped', () => {
    const url = 'https://s/v/clip.mp4';
    const items = buildPickerItems([entry('a', 'image')], [url, url, '']);
    const vids = items.filter((i) => i.group === 'video');
    expect(vids).toHaveLength(1);
    expect(vids[0]).toMatchObject({ ref: url, isUrl: true });
  });
});

describe('orderSelectedRefs', () => {
  it('orders photos → videos → documents and drops unselected', () => {
    const items = buildPickerItems(
      [entry('doc', 'pdf'), entry('img', 'image'), entry('vidfile', 'video')],
      ['https://s/v/clip.mp4'],
    );
    const selected = new Set(['doc', 'img', 'https://s/v/clip.mp4']); // vidfile excluded
    expect(orderSelectedRefs(items, selected)).toEqual(['img', 'https://s/v/clip.mp4', 'doc']);
  });
});

describe('orderSelectedRefsBulk', () => {
  it('orders documents → photos → videos (text is sent separately first)', () => {
    const items = buildPickerItems(
      [entry('img', 'image'), entry('doc', 'pdf'), entry('vidfile', 'video')],
      ['https://s/v/clip.mp4'],
    );
    const selected = new Set(['img', 'doc', 'vidfile', 'https://s/v/clip.mp4']);
    // PDF leads, then photos, then videos → the send reads text → PDF → pictures.
    expect(orderSelectedRefsBulk(items, selected)).toEqual([
      'doc', 'img', 'vidfile', 'https://s/v/clip.mp4',
    ]);
  });
});

describe('defaultBulkSelection', () => {
  it('pre-checks ONLY the brochure document + the first three photos, videos off', () => {
    const items = buildPickerItems(
      [
        entry('p1', 'image'), entry('p2', 'image'), entry('p3', 'image'),
        entry('p4', 'image'), // 4th photo must NOT be pre-checked
        entry('broch', 'pdf', { primary_category: 'brochure' }),
        entry('specs', 'pdf'), // a non-brochure document must NOT be pre-checked
        entry('v1', 'video'),
      ],
      ['https://s/v/clip.mp4'],
    );
    const sel = defaultBulkSelection(items);
    expect([...sel].sort()).toEqual(['broch', 'p1', 'p2', 'p3'].sort());
    expect(sel.has('specs')).toBe(false);
    expect(sel.has('p4')).toBe(false);
    expect(sel.has('v1')).toBe(false);
  });

  it('detects an untyped brochure by name (بروشور / brochure)', () => {
    const items = buildPickerItems(
      [entry('doc', 'pdf', { title: 'مينا 52- بروشور' }), entry('other', 'pdf', { title: 'ورقة معلومات المشروع' })],
      [],
    );
    expect([...defaultBulkSelection(items)]).toEqual(['doc']);
  });

  it('picks exactly ONE brochure — the name-titled one wins over type-only ones', () => {
    // The file-enrichment AI tags several marketing PDFs primary_category=brochure;
    // only «بروشور المشروع» is the real brochure, and only it must be pre-checked.
    const items = buildPickerItems(
      [
        entry('plan', 'pdf', { primary_category: 'brochure', title: 'الخطة التسويقية' }),
        entry('broch', 'pdf', { primary_category: 'brochure', title: 'بروشور المشروع' }),
        entry('specs', 'pdf', { primary_category: 'brochure', title: 'المواصفات الرئيسية' }),
      ],
      [],
    );
    expect([...defaultBulkSelection(items)]).toEqual(['broch']);
  });

  it('falls back to the first type-brochure when none is named a brochure', () => {
    const items = buildPickerItems(
      [
        entry('d1', 'pdf', { primary_category: 'brochure', title: 'ملف أول' }),
        entry('d2', 'pdf', { primary_category: 'brochure', title: 'ملف ثانٍ' }),
      ],
      [],
    );
    expect([...defaultBulkSelection(items)]).toEqual(['d1']);
  });

  it('pre-checks no document when none is a brochure', () => {
    const items = buildPickerItems([entry('p1', 'image'), entry('info', 'pdf', { title: 'info sheet' })], []);
    expect([...defaultBulkSelection(items)]).toEqual(['p1']);
  });
});

describe('social-intake files (Competitor Watch → Files bridge)', () => {
  it('hides files whose rights forbid sending, keeps the rest', () => {
    // A collected VIDEO carries the badge and is offered; a collected IMAGE is
    // not offered at all any more (see "social intake offers videos only").
    const items = buildPickerItems([
      entry('own', 'video', { origin: 'social_intake', usage_rights: 'approved', acquisition_source: 'developer' } as Partial<BusinessFileRow>),
      entry('rival', 'video', { origin: 'social_intake', usage_rights: 'internal_only', acquisition_source: 'competitor' } as Partial<BusinessFileRow>),
      entry('nope', 'image', { usage_rights: 'do_not_use' } as Partial<BusinessFileRow>),
      entry('plain', 'image'),
    ], []);
    expect(items.map((i) => i.ref)).toEqual(['own', 'plain']);
    expect(items[0]).toMatchObject({ isSocial: true, acquisitionSource: 'developer' });
    expect(items[1]).toMatchObject({ isSocial: false });
  });
  it('never pre-checks a collected item in the bulk default', () => {
    const items = buildPickerItems([
      entry('s1', 'video', { origin: 'social_intake', usage_rights: 'approved' } as Partial<BusinessFileRow>),
      entry('g1', 'image'),
      entry('g2', 'image'),
    ], []);
    const sel = defaultBulkSelection(items);
    expect([...sel].sort()).toEqual(['g1', 'g2']);
  });
});

describe('the bot and the rep share one selection — rights must never be optional', () => {
  it('a file row WITHOUT usage_rights is treated as unrestricted (why the bot must select the column)', () => {
    const items = buildPickerItems([entry('unknown-rights', 'image')], []);
    expect(items.map((i) => i.ref)).toEqual(['unknown-rights']);
  });
  it('once the column is present, internal-only never reaches the send list', () => {
    const items = buildPickerItems([
      entry('ok', 'image', { usage_rights: 'approved' } as Partial<BusinessFileRow>),
      entry('no', 'image', { usage_rights: 'internal_only' } as Partial<BusinessFileRow>),
    ], []);
    expect(items.map((i) => i.ref)).toEqual(['ok']);
  });
});

describe('social intake offers videos only (operator, 2026-09-15)', () => {
  it('hides a collected post image — it carries the other company\'s logo and number', () => {
    const items = buildPickerItems([
      entry('their-poster', 'image', { origin: 'social_intake', usage_rights: 'approved' } as Partial<BusinessFileRow>),
      entry('their-video', 'video', { origin: 'social_intake', usage_rights: 'approved' } as Partial<BusinessFileRow>),
    ], []);
    expect(items.map((i) => i.ref)).toEqual(['their-video']);
  });
  it('leaves OUR own designs and photos alone', () => {
    const items = buildPickerItems([
      entry('our-design', 'image', { origin: 'user_upload', primary_category: 'design' } as Partial<BusinessFileRow>),
      entry('our-photo', 'image', { origin: 'marketing_intake' } as Partial<BusinessFileRow>),
    ], []);
    expect(items.map((i) => i.ref)).toEqual(['our-design', 'our-photo']);
  });
  it('still drops a collected video whose rights forbid sending', () => {
    const items = buildPickerItems([
      entry('rival-video', 'video', { origin: 'social_intake', usage_rights: 'internal_only' } as Partial<BusinessFileRow>),
    ], []);
    expect(items).toEqual([]);
  });
});
