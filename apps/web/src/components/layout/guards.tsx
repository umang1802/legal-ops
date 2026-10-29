import { can, type FeatureKey, type Permission, PERMISSION_FEATURE } from '@legalops/types';
import { Button, Spinner } from '@legalops/ui';
import { Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { hasFeature, useCan, useMe, useSession } from '../../lib/auth.js';
import { NotFound } from '../../features/common/NotFound.js';
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
  const me = useSession();
  const allowed = useCan(permission);
  if (allowed) return <>{children}</>;
  // The role has it but the firm's feature is off: the page doesn't exist for this firm.
  const feature = PERMISSION_FEATURE[permission];
  if (feature && can(me.role, permission) && !hasFeature(me, feature)) return <NotFound />;
  return <PermissionDenied />;
}

/** Pages of a switchable feature: Not Found when it's off for the firm. */
export function RequireFeature({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  return hasFeature(useSession(), feature) ? <>{children}</> : <NotFound />;
}
