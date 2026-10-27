import { useMe } from '../../lib/auth.js';

export function SuspendedBanner() {
  const { data } = useMe();
  if (data?.organization.status !== 'suspended') return null;
  return (
    <div
      role="status"
      className="border-b border-warning-200 bg-warning-50 px-4 py-2 text-center text-sm text-warning-900"
    >
      This account is suspended. You can view and export your records, but changes can’t be saved. Contact
      LexForgeX to reactivate.
    </div>
  );
}
