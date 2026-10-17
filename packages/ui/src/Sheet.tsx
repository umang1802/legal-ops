import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

/**
 * Bottom sheet on phones, centred dialog on larger screens. Built on <dialog> so focus trapping,
 * Escape-to-close and inert background come from the browser.
 *
 * Portalled to <body>: a sheet containing its own <form> may be opened from inside another form
 * (e.g. "new client" inside "new matter"). Nested forms are invalid HTML and make the browser fall
 * back to a native GET submit that leaks field values into the URL.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // React's autoFocus fires on mount (while closed); focus the first field once the dialog is shown.
      el.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return createPortal(
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // React events bubble through portals; keep this sheet's submits away from any parent form.
      onSubmit={(e) => e.stopPropagation()}
      aria-labelledby={titleId}
      className={cn(
        'm-0 mt-auto w-full max-w-none rounded-t-2xl bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40',
        'sm:m-auto sm:max-w-lg sm:rounded-2xl',
      )}
    >
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 grid size-10 place-items-center rounded-lg text-muted hover:bg-subtle"
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden>
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <div className="border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
