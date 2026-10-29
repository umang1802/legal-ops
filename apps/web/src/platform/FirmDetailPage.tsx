import type { PlatformFirmDetail } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Sheet,
  SkeletonList,
  TextAreaField,
  TextField,
} from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';
import { STATUS } from './FirmsPage.js';
import { PendingInvitesCard } from './PendingInvitesCard.js';

const when = (s: string | null) =>
  s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function FirmDetailPage() {
  const { firmId = '' } = useParams();
  const qc = useQueryClient();
  const key = ['platform', 'firms', firmId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => platformApi.get<PlatformFirmDetail>(`/firms/${firmId}`),
  });
  const act = useMutation({
    mutationFn: ({
      path,
      body,
      method = 'post',
    }: {
      path: string;
      body?: unknown;
      method?: 'post' | 'patch';
    }) => platformApi[method]<PlatformFirmDetail>(`/firms/${firmId}${path}`, body),
    onSuccess: (firm) => {
      qc.setQueryData(key, firm);
      void qc.invalidateQueries({ queryKey: ['platform', 'firms'], exact: false });
    },
  });
  const [notes, setNotes] = useState<string | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');
  const [reinvite, setReinvite] = useState(false);
  const [partner, setPartner] = useState({ partnerName: '', partnerEmail: '' });
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (q.data && notes === null) setNotes(q.data.platformNotes ?? '');
  }, [q.data, notes]);
  // Autosave notes 800 ms after typing stops.
  const save = act.mutate; // stable across renders
  const serverNotes = q.data?.platformNotes ?? '';
  useEffect(() => {
    // The equality guard stops a save loop once the server copy matches what was typed.
    if (notes === null || !q.data || notes === serverNotes) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSaved('saving');
      save(
        { path: '', method: 'patch', body: { platformNotes: notes || null } },
        { onSuccess: () => setSaved('saved') },
      );
    }, 800);
    return () => window.clearTimeout(timer.current);
  }, [notes, serverNotes, q.data, save]);

  if (q.isPending) return <SkeletonList rows={4} />;
  if (!q.data) return <Alert tone="danger">Firm not found.</Alert>;
  const f = q.data;
  const inv = f.invitation;

  return (
    <>
      <Link to="/platform/firms" className="text-sm text-muted hover:underline">
        ← Firms
      </Link>
      <PageHeader
        title={f.name}
        description={<Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>}
        actions={
          f.status === 'active' ? (
            <Button variant="danger" onClick={() => setSuspending(true)}>
              Suspend
            </Button>
          ) : f.status === 'suspended' ? (
            <Button onClick={() => act.mutate({ path: '/reactivate' })} disabled={act.isPending}>
              Reactivate
            </Button>
          ) : null
        }
      />
      {act.error instanceof ApiError ? (
        <div className="mb-4">
          <Alert tone="danger">{act.error.message}</Alert>
        </div>
      ) : null}
      {f.status === 'suspended' ? (
        <div className="mb-4">
          <Alert tone="warning" title={`Suspended ${when(f.suspendedAt)}`}>
            {f.suspendedReason}
          </Alert>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <TextAreaField
                label="Payment and account notes (LexForgeX team only)"
                rows={5}
                value={notes ?? ''}
                onChange={(e) => setNotes(e.target.value)}
                hint={
                  saved === 'saving'
                    ? 'Saving…'
                    : saved === 'saved'
                      ? 'Saved'
                      : 'Saves automatically. Never shown to the firm.'
                }
              />
            </CardBody>
          </Card>
          <PendingInvitesCard firmId={f.id} suspended={f.status === 'suspended'} />
          <Card>
            <CardHeader title="History" />
            <CardBody>
              <ul className="space-y-2 text-sm">
                {f.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="font-medium">{h.action.replace('firm.', '').replace(/_/g, ' ')}</span>
                      {typeof h.details.reason === 'string' ? ` — ${h.details.reason}` : ''}
                    </span>
                    <span className="text-muted">
                      {h.adminName} · {when(h.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Firm" />
            <CardBody className="space-y-1 text-sm">
              <p>Owner: {f.ownerEmail ?? '—'}</p>
              <p>Users: {f.userCount}</p>
              <p>Cases: {f.caseCount}</p>
              <p>Last active: {when(f.lastActivityAt)}</p>
              <p>Created: {when(f.createdAt)}</p>
            </CardBody>
          </Card>
          {inv ? (
            <Card>
              <CardHeader title="Owner invitation" />
              <CardBody className="space-y-2 text-sm">
                <p>{inv.email}</p>
                <p className="text-muted">
                  {inv.state === 'pending' ? `Expires ${when(inv.expiresAt)}` : inv.state}
                </p>
                {f.status === 'invited' ? (
                  <div className="flex flex-wrap gap-2">
                    {inv.state === 'pending' ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => act.mutate({ path: '/invitation/resend' })}
                        >
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => act.mutate({ path: '/invitation/revoke' })}
                        >
                          Revoke
                        </Button>
                      </>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={() => setReinvite(true)}>
                      Invite a different email
                    </Button>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <Sheet open={suspending} onClose={() => setSuspending(false)} title={`Suspend ${f.name}`}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            act.mutate(
              { path: '/suspend', body: { reason } },
              {
                onSuccess: () => {
                  setSuspending(false);
                  setReason('');
                },
              },
            );
          }}
        >
          <p className="text-sm">
            The firm keeps read-only access and can export its data. Nothing is deleted. Reminders and client
            emails stop until you reactivate.
          </p>
          <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <Button
            type="submit"
            variant="danger"
            className="w-full"
            disabled={!reason.trim() || act.isPending}
          >
            Suspend firm
          </Button>
        </form>
      </Sheet>
      <Sheet open={reinvite} onClose={() => setReinvite(false)} title="Invite a different email">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            act.mutate({ path: '/invitation', body: partner }, { onSuccess: () => setReinvite(false) });
          }}
        >
          <TextField
            label="Partner’s name"
            value={partner.partnerName}
            onChange={(e) => setPartner((p) => ({ ...p, partnerName: e.target.value }))}
            required
          />
          <TextField
            label="Partner’s email"
            type="email"
            value={partner.partnerEmail}
            onChange={(e) => setPartner((p) => ({ ...p, partnerEmail: e.target.value }))}
            required
          />
          <Button type="submit" className="w-full" disabled={act.isPending}>
            Send invitation
          </Button>
        </form>
      </Sheet>
    </>
  );
}
