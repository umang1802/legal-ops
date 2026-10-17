import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, TextField } from '@legalops/ui';
import { loginSchema } from '@legalops/validation';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import type { z } from 'zod';
import { ApiError } from '../../lib/api.js';
import { useLogin } from '../../lib/auth.js';
import { AuthLayout } from './AuthLayout.js';

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const form = useForm<z.input<typeof loginSchema>, unknown, z.output<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', remember: false },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, { onSuccess: () => navigate(from, { replace: true }) }),
  );

  return (
    <AuthLayout title="Sign in" subtitle="Use the email your firm invited you with.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {login.error ? (
          <Alert tone="danger">
            {login.error instanceof ApiError
              ? login.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        ) : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
          error={errors.email?.message}
          {...form.register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-line accent-brand-700"
              {...form.register('remember')}
            />
            Keep me signed in
          </label>
          <Link to="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" block size="lg" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
