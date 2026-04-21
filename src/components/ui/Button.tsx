import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-copper text-white hover:bg-terracotta shadow-sm shadow-copper/20 focus:ring-copper/30',
  secondary:
    'bg-white text-charcoal hover:bg-cream border border-sand/30 shadow-sm focus:ring-sand/30',
  danger:
    'bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/20 focus:ring-red-400/30',
  ghost:
    'bg-transparent text-charcoal/60 hover:bg-cream hover:text-charcoal focus:ring-copper/20',
};

export default function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all duration-200 focus:outline-none focus:ring-2 disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
