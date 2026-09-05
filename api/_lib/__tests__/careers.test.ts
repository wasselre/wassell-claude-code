import { describe, it, expect } from 'vitest';
import { canonKsaPhone, sniffCvKind, looksLikeAudio, hasSalesExperience, safeExt } from '../careers';

describe('canonKsaPhone', () => {
  it.each([
    ['0512345678', '+966512345678'],
    ['512345678', '+966512345678'],
    ['+966512345678', '+966512345678'],
    ['966512345678', '+966512345678'],
    ['00966512345678', '+966512345678'],
    ['05 12 345 678', '+966512345678'],
    ['٠٥١٢٣٤٥٦٧٨', '+966512345678'],
  ])('canonicalizes %s -> %s', (input, expected) => {
    expect(canonKsaPhone(input)).toBe(expected);
  });

  it.each(['0412345678', '12345678', '', '05123', '+11234567890'])(
    'rejects %s',
    (input) => expect(canonKsaPhone(input)).toBeNull(),
  );
});

describe('sniffCvKind (magic bytes, not the client-declared mime)', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('detects PDF', () => expect(sniffCvKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe('pdf'));
  it('detects DOCX (zip)', () => expect(sniffCvKind(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('docx'));
  it('detects legacy DOC (OLE2)', () => expect(sniffCvKind(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('doc'));
  it('rejects an executable masquerading as a CV', () => expect(sniffCvKind(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull());
  it('rejects a plain-text file', () => expect(sniffCvKind(bytes(0x68, 0x69, 0x0a))).toBeNull());
});

describe('looksLikeAudio', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('accepts webm/matroska', () => expect(looksLikeAudio(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(true));
  it('accepts ogg', () => expect(looksLikeAudio(bytes(0x4f, 0x67, 0x67, 0x53))).toBe(true));
  it('accepts mp3 (ID3)', () => expect(looksLikeAudio(bytes(0x49, 0x44, 0x33, 0x03))).toBe(true));
  it('accepts mp4/m4a (ftyp at offset 4)', () => expect(looksLikeAudio(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toBe(true));
  it('accepts wav (RIFF/WAVE)', () => expect(looksLikeAudio(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBe(true));
  it('rejects a PDF pretending to be audio', () => expect(looksLikeAudio(bytes(0x25, 0x50, 0x44, 0x46))).toBe(false));
});

describe('hasSalesExperience / safeExt', () => {
  it('flags experienced levels only', () => {
    expect(hasSalesExperience('none')).toBe(false);
    expect(hasSalesExperience('less_than_1')).toBe(true);
    expect(hasSalesExperience('more_than_3')).toBe(true);
  });
  it('derives safe extensions', () => {
    expect(safeExt('cv.pdf')).toBe('pdf');
    expect(safeExt('resume.DOCX')).toBe('docx');
    expect(safeExt('noext')).toBe('');
    expect(safeExt('weird.<>')).toBe('');
  });
});
