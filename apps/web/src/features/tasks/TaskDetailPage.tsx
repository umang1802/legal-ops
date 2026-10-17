import { can, PRIORITY_LABELS, TASK_STATUS_LABELS, type TaskCommentDto, type TaskDto } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  SelectField,
  SkeletonList,
  TextAreaField,
} from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDateTime, fullName, relativeDay, relativeTime, todayIn } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { invalidateWork } from '../../lib/invalidate.js';
import { PRIORITY_TONE, TASK_STATUS_TONE } from '../../lib/status.js';
import { NotFound } from '../common/NotFound.js';
import { TaskFormSheet } from './TaskFormSheet.js';

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const me = useSession();
  const qc = useQueryClient();
  const members = useMembers();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const today = todayIn(me.organization.timezone);

  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api.get<TaskDto>(`/tasks/${taskId}`) });
  const comments = useQuery({
    queryKey: ['task', taskId, 'comments'],
    queryFn: () => api.get<TaskCommentDto[]>(`/tasks/${taskId}/comments`),
  });
  const onDone = () => invalidateWork(qc);
  const complete = useMutation({
    mutationFn: () => api.post<TaskDto>(`/tasks/${taskId}/complete`),
    onSuccess: onDone,
  });
  const start = useMutation({
    mutationFn: () => api.patch<TaskDto>(`/tasks/${taskId}`, { status: 'in_progress' }),
    onSuccess: onDone,
  });
  const reassign = useMutation({
    mutationFn: (assigneeId: string | null) => api.post<TaskDto>(`/tasks/${taskId}/reassign`, { assigneeId }),
    onSuccess: onDone,
  });
  const addComment = useMutation({
    mutationFn: () => api.post<TaskCommentDto[]>(`/tasks/${taskId}/comments`, { body: comment }),
    onSuccess: (list) => {
      qc.setQueryData(['task', taskId, 'comments'], list);
      setComment('');
    },
  });

  if (task.isPending) return <SkeletonList rows={4} />;
  if (task.isError) {
    return task.error instanceof ApiError && task.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this task.</Alert>
    );
  }
  const t = task.data;
  const manager = can(me.role, 'tasks.manage');
  const canChange = manager || t.assignee?.userId === me.user.id;
  const open = t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked';
  const error = complete.error ?? start.error ?? reassign.error;

  return (
    <div className="space-y-4">
      <div>
        <Link to="/tasks" className="text-sm text-muted hover:text-ink">
          ← Tasks
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight break-words sm:text-2xl">{t.title}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
          {t.priority !== 'normal' ? (
            <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABELS[t.priority]} priority</Badge>
          ) : null}
          {t.overdue ? <Badge tone="danger">Overdue</Badge> : null}
        </div>
      </div>

      {error ? (
        <Alert tone="danger">{error instanceof ApiError ? error.message : 'Update failed.'}</Alert>
      ) : null}
      {open && canChange ? (
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Check className="size-4" />}
            loading={complete.isPending}
            onClick={() => complete.mutate()}
          >
            Mark done
          </Button>
          {t.status === 'todo' ? (
            <Button
              variant="secondary"
              icon={<Play className="size-4" />}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              Start
            </Button>
          ) : null}
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
            Edit / change due date
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Activity" />
          <CardBody className="space-y-4">
            {t.description ? <p className="text-sm whitespace-pre-wrap">{t.description}</p> : null}
            <ul className="space-y-3">
              {(comments.data ?? []).map((c) => (
                <li key={c.id} className="rounded-lg bg-subtle px-3 py-2 text-sm">
                  <p className="whitespace-pre-wrap">{c.body}</p>
                  <p className="mt-1 text-xs text-muted">
                    {fullName(c.author)} ·{' '}
                    <time title={formatDateTime(c.createdAt, me.organization.timezone)}>
                      {relativeTime(c.createdAt)}
                    </time>
                  </p>
                </li>
              ))}
              {comments.data && comments.data.length === 0 && !t.description ? (
                <li className="text-sm text-muted">No notes yet.</li>
              ) : null}
            </ul>
            {me.role !== 'read_only' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) addComment.mutate();
                }}
                className="space-y-2"
              >
                <TextAreaField
                  label="Add a note"
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!comment.trim()}
                  loading={addComment.isPending}
                >
                  Post note
                </Button>
              </form>
            ) : null}
          </CardBody>
        </Card>
        <Card className="h-fit">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <Row label="Due">{t.dueDate ? relativeDay(t.dueDate, today) : 'No due date'}</Row>
              <Row label="Assigned to">
                {manager && open ? (
                  <SelectField
                    label="Assigned to"
                    className="h-10"
                    value={t.assignee?.userId ?? ''}
                    disabled={reassign.isPending}
                    onChange={(e) => reassign.mutate(e.target.value || null)}
                    options={[
                      { value: '', label: 'Unassigned' },
                      ...(members.data ?? [])
                        .filter((m) => m.status === 'active')
                        .map((m) => ({ value: m.userId, label: fullName(m) })),
                    ]}
                  />
                ) : (
                  fullName(t.assignee)
                )}
              </Row>
              {t.matter ? (
                <Row label="Matter">
                  <Link to={`/matters/${t.matter.id}`} className="text-brand-700 hover:underline">
                    {t.matter.title}
                  </Link>
                </Row>
              ) : null}
              {t.hearingId ? (
                <Row label="From hearing">
                  <Link to={`/hearings/${t.hearingId}`} className="text-brand-700 hover:underline">
                    View hearing
                  </Link>
                </Row>
              ) : null}
              <Row label="Created">
                {fullName(t.createdBy)}
                {t.sourceEventId ? ' (from hearing outcome)' : ''} · {relativeTime(t.createdAt)}
              </Row>
              {t.completedAt ? (
                <Row label="Completed">
                  {fullName(t.completedBy)} · {relativeTime(t.completedAt)}
                </Row>
              ) : null}
            </dl>
          </CardBody>
        </Card>
      </div>
      {canChange ? <TaskFormSheet open={editing} onClose={() => setEditing(false)} existing={t} /> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words [&_label]:sr-only">{children}</dd>
    </div>
  );
}
