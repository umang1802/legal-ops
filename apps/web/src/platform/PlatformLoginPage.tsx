import { Alert, Button, OtpInput, TextField } from '@legalops/ui';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { LogoMark } from '../components/branding/LogoMark.js';
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
  // Bumped after a wrong code: a new key clears the six boxes and puts the cursor back in the first.
  const [attempt, setAttempt] = useState(0);

  if (me?.mfaVerified) return <Navigate to="/platform/firms" replace />;
  const error = [login.error, enrol.error, verify.error].find((e) => e instanceof ApiError) as
    ApiError | undefined;

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: (m) => (!m.mfaEnrolled ? enrol.mutate() : undefined) });
  };
  const submitCode = (value: string) =>
    verify.mutate(value, {
      onError: () => {
        setCode('');
        setAttempt((a) => a + 1);
      },
    });
  const onCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 6) submitCode(code);
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <LogoMark className="size-10" />
        <p className="mt-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">
          LexForgeX Platform
        </p>
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
                  Add LexForgeX Platform to your authenticator app with this key, then enter the code it
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
            <OtpInput
              key={attempt}
              autoFocus
              label="6-digit code"
              error={verify.isError}
              disabled={verify.isPending}
              onChange={setCode}
              onComplete={submitCode}
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
