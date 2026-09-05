/**
 * Shared helpers for the PUBLIC job-application endpoints (`api/careers/*`).
 *
 * Edge-safe (no Node built-ins): the endpoints run on the edge runtime like the
 * other signed-url endpoints. Everything here is pure validation + small crypto
 * so the browser is never trusted:
 *   - MIME/size ALLOWLISTS (declared mime is checked, but never alone).
 *   - magic-byte sniffing so a `.pdf` that is really an `.exe` is rejected.
 *   - KSA phone canonicalization (mirrors the SQL `ksa_phone_canon`).
 *   - salted IP hashing so the rate-limiter never stores a raw IP.
 */

export const JOB_APP_BUCKET = 'job-applications';

// Server-enforced caps (the browser shows friendlier limits; these are the wall).
export const CV_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// Declared-MIME allowlists. Browsers are inconsistent (esp. for .doc/.docx and
// recorded audio), so these are intentionally broad and the magic-byte sniff is
// the real gate.
export const CV_MIME_ALLOW = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream', // some browsers send this for .doc/.docx
  '',
]);
export const CV_EXT_ALLOW = new Set(['pdf', 'doc', 'docx']);

export const AUDIO_MIME_ALLOW = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'video/webm', // MediaRecorder sometimes labels webm audio as video/webm
  'application/octet-stream',
  '',
]);
export const AUDIO_EXT_ALLOW = new Set(['webm', 'ogg', 'mp3', 'mp4', 'm4a', 'aac', 'wav']);

export type ApplicantSituation = 'full_time' | 'employed' | 'student' | 'job_seeker';
export const SITUATION_VALUES = new Set<ApplicantSituation>([
  'full_time', 'employed', 'student', 'job_seeker',
]);

export type ExperienceLevel = 'none' | 'less_than_1' | '1_to_3' | 'more_than_3';
export const EXPERIENCE_VALUES = new Set<ExperienceLevel>([
  'none', 'less_than_1', '1_to_3', 'more_than_3',
]);

export const YES_NO = new Set(['yes', 'no']);

/** True when the applicant selected an experience level implying real experience
 *  (so Q5 "results" is expected + the file/story make sense). */
export function hasSalesExperience(level: string | null | undefined): boolean {
  return level === 'less_than_1' || level === '1_to_3' || level === 'more_than_3';
}

/**
 * Canonicalize a Saudi mobile number to +9665XXXXXXXX, or null if not a valid
 * KSA mobile. Accepts 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, +9665XXXXXXXX and
 * separators/spaces. Mirrors the SQL `ksa_phone_canon` shape used elsewhere.
 */
export function canonKsaPhone(raw: string): string | null {
  if (!raw) return null;
  // Convert Arabic-Indic digits to ASCII, then strip everything but digits.
  const ascii = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
                   .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  let digits = ascii.replace(/\D/g, '');
  // Normalize national/international prefixes down to the bare 9-digit "5XXXXXXXX".
  if (digits.startsWith('00966')) digits = digits.slice(5);
  else if (digits.startsWith('966')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  // Now expect exactly 9 digits beginning with 5.
  if (!/^5\d{8}$/.test(digits)) return null;
  return `+966${digits}`;
}

/** Derive a safe lowercase file extension from a filename. */
export function safeExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean =>
  sig.every((v, i) => b[offset + i] === v);

/**
 * Sniff a CV file's real container type from its leading bytes. Returns the
 * canonical kind or null when it is not a PDF / DOC / DOCX.
 *   PDF  → "%PDF"           25 50 44 46
 *   DOCX → ZIP (OOXML)      50 4B 03 04 / 05 06 / 07 08
 *   DOC  → OLE2 compound    D0 CF 11 E0 A1 B1 1A E1
 */
export function sniffCvKind(bytes: Uint8Array): 'pdf' | 'docx' | 'doc' | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) return 'docx';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc';
  return null;
}

/**
 * True when the leading bytes look like one of the accepted audio containers.
 *   webm/mkv (EBML)  1A 45 DF A3
 *   ogg              4F 67 67 53  "OggS"
 *   wav (RIFF/WAVE)  52 49 46 46 .. .. .. .. 57 41 56 45
 *   mp3 (ID3)        49 44 33  "ID3"
 *   mp3 frame sync   FF Ex/Fx
 *   mp4/m4a (ftyp)   .. .. .. .. 66 74 79 70  at offset 4
 *   aac (ADTS)       FF F1 / FF F9
 */
export function looksLikeAudio(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return true; // webm/matroska
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return true; // ogg
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) return true; // wav
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return true; // mp3 ID3
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return true; // mp3/aac frame sync
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return true; // mp4/m4a ftyp box
  return false;
}

/** The client IP as reported by Vercel's edge (first hop of x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  const first = xff.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || 'unknown';
}

/** Salted SHA-256 of an IP → hex, so the rate table never stores a raw address. */
export async function hashIp(ip: string): Promise<string> {
  const salt = process.env.JOB_APP_IP_SALT ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'wassel-careers';
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
