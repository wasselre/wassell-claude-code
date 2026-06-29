import { normalizePhoneDigits } from '@/lib/haberchat/normalize';

/**
 * Build a wa.me international number (digits only, no +) from a stored phone.
 * KSA-aware: a local "05XXXXXXXX" becomes "9665XXXXXXXX"; a bare "5XXXXXXXX"
 * gets the 966 prefix; an already-international number passes through. Returns
 * null when there aren't enough digits to form a usable number.
 */
export function toWaMeNumber(phone: string | null | undefined): string | null {
  let d = normalizePhoneDigits(phone);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = `966${d.slice(1)}`;
  else if (d.length === 9 && d.startsWith('5')) d = `966${d}`;
  return d.length >= 8 ? d : null;
}

/** wa.me chat URL for a phone, or null when the phone can't be normalized. */
export function waMeUrl(phone: string | null | undefined): string | null {
  const n = toWaMeNumber(phone);
  return n ? `https://wa.me/${n}` : null;
}

/** tel: URL for a phone (keeps a leading +). Null when empty. */
export function telUrl(phone: string | null | undefined): string | null {
  if (!phone || !phone.trim()) return null;
  const cleaned = phone.trim().replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : null;
}
