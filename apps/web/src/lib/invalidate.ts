import type { QueryClient } from '@tanstack/react-query';

/** Hearings and tasks feed the dashboard, calendar, matter pages and timelines: refresh them together. */
export function invalidateWork(qc: QueryClient): void {
  for (const key of ['dashboard', 'hearings', 'hearing', 'tasks', 'task', 'matter', 'matters', 'case']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}
