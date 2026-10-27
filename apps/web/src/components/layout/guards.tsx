import type { Permission } from '@legalops/types';
import { Button, Spinner } from '@legalops/ui';
import { Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useCan, useMe } from '../../lib/auth.js';
import { PermissionDenied } from '../../features/common/PermissionDenied.js';

function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center text-brand-700">
      <Spinner className="size-8" />
    </div>
  );
}

export function RequireAuth() {
  const { data: me, isPending, isError, refetch } = useMe();
  const location = useLocation();
  if (isPending) return <FullPageSpinner />;
  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="font-medium">We couldn’t reach LexForgeX.</p>
          <p className="mt-1 text-sm text-muted">Check your connection and try again.</p>
          <Button className="mt-4" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Outlet />
    </Suspense>
  );
}

export function RedirectIfAuthed() {
  const { data: me, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  if (me) return <Navigate to="/" replace />;
  return <Outlet />;
}

export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  return useCan(permission) ? <>{children}</> : <PermissionDenied />;
}
