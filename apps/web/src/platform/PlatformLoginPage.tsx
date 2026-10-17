import { Alert, Button, TextField } from '@legalops/ui';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ApiError } from '../lib/api.js';
import { usePlatformLogin, usePlatformMe, useStartEnrolment, useVerifyCode } from './auth.js';

export function PlatformLoginPage() {
  const { data: me } = usePlatformMe();
  const login = usePlatformLogin();
  const enrol = useStartEnrolment();
  const verify = useVerifyCode();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  if (me?.mfaVerified) return <Navigate to="/platform/firms" replace />;
  const error = [login.error, enrol.error, verify.error].find((e) => e instanceof ApiError) as
    ApiError | undefined;

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: (m) => (!m.mfaEnrolled ? enrol.mutate() : undefined) });
  };
  const onCode = (e: FormEvent) => {
    e.preventDefault();
    verify.mutate(code.trim());
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">LegalForgeX Platform</p>
        <h1 className="mt-1 text-xl font-semibold">{me ? 'Two-factor sign-in' : 'Sign in'}</h1>
        {error ? (
          <div className="mt-4">
            <Alert tone="danger">{error.message}</Alert>
          </div>
        ) : null}
        {!me ? (
          <form className="mt-4 space-y-4" onSubmit={onPassword}>
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" className="w-full" disabled={login.isPending}>
              Continue
            </Button>
          </form>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={onCode}>
            {!me.mfaEnrolled && enrol.data ? (
              <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
                <p>
                  Add LegalForgeX Platform to your authenticator app with this key, then enter the code it
                  shows.
                </p>
                <p className="font-mono text-base tracking-wider break-all select-all">
                  {enrol.data.secret.match(/.{1,4}/g)?.join(' ')}
                </p>
                <a className="text-brand-700 underline" href={enrol.data.otpauthUrl}>
                  Open in authenticator app
                </a>
              </div>
            ) : (
              <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
            )}
            <TextField
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
            <Button type="submit" className="w-full" disabled={verify.isPending || code.length !== 6}>
              Verify
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
