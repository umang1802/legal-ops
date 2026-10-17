import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, TextField } from '@legalops/ui';
import { passwordSchema } from '@legalops/validation';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { api, ApiError } from '../../lib/api.js';
import { AuthLayout } from './AuthLayout.js';

const schema = z
  .object({
    firstName: z.string().trim().min(1, { error: 'Enter your first name' }).max(100),
    lastName: z.string().trim().max(100),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], error: 'Passwords do not match' });

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const accept = useMutation({
    mutationFn: (v: z.infer<typeof schema>) =>
      api.post<{ existingAccount: boolean }>('/auth/invitations/accept', {
        token,
        firstName: v.firstName,
        lastName: v.lastName || undefined,
        password: v.password,
      }),
    onSuccess: ({ existingAccount }) =>
      navigate('/login', {
        replace: true,
        state: {
          notice: existingAccount
            ? 'You’ve joined the firm. Sign in with your existing password.'
            : 'Your account is ready. Sign in to continue.',
        },
      }),
  });
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { firstName: '', lastName: '', password: '', confirm: '' },
  });
  const { errors } = form.formState;

  if (!token) {
    return (
      <AuthLayout title="Invitation link incomplete">
        <p className="text-sm text-ink-soft">
          Open the link from your invitation email again, or ask your firm to resend it.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Join your firm on LegalOps" subtitle="Set up your account to accept the invitation.">
      <form onSubmit={form.handleSubmit((v) => accept.mutate(v))} className="space-y-4" noValidate>
        {accept.error ? (
          <Alert tone="danger">
            {accept.error instanceof ApiError ? accept.error.message : 'Please try again.'}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="First name"
            autoComplete="given-name"
            error={errors.firstName?.message}
            {...form.register('firstName')}
          />
          <TextField label="Last name" autoComplete="family-name" {...form.register('lastName')} />
        </div>
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters. Ignored if you already have a LegalOps account."
          error={errors.password?.message}
          {...form.register('password')}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...form.register('confirm')}
        />
        <Button type="submit" block size="lg" loading={accept.isPending}>
          Accept invitation
        </Button>
        <Link to="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">
          Already joined? Sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
