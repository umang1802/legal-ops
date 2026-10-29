import type { FeatureKey, MeResponse, Permission } from '@legalops/types';
import { canAct, hasFeature } from '../../lib/auth.js';
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

export type NavItem = { to: string; label: string; icon: LucideIcon; permission?: Permission; feature?: FeatureKey; end?: boolean };

/** Desktop sidebar order. Items the role can't use are hidden (the server enforces regardless). */
export const SIDEBAR: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/cases', label: 'Cases', icon: Briefcase, permission: 'matters.view' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'matters.view' },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, permission: 'matters.view' },
  { to: '/clients', label: 'Clients', icon: UsersRound, permission: 'clients.view' },
  { to: '/billing', label: 'Billing', icon: Banknote, permission: 'billing.view' },
  { to: '/communication', label: 'Communication', icon: Mail, permission: 'matters.view', feature: 'communication' },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: '/settings/firm', label: 'Firm settings', icon: Settings, permission: 'organization.manage' },
  { to: '/settings/automations', label: 'Automations', icon: Zap, permission: 'workflows.manage' },
  { to: '/settings/members', label: 'Team', icon: Users, permission: 'dashboard.view' },
  { to: '/settings/calendar', label: 'Calendar sync', icon: CalendarSync, permission: 'matters.view', feature: 'calendar_sync' },
];

/** Whether a menu entry shows for this person: their role allows it and its feature is on. */
export const navVisible = (me: MeResponse, item: NavItem) =>
  (!item.permission || canAct(me, item.permission)) && (!item.feature || hasFeature(me, item.feature));
