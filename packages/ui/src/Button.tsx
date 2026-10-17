import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from './cn.js';
import { Spinner } from './Spinner.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900 disabled:bg-brand-700/50',
  secondary: 'bg-surface text-ink border border-line hover:bg-subtle active:bg-line disabled:text-muted',
  ghost: 'bg-transparent text-ink hover:bg-subtle active:bg-line disabled:text-muted',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 disabled:bg-danger-600/50',
};

// Minimum 44px touch target on md/lg (mobile-first).
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}
