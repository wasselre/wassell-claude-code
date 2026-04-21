import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE, splitPhone, joinPhone } from '@/lib/phone';

interface PhoneInputProps {
  value: string | null | undefined;
  onChange: (value: string | undefined) => void;
  defaultCountryCode?: string;
  placeholder?: string;
  compact?: boolean; // table inline-edit mode: shorter inputs, code-only dropdown
}

export default function PhoneInput({
  value,
  onChange,
  defaultCountryCode,
  placeholder,
  compact = false,
}: PhoneInputProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const fallbackCode = defaultCountryCode ?? DEFAULT_COUNTRY_CODE;

  const initial = splitPhone(value, fallbackCode);
  const [code, setCode] = useState<string>(initial.code);
  const [rest, setRest] = useState<string>(initial.rest);

  // Keep internal state in sync when the external value changes unexpectedly
  // (e.g., parent resets the form). Doesn't fire during user edits because
  // we emit only canonicalized joined values, and splitPhone round-trips them.
  useEffect(() => {
    const next = splitPhone(value, fallbackCode);
    if (next.code !== code) setCode(next.code);
    if (next.rest !== rest) setRest(next.rest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (nextCode: string, nextRest: string) => {
    const joined = joinPhone(nextCode, nextRest);
    onChange(joined || undefined);
  };

  const inputCls = compact ? 'form-input text-sm py-1 px-2 flex-1 min-w-0' : 'form-input flex-1';
  const selectCls = compact ? 'form-input text-sm py-1 px-2 w-20 shrink-0' : 'form-input w-40 shrink-0';

  return (
    <div
      className={`flex ${compact ? 'gap-1' : 'gap-2'} items-center`}
      dir="ltr"
      onClick={(e) => e.stopPropagation()}
    >
      <select
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          emit(e.target.value, rest);
        }}
        className={selectCls}
        aria-label={isAr ? 'رمز الدولة' : 'Country code'}
      >
        {COUNTRY_CODES.map((c) => (
          <option key={c.code} value={c.code} title={isAr ? c.name_ar : c.name_en}>
            {compact ? c.code : `${c.code} ${isAr ? c.name_ar : c.name_en}`}
          </option>
        ))}
      </select>
      <input
        type="tel"
        value={rest}
        onChange={(e) => {
          setRest(e.target.value);
          emit(code, e.target.value);
        }}
        className={inputCls}
        placeholder={placeholder}
      />
    </div>
  );
}
