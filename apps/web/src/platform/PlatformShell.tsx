import { Button, Spinner } from '@legalops/ui';
import { Suspense } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router';
import { usePlatformLogout, usePlatformMe } from './auth.js';

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:text-white'}`;

/** Visually distinct from any firm workspace (dark header) so no admin mistakes one for the other. */
export function PlatformShell() {
  const { data: me, isPending } = usePlatformMe();
  const logout = usePlatformLogout();
  const navigate = useNavigate();
  if (isPending)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-8" />
      </div>
    );
  if (!me?.mfaVerified) return <Navigate to="/platform/login" replace />;
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="bg-slate-950 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <span className="font-semibold">LegalForgeX Platform</span>
          <nav className="flex gap-1">
            <NavLink to="/platform/firms" className={link}>
              Firms
            </NavLink>
            <NavLink to="/platform/audit" className={link}>
              Audit log
            </NavLink>
          </nav>
          <span className="ml-auto hidden text-sm text-slate-400 sm:inline">{me.admin.email}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/platform/login') })}
          >
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Suspense fallback={<Spinner className="size-6" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
