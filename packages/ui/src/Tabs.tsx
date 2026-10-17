import { useRef, type KeyboardEvent } from 'react';
import { cn } from './cn.js';

export type TabItem<K extends string> = { key: K; label: string; badge?: string | number | undefined };

/**
 * Accessible tab strip (arrow-key navigation). On narrow screens the strip scrolls inside
 * itself so the page never scrolls horizontally.
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + items.length) % items.length;
    refs.current[next]?.focus();
    onChange(items[next]!.key);
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
    >
      {items.map((t, i) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'relative h-11 shrink-0 px-3 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'text-brand-700' : 'text-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.badge !== undefined ? (
              <span className="ml-1.5 rounded-full bg-subtle px-1.5 py-0.5 text-xs text-ink-soft">
                {t.badge}
              </span>
            ) : null}
            {active ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-700" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
