import { Button, EmptyState } from '@legalops/ui';
import { Compass } from 'lucide-react';
import { Link } from 'react-router';

export function NotFound() {
  return (
    <EmptyState
      icon={<Compass />}
      title="Page not found"
      description="The link may be old or mistyped."
      action={
        <Link to="/">
          <Button variant="secondary">Go home</Button>
        </Link>
      }
      className="py-16"
    />
  );
}
