import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn.js';
import { Spinner } from './Spinner.js';

export type ComboOption = { value: string; label: string; description?: string | undefined };

/**
 * Search-as-you-type picker (WAI-ARIA combobox pattern). The parent owns fetching: it receives
 * the query via onQueryChange and passes back options.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  onQueryChange,
  loading,
  placeholder,
  error,
  footer,
  emptyText = 'No matches',
}: {
  label: string;
  value: ComboOption | null;
  onChange: (option: ComboOption | null) => void;
  options: readonly ComboOption[];
  onQueryChange: (query: string) => void;
  loading?: boolean;
  placeholder?: string;
  error?: string | undefined;
  footer?: ReactNode;
  emptyText?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (o: ComboOption) => {
    onChange(o);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="min-w-0 space-y-1.5" ref={wrapper}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {value ? (
        <div className="flex h-11 items-center justify-between gap-2 rounded-lg border border-line bg-subtle px-3">
          <span className="min-w-0 truncate text-sm font-medium">
            {value.label}
            {value.description ? (
              <span className="ml-2 font-normal text-muted">{value.description}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="shrink-0 text-sm font-medium text-brand-700 hover:underline"
            onClick={() => {
              onChange(null);
              setOpen(true);
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            value={query}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
              onQueryChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, options.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && open && options[active]) {
                e.preventDefault();
                pick(options[active]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
            className={cn(
              'block h-11 w-full rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-muted sm:text-sm',
              'focus:outline-2 focus:outline-offset-0 focus:outline-brand-600',
              error ? 'border-danger-600' : 'border-line',
            )}
          />
          {loading ? <Spinner className="absolute top-3.5 right-3 size-4 text-muted" /> : null}
          {open ? (
            <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
              <ul id={`${id}-list`} role="listbox" className="max-h-64 overflow-y-auto py-1">
                {options.length === 0 && !loading ? (
                  <li className="px-3 py-2 text-sm text-muted">{emptyText}</li>
                ) : null}
                {options.map((o, i) => (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(o);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn('cursor-pointer px-3 py-2 text-sm', i === active && 'bg-brand-50')}
                  >
                    <span className="font-medium">{o.label}</span>
                    {o.description ? <span className="block text-xs text-muted">{o.description}</span> : null}
                  </li>
                ))}
              </ul>
              {footer ? <div className="border-t border-line p-1">{footer}</div> : null}
            </div>
          ) : null}
        </div>
      )}
      {error ? <p className="text-sm text-danger-700">{error}</p> : null}
    </div>
  );
}
