import type { Permission } from '@legalops/types';
import { Button, cn, SearchInput, Sheet, SkeletonList } from '@legalops/ui';
import { Banknote, Briefcase, CheckSquare, Home, LogOut, Menu, Plus, Scale, Search } from 'lucide-react';
import { Suspense, useState } from 'react';
import { NavLink, Outlet, ScrollRestoration, useNavigate } from 'react-router';
import { canAct, useLogout, useSession } from '../../lib/auth.js';
import { initials } from '../../lib/format.js';
import { OrgSwitcher } from './OrgSwitcher.js';
import { navVisible, SETTINGS_NAV, SIDEBAR, type NavItem } from './nav.js';
import { SuspendedBanner } from './SuspendedBanner.js';

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      className={({ isActive }) =>
        cn(
          'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-soft hover:bg-subtle hover:text-ink',
        )
      }
    >
      <Icon className="size-4.5 shrink-0" aria-hidden />
      {item.label}
    </NavLink>
  );
}

function BottomTab({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className={({ isActive }) =>
        cn(
          'flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
          isActive ? 'text-brand-700' : 'text-muted',
        )
      }
    >
      <Icon className="size-5" aria-hidden />
      {label}
    </NavLink>
  );
}

export function AppShell() {
  const me = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const visible = (items: NavItem[]) => items.filter((i) => navVisible(me, i));
  const canBilling = canAct(me, 'billing.view');
  // Hidden when nothing could be added (read-only users, suspended firms) rather than opening an empty sheet.
  const canQuickAdd = QUICK_ADD.some((i) => canAct(me, i.permission));

  const signOut = () => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center gap-2 px-5">
          <Scale className="size-6 text-brand-700" aria-hidden />
          <span className="text-lg font-semibold tracking-tight">LexForgeX</span>
        </div>
        <div className="space-y-3 px-3">
          <OrgSwitcher />
          <SearchInput
            placeholder="Search…"
            aria-label="Search"
            onKeyDown={(e) => {
              const v = e.currentTarget.value.trim();
              if (e.key === 'Enter' && v) {
                navigate(`/search?q=${encodeURIComponent(v)}`);
                e.currentTarget.value = '';
              }
            }}
          />
        </div>
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto px-3" aria-label="Main">
          {visible(SIDEBAR).map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
          <p className="px-3 pt-5 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Settings</p>
          {visible(SETTINGS_NAV).map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t border-line p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
            {initials(me.user.firstName, me.user.lastName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {me.user.firstName} {me.user.lastName}
            </p>
            <p className="truncate text-xs text-muted">{me.user.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-ink"
            aria-label="Sign out"
          >
            <LogOut className="size-4.5" />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <SuspendedBanner />
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-4 backdrop-blur lg:hidden">
          <Scale className="size-5 text-brand-700" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-semibold">{me.organization.name}</span>
          <NavLink
            to="/search"
            aria-label="Search"
            className="-mr-2 grid size-10 place-items-center rounded-lg text-ink-soft"
          >
            <Search className="size-5" />
          </NavLink>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-10">
          <Suspense fallback={<SkeletonList rows={5} />}>
            <Outlet />
          </Suspense>
        </main>
        {/* New pages start at the top; back/forward restores the previous position. */}
        <ScrollRestoration />

        {/* Mobile bottom navigation: Home, Cases, +, Billing, More (PRD §19) */}
        <nav
          className="fixed inset-x-0 bottom-0 z-20 flex h-16 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
          aria-label="Main"
        >
          <BottomTab to="/" label="Home" icon={Home} end />
          <BottomTab to="/cases" label="Cases" icon={Briefcase} />
          <div className="flex flex-1 items-center justify-center">
            {canQuickAdd ? (
              <button
                type="button"
                onClick={() => setQuickAddOpen(true)}
                className="-mt-6 grid size-14 place-items-center rounded-full bg-brand-700 text-white shadow-lg ring-4 ring-canvas active:bg-brand-800"
                aria-label="Quick add"
              >
                <Plus className="size-6" />
              </button>
            ) : null}
          </div>
          {canBilling ? (
            <BottomTab to="/billing" label="Billing" icon={Banknote} />
          ) : (
            <BottomTab to="/tasks" label="Tasks" icon={CheckSquare} />
          )}
          <BottomTab to="/more" label="More" icon={Menu} />
        </nav>
      </div>

      <Sheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} title="Quick add">
        <QuickAdd onPick={() => setQuickAddOpen(false)} />
      </Sheet>
    </div>
  );
}

const QUICK_ADD: { label: string; to: string; permission: Permission }[] = [
  { label: 'Matter', to: '/matters/new', permission: 'matters.create' },
  { label: 'Client', to: '/clients?new=1', permission: 'clients.create' },
  { label: 'Hearing', to: '/calendar?new=1', permission: 'hearings.manage' },
  { label: 'Task', to: '/tasks?new=1', permission: 'tasks.manage' },
];

function QuickAdd({ onPick }: { onPick: () => void }) {
  const navigate = useNavigate();
  const me = useSession();
  const items = QUICK_ADD.filter((i) => canAct(me, i.permission));
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((i) => (
        <Button
          key={i.label}
          variant="secondary"
          size="lg"
          onClick={() => {
            onPick();
            navigate(i.to);
          }}
        >
          {i.label}
        </Button>
      ))}
    </div>
  );
}
