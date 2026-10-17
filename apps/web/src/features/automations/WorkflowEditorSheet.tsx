import {
  ACTION_LABELS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  NOTIFY_RECIPIENTS,
  OPERATOR_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  RECIPIENT_LABELS,
  TRIGGER_ANCHORS,
  TRIGGER_LABELS,
  WORKFLOW_TRIGGERS,
  type EmailTemplateDto,
  type WorkflowAction,
  type WorkflowActionType,
  type WorkflowCondition,
  type WorkflowDto,
  type WorkflowTrigger,
} from '@legalops/types';
import { Alert, Button, SelectField, Sheet, TextField } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';

type When = 'immediate' | 'before' | 'on' | 'after';
type Draft = {
  name: string;
  description: string;
  triggerType: WorkflowTrigger;
  when: When;
  days: number;
  at: string;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  requiresApproval: boolean;
  isActive: boolean;
};

const blank = (): Draft => ({
  name: '',
  description: '',
  triggerType: 'HEARING_SCHEDULED',
  when: 'before',
  days: 2,
  at: '09:00',
  conditions: [],
  actions: [{ type: 'notify', channel: 'email', recipient: 'client', templateKey: 'hearing_reminder_client' }],
  requiresApproval: false,
  isActive: true,
});

function fromWorkflow(w: WorkflowDto): Draft {
  const t = w.triggerConfig;
  return {
    name: w.name,
    description: w.description ?? '',
    triggerType: w.triggerType,
    when: t.timing === 'immediate' ? 'immediate' : t.offsetDays < 0 ? 'before' : t.offsetDays === 0 ? 'on' : 'after',
    days: t.timing === 'relative' ? Math.abs(t.offsetDays) || 1 : 1,
    at: t.timing === 'relative' ? t.at : '09:00',
    conditions: w.conditions,
    actions: w.actions,
    requiresApproval: w.requiresApproval,
    isActive: w.isActive,
  };
}

function toBody(d: Draft) {
  const anchor = TRIGGER_ANCHORS[d.triggerType]?.anchor;
  const triggerConfig =
    d.when === 'immediate' || !anchor
      ? { timing: 'immediate' as const }
      : { timing: 'relative' as const, anchor, offsetDays: d.when === 'on' ? 0 : d.when === 'before' ? -d.days : d.days, at: d.at };
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    triggerType: d.triggerType,
    triggerConfig,
    conditions: d.conditions,
    actions: d.actions,
    requiresApproval: d.requiresApproval,
    isActive: d.isActive,
  };
}

const isTaskTrigger = (t: WorkflowTrigger) => t === 'TASK_CREATED' || t === 'TASK_COMPLETED';

function newAction(type: WorkflowActionType): WorkflowAction {
  switch (type) {
    case 'notify':
      return { type, channel: 'email', recipient: 'client', templateKey: 'client_update' };
    case 'create_task':
      return { type, title: '', assignTo: 'lead', dueInDays: 1, priority: 'normal' };
    case 'update_task':
      return { type, priority: 'high' };
    case 'add_timeline':
      return { type, title: '' };
    case 'add_tag':
      return { type, tag: '' };
  }
}

