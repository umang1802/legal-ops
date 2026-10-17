-- Phase 3: hearing cancellation + indexes for calendar, dashboard and task views.

ALTER TABLE hearings
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by UUID REFERENCES users(id),
  ADD COLUMN cancel_reason TEXT,
  ADD COLUMN next_hearing_id UUID;

ALTER TABLE hearings
  ADD CONSTRAINT hearings_cancel_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT hearings_next_hearing_fk FOREIGN KEY (organization_id, next_hearing_id) REFERENCES hearings(organization_id, id);

-- Calendar range scans and "pending outcome" (past + still scheduled).
CREATE INDEX idx_hearings_org_status_date ON hearings (organization_id, status, scheduled_date);
-- A hearing can be the "previous" of at most one follow-up (complete is not replayable).
CREATE UNIQUE INDEX uq_hearings_previous ON hearings (previous_hearing_id) WHERE previous_hearing_id IS NOT NULL;

-- Task views: my open tasks by due date, overdue sweep, completed history.
CREATE INDEX idx_tasks_org_open_due ON tasks (organization_id, due_at) WHERE status IN ('todo', 'in_progress', 'blocked');
CREATE INDEX idx_tasks_org_completed ON tasks (organization_id, completed_at DESC) WHERE status = 'done';
CREATE INDEX idx_tasks_org_hearing ON tasks (organization_id, hearing_id) WHERE hearing_id IS NOT NULL;
CREATE INDEX idx_task_comments_org ON task_comments (organization_id, task_id);
