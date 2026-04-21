import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export default function Input({ label, error, className = '', id, ...props }: InputProps) {
  const inputId = id ?? label?.replace(/\s+/g, '_').toLowerCase();

  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-bold text-charcoal">
          {label}
          {props.required && <span className="text-red-500 ms-1">*</span>}
        </label>
      )}
      <input
        id={inputId}
        className={`form-input ${error ? 'border-red-400 focus:border-red-500 focus:ring-red-300/30' : ''} ${className}`}
        {...props}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
