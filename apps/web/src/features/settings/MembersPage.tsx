import { zodResolver } from '@hookform/resolvers/zod';
import { ROLE_LABELS, ROLES, type MemberDto, type Role } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SelectField,
  Sheet,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { inviteMemberSchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { api, ApiError, applyFieldErrors } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { initials } from '../../lib/format.js';
import { MEMBERS_KEY } from '../../lib/hooks.js';

const roleOptions = (allowOwner: boolean) =>
  ROLES.filter((r) => allowOwner || r !== 'owner').map((r) => ({ value: r, label: ROLE_LABELS[r] }));

export function MembersPage() {
  const me = useSession();
  const canManage = canAct(me, 'users.manage');
  const [inviteOpen, setInviteOpen] = useState(false);
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => api.get<MemberDto[]>('/organization/members'),
  });

  return (
    <>
      <PageHeader
        title="Team"
        description={
          canManage ? 'Invite colleagues and control what they can access.' : 'People in your firm.'
        }
        actions={
          canManage ? (
            <Button icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)}>
              Invite
            </Button>
          ) : null
        }
      />
      {canManage ? (
        <div className="mb-4">
          <Alert tone="info">
            Lawyers, staff and read-only users only see matters they’re assigned to. Owners, admins and
            finance see every matter.
          </Alert>
        </div>
      ) : null}

      {members.isPending ? (
        <SkeletonList rows={4} />
      ) : members.isError ? (
        <Alert tone="danger">Couldn’t load the team. Refresh to try again.</Alert>
      ) : members.data.length === 0 ? (
        <Card>
          <EmptyState icon={<Users />} title="No team members yet" />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {members.data.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              isSelf={m.userId === me.user.id}
              canManage={canManage}
              actorRole={me.role}
            />
          ))}
        </Card>
      )}

      {canManage ? (
        <InviteSheet
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          allowOwner={me.role === 'owner'}
        />
      ) : null}
    </>
  );
}

function MemberRow({
  member,
  isSelf,
  canManage,
  actorRole,
}: {
  member: MemberDto;
  isSelf: boolean;
  canManage: boolean;
  actorRole: Role;
}) {
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const update = useMutation({
    mutationFn: (body: { role?: Role; status?: 'active' | 'suspended' }) =>
      api.patch<MemberDto>(`/organization/members/${member.id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: MEMBERS_KEY }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/organization/members/${member.id}`),
    onSuccess: () => {
      setConfirmRemove(false);
      void qc.invalidateQueries({ queryKey: MEMBERS_KEY });
    },
  });
  const editable = canManage && !isSelf && (actorRole === 'owner' || member.role !== 'owner');
  const error = update.error ?? remove.error;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
          {initials(member.firstName, member.lastName)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {member.firstName} {member.lastName} {isSelf ? <span className="text-muted">(you)</span> : null}
          </p>
          <p className="truncate text-sm text-muted">{member.email}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {member.status === 'suspended' ? <Badge tone="warning">Suspended</Badge> : null}
        {editable ? (
          <>
            <label className="min-w-0 flex-1 sm:flex-none">
              <span className="sr-only">Role for {member.email}</span>
              <select
                className="h-10 w-full rounded-lg border border-line bg-surface px-2 text-sm sm:w-40"
                value={member.role}
                disabled={update.isPending}
                onChange={(e) => update.mutate({ role: e.target.value as Role })}
              >
                {roleOptions(actorRole === 'owner').map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              loading={update.isPending}
              onClick={() => update.mutate({ status: member.status === 'active' ? 'suspended' : 'active' })}
            >
              {member.status === 'active' ? 'Suspend' : 'Reactivate'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-danger-700"
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          </>
        ) : (
          <Badge>{ROLE_LABELS[member.role]}</Badge>
        )}
      </div>
      {error ? (
        <p className="text-sm text-danger-700 sm:basis-full">
          {error instanceof ApiError ? error.message : 'Update failed.'}
        </p>
      ) : null}

      <Sheet
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove from firm?"
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button variant="secondary" block className="sm:w-auto" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              block
              className="sm:w-auto"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          {member.firstName} will lose access immediately and be unassigned from all matters. Their past
          activity stays in the audit log.
        </p>
      </Sheet>
    </div>
  );
}

function InviteSheet({
  open,
  onClose,
  allowOwner,
}: {
  open: boolean;
  onClose: () => void;
  allowOwner: boolean;
}) {
  const qc = useQueryClient();
  const form = useForm<z.input<typeof inviteMemberSchema>, unknown, z.output<typeof inviteMemberSchema>>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role: 'lawyer' },
  });
  const invite = useMutation({
    mutationFn: (v: z.output<typeof inviteMemberSchema>) => api.post('/organization/members/invite', v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: MEMBERS_KEY }),
    onError: (err) => applyFieldErrors(err, form.setError),
  });
  const close = () => {
    form.reset();
    invite.reset();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Invite a colleague"
      footer={
        invite.isSuccess ? (
          <Button block onClick={close}>
            Done
          </Button>
        ) : (
          <Button block type="submit" form="invite-form" loading={invite.isPending}>
            Send invitation
          </Button>
        )
      }
    >
      {invite.isSuccess ? (
        <Alert tone="success" title="Invitation created">
          {/* Honest: email delivery is built in Phase 5; until then the invite is queued, not sent. */}
          The invitation email is queued and will be sent once email delivery is switched on.
        </Alert>
      ) : (
        <form
          id="invite-form"
          onSubmit={form.handleSubmit((v) => invite.mutate(v))}
          className="space-y-4"
          noValidate
        >
          {invite.error && !(invite.error instanceof ApiError && invite.error.details.length) ? (
            <Alert tone="danger">
              {invite.error instanceof ApiError ? invite.error.message : 'Could not invite.'}
            </Alert>
          ) : null}
          <TextField
            label="Email"
            type="email"
            inputMode="email"
            autoFocus
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <SelectField label="Role" options={roleOptions(allowOwner)} {...form.register('role')} />
        </form>
      )}
    </Sheet>
  );
}
