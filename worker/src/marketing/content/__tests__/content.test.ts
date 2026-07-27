import { describe, it, expect } from 'vitest';
import { extractMedia } from '../mediaExtract';
import { detectLanguage, isMeaninglessTranscript } from '../falTranscribe';
import { classifyVisionError } from '../vision';

describe('media extraction from raw payloads', () => {
  it('instagram reel → video + thumbnail with duration', () => {
    const m = extractMedia('instagram', { videoUrl: 'https://cdn/v.mp4', displayUrl: 'https://cdn/cover.jpg', videoDuration: 30, originalWidth: 1080, originalHeight: 1920 });
    expect(m.find((x) => x.kind === 'video')).toMatchObject({ url: 'https://cdn/v.mp4', durationMs: 30000, carouselIndex: 0 });
    expect(m.find((x) => x.kind === 'thumbnail')?.url).toBe('https://cdn/cover.jpg');
  });
  it('instagram image → single image, no thumbnail', () => {
    const m = extractMedia('instagram', { displayUrl: 'https://cdn/i.jpg', type: 'Image' });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'image', carouselIndex: 0 });
  });
  it('instagram carousel → ordered children preserving index + type', () => {
    const m = extractMedia('instagram', {
      displayUrl: 'https://cdn/cover.jpg',
      childPosts: [
        { displayUrl: 'https://cdn/c0.jpg' },
        { videoUrl: 'https://cdn/c1.mp4', displayUrl: 'https://cdn/c1.jpg', videoDuration: 12 },
        { displayUrl: 'https://cdn/c2.jpg' },
      ],
    });
    const items = m.filter((x) => x.kind !== 'thumbnail');
    expect(items.map((x) => x.carouselIndex)).toEqual([0, 1, 2]);
    expect(items[1]).toMatchObject({ kind: 'video', url: 'https://cdn/c1.mp4', durationMs: 12000 });
    expect(items[0]!.kind).toBe('image');
  });
  it('tiktok → video from mediaUrls + cover thumbnail, rejects the profile url', () => {
    const m = extractMedia('tiktok', { mediaUrls: ['https://tt/dl.mp4'], webVideoUrl: 'https://www.tiktok.com/@x/video/1', videoMeta: { coverUrl: 'https://tt/cover.jpg', duration: 15, width: 720, height: 1280 } });
    expect(m.find((x) => x.kind === 'video')).toMatchObject({ url: 'https://tt/dl.mp4', durationMs: 15000 });
    expect(m.find((x) => x.kind === 'thumbnail')?.url).toBe('https://tt/cover.jpg');
  });
  it('youtube → thumbnail only (no direct video url)', () => {
    const m = extractMedia('youtube', { snippet: { thumbnails: { high: { url: 'https://yt/hq.jpg' } } } });
    expect(m).toEqual([{ carouselIndex: 0, kind: 'thumbnail', url: 'https://yt/hq.jpg' }]);
  });
  it('empty / unknown payloads yield no media (never throws)', () => {
    expect(extractMedia('instagram', {})).toEqual([]);
    expect(extractMedia('snapchat', { videoUrl: 'x' })).toEqual([]);
  });
});

describe('transcript language detection (ar / en / mixed)', () => {
  it('detects Arabic', () => expect(detectLanguage('وصل ريفييرا عرض خاص')).toBe('ar'));
  it('detects English', () => expect(detectLanguage('Welcome to Riviera book now')).toBe('en'));
  it('detects mixed code-switching', () => expect(detectLanguage('مشروع Riviera الآن available today احجز')).toBe('mixed'));
  it('honors multiple inferred languages as mixed', () => expect(detectLanguage('...', ['ar', 'en'])).toBe('mixed'));
  it('empty text with no inference is null', () => expect(detectLanguage('')).toBeNull());
});

describe('whisper hallucination guard (music-only reels)', () => {
  it('flags the classic silent-audio hallucinations', () => {
    for (const h of ['you', 'You', 'Thank you.', 'thanks for watching!', '.', 'bye']) expect(isMeaninglessTranscript(h)).toBe(true);
  });
  it('keeps real speech', () => {
    expect(isMeaninglessTranscript('وصل ريفييرا عرض خاص لفترة محدودة')).toBe(false);
    expect(isMeaninglessTranscript('Book your unit now')).toBe(false);
  });
});

// ============================================================================
// Silent-success guard. A content_process job used to report `succeeded` even
// when its OCR step died: 66 jobs across four days read green while Anthropic
// credits were exhausted and every post came out with no visual text. These
// tests pin the classifier that tells "our account broke" apart from "this
// creative is unreadable" — both fatal for the post, different for the operator.
// ============================================================================
describe('vision error classification (silent-success guard)', () => {
  it('the real credit-exhaustion message classifies as infrastructure', () => {
    const c = classifyVisionError(new Error('Your credit balance is too low to access the Anthropic API'));
    expect(c.kind).toBe('infrastructure');
    expect(c.message).toContain('credit balance');
  });

  it.each([
    ['401 auth', Object.assign(new Error('unauthorized'), { status: 401 })],
    ['429 rate limit', Object.assign(new Error('too many requests'), { status: 429 })],
    ['500 upstream', Object.assign(new Error('internal'), { status: 503 })],
    ['overloaded', new Error('Overloaded')],
    ['transport', new Error('fetch failed')],
  ])('%s → infrastructure (it will hit every post, not just this one)', (_label, err) => {
    expect(classifyVisionError(err).kind).toBe('infrastructure');
  });

  it('a genuine per-post problem is data, not infrastructure', () => {
    expect(classifyVisionError(new Error('could not process image: unsupported dimensions')).kind).toBe('data');
  });

  it('a 400 that is not about billing stays data-class', () => {
    expect(classifyVisionError(Object.assign(new Error('invalid_request_error'), { status: 400 })).kind).toBe('data');
  });

  it('survives a non-Error throw without losing the message', () => {
    expect(classifyVisionError('boom').message).toBe('boom');
    expect(classifyVisionError(null).message).toBe('null');
  });
});
