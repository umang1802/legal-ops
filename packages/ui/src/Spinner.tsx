import { cn } from './cn.js';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
