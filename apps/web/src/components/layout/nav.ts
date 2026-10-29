import type { Permission } from '@legalops/types';
import {
  Banknote,
  Briefcase,
  CalendarDays,
  CalendarSync,
  CheckSquare,
  Home,
  Mail,
  Zap,
  Settings,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; permission?: Permission; end?: boolean };

/** Desktop sidebar order. Items the role can't use are hidden (the server enforces regardless). */
export const SIDEBAR: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/cases', label: 'Cases', icon: Briefcase, permission: 'matters.view' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'matters.view' },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, permission: 'matters.view' },
  { to: '/clients', label: 'Clients', icon: UsersRound, permission: 'clients.view' },
  { to: '/billing', label: 'Billing', icon: Banknote, permission: 'billing.view' },
  { to: '/communication', label: 'Communication', icon: Mail, permission: 'matters.view' },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: '/settings/firm', label: 'Firm settings', icon: Settings, permission: 'organization.manage' },
  { to: '/settings/automations', label: 'Automations', icon: Zap, permission: 'workflows.manage' },
  { to: '/settings/members', label: 'Team', icon: Users, permission: 'dashboard.view' },
  { to: '/settings/calendar', label: 'Calendar sync', icon: CalendarSync, permission: 'matters.view' },
];
