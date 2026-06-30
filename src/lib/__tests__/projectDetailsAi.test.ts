import { describe, it, expect } from 'vitest';
import { projectImagesToDetailFields } from '../projectDetailsAi';

describe('projectImagesToDetailFields', () => {
  it('maps main_image to hero and library images to gallery slots', () => {
    const out = projectImagesToDetailFields({
      main_image: 'hero-id',
      project_images: ['hero-id', 'g1', 'g2'],
    });
    // hero = main_image; gallery excludes the hero to avoid duplication.
    expect(out).toEqual({
      hero_image_url: 'hero-id',
      gallery_image_1: 'g1',
      gallery_image_2: 'g2',
    });
  });

  it('falls back to the first library image as hero when main_image is absent', () => {
    const out = projectImagesToDetailFields({ project_images: ['a', 'b', 'c'] });
    expect(out).toEqual({
      hero_image_url: 'a',
      gallery_image_1: 'b',
      gallery_image_2: 'c',
    });
  });

  it('caps the gallery at the 8 available slots', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `img-${i}`);
    const out = projectImagesToDetailFields({ project_images: ids });
    expect(out.hero_image_url).toBe('img-0');
    expect(Object.keys(out).filter((k) => k.startsWith('gallery_image_'))).toHaveLength(8);
    expect(out.gallery_image_8).toBe('img-8'); // img-1..img-8 fill slots 1..8
    expect(out.gallery_image_1).toBe('img-1');
  });

  it('dedupes repeated library ids', () => {
    const out = projectImagesToDetailFields({
      main_image: 'h',
      project_images: ['h', 'x', 'x', 'y'],
    });
    expect(out).toEqual({
      hero_image_url: 'h',
      gallery_image_1: 'x',
      gallery_image_2: 'y',
    });
  });

  it('returns an empty object when there are no images', () => {
    expect(projectImagesToDetailFields({})).toEqual({});
    expect(projectImagesToDetailFields({ main_image: '', project_images: [] })).toEqual({});
  });

  it('ignores non-string entries in project_images', () => {
    const out = projectImagesToDetailFields({
      project_images: ['a', null, 42, '', 'b'] as unknown[],
    });
    expect(out).toEqual({ hero_image_url: 'a', gallery_image_1: 'b' });
  });
});
