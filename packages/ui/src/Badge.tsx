import type { ReactNode } from 'react';
import { cn } from './cn.js';

/** Tones follow the design rules: red only for attention, green only for done/paid, amber for warnings. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-soft ring-line',
  info: 'bg-brand-50 text-brand-800 ring-brand-200',
  success: 'bg-success-50 text-success-800 ring-success-200',
  warning: 'bg-warning-50 text-warning-800 ring-warning-200',
  danger: 'bg-danger-50 text-danger-800 ring-danger-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
