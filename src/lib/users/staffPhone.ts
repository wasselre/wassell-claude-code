/**
 * A team member's own mobile (users.phone) — what the operations WhatsApp line
 * messages them on (e.g. the portal-status alert) and what portal forms
 * prefill as `user.phone`.
 *
 * Stored as E.164 with the plus: "+9665XXXXXXXX" for a Saudi mobile. Accepts
 * the ways people type it («0555…», «555…», «966555…», «+966 55 …»). A number
 * that is clearly not a valid mobile is REJECTED with a reason rather than
 * saved half-right — a wrong number here means alerts silently go nowhere.
 */
import { normalizePhoneDigits, ksaCanonicalPhone } from '@/lib/haberchat/normalize';

export type StaffPhoneResult =
  | { ok: true; value: string | null }
  | { ok: false; reason_ar: string; reason_en: string };

export function normalizeStaffPhone(input: string | null | undefined): StaffPhoneResult {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: true, value: null }; // clearing the field is allowed
  const digits = normalizePhoneDigits(raw);
  const international = raw.startsWith('+') || raw.startsWith('00');
  const intlDigits = raw.startsWith('00') ? digits.slice(2) : digits;

  // A non-Saudi number typed with its country code is kept as typed.
  if (international && !intlDigits.startsWith('966')) {
    if (intlDigits.length >= 8 && intlDigits.length <= 15) return { ok: true, value: `+${intlDigits}` };
    return { ok: false, reason_ar: 'رقم دولي غير صالح', reason_en: 'Not a valid international number' };
  }

  const canon = ksaCanonicalPhone(digits);
  if (/^9665\d{8}$/.test(canon)) return { ok: true, value: `+${canon}` };
  return {
    ok: false,
    reason_ar: 'أدخل رقم جوال سعودي صحيح مثل 0555123456',
    reason_en: 'Enter a valid Saudi mobile, e.g. 0555123456',
  };
}
