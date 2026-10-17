import { zodResolver } from '@hookform/resolvers/zod';
import { PRIORITIES, PRIORITY_LABELS, type TaskDto } from '@legalops/types';
import { Alert, Button, SelectField, Sheet, TextAreaField, TextField, type ComboOption } from '@legalops/ui';
import { createTaskSchema, updateTaskSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, applyFieldErrors } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { fullName } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { MatterPicker } from '../matters/pickers.js';
import { invalidateWork } from '../../lib/invalidate.js';

const formSchema = z.object({
  title: z.string().trim().min(1, { error: 'Describe the task' }).max(255),
  description: z.string(),
  priority: z.enum(PRIORITIES),
  dueDate: z.string(),
  dueTime: z.string(),
  assigneeId: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

export function TaskFormSheet({
  open,
  onClose,
  existing,
  fixedMatter,
  hearingId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  existing?: TaskDto;
  fixedMatter?: ComboOption;
  hearingId?: string;
  onSaved?: (t: TaskDto) => void;
}) {
  const me = useSession();
  const qc = useQueryClient();
  const members = useMembers();
  const [matter, setMatter] = useState<ComboOption | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  useEffect(() => {
    if (!open) return;
    form.reset({
      title: existing?.title ?? '',
      description: existing?.description ?? '',
      priority: existing?.priority ?? 'normal',
      dueDate: existing?.dueDate ?? '',
      dueTime: '',
      assigneeId: existing ? (existing.assignee?.userId ?? '') : me.user.id,
    });
    setMatter(fixedMatter ?? null);
  }, [open, existing, fixedMatter, me.user.id, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      existing
        ? api.patch<TaskDto>(
            `/tasks/${existing.id}`,
            updateTaskSchema.parse({
              title: v.title,
              description: v.description,
              priority: v.priority,
              dueDate: v.dueDate || null,
              dueTime: v.dueTime || null,
            }),
          )
        : api.post<TaskDto>(
            '/tasks',
            createTaskSchema.parse({
              title: v.title,
              description: v.description,
              priority: v.priority,
              dueDate: v.dueDate || null,
              dueTime: v.dueTime || null,
              assigneeId: v.assigneeId || null,
              matterId: matter?.value ?? null,
              hearingId: hearingId ?? null,
            }),
          ),
    onSuccess: (t) => {
      invalidateWork(qc);
      onSaved?.(t);
      onClose();
    },
    onError: (err) => {
      if (err instanceof z.ZodError) {
        for (const i of err.issues)
          form.setError(i.path.join('.') as keyof FormValues, { message: i.message });
      } else applyFieldErrors(err, form.setError);
    },
  });
  const { errors } = form.formState;

  // The members list loads after the form resets; re-apply the default assignee once options exist.
  const { setValue } = form;
  useEffect(() => {
    if (open && members.data && !existing) setValue('assigneeId', me.user.id);
  }, [open, members.data, existing, me.user.id, setValue]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? 'Edit task' : 'New task'}
      footer={
        <Button block type="submit" form="task-form" loading={save.isPending}>
          {existing ? 'Save changes' : 'Create task'}
        </Button>
      }
    >
      <form
        id="task-form"
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="space-y-4"
        noValidate
      >
        {save.error instanceof ApiError && save.error.details.length === 0 ? (
          <Alert tone="danger">{save.error.message}</Alert>
        ) : null}
        <TextField
          label="Task"
          placeholder="e.g. File rejoinder"
          error={errors.title?.message}
          {...form.register('title')}
        />
        {!existing ? (
          fixedMatter ? (
            <div className="rounded-lg bg-subtle px-3 py-2 text-sm">
              <span className="text-muted">Matter: </span>
              <span className="font-medium">{fixedMatter.label}</span>
            </div>
          ) : (
            <MatterPicker value={matter} onChange={setMatter} />
          )
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!existing ? (
            <SelectField
              label="Assign to"
              options={[
                { value: '', label: 'Unassigned' },
                ...(members.data ?? [])
                  .filter((m) => m.status === 'active')
                  .map((m) => ({
                    value: m.userId,
                    label: `${fullName(m)}${m.userId === me.user.id ? ' (me)' : ''}`,
                  })),
              ]}
              {...form.register('assigneeId')}
            />
          ) : null}
          <SelectField
            label="Priority"
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
            {...form.register('priority')}
          />
          <TextField
            label="Due date"
            type="date"
            error={errors.dueDate?.message}
            {...form.register('dueDate')}
          />
          <TextField
            label="Due time"
            type="time"
            hint="Optional"
            error={errors.dueTime?.message}
            {...form.register('dueTime')}
          />
        </div>
        <TextAreaField label="Details" {...form.register('description')} />
      </form>
    </Sheet>
  );
}
