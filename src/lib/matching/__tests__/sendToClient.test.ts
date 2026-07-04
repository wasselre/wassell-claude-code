import { describe, it, expect } from 'vitest';
import {
  findProjectTemplate,
  findReadyListingTemplate,
  templateListingImageUrls,
  templateBody,
  directVideoUrls,
} from '../sendToClient';
import type { AppRecord } from '@/types';

const rec = (id: string, data: Record<string, unknown>): AppRecord =>
  ({ id, model_id: 'tm', data, created_at: '', updated_at: '' } as AppRecord);

describe('findProjectTemplate', () => {
  it('finds the template linked to the all_projects id', () => {
    const templates = [rec('a', { project_id: 'p1' }), rec('b', { project_id: 'p2' })];
    expect(findProjectTemplate(templates, 'p2')?.id).toBe('b');
    expect(findProjectTemplate(templates, 'p3')).toBeNull();
  });
});

describe('findReadyListingTemplate', () => {
  it('only matches ready templates for the listing — drafts never send', () => {
    const templates = [
      rec('draft', { listing_id: 'l1' }), // mid-cleaning draft, no status
      rec('ready', { listing_id: 'l1', status: 'ready' }),
      rec('other', { listing_id: 'l2', status: 'ready' }),
    ];
    expect(findReadyListingTemplate(templates, 'l1')?.id).toBe('ready');
    expect(findReadyListingTemplate([templates[0]!], 'l1')).toBeNull();
  });
});

describe('templateListingImageUrls', () => {
  it('extracts cleaned photo public URLs, skipping null/failed entries', () => {
    expect(
      templateListingImageUrls({
        images: [{ public_url: 'https://x/1.jpg' }, { public_url: null }, null, { public_url: 'https://x/2.jpg' }],
      }),
    ).toEqual(['https://x/1.jpg', 'https://x/2.jpg']);
    expect(templateListingImageUrls({})).toEqual([]);
  });
});

describe('templateBody', () => {
  it('prefers the UI language and falls back to the other', () => {
    expect(templateBody({ body_ar: 'عربي', body_en: 'english' }, true)).toBe('عربي');
    expect(templateBody({ body_ar: 'عربي', body_en: 'english' }, false)).toBe('english');
    expect(templateBody({ body_ar: 'عربي', body_en: '' }, false)).toBe('عربي');
    expect(templateBody({}, true)).toBe('');
  });
});

describe('directVideoUrls', () => {
  it('keeps direct video files only — HLS streams and page links are not sendable', () => {
    expect(
      directVideoUrls([
        'https://cdn.x/a.mp4',
        'https://cdn.x/b.MP4?sig=1',
        'https://stream.x/c.m3u8', // HLS — excluded
        'https://youtube.com/watch?v=abc', // page link — excluded
        'https://cdn.x/d.webm#t=1',
        'not-a-url.mp4',
        42,
        null,
      ]),
    ).toEqual(['https://cdn.x/a.mp4', 'https://cdn.x/b.MP4?sig=1', 'https://cdn.x/d.webm#t=1']);
    expect(directVideoUrls(undefined)).toEqual([]);
    expect(directVideoUrls('https://cdn.x/a.mp4')).toEqual([]);
  });
});
