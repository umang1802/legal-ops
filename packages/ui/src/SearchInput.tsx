import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn.js';

export function SearchInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      >
        <path
          fillRule="evenodd"
          d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.45 4.39l3.08 3.08a.75.75 0 1 1-1.06 1.06l-3.08-3.08A7 7 0 0 1 2 9Z"
          clipRule="evenodd"
        />
      </svg>
      <input
        type="search"
        className="block h-11 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-base placeholder:text-muted focus:outline-2 focus:outline-offset-0 focus:outline-brand-600 sm:text-sm"
        {...rest}
      />
    </div>
  );
}
