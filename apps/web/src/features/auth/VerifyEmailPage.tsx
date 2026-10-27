import { Alert, Spinner } from '@legalops/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { AuthLayout } from './AuthLayout.js';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const verify = useMutation({ mutationFn: () => api.post('/auth/verify-email', { token }) });
  const { mutate } = verify;

  useEffect(() => {
    if (token) mutate();
  }, [token, mutate]);

  return (
    <AuthLayout title="Verify your email">
      {!token ? (
        <Alert tone="danger">This verification link is incomplete.</Alert>
      ) : verify.isPending || verify.isIdle ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-4" /> Verifying…
        </div>
      ) : verify.isSuccess ? (
        <Alert tone="success">Your email is verified.</Alert>
      ) : (
        <Alert tone="danger">
          {verify.error instanceof ApiError ? verify.error.message : 'Verification failed.'}
        </Alert>
      )}
      <Link to="/" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">
        Continue to LexForgeX
      </Link>
    </AuthLayout>
  );
}
