import type { ReactNode } from 'react';
import { cn } from './cn.js';
import type { Tone } from './Badge.js';

const TONES: Record<Exclude<Tone, 'neutral'>, string> = {
  info: 'border-brand-200 bg-brand-50 text-brand-900',
  success: 'border-success-200 bg-success-50 text-success-900',
  warning: 'border-warning-200 bg-warning-50 text-warning-900',
  danger: 'border-danger-200 bg-danger-50 text-danger-900',
};

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Exclude<Tone, 'neutral'>;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', TONES[tone])}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? 'mt-1' : undefined}>{children}</div> : null}
    </div>
  );
}
