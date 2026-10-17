import { TRIGGER_LABELS, WORKFLOW_TRIGGERS, type EmailTemplateDto, type WorkflowDto, type WorkflowTrigger } from '@legalops/types';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, SkeletonList } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { DryRunSheet } from './DryRunSheet.js';
import { describeAction, describeTiming, emailsClient } from './describe.js';
import { WorkflowEditorSheet } from './WorkflowEditorSheet.js';

/** PRD Screen 20: the firm's automation rules, grouped by what starts them. */
export function AutomationsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<WorkflowDto[]>('/workflows') });
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: () => api.get<EmailTemplateDto[]>('/email-templates') });
  const [editing, setEditing] = useState<WorkflowDto | 'new' | null>(null);
  const [testing, setTesting] = useState<WorkflowDto | null>(null);
  const toggle = useMutation({
    mutationFn: (w: WorkflowDto) => api.post<WorkflowDto>(`/workflows/${w.id}/active`, { isActive: !w.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
  const duplicate = useMutation({
    mutationFn: (w: WorkflowDto) => api.post<WorkflowDto>(`/workflows/${w.id}/duplicate`),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      setEditing(w);
    },
  });
  const templateName = (key: string) => templates.data?.find((t) => t.templateKey === key)?.name ?? key;
  const groups = WORKFLOW_TRIGGERS.map((t) => [t, (list.data ?? []).filter((w) => w.triggerType === t)] as const).filter(([, ws]) => ws.length);
  const actionError = toggle.error ?? duplicate.error;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automations"
        description="Reminders and emails LegalOps sends for you. Switch any of them off, or test them against a real record."
        actions={
          <>
            <Link to="/settings/email-templates" className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-brand-700 hover:bg-subtle">
              Email templates
            </Link>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New
            </Button>
          </>
        }
      />
      {list.isError ? <Alert tone="danger">Couldn’t load automations.</Alert> : null}
      {actionError ? <Alert tone="danger">{actionError instanceof ApiError ? actionError.message : 'Something went wrong.'}</Alert> : null}
      {list.isPending ? (
        <Card>
          <SkeletonList rows={4} />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState title="No automations" className="py-12" />
        </Card>
      ) : (
        groups.map(([trigger, ws]) => (
          <Card key={trigger}>
            <CardHeader title={`When: ${TRIGGER_LABELS[trigger as WorkflowTrigger]}`} />
            <ul className="divide-y divide-line">
              {ws.map((w) => (
                <li key={w.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${w.isActive ? '' : 'text-muted'}`}>{w.name}</p>
                      {!w.isActive ? <Badge>Off</Badge> : null}
                      {w.requiresApproval && emailsClient(w) ? <Badge tone="warning">Needs approval</Badge> : null}
                    </div>
                    <p className="text-xs text-muted">{describeTiming(w.triggerType, w.triggerConfig)}</p>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                      {w.actions.map((a, i) => (
                        <li key={i} className="break-words">
                          → {describeAction(a, templateName)}
                        </li>
                      ))}
                    </ul>
                    {w.stats.scheduled || w.stats.done ? (
                      <p className="mt-1 text-xs text-muted">
                        {w.stats.scheduled ? `${w.stats.scheduled} planned` : ''}
                        {w.stats.scheduled && w.stats.done ? ' · ' : ''}
                        {w.stats.done ? `${w.stats.done} done` : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label={`Test ${w.name}`} icon={<FlaskConical className="size-4" />} onClick={() => setTesting(w)} />
                    <Button variant="ghost" size="sm" aria-label={`Edit ${w.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(w)} />
                    <Button variant="ghost" size="sm" aria-label={`Copy ${w.name}`} icon={<Copy className="size-4" />} loading={duplicate.isPending && duplicate.variables?.id === w.id} onClick={() => duplicate.mutate(w)} />
                    <Switch checked={w.isActive} label={`${w.name} on`} disabled={toggle.isPending && toggle.variables?.id === w.id} onChange={() => toggle.mutate(w)} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
      <WorkflowEditorSheet open={editing !== null} onClose={() => setEditing(null)} workflow={editing === 'new' ? null : editing} />
      <DryRunSheet workflow={testing} onClose={() => setTesting(null)} />
    </div>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative ml-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${checked ? 'bg-brand-600' : 'bg-line'}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}
