/**
 * Phase 0 canonical-asset guarantees.
 *
 * Two properties matter more than anything else here and both are asserted
 * directly, because a regression in either is silent in the UI:
 *   1. A LEGACY asset (stored public url) is never signed and never altered.
 *   2. A CANONICAL asset never persists a URL into mos_assets — a signed URL
 *      written to `url` would expire in five minutes and strand the asset.
 */
import { describe, expect, it } from 'vitest';
import {
  isImageAsset, needsSigning, requiredFileIds, resolveAssetThumb, resolveAssetUrl,
} from '../assetUrls';
import {
  UnsupportedAssetError, assertCanonicalUploadable, assetErrorText, canonicalAssetFields,
} from '../canonicalUpload';
import type { FileRow } from '@/types/files';

const LEGACY = {
  file_id: null,
  url: 'https://x.supabase.co/storage/v1/object/public/marketing-assets/mos/a.jpg',
  thumb_url: 'https://x.supabase.co/storage/v1/object/public/marketing-assets/mos/a.jpg',
  kind: 'photo' as const,
  mime_type: 'image/jpeg',
};

/** The real production shape today: 1,252 rows carry BOTH a url and a file_id. */
const LEGACY_WITH_FILE_ID = { ...LEGACY, file_id: 'f-dup' };

const CANONICAL_IMAGE = {
  file_id: 'f-img',
  url: null,
  thumb_url: null,
  kind: 'photo' as const,
  mime_type: 'image/png',
};

const CANONICAL_VIDEO = {
  file_id: 'f-vid',
  url: null,
  thumb_url: null,
  kind: 'video' as const,
  mime_type: 'video/mp4',
};

function file(name: string, type: string): File {
  return new File([new Uint8Array(1)], name, { type });
}

