import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn.js';

const CONTROL =
  'block w-full rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-muted ' +
  'focus:outline-2 focus:outline-offset-0 focus:outline-brand-600 disabled:bg-subtle disabled:text-muted sm:text-sm';

export type FieldShellProps = {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  id: string;
  children: ReactNode;
};

export function FieldShell({ label, error, hint, id, children }: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

export function TextField({ label, error, hint, id, className, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} error={error} hint={hint} id={fieldId}>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        className={cn(CONTROL, 'h-11', error ? 'border-danger-600' : 'border-line', className)}
        {...rest}
      />
    </FieldShell>
  );
}

export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  options: readonly { value: string; label: string }[];
  ref?: Ref<HTMLSelectElement>;
};

export function SelectField({ label, error, hint, id, options, className, ...rest }: SelectFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} error={error} hint={hint} id={fieldId}>
      <select
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'h-11 pr-8', error ? 'border-danger-600' : 'border-line', className)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextAreaField({ label, error, hint, id, className, rows = 3, ...rest }: TextAreaFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldShell label={label} error={error} hint={hint} id={fieldId}>
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'py-2.5', error ? 'border-danger-600' : 'border-line', className)}
        {...rest}
      />
    </FieldShell>
  );
}
