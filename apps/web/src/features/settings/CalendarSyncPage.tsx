import { PageHeader, Alert, Button, Card, CardBody, CardHeader } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';

type Status = { active: boolean; createdAt: string | null; lastAccessedAt: string | null };

/** Personal calendar subscribe link (one-way sync of the hearings this user can see). */
export function CalendarSyncPage() {
  const me = useSession();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['calendar-feed'], queryFn: () => api.get<Status>('/calendar-feed') });
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ url: string; createdAt: string }>('/calendar-feed'),
    onSuccess: (d) => {
      setUrl(d.url);
      setCopied(false);
      void qc.invalidateQueries({ queryKey: ['calendar-feed'] });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.delete<void>('/calendar-feed'),
    onSuccess: () => {
      setUrl(null);
      void qc.invalidateQueries({ queryKey: ['calendar-feed'] });
    },
  });

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      input.current?.select();
    }
  };
  const error = [create.error, revoke.error].find((e) => e instanceof ApiError) as ApiError | undefined;
  const s = status.data;

  return (
    <>
      <PageHeader title="Calendar sync" description="See your hearings in Google Calendar, Outlook or your iPhone calendar." />
      <div className="max-w-2xl space-y-4">
        {error ? <Alert tone="danger">{error.message}</Alert> : null}
        <Card>
          <CardHeader title="Your subscribe link" />
          <CardBody className="space-y-4 text-sm">
            <p className="text-muted">
              A private link your calendar app checks for updates. It includes the hearings you can see in LexForgeX, from the last 30
              days to 6 months ahead. It’s one-way: changes made in your calendar app don’t come back here.
            </p>
            {s?.active ? (
              <p>
                Active since {formatDateTime(s.createdAt!, me.organization.timezone)}.{' '}
                {s.lastAccessedAt
                  ? `Your calendar app last fetched it on ${formatDateTime(s.lastAccessedAt, me.organization.timezone)}.`
                  : 'Your calendar app hasn’t fetched it yet.'}
              </p>
            ) : (
              <p>Calendar sync is off.</p>
            )}

            {url ? (
              <div className="space-y-2 rounded-lg bg-subtle p-3" role="status">
                <div className="flex gap-2">
                  <input
                    ref={input}
                    readOnly
                    value={url}
                    aria-label="Calendar subscribe link"
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs"
                  />
                  <Button size="sm" onClick={() => void copy()} icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="text-xs text-muted">
                  Keep this link private: anyone who has it can see these hearings. It’s shown only now; if you lose it, create a new one.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => create.mutate()} disabled={create.isPending}>
                {s?.active ? 'Reset link' : 'Create subscribe link'}
              </Button>
              {s?.active ? (
                <Button variant="secondary" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
                  Turn off
                </Button>
              ) : null}
            </div>
            {s?.active ? (
              <p className="text-xs text-muted">Reset makes the old link stop working at once, for example if a phone is lost.</p>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Add it to your calendar" />
          <CardBody className="space-y-3 text-sm">
            <p>
              <span className="font-medium">Google Calendar</span> (on a computer): Other calendars → <b>+</b> → <b>From URL</b> → paste the
              link → <b>Add calendar</b>.
            </p>
            <p>
              <span className="font-medium">Outlook</span>: Add calendar → <b>Subscribe from web</b> → paste the link → <b>Import</b>.
            </p>
            <p>
              <span className="font-medium">iPhone</span>: Settings → Calendar → Accounts → Add Account → Other → <b>Add Subscribed Calendar</b>
              → paste the link.
            </p>
            <p className="text-xs text-muted">
              Calendar apps decide how often they refresh: Apple every 15–60 minutes, Outlook about every 3 hours, Google sometimes only
              once a day. For today’s exact list, use the Calendar page or print the diary.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
