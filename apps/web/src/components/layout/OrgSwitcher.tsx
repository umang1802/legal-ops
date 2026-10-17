import { ROLE_LABELS } from '@legalops/types';
import { useNavigate } from 'react-router';
import { useSession, useSwitchOrganization } from '../../lib/auth.js';

export function OrgSwitcher() {
  const me = useSession();
  const switchOrg = useSwitchOrganization();
  const navigate = useNavigate();

  if (me.memberships.length <= 1) {
    return (
      <div className="rounded-lg bg-subtle px-3 py-2">
        <p className="truncate text-sm font-semibold">{me.organization.name}</p>
        <p className="text-xs text-muted">{ROLE_LABELS[me.role]}</p>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="sr-only">Active firm</span>
      <select
        className="h-11 w-full rounded-lg border border-line bg-subtle px-3 text-sm font-semibold"
        value={me.organization.id}
        disabled={switchOrg.isPending}
        onChange={(e) => switchOrg.mutate(e.target.value, { onSuccess: () => navigate('/') })}
      >
        {me.memberships.map((m) => (
          <option key={m.organizationId} value={m.organizationId}>
            {m.organizationName} · {ROLE_LABELS[m.role]}
          </option>
        ))}
      </select>
    </label>
  );
}
