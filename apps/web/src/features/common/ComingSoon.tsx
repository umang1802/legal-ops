import { Card, EmptyState, PageHeader } from '@legalops/ui';
import { Construction } from 'lucide-react';

/** Honest placeholder for modules not built yet. Never shows fake data. */
export function ComingSoon({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          icon={<Construction />}
          title={`${title} arrives in ${phase}`}
          description={description}
          className="py-14"
        />
      </Card>
    </>
  );
}
