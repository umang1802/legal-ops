import { PRIORITY_LABELS, TASK_STATUS_LABELS, type TaskDto } from '@legalops/types';
import { Badge, cn } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../../lib/api.js';
import { fullName, relativeDay } from '../../lib/format.js';
import { invalidateWork } from '../../lib/invalidate.js';
import { PRIORITY_TONE, TASK_STATUS_TONE } from '../../lib/status.js';

/** Task line with a one-tap complete control (PRD Screen 11 "quick complete"). */
export function TaskRow({
  task: t,
  today,
  canComplete,
}: {
  task: TaskDto;
  today: string;
  canComplete: boolean;
}) {
  const qc = useQueryClient();
  const complete = useMutation({
    mutationFn: () => api.post<TaskDto>(`/tasks/${t.id}/complete`),
    onSuccess: () => invalidateWork(qc),
  });
  const open = t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked';
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
      {open && canComplete ? (
        <button
          type="button"
          onClick={() => complete.mutate()}
          disabled={complete.isPending}
          aria-label={`Mark “${t.title}” done`}
          className="grid size-11 shrink-0 place-items-center rounded-full"
        >
          <span
            className={cn(
              'grid size-6 place-items-center rounded-full border-2 transition-colors',
              complete.isPending
                ? 'border-success-800 bg-success-50'
                : 'border-line hover:border-success-800',
            )}
          >
            {complete.isPending ? <Check className="size-3.5 text-success-800" /> : null}
          </span>
        </button>
      ) : (
        <span className="grid size-11 shrink-0 place-items-center" aria-hidden>
          <span
            className={cn(
              'grid size-6 place-items-center rounded-full',
              t.status === 'done' ? 'bg-success-800 text-white' : 'border-2 border-line',
            )}
          >
            {t.status === 'done' ? <Check className="size-3.5" /> : null}
          </span>
        </span>
      )}
      <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 space-y-0.5">
        <p className={cn('truncate text-sm font-medium', t.status === 'done' && 'text-muted line-through')}>
          {t.title}
        </p>
        <p className="truncate text-xs text-muted">
          {[t.matter?.title, t.assignee ? fullName(t.assignee) : 'Unassigned'].filter(Boolean).join(' · ')}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {t.dueDate ? (
            <Badge tone={t.overdue ? 'danger' : t.dueDate === today ? 'warning' : 'neutral'}>
              {dueLabel(t.dueDate, today, t.overdue)}
            </Badge>
          ) : null}
          {t.priority === 'high' || t.priority === 'urgent' ? (
            <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
          ) : null}
          {t.status === 'in_progress' || t.status === 'blocked' || t.status === 'cancelled' ? (
            <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
          ) : null}
        </div>
      </Link>
      {complete.error ? <span className="text-xs text-danger-700">Failed</span> : null}
    </div>
  );
}

/** "Due today", "Due tomorrow", "Due Mon 12 Oct", "Overdue · since Thu 1 Oct". */
function dueLabel(dueDate: string, today: string, overdue: boolean): string {
  const rel = relativeDay(dueDate, today, { short: true });
  const lower = rel === 'Today' || rel === 'Tomorrow' || rel === 'Yesterday' ? rel.toLowerCase() : rel;
  return overdue ? `Overdue · ${dueDate === today ? 'today' : `since ${lower}`}` : `Due ${lower}`;
}
