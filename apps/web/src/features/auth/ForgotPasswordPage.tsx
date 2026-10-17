import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, TextField } from '@legalops/ui';
import { forgotPasswordSchema } from '@legalops/validation';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import type { z } from 'zod';
import { api, ApiError } from '../../lib/api.js';
import { AuthLayout } from './AuthLayout.js';

export function ForgotPasswordPage() {
  const request = useMutation({
    mutationFn: (email: string) => api.post('/auth/forgot-password', { email }),
  });
  const form = useForm<z.input<typeof forgotPasswordSchema>, unknown, z.output<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  if (request.isSuccess) {
    return (
      <AuthLayout title="Check your email">
        {/* Same message whether or not the account exists (PRD Screen 2). */}
        <p className="text-sm text-ink-soft">
          If an account exists for that email, we’ve sent a link to reset your password. It expires in 1 hour.
        </p>
        <Link to="/login" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password" subtitle="We’ll email you a link to choose a new one.">
      <form onSubmit={form.handleSubmit((v) => request.mutate(v.email))} className="space-y-4" noValidate>
        {request.error ? (
          <Alert tone="danger">
            {request.error instanceof ApiError ? request.error.message : 'Please try again.'}
          </Alert>
        ) : null}
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <Button type="submit" block size="lg" loading={request.isPending}>
          Send reset link
        </Button>
        <Link to="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
