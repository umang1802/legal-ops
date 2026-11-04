import type { ZohoPayConfigDto, ZohoPayEnvironment } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, SelectField, TextField } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';

const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

type Form = {
  environment: ZohoPayEnvironment;
  accountId: string;
  clientId: string;
  enabled: boolean;
  // Secrets are write-only: they start empty and are only sent when typed.
  clientSecret: string;
  refreshToken: string;
  signingKey: string;
};

const fromServer = (c: ZohoPayConfigDto): Form => ({
  environment: c.environment,
  accountId: c.accountId ?? '',
  clientId: c.clientId ?? '',
  enabled: c.enabled,
  clientSecret: '',
  refreshToken: '',
  signingKey: '',
});

/**
 * Online payments for one firm through Zoho Payments. Platform admins enter the firm's Zoho credentials here;
 * the firm's own team never sees or edits them. Secrets are encrypted on the server and never sent back.
 */
export function FirmZohoPayCard({ firmId }: { firmId: string }) {
  const qc = useQueryClient();
  const key = ['platform', 'firms', firmId, 'zohopay'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => platformApi.get<ZohoPayConfigDto>(`/firms/${firmId}/zohopay`),
  });
  const [form, setForm] = useState<Form | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (q.data && form === null) setForm(fromServer(q.data));
  }, [q.data, form]);

  const done = (c: ZohoPayConfigDto) => {
    qc.setQueryData(key, c);
    setForm(fromServer(c));
    setConfirmRemove(false);
    void qc.invalidateQueries({ queryKey: ['platform', 'firms', firmId], exact: true }); // history shows the change
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      platformApi.patch<ZohoPayConfigDto>(`/firms/${firmId}/zohopay`, body),
    onSuccess: done,
  });
  const test = useMutation({
    mutationFn: () => platformApi.post<ZohoPayConfigDto>(`/firms/${firmId}/zohopay/test`),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => platformApi.post<ZohoPayConfigDto>(`/firms/${firmId}/zohopay/remove`),
    onSuccess: done,
  });

  if (q.isPending || !form)
    return (
      <Card>
        <CardHeader title="Online payments (Zoho Pay)" />
        <CardBody className="text-sm text-muted">Loading…</CardBody>
      </Card>
    );
  if (q.isError)
    return (
      <Card>
        <CardHeader title="Online payments (Zoho Pay)" />
        <CardBody>
          <Alert tone="danger">Couldn’t load the Zoho Pay settings.</Alert>
        </CardBody>
      </Card>
    );
  const c = q.data;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = (Object.keys(form) as (keyof Form)[]).some((k) =>
    k === 'clientSecret' || k === 'refreshToken' || k === 'signingKey'
      ? form[k] !== ''
      : form[k] !== fromServer(c)[k],
  );
  const submit = () => {
    const base = fromServer(c);
    const body: Record<string, unknown> = {};
    if (form.environment !== base.environment) body.environment = form.environment;
    if (form.accountId.trim() !== base.accountId) body.accountId = form.accountId.trim();
    if (form.clientId.trim() !== base.clientId) body.clientId = form.clientId.trim();
    if (form.enabled !== base.enabled) body.enabled = form.enabled;
    if (form.clientSecret) body.clientSecret = form.clientSecret;
    if (form.refreshToken) body.refreshToken = form.refreshToken;
    if (form.signingKey) body.signingKey = form.signingKey;
    // First save sends everything the server needs, even if it matches the empty defaults.
    if (!c.configured)
      Object.assign(body, {
        environment: form.environment,
        accountId: form.accountId.trim(),
        clientId: form.clientId.trim(),
      });
    save.mutate(body);
  };
  const fieldError = (path: string) =>
    (save.error instanceof ApiError
      ? save.error.details.find((d) => (d as { path?: string }).path === path)
      : undefined) as { message?: string } | undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the URL is selectable below */
    }
  };

  const status = !c.configured ? (
    <Badge>Not set up</Badge>
  ) : !c.enabled ? (
    <Badge tone="warning">Off</Badge>
  ) : (
    <Badge tone="success">On · {c.environment === 'live' ? 'Live' : 'Sandbox'}</Badge>
  );
  const saved = (has: boolean) => (has ? 'Saved. Leave blank to keep it.' : undefined);

  return (
    <Card>
      <CardHeader title="Online payments (Zoho Pay)" action={status} />
      <CardBody className="space-y-4 text-sm">
        <p className="text-muted">
          Lets this firm send clients a Zoho Payments link on an invoice. When a client pays, the receipt is
          recorded on the invoice automatically. Use the firm’s own Zoho Payments account. Secrets are
          encrypted and can’t be read back after saving.
        </p>
        {save.error instanceof ApiError && !save.error.details.length ? (
          <Alert tone="danger">{save.error.message}</Alert>
        ) : null}
        {test.error instanceof ApiError ? <Alert tone="danger">{test.error.message}</Alert> : null}
        {remove.error instanceof ApiError ? <Alert tone="danger">{remove.error.message}</Alert> : null}
        {form.environment === 'live' && form.enabled ? (
          <Alert tone="warning" title="Live mode takes real payments">
            Check the test result below before turning this on for a firm.
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Environment"
            value={form.environment}
            onChange={(e) => set('environment', e.target.value as ZohoPayEnvironment)}
            options={[
              { value: 'sandbox', label: 'Sandbox (test payments)' },
              { value: 'live', label: 'Live (real payments)' },
            ]}
          />
          <TextField
            label="Zoho Payments account ID"
            inputMode="numeric"
            autoComplete="off"
            value={form.accountId}
            onChange={(e) => set('accountId', e.target.value)}
            error={fieldError('accountId')?.message}
            hint="Zoho Payments → Settings → Account details."
          />
          <TextField
            label="OAuth client ID"
            autoComplete="off"
            value={form.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            error={fieldError('clientId')?.message}
            hint="From the Zoho API Console (client type: ORG)."
          />
          <TextField
            label="OAuth client secret"
            type="password"
            autoComplete="new-password"
            value={form.clientSecret}
            onChange={(e) => set('clientSecret', e.target.value)}
            error={fieldError('clientSecret')?.message}
            hint={saved(c.hasClientSecret)}
          />
          <TextField
            label="Refresh token"
            type="password"
            autoComplete="new-password"
            value={form.refreshToken}
            onChange={(e) => set('refreshToken', e.target.value)}
            error={fieldError('refreshToken')?.message}
            hint={saved(c.hasRefreshToken) ?? 'Needs the ZohoPay.payments CREATE, READ and UPDATE scopes.'}
          />
          <TextField
            label="Webhook signing key"
            type="password"
            autoComplete="new-password"
            value={form.signingKey}
            onChange={(e) => set('signingKey', e.target.value)}
            error={fieldError('signingKey')?.message}
            hint={saved(c.hasSigningKey) ?? 'Shown by Zoho when the webhook is created.'}
          />
        </div>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span>
            <span className="font-medium">Online payments on for this firm</span>
            <span className="block text-muted">
              Shows “Create payment link” on the firm’s issued invoices. Needs the signing key first.
            </span>
          </span>
        </label>

        <div className="rounded-lg border border-line bg-subtle p-3">
          <p className="font-medium text-ink">Webhook to add in Zoho Payments</p>
          <p className="mt-1 text-muted">
            In this firm’s Zoho Payments account, add a webhook pointing to the address below and subscribe it
            to: {c.webhookEvents.join(', ')}. Then paste its signing key above.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded bg-surface px-2 py-1.5 text-xs break-all select-all">
              {c.webhookUrl}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        {c.configured ? (
          <p className={c.lastTestOk === false ? 'text-danger-700' : 'text-muted'}>
            {c.lastTestAt
              ? `Last test ${when(c.lastTestAt)}: ${c.lastTestMessage ?? (c.lastTestOk ? 'OK' : 'Failed')}`
              : 'Not tested since the last change. Save, then test the connection.'}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button loading={save.isPending} disabled={!dirty} onClick={submit}>
            Save
          </Button>
          {c.configured ? (
            <Button
              variant="secondary"
              loading={test.isPending}
              disabled={dirty}
              onClick={() => test.mutate()}
            >
              Test connection
            </Button>
          ) : null}
          {c.configured && !confirmRemove ? (
            <Button variant="ghost" className="text-danger-700" onClick={() => setConfirmRemove(true)}>
              Remove credentials
            </Button>
          ) : null}
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <span className="text-muted">Delete the saved Zoho credentials?</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger-700"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Yes, remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </span>
          ) : null}
        </div>
        {c.updatedAt ? <p className="text-xs text-muted">Last changed {when(c.updatedAt)}.</p> : null}
      </CardBody>
    </Card>
  );
}
