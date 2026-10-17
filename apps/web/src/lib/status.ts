import type {
  CaseStatus,
  HearingDto,
  InvoiceDisplayStatus,
  MatterStatus,
  Priority,
  TaskStatus,
} from '@legalops/types';
import type { Tone } from '@legalops/ui';

// Design rule: red only for genuine attention, green only for done.
export const MATTER_STATUS_TONE: Record<MatterStatus, Tone> = {
  lead: 'info',
  active: 'neutral',
  on_hold: 'warning',
  closed: 'success',
  archived: 'neutral',
};

export const CASE_STATUS_TONE: Record<CaseStatus, Tone> = {
  pending_filing: 'warning',
  active: 'neutral',
  reserved: 'info',
  disposed: 'success',
  withdrawn: 'neutral',
  transferred: 'neutral',
  closed: 'success',
};

export const PRIORITY_TONE: Record<Priority, Tone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function hearingTone(h: Pick<HearingDto, 'status' | 'pendingOutcome'>): Tone {
  if (h.pendingOutcome) return 'warning';
  return {
    scheduled: 'info',
    completed: 'success',
    adjourned: 'neutral',
    cancelled: 'neutral',
    unknown: 'neutral',
  }[h.status] as Tone;
}

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  todo: 'neutral',
  in_progress: 'info',
  blocked: 'warning',
  done: 'success',
  cancelled: 'neutral',
};

export const INVOICE_TONE: Record<InvoiceDisplayStatus, Tone> = {
  draft: 'neutral',
  unpaid: 'info',
  partial: 'warning',
  paid: 'success',
  overdue: 'danger',
  void: 'neutral',
  written_off: 'neutral',
};
