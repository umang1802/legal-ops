import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-xs', className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 sm:px-5', className)} {...rest} />;
}
