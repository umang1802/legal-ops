import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from './cn.js';

/**
 * One box per digit, like the one-time-code screens people know. Digits only. Typing moves to the next box, Backspace
 * to the previous one, and pasting (or a phone's SMS/authenticator autofill) fills every box at once.
 *
 * It keeps its own boxes and reports the digits typed so far through `onChange` (shorter than `length` means
 * incomplete); `onComplete` fires when the last box is filled. To clear it, give it a new `key`.
 */
export function OtpInput({
  length = 6,
  onChange,
  onComplete,
  label = 'Verification code',
  error,
  disabled,
  autoFocus,
  className,
}: {
  length?: number;
  onChange?: (code: string) => void;
  onComplete?: (code: string) => void;
  label?: string;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length }, () => ''));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const focus = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  };
  const commit = (next: string[], focusAt: number) => {
    setDigits(next);
    const code = next.join('');
    onChange?.(code);
    focus(focusAt);
    if (code.length === length) onComplete?.(code);
  };
  /** Writes `typed` into the boxes starting at `from`; a full-length code always starts at the first box. */
  const fill = (typed: string, from: number) => {
    const clean = typed.replace(/\D/g, '');
    if (!clean) return;
    const start = clean.length >= length ? 0 : from;
    const next = [...digits];
    let last = start;
    for (const [k, d] of [...clean.slice(0, length - start)].entries()) {
      next[start + k] = d;
      last = start + k;
    }
    commit(next, last + 1);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) next[i] = '';
      else if (i > 0) next[i - 1] = '';
      else return;
      setDigits(next);
      onChange?.(next.join(''));
      focus(next[i] === '' && digits[i] ? i : i - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(i + 1);
    }
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    fill(e.clipboardData.getData('text'), i);
  };

  return (
    <div role="group" aria-label={label} className={cn('flex gap-2', className)}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${id}-${i}`}
          value={d}
          inputMode="numeric"
          pattern="[0-9]*"
          // Only the first box asks the phone for the code from SMS or the authenticator; it then arrives as one paste.
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={error ? true : undefined}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, '');
            if (!typed) {
              const next = [...digits];
              next[i] = '';
              setDigits(next);
              onChange?.(next.join(''));
            } else fill(typed, i);
          }}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => onPaste(i, e)}
          className={cn(
            'h-12 min-w-0 flex-1 rounded-lg border bg-surface text-center text-xl font-semibold text-ink tabular-nums',
            'focus:outline-2 focus:outline-offset-0 focus:outline-brand-600 disabled:bg-subtle disabled:text-muted',
            error ? 'border-danger-600' : 'border-line',
          )}
        />
      ))}
    </div>
  );
}
