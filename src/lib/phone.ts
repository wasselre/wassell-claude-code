export interface CountryCode {
  code: string;
  name_en: string;
  name_ar: string;
}

export const DEFAULT_COUNTRY_CODE = '+966';

export const COUNTRY_CODES: CountryCode[] = [
  { code: '+966', name_en: 'Saudi Arabia', name_ar: 'السعودية' },
  { code: '+971', name_en: 'UAE', name_ar: 'الإمارات' },
  { code: '+965', name_en: 'Kuwait', name_ar: 'الكويت' },
  { code: '+973', name_en: 'Bahrain', name_ar: 'البحرين' },
  { code: '+974', name_en: 'Qatar', name_ar: 'قطر' },
  { code: '+968', name_en: 'Oman', name_ar: 'عُمان' },
  { code: '+967', name_en: 'Yemen', name_ar: 'اليمن' },
  { code: '+20', name_en: 'Egypt', name_ar: 'مصر' },
  { code: '+962', name_en: 'Jordan', name_ar: 'الأردن' },
  { code: '+961', name_en: 'Lebanon', name_ar: 'لبنان' },
  { code: '+963', name_en: 'Syria', name_ar: 'سوريا' },
  { code: '+964', name_en: 'Iraq', name_ar: 'العراق' },
  { code: '+212', name_en: 'Morocco', name_ar: 'المغرب' },
  { code: '+90', name_en: 'Turkey', name_ar: 'تركيا' },
  { code: '+92', name_en: 'Pakistan', name_ar: 'باكستان' },
  { code: '+91', name_en: 'India', name_ar: 'الهند' },
  { code: '+1', name_en: 'US / Canada', name_ar: 'أمريكا / كندا' },
  { code: '+44', name_en: 'United Kingdom', name_ar: 'المملكة المتحدة' },
  { code: '+33', name_en: 'France', name_ar: 'فرنسا' },
  { code: '+49', name_en: 'Germany', name_ar: 'ألمانيا' },
];

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Normalize a raw phone value to canonical E.164 (e.g. "+966501234567").
 * Returns null if the input is empty or has fewer than 7 digits.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const hasPlusPrefix = trimmed.startsWith('+');
  const digits = digitsOnly(trimmed);
  if (digits.length < 7) return null;

  if (hasPlusPrefix) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.substring(2)}`;
  if (digits.startsWith('0')) return `+966${digits.substring(1)}`;
  if (digits.startsWith('966')) return `+${digits}`;
  return `+966${digits}`;
}

export function telUrl(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  return n ? `tel:${n}` : null;
}

/** wa.me requires digits only, no "+" and no spaces. */
export function whatsappUrl(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  if (!n) return null;
  return `https://wa.me/${n.substring(1)}`;
}

/**
 * Split a stored phone value into { code, rest } for the edit UI.
 * Matches the longest known country-code prefix; otherwise falls back to the field's default.
 */
export function splitPhone(
  raw: string | null | undefined,
  defaultCode: string = DEFAULT_COUNTRY_CODE,
): { code: string; rest: string } {
  if (raw === null || raw === undefined) return { code: defaultCode, rest: '' };
  const trimmed = String(raw).trim();
  if (!trimmed) return { code: defaultCode, rest: '' };

  if (trimmed.startsWith('+')) {
    const sorted = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);
    for (const c of sorted) {
      if (trimmed.startsWith(c.code)) {
        return { code: c.code, rest: trimmed.substring(c.code.length).trim() };
      }
    }
    return { code: defaultCode, rest: trimmed };
  }

  const restDigits = digitsOnly(trimmed);
  if (restDigits.startsWith('0')) {
    return { code: defaultCode, rest: restDigits.substring(1) };
  }
  return { code: defaultCode, rest: restDigits };
}

/** Combine a country code and number part into canonical E.164 (no space). */
export function joinPhone(code: string, rest: string): string {
  const codeDigits = digitsOnly(code);
  const restDigits = digitsOnly(rest);
  if (!restDigits) return '';
  return `+${codeDigits}${restDigits}`;
}
