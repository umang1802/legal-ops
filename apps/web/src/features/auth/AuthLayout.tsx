import { Card } from '@legalops/ui';
import type { ReactNode } from 'react';
import { Logo } from '../../components/branding/LogoMark.js';

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6">
        <Logo markClassName="size-10" textClassName="text-lg" />
      </div>
      <Card className="w-full max-w-sm p-5 sm:p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        <div className="mt-5">{children}</div>
      </Card>
    </div>
  );
}