/** Builder (PRD §9): when → only if → do. Kept to plain sentences, no graph editor. */
export function WorkflowEditorSheet({ open, onClose, workflow }: { open: boolean; onClose: () => void; workflow: WorkflowDto | null }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(blank);
  useEffect(() => {
    if (open) setD(workflow ? fromWorkflow(workflow) : blank());
  }, [open, workflow]);
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: () => api.get<EmailTemplateDto[]>('/email-templates'), enabled: open });
  const save = useMutation({
    mutationFn: () => (workflow ? api.patch<WorkflowDto>(`/workflows/${workflow.id}`, toBody(d)) : api.post<WorkflowDto>('/workflows', toBody(d))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      onClose();
    },
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const setAction = (i: number, a: WorkflowAction) => set('actions', d.actions.map((x, j) => (j === i ? a : x)));
  const setCond = (i: number, c: WorkflowCondition) => set('conditions', d.conditions.map((x, j) => (j === i ? c : x)));

  const anchor = TRIGGER_ANCHORS[d.triggerType];
  const fields = CONDITION_FIELDS.filter((f) => f.triggers.includes(d.triggerType));
  const taskTrigger = isTaskTrigger(d.triggerType);
  const templateOptions = (templates.data ?? []).filter((t) => t.isActive).map((t) => ({ value: t.templateKey, label: t.name }));
  const emailsClient = d.actions.some((a) => a.type === 'notify' && a.recipient === 'client');
  const err = save.error instanceof ApiError ? save.error : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={workflow ? 'Edit automation' : 'New automation'}
      footer={
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button block className="sm:w-auto" loading={save.isPending} disabled={!d.name.trim() || d.actions.length === 0} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {err ? (
          <Alert tone="danger">
            {err.message}
            {err.details.length ? (
              <ul className="mt-1 list-disc pl-5">
                {err.details.map((x, i) => (
                  <li key={i}>{x.message}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : save.error ? (
          <Alert tone="danger">Something went wrong.</Alert>
        ) : null}
        <TextField label="Name" value={d.name} maxLength={255} onChange={(e) => set('name', e.target.value)} />
        <TextField label="Description (optional)" value={d.description} onChange={(e) => set('description', e.target.value)} />

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">When</legend>
          <SelectField
            label="This happens"
            value={d.triggerType}
            onChange={(e) => {
              const t = e.target.value as WorkflowTrigger;
              setD((p) => ({
                ...p,
                triggerType: t,
                when: TRIGGER_ANCHORS[t] ? p.when : 'immediate',
                conditions: p.conditions.filter((c) => CONDITION_FIELDS.find((f) => f.field === c.field)?.triggers.includes(t)),
              }));
            }}
            options={WORKFLOW_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))}
          />
          {anchor ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SelectField
                label="Run"
                value={d.when}
                onChange={(e) => set('when', e.target.value as When)}
                options={[
                  { value: 'immediate', label: 'Straight away' },
                  { value: 'before', label: `Days before ${anchor.label}` },
                  { value: 'on', label: `On ${anchor.label}` },
                  { value: 'after', label: `Days after ${anchor.label}` },
                ]}
              />
              {d.when === 'before' || d.when === 'after' ? (
                <TextField label="Days" type="number" inputMode="numeric" min={1} max={90} value={d.days} onChange={(e) => set('days', Math.max(1, Math.min(90, Number(e.target.value) || 1)))} />
              ) : null}
              {d.when !== 'immediate' ? <TextField label="At" type="time" value={d.at} onChange={(e) => set('at', e.target.value)} /> : null}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">Only if (optional)</legend>
          {d.conditions.map((c, i) => {
            const noValue = c.operator === 'is_empty' || c.operator === 'is_not_empty';
            return (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <SelectField label="Field" value={c.field} onChange={(e) => setCond(i, { ...c, field: e.target.value })} options={fields.map((f) => ({ value: f.field, label: f.label }))} />
                <SelectField label="Test" value={c.operator} onChange={(e) => setCond(i, { ...c, operator: e.target.value as WorkflowCondition['operator'] })} options={CONDITION_OPERATORS.map((o) => ({ value: o, label: OPERATOR_LABELS[o] }))} />
                {noValue ? <div /> : <TextField label="Value" value={String(c.value ?? '')} onChange={(e) => setCond(i, { ...c, value: e.target.value })} />}
                <Button variant="ghost" size="sm" aria-label="Remove condition" icon={<Trash2 className="size-4" />} onClick={() => set('conditions', d.conditions.filter((_, j) => j !== i))} />
              </div>
            );
          })}
          {fields.length ? (
            <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => set('conditions', [...d.conditions, { field: fields[0]!.field, operator: 'equals', value: '' }])}>
              Add condition
            </Button>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">Do</legend>
          {d.actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <SelectField
                    label={`Action ${i + 1}`}
                    value={a.type}
                    onChange={(e) => setAction(i, newAction(e.target.value as WorkflowActionType))}
                    options={(Object.keys(ACTION_LABELS) as WorkflowActionType[]).filter((t) => t !== 'update_task' || taskTrigger).map((t) => ({ value: t, label: ACTION_LABELS[t] }))}
                  />
                </div>
                {d.actions.length > 1 ? (
                  <Button variant="ghost" size="sm" aria-label="Remove action" icon={<Trash2 className="size-4" />} onClick={() => set('actions', d.actions.filter((_, j) => j !== i))} />
                ) : null}
              </div>
              {a.type === 'notify' ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <SelectField
                    label="To"
                    value={a.recipient}
                    onChange={(e) => setAction(i, { ...a, recipient: e.target.value as typeof a.recipient })}
                    options={NOTIFY_RECIPIENTS.filter((r) => r !== 'assignee' || taskTrigger).map((r) => ({ value: r, label: RECIPIENT_LABELS[r] }))}
                  />
                  <SelectField
                    label="Email template"
                    value={a.templateKey}
                    onChange={(e) => setAction(i, { ...a, templateKey: e.target.value })}
                    options={templateOptions.some((o) => o.value === a.templateKey) ? templateOptions : [{ value: a.templateKey, label: a.templateKey }, ...templateOptions]}
                  />
                </div>
              ) : a.type === 'create_task' ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextField label="Task" value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} />
                  <SelectField
                    label="Assign to"
                    value={a.assignTo}
                    onChange={(e) => setAction(i, { ...a, assignTo: e.target.value as typeof a.assignTo })}
                    options={[
                      { value: 'lead', label: 'Lead lawyer' },
                      { value: 'owners', label: 'A partner' },
                      ...(taskTrigger ? [{ value: 'assignee', label: 'Task assignee' }] : []),
                    ]}
                  />
                  <TextField label="Due in (days)" type="number" min={0} max={365} value={a.dueInDays ?? ''} onChange={(e) => setAction(i, { ...a, dueInDays: e.target.value === '' ? null : Number(e.target.value) })} />
                  <SelectField label="Priority" value={a.priority ?? 'normal'} onChange={(e) => setAction(i, { ...a, priority: e.target.value as (typeof PRIORITIES)[number] })} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
                </div>
              ) : a.type === 'update_task' ? (
                <SelectField label="Set priority" value={a.priority ?? 'high'} onChange={(e) => setAction(i, { ...a, priority: e.target.value as (typeof PRIORITIES)[number] })} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
              ) : a.type === 'add_timeline' ? (
                <TextField label="Note" value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} />
              ) : (
                <TextField label="Tag" value={a.tag} onChange={(e) => setAction(i, { ...a, tag: e.target.value })} />
              )}
            </div>
          ))}
          {d.actions.length < 10 ? (
            <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => set('actions', [...d.actions, newAction('notify')])}>
              Add action
            </Button>
          ) : null}
        </fieldset>

        {emailsClient ? (
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={d.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} />
            <span>
              <span className="font-medium">Ask a lawyer before emailing the client</span>
              <span className="block text-muted">Client emails wait under “Needs approval” until someone approves them.</span>
            </span>
          </label>
        ) : null}
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-4" checked={d.isActive} onChange={(e) => set('isActive', e.target.checked)} />
          <span className="font-medium">On</span>
        </label>
      </form>
    </Sheet>
  );
}
