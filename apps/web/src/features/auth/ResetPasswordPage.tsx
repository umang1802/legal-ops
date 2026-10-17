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
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], error: 'Passwords do not match' });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const reset = useMutation({
    mutationFn: (password: string) => api.post('/auth/reset-password', { token, password }),
    onSuccess: () =>
      navigate('/login', {
        replace: true,
        state: { notice: 'Password updated. Sign in with your new password.' },
      }),
  });
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  if (!token) {
    return (
      <AuthLayout title="Link incomplete">
        <p className="text-sm text-ink-soft">This reset link is missing its token. Request a new one.</p>
        <Link
          to="/forgot-password"
          className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="This signs you out on every other device.">
      <form onSubmit={form.handleSubmit((v) => reset.mutate(v.password))} className="space-y-4" noValidate>
        {reset.error ? (
          <Alert tone="danger">
            {reset.error instanceof ApiError ? reset.error.message : 'Please try again.'}{' '}
            {reset.error instanceof ApiError && reset.error.code === 'TOKEN_INVALID' ? (
              <Link to="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            ) : null}
          </Alert>
        ) : null}
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={form.formState.errors.confirm?.message}
          {...form.register('confirm')}
        />
        <Button type="submit" block size="lg" loading={reset.isPending}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
