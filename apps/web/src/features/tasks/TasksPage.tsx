import { seesAllMatters, type TaskDto } from '@legalops/types';
import { Alert, Button, Card, EmptyState, PageHeader, Pagination, SkeletonList, Tabs } from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { todayIn } from '../../lib/format.js';
import { TaskFormSheet } from './TaskFormSheet.js';
import { TaskRow } from './TaskRow.js';

const VIEWS = [
  { key: 'mine', label: 'My tasks' },
  { key: 'team', label: 'Team' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'completed', label: 'Completed' },
] as const;
type View = (typeof VIEWS)[number]['key'];

const EMPTY: Record<View, string> = {
  mine: 'Nothing assigned to you. Enjoy the quiet.',
  team: 'No open tasks on your matters.',
  overdue: 'No overdue tasks.',
  completed: 'Completed tasks will appear here.',
};

export function TasksPage() {
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'mine') as View;
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(params.get('new') === '1');
  // Quick add can target the page you're already on: react to ?new=1, not just the first render.
  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
  }, [params]);
  const today = todayIn(me.organization.timezone);

  const tasks = useQuery({
    queryKey: ['tasks', { view, page }],
    queryFn: () => api.getPage<TaskDto>(`/tasks${qs({ view, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          view === 'team' && !seesAllMatters(me.role)
            ? 'Open tasks on matters you’re assigned to.'
            : undefined
        }
        actions={
          canAct(me, 'tasks.manage') ? (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New task
            </Button>
          ) : null
        }
      />
      <div className="mb-4">
        <Tabs
          label="Task views"
          items={VIEWS}
          value={view}
          onChange={(k) => {
            setPage(1);
            setParams({ view: k }, { replace: true });
          }}
        />
      </div>
      {tasks.isPending ? (
        <SkeletonList rows={5} />
      ) : tasks.isError ? (
        <Alert tone="danger">Couldn’t load tasks.</Alert>
      ) : tasks.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<CheckCircle2 />} title={EMPTY[view]} />
        </Card>
      ) : (
        <>
          <Card className="divide-y divide-line">
            {tasks.data.items.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                today={today}
                canComplete={canAct(me, 'tasks.manage') || t.assignee?.userId === me.user.id}
              />
            ))}
          </Card>
          <Pagination
            page={page}
            pageSize={tasks.data.meta.pageSize}
            total={tasks.data.meta.total}
            onPage={setPage}
          />
        </>
      )}
      <TaskFormSheet
        open={creating}
        onClose={() => {
          setCreating(false);
          if (params.has('new')) setParams({ view }, { replace: true });
        }}
      />
    </>
  );
}
