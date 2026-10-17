import type { ClientDto, MatterDetailDto, NotificationDto } from '@legalops/types';
import { Button, Card, CardHeader, EmptyState, SkeletonList } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useCan, useSession } from '../../lib/auth.js';
import { NotificationSheet } from './NotificationSheet.js';
import { SendUpdateSheet } from './SendUpdateSheet.js';
import { NotificationRow } from './shared.js';

export function MatterCommunicationTab({ matter }: { matter: MatterDetailDto }) {
  const me = useSession();
  const canSend = useCan('matters.edit');
  const [open, setOpen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const list = useQuery({
    queryKey: ['notifications', { matterId: matter.id }],
    queryFn: () => api.getPage<NotificationDto>(`/notifications${qs({ matterId: matter.id, pageSize: 50 })}`),
  });
  const client = useQuery({
    queryKey: ['client', matter.client.id],
    queryFn: () => api.get<ClientDto>(`/clients/${matter.client.id}`),
    enabled: canSend,
  });

  return (
    <Card>
      <CardHeader
        title="Messages"
        action={
          canSend ? (
            <Button size="sm" icon={<Send className="size-4" />} onClick={() => setSending(true)} disabled={!client.data}>
              Send client update
            </Button>
          ) : undefined
        }
      />
      {list.isPending ? (
        <SkeletonList rows={3} />
      ) : list.data && list.data.items.length ? (
        <div className="divide-y divide-line">
          {list.data.items.map((n) => (
            <NotificationRow key={n.id} n={n} showMatter={false} timeZone={me.organization.timezone} onOpen={() => setOpen(n.id)} />
          ))}
        </div>
      ) : (
        <EmptyState title="No messages yet" description="Hearing reminders, outcomes and invoices emailed to the client appear here." className="py-10" />
      )}
      <NotificationSheet id={open} onClose={() => setOpen(null)} />
      {client.data ? (
        <SendUpdateSheet
          open={sending}
          onClose={() => setSending(false)}
          clientId={client.data.id}
          clientName={client.data.name}
          clientEmail={client.data.email}
          emailsOff={!client.data.emailNotificationsEnabled}
          matterId={matter.id}
          onSent={(n) => setOpen(n.id)}
        />
      ) : null}
    </Card>
  );
}