/** A file whose reported size is forced — File() size derives from content. */
function bigFile(name: string, type: string, size: number): File {
  const f = file(name, type);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('legacy assets are never signed and never altered', () => {
  it('a stored url is returned verbatim', () => {
    expect(resolveAssetUrl(LEGACY, {})).toBe(LEGACY.url);
    expect(resolveAssetThumb(LEGACY, {})).toBe(LEGACY.thumb_url);
  });

  it('an asset carrying a url needs no signing, even when it also has a file_id', () => {
    // This is the production majority — the duplicate rows. They must keep
    // using the public URL and must not add a signing round-trip.
    expect(needsSigning(LEGACY_WITH_FILE_ID)).toBe(false);
    expect(requiredFileIds([LEGACY, LEGACY_WITH_FILE_ID])).toEqual([]);
    expect(resolveAssetUrl(LEGACY_WITH_FILE_ID, {})).toBe(LEGACY.url);
  });

  it('a legacy asset with no stored thumb still shows no thumb (video/PDF today)', () => {
    const legacyVideo = { ...LEGACY, thumb_url: null, kind: 'video' as const, mime_type: 'video/mp4' };
    expect(resolveAssetThumb(legacyVideo, {})).toBeNull();
  });
});

describe('canonical assets resolve through the signed map', () => {
  it('resolves the signed url when present, null when not yet signed', () => {
    expect(resolveAssetUrl(CANONICAL_IMAGE, {})).toBeNull();
    expect(resolveAssetUrl(CANONICAL_IMAGE, { 'f-img': 'https://signed/x' })).toBe('https://signed/x');
  });

  it('only image-like assets get a thumbnail from the signed map', () => {
    const signed = { 'f-img': 'https://signed/i', 'f-vid': 'https://signed/v' };
    expect(resolveAssetThumb(CANONICAL_IMAGE, signed)).toBe('https://signed/i');
    // A video's signed URL is the clip itself — never an <img> thumbnail.
    expect(resolveAssetThumb(CANONICAL_VIDEO, signed)).toBeNull();
    expect(isImageAsset(CANONICAL_VIDEO)).toBe(false);
  });

  it('required ids are de-duplicated and sorted, so re-ordering never re-signs', () => {
    const a = { ...CANONICAL_IMAGE, file_id: 'b' };
    const b = { ...CANONICAL_IMAGE, file_id: 'a' };
    const dup = { ...CANONICAL_IMAGE, file_id: 'a' };
    expect(requiredFileIds([a, b, dup])).toEqual(['a', 'b']);
    // Same set, different order → identical effect key.
    expect(requiredFileIds([a, b]).join(',')).toBe(requiredFileIds([b, a]).join(','));
  });

  it('null/undefined entries are tolerated', () => {
    expect(requiredFileIds([null, undefined, CANONICAL_IMAGE])).toEqual(['f-img']);
    expect(resolveAssetUrl(null, {})).toBeNull();
    expect(resolveAssetThumb(undefined, {})).toBeNull();
  });
});

describe('canonicalAssetFields never persists a URL', () => {
  it('writes only file_id and nulls every legacy location column', () => {
    const row = {
      id: 'file-123',
      mime_type: 'image/jpeg',
      size_bytes: 4096,
      original_name: 'shot.jpg',
    } as FileRow;
    const fields = canonicalAssetFields(row);
    expect(fields.file_id).toBe('file-123');
    // The whole point of Phase 0: no second copy, no persisted signed URL.
    expect(fields.url).toBeNull();
    expect(fields.thumb_url).toBeNull();
    expect(fields.file_path).toBeNull();
    expect(fields.mime_type).toBe('image/jpeg');
    expect(fields.size_bytes).toBe(4096);
  });
});

describe('unsupported uploads fail visibly, with a reason', () => {
  it('accepts the formats the canonical bucket allows', () => {
    expect(() => assertCanonicalUploadable(file('a.jpg', 'image/jpeg'))).not.toThrow();
    expect(() => assertCanonicalUploadable(file('a.mp4', 'video/mp4'))).not.toThrow();
    expect(() => assertCanonicalUploadable(file('a.pdf', 'application/pdf'))).not.toThrow();
    expect(() => assertCanonicalUploadable(file('a.heic', 'image/heic'))).not.toThrow();
  });

  it('rejects formats the public bucket used to swallow', () => {
    // These all upload fine to marketing-assets today and are NOT in the
    // wassel-files allowlist — exactly the silent-drop risk Phase 0b closes.
    for (const [name, mime] of [
      ['a.avif', 'image/avif'],
      ['a.mkv', 'video/x-matroska'],
      ['a.avi', 'video/x-msvideo'],
      ['a.psd', 'image/vnd.adobe.photoshop'],
    ] as const) {
      expect(() => assertCanonicalUploadable(file(name, mime))).toThrow(UnsupportedAssetError);
    }
  });

  it('rejects an unidentifiable type rather than uploading it blind', () => {
    expect(() => assertCanonicalUploadable(file('mystery', ''))).toThrow(UnsupportedAssetError);
  });

  it('rejects over-cap files before any bytes go over the wire', () => {
    const huge = bigFile('big.mp4', 'video/mp4', 600 * 1024 * 1024);
    expect(() => assertCanonicalUploadable(huge)).toThrow(UnsupportedAssetError);
  });

  it('every rejection carries both languages and names the file', () => {
    try {
      assertCanonicalUploadable(file('لقطة.avif', 'image/avif'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedAssetError);
      const ar = assetErrorText(e, true);
      const en = assetErrorText(e, false);
      expect(ar).not.toBe(en);
      expect(ar).toContain('لقطة.avif');
      expect(en).toContain('لقطة.avif');
      // Actionable, not just "failed".
      expect(en.toLowerCase()).toContain('convert');
    }
  });

  it('a non-Error rejection still yields a readable string', () => {
    expect(assetErrorText(new Error('boom'), false)).toBe('boom');
    expect(assetErrorText('plain', true)).toBe('plain');
  });
});
