import { EmptyState, Button } from '@legalops/ui';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';

export function PermissionDenied() {
  return (
    <EmptyState
      icon={<ShieldAlert />}
      title="You don’t have access to this page"
      description="Ask a partner or admin in your firm if you need access."
      action={
        <Link to="/">
          <Button variant="secondary">Back to home</Button>
        </Link>
      }
      className="py-16"
    />
  );
}
