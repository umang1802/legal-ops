import type { DocumentDto, HearingDto } from '@legalops/types';
import { Button, Card, CardHeader, Sheet } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { DocumentList } from './DocumentList.js';
import { DocumentUploader } from './DocumentUploader.js';

/** Orders and papers filed against one hearing. */
export function HearingDocumentsCard({ hearing }: { hearing: HearingDto }) {
  const me = useSession();
  const [attaching, setAttaching] = useState(false);
  const q = useQuery({
    queryKey: ['documents', 'hearing', hearing.id],
    queryFn: () => api.get<DocumentDto[]>(`/documents${qs({ hearingId: hearing.id })}`),
    enabled: canAct(me, 'documents.view'),
  });
  if (!canAct(me, 'documents.view')) return null;
  return (
    <Card>
      <CardHeader
        title="Orders & documents"
        action={
          canAct(me, 'documents.upload') ? (
            <Button size="sm" variant="secondary" icon={<Paperclip className="size-4" />} onClick={() => setAttaching(true)}>
              Attach order
            </Button>
          ) : null
        }
      />
      <DocumentList docs={q.data} loading={q.isPending} emptyHint="Attach the court order or other papers from this hearing." />
      <Sheet open={attaching} onClose={() => setAttaching(false)} title="Attach to this hearing">
        <DocumentUploader matterId={hearing.matterId} cases={[]} hearingId={hearing.id} defaultCategory="orders" onDone={() => setAttaching(false)} />
      </Sheet>
    </Card>
  );
}
