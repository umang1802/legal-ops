import { Card } from '@legalops/ui';
import { ChevronRight, LogOut } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { OrgSwitcher } from '../../components/layout/OrgSwitcher.js';
import { SETTINGS_NAV, SIDEBAR } from '../../components/layout/nav.js';
import { canAct, useLogout, useSession } from '../../lib/auth.js';

/** Mobile overflow menu: everything not in the bottom bar. */
export function MorePage() {
  const me = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const inBottomBar = new Set(['/', '/cases', '/billing']);
  const items = [...SIDEBAR.filter((i) => !inBottomBar.has(i.to)), ...SETTINGS_NAV].filter(
    (i) => !i.permission || canAct(me, i.permission),
  );

  return (
    <div className="space-y-4">
      <OrgSwitcher />
      <Card className="divide-y divide-line">
        {items.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex h-14 items-center gap-3 px-4 text-sm font-medium active:bg-subtle"
          >
            <Icon className="size-5 text-muted" aria-hidden />
            <span className="flex-1">{label}</span>
            <ChevronRight className="size-4 text-muted" aria-hidden />
          </Link>
        ))}
      </Card>
      <Card>
        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
          className="flex h-14 w-full items-center gap-3 px-4 text-sm font-medium text-danger-700 active:bg-subtle"
        >
          <LogOut className="size-5" aria-hidden />
          Sign out
        </button>
      </Card>
      <p className="text-center text-xs text-muted">Signed in as {me.user.email}</p>
    </div>
  );
}
