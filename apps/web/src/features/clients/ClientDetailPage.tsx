import { type ClientDto, type MatterListItemDto } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Sheet,
  SkeletonList,
} from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Briefcase, Mail, MapPin, Pencil, Phone, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { NotFound } from '../common/NotFound.js';
import { MatterCard } from '../matters/MatterCard.js';
import { ClientBilling } from './ClientBilling.js';
import { ClientFormSheet } from './ClientFormSheet.js';

export function ClientDetailPage() {
  const { clientId = '' } = useParams();
  const me = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const client = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => api.get<ClientDto>(`/clients/${clientId}`),
  });
  const matters = useQuery({
    queryKey: ['matters', { clientId, status: 'all' }],
    queryFn: () => api.getPage<MatterListItemDto>(`/matters${qs({ clientId, status: 'all', pageSize: 50 })}`),
    enabled: canAct(me, 'matters.view'),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/clients/${clientId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
      setConfirmArchive(false);
    },
  });

  if (client.isPending) return <SkeletonList rows={4} />;
  if (client.isError) {
    return client.error instanceof ApiError && client.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this client.</Alert>
    );
  }
  const c = client.data;
  const canEdit = canAct(me, 'clients.edit') && c.status !== 'archived';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/clients" className="text-sm text-muted hover:text-ink">
            ← Clients
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{c.name}</h1>
          <div className="mt-1 flex flex-wrap gap-2">
            <Badge>{c.clientType === 'company' ? 'Company' : 'Individual'}</Badge>
            {c.status !== 'active' ? (
              <Badge tone="warning">{c.status === 'archived' ? 'Archived' : 'Inactive'}</Badge>
            ) : null}
            {!c.emailNotificationsEnabled ? <Badge tone="warning">Email updates off</Badge> : null}
          </div>
        </div>
        <div className="flex gap-2">
          {canEdit ? (
            <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {canAct(me, 'matters.create') && c.status !== 'archived' ? (
            <Button
              icon={<Plus className="size-4" />}
              onClick={() => navigate(`/matters/new?clientId=${c.id}`)}
            >
              New matter
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="h-fit">
          <CardHeader title="Contact" />
          <CardBody className="space-y-3 text-sm">
            <ContactRow icon={<Mail />} value={c.email} href={c.email ? `mailto:${c.email}` : undefined} />
            <ContactRow icon={<Phone />} value={c.phone} href={c.phone ? `tel:${c.phone}` : undefined} />
            {c.alternatePhone ? (
              <ContactRow icon={<Phone />} value={c.alternatePhone} href={`tel:${c.alternatePhone}`} />
            ) : null}
            <ContactRow
              icon={<MapPin />}
              value={[c.address, c.city, c.state].filter(Boolean).join(', ') || null}
            />
            {c.gstin || c.pan ? (
              <dl className="grid grid-cols-2 gap-2 border-t border-line pt-3">
                {c.gstin ? (
                  <div>
                    <dt className="text-xs text-muted">GSTIN</dt>
                    <dd className="font-mono text-xs">{c.gstin}</dd>
                  </div>
                ) : null}
                {c.pan ? (
                  <div>
                    <dt className="text-xs text-muted">PAN</dt>
                    <dd className="font-mono text-xs">{c.pan}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {c.notes ? (
              <p className="border-t border-line pt-3 whitespace-pre-wrap text-ink-soft">{c.notes}</p>
            ) : null}
          </CardBody>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Matters"
              description={
                me.role === 'lawyer' || me.role === 'staff' || me.role === 'read_only'
                  ? 'Matters you’re assigned to.'
                  : undefined
              }
            />
            {matters.isPending ? (
              <CardBody>
                <SkeletonList rows={2} />
              </CardBody>
            ) : matters.data && matters.data.items.length > 0 ? (
              <div className="divide-y divide-line">
                {matters.data.items.map((m) => (
                  <MatterCard key={m.id} matter={m} hideClient />
                ))}
              </div>
            ) : (
              <EmptyState icon={<Briefcase />} title="No matters to show" />
            )}
          </Card>
          {canAct(me, 'billing.view') ? <ClientBilling client={c} /> : null}
          {canEdit ? (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                className="text-danger-700"
                icon={<Archive className="size-4" />}
                onClick={() => setConfirmArchive(true)}
              >
                Archive client
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <ClientFormSheet open={editing} onClose={() => setEditing(false)} client={c} />
      <Sheet
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Archive this client?"
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button variant="secondary" block className="sm:w-auto" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              block
              className="sm:w-auto"
              loading={archive.isPending}
              onClick={() => archive.mutate()}
            >
              Archive
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-soft">
          <p>Archived clients are hidden from lists and can’t be edited. Their history is kept.</p>
          {archive.error ? (
            <Alert tone="danger">
              {archive.error instanceof ApiError ? archive.error.message : 'Could not archive.'}
            </Alert>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}

function ContactRow({
  icon,
  value,
  href,
}: {
  icon: ReactNode;
  value: string | null;
  href?: string | undefined;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-muted [&_svg]:size-4">{icon}</span>
      {value ? (
        href ? (
          <a href={href} className="min-w-0 break-words text-brand-700 hover:underline">
            {value}
          </a>
        ) : (
          <span className="min-w-0 break-words">{value}</span>
        )
      ) : (
        <span className="text-muted">Not provided</span>
      )}
    </div>
  );
}
