import { ACTION_LABELS, RECIPIENT_LABELS, TRIGGER_ANCHORS, type WorkflowAction, type WorkflowDto, type WorkflowTiming, type WorkflowTrigger } from '@legalops/types';
import { formatTime } from '../../lib/format.js';

/** "1 day before the hearing date, at 9:00 am" — plain words for the timing rule. */
export function describeTiming(trigger: WorkflowTrigger, t: WorkflowTiming): string {
  if (t.timing === 'immediate') return 'Straight away';
  const anchor = TRIGGER_ANCHORS[trigger]?.label ?? 'the date';
  const n = Math.abs(t.offsetDays);
  const when = t.offsetDays === 0 ? `On ${anchor}` : `${n} day${n === 1 ? '' : 's'} ${t.offsetDays < 0 ? 'before' : 'after'} ${anchor}`;
  return `${when}, at ${formatTime(t.at)}`;
}

export function describeAction(a: WorkflowAction, templateName?: (key: string) => string): string {
  switch (a.type) {
    case 'notify':
      return `Email ${RECIPIENT_LABELS[a.recipient].toLowerCase()}: ${templateName?.(a.templateKey) ?? a.templateKey}`;
    case 'create_task':
      return `Create task “${a.title}”`;
    case 'add_tag':
      return `Tag the matter “${a.tag}”`;
    case 'add_timeline':
      return `Note on timeline: ${a.title}`;
    case 'update_task':
      return ACTION_LABELS.update_task;
  }
}

export const emailsClient = (w: Pick<WorkflowDto, 'actions'>) => w.actions.some((a) => a.type === 'notify' && a.recipient === 'client');
