import { ROLE_LABELS, type PlatformInviteLink, type PlatformPendingInvitation, type Role } from '@legalops/types';
import { Alert, Button, Card, CardBody, CardHeader } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';

const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Lets the LexForgeX team hand out accept-invite links without email (e.g. over WhatsApp) while email is off.
 * A link is a credential: it's shown once, never cached, and generating another cancels the previous one.
 */
export function PendingInvitesCard({ firmId, suspended }: { firmId: string; suspended: boolean }) {
  const qc = useQueryClient();
  const key = ['platform', 'firms', firmId, 'invitations'];
  const q = useQuery({ queryKey: key, queryFn: () => platformApi.get<PlatformPendingInvitation[]>(`/firms/${firmId}/invitations`) });
  const [link, setLink] = useState<(PlatformInviteLink & { id: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const mint = useMutation({
    mutationFn: (id: string) => platformApi.post<PlatformInviteLink>(`/firms/${firmId}/invitations/${id}/link`),
    onSuccess: (data, id) => {
      setLink({ ...data, id });
      setCopied(false);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['platform', 'firms', firmId], exact: true }); // history shows the new entry
    },
  });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      input.current?.select(); // clipboard blocked: select it so ⌘C works
    }
  };

  return (
    <Card>
      <CardHeader title="Pending invitations" />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          While email is off, get a sign-up link here and send it to the person directly. Anyone with the link can join this firm in that
          role, so send it only to them, over a channel you trust.
        </p>
        {mint.error instanceof ApiError ? <Alert tone="danger">{mint.error.message}</Alert> : null}
        {q.isPending ? (
          <p className="text-muted">Loading…</p>
        ) : !q.data?.length ? (
          <p className="text-muted">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {q.data.map((inv) => (
              <li key={inv.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{inv.email}</p>
                    <p className="text-xs text-muted">
                      {ROLE_LABELS[inv.role as Role] ?? inv.role} · invited by {inv.invitedBy || '—'} ·{' '}
                      {inv.expired ? <span className="text-danger-700">link expired</span> : `expires ${when(inv.expiresAt)}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={suspended || mint.isPending}
                    title={suspended ? 'Reactivate the firm first' : undefined}
                    onClick={() => mint.mutate(inv.id)}
                  >
                    <Link2 className="size-4" aria-hidden="true" />
                    {link?.id === inv.id ? 'New link' : 'Get link'}
                  </Button>
                </div>
                {link?.id === inv.id ? (
                  <div className="space-y-2 rounded-lg bg-canvas p-3" role="status">
                    <div className="flex gap-2">
                      <input
                        ref={input}
                        readOnly
                        value={link.url}
                        aria-label={`Sign-up link for ${link.email}`}
                        onFocus={(e) => e.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs"
                      />
                      <Button size="sm" onClick={() => void copy()}>
                        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="text-xs text-muted">
                      Valid until {when(link.expiresAt)}. Any earlier link for {link.email} no longer works. This link won’t be shown again;
                      generate a new one if it’s lost.
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
