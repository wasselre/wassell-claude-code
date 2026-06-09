import { describe, it, expect } from 'vitest';
import { shortenGoogleMapsUrl } from '../urlUtils';

describe('shortenGoogleMapsUrl', () => {
  describe('shortens long Google Maps links', () => {
    it('collapses a full /place/.../@.../data= link using the exact pin (!3d/!4d)', () => {
      const long =
        'https://www.google.com/maps/place/Kingdom+Centre/@24.7115338,46.6744,17z/' +
        'data=!3m1!4b1!4m6!3m5!1s0x3e2f03890d489399:0xba974d1c98e79fd5!8m2!3d24.7115338!4d46.6744123!16zL20vMDFmcW0';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=24.7115338,46.6744123',
      );
    });

    it('uses the @viewport coordinate when there is no data blob', () => {
      const long = 'https://www.google.com/maps/@24.7135517,46.6752957,11z';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=24.7135517,46.6752957',
      );
    });

    it('reads the query param of a /maps/search/?api=1&query= link', () => {
      const long = 'https://www.google.com/maps/search/?api=1&query=24.774265,46.738586';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=24.774265,46.738586',
      );
    });

    it('handles a missing protocol and adds https to the result', () => {
      const long =
        'www.google.com/maps/place/X/@24.71,46.67,17z/data=!3m1!4b1!8m2!3d24.711111!4d46.677777';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=24.711111,46.677777',
      );
    });

    it('handles country-TLD hosts (google.com.sa)', () => {
      const long = 'https://www.google.com.sa/maps/place/Riyadh/@24.633333,46.716667,12z/data=!3m1';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=24.633333,46.716667',
      );
    });

    it('handles negative coordinates', () => {
      const long = 'https://www.google.com/maps/@-33.8688197,151.2092955,15z';
      expect(shortenGoogleMapsUrl(long)).toBe(
        'https://www.google.com/maps?q=-33.8688197,151.2092955',
      );
    });

    it('preserves full coordinate precision (no rounding)', () => {
      const long = 'https://www.google.com/maps/@24.71355179999,46.67529571234,11z';
      expect(shortenGoogleMapsUrl(long)).toContain('24.71355179999,46.67529571234');
    });
  });

  describe('leaves the value unchanged', () => {
    it('for an already-canonical short link (idempotent)', () => {
      const short = 'https://www.google.com/maps?q=24.7115338,46.6744123';
      expect(shortenGoogleMapsUrl(short)).toBe(short);
    });

    it('is idempotent on its own output', () => {
      const long =
        'https://www.google.com/maps/place/X/@24.71,46.67,17z/data=!8m2!3d24.711111!4d46.677777';
      const once = shortenGoogleMapsUrl(long);
      expect(shortenGoogleMapsUrl(once)).toBe(once);
    });

    it('for opaque short share links (maps.app.goo.gl)', () => {
      const link = 'https://maps.app.goo.gl/abc123XYZ';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for legacy goo.gl/maps share links', () => {
      const link = 'https://goo.gl/maps/abc123XYZ';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for multi-stop directions links (would lose the route)', () => {
      const dir = 'https://www.google.com/maps/dir/24.7,46.6/24.8,46.7/@24.75,46.65,13z';
      expect(shortenGoogleMapsUrl(dir)).toBe(dir);
    });

    it('for a non-Maps Google URL', () => {
      const search = 'https://www.google.com/search?q=kingdom+centre+riyadh';
      expect(shortenGoogleMapsUrl(search)).toBe(search);
    });

    it('for a Maps URL with a place name but no coordinates', () => {
      const link = 'https://www.google.com/maps/place/Kingdom+Centre';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for a non-Google URL that happens to contain a /maps path', () => {
      const link = 'https://example.com/maps/@24.71,46.67,17z';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for a google-look-alike host (google.evil.com)', () => {
      const link = 'https://google.evil.com/maps/@24.71,46.67,17z';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for out-of-range coordinates', () => {
      const link = 'https://www.google.com/maps/@200,500,11z';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for a 0,0 "Null Island" coordinate', () => {
      const link = 'https://www.google.com/maps/@0,0,3z';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });

    it('for a non-URL string', () => {
      const text = 'not a url at all';
      expect(shortenGoogleMapsUrl(text)).toBe(text);
    });

    it('for an empty string', () => {
      expect(shortenGoogleMapsUrl('')).toBe('');
    });

    it('when the canonical form would not be shorter than the input', () => {
      // maps.google.com/?q= is already shorter than our www.google.com/maps?q= form.
      const link = 'https://maps.google.com/?q=24.7,46.6';
      expect(shortenGoogleMapsUrl(link)).toBe(link);
    });
  });
});
