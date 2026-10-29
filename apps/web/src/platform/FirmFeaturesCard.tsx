import type { FeatureKey, PlatformFirmFeature } from '@legalops/types';
import { Alert, Button, Card, CardBody, CardHeader, Sheet } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';

const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Which switchable features this firm can use. Changes apply on the firm's next request; switching off hides the
 * feature and stops its scheduled emails, but deletes nothing. Every change is in the firm's history.
 */
export function FirmFeaturesCard({ firmId }: { firmId: string }) {
  const qc = useQueryClient();
  const key = ['platform', 'firms', firmId, 'features'];
  const q = useQuery({ queryKey: key, queryFn: () => platformApi.get<PlatformFirmFeature[]>(`/firms/${firmId}/features`) });
  const [confirming, setConfirming] = useState<PlatformFirmFeature | null>(null);

  const set = useMutation({
    mutationFn: ({ feature, enabled }: { feature: FeatureKey; enabled: boolean }) =>
      platformApi.patch<PlatformFirmFeature[]>(`/firms/${firmId}/features/${feature}`, { enabled }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['platform', 'firms', firmId], exact: true }); // history shows the change
    },
  });

  const toggle = (f: PlatformFirmFeature) => {
    set.reset();
    if (f.enabled) setConfirming(f);
    else set.mutate({ feature: f.key, enabled: true });
  };

  return (
    <Card>
      <CardHeader title="Features" />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">Switch features on or off for this firm. Switching one off hides it from their team; nothing is deleted.</p>
        {set.error instanceof ApiError && !confirming ? <Alert tone="danger">{set.error.message}</Alert> : null}
        {q.isPending ? (
          <p className="text-muted">Loading…</p>
        ) : q.isError ? (
          <Alert tone="danger">Couldn’t load this firm’s features.</Alert>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {q.data.map((f) => {
              const busy = set.isPending && set.variables?.feature === f.key;
              return (
                <li key={f.key} className="flex items-start justify-between gap-3 px-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{f.label}</p>
                    <p className="text-xs text-muted">{f.description}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {f.isDefault ? 'Default' : `Set by ${f.setBy ?? 'LexForgeX'}${f.setAt ? `, ${when(f.setAt)}` : ''}`}
                    </p>
                  </div>
                  <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      role="switch"
                      className="peer sr-only"
                      checked={f.enabled}
                      disabled={busy}
                      aria-label={`${f.label}: ${f.enabled ? 'on' : 'off'}`}
                      onChange={() => toggle(f)}
                    />
                    <span
                      aria-hidden="true"
                      className="h-6 w-11 rounded-full bg-line transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5"
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <Sheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`Switch off ${confirming?.label ?? ''}?`}
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button variant="secondary" block className="sm:w-auto" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              block
              className="sm:w-auto"
              loading={set.isPending}
              onClick={() => confirming && set.mutate({ feature: confirming.key, enabled: false })}
            >
              Switch off
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-soft">
          <p>
            Their team will no longer see {confirming?.label}. Nothing is deleted, and switching it back on restores everything.
          </p>
          {set.error ? <Alert tone="danger">{set.error instanceof ApiError ? set.error.message : 'Could not save.'}</Alert> : null}
        </div>
      </Sheet>
    </Card>
  );
}
