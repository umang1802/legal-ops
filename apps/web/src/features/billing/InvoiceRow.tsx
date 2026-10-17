import { INVOICE_DISPLAY_LABELS, type InvoiceListItemDto } from '@legalops/types';
import { Badge } from '@legalops/ui';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { formatDate } from '../../lib/format.js';
import { formatINR } from '../../lib/money.js';
import { INVOICE_TONE } from '../../lib/status.js';

/** Invoice line: number, client/matter, status; amount due on the right (PRD Screen 16 fields). */
export function InvoiceRow({
  invoice: i,
  showClient = true,
}: {
  invoice: InvoiceListItemDto;
  showClient?: boolean;
}) {
  const open = i.displayStatus === 'unpaid' || i.displayStatus === 'partial' || i.displayStatus === 'overdue';
  return (
    <Link to={`/invoices/${i.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold">{i.invoiceNumber ?? 'Draft'}</p>
          <Badge tone={INVOICE_TONE[i.displayStatus]}>
            {i.displayStatus === 'overdue'
              ? `Overdue ${i.daysOverdue}d`
              : INVOICE_DISPLAY_LABELS[i.displayStatus]}
          </Badge>
        </div>
        <p className="truncate text-sm text-ink-soft">
          {showClient ? `${i.client.name} · ${i.matter.title}` : i.matter.title}
        </p>
        <p className="truncate text-xs text-muted">
          {i.issueDate ? `Issued ${formatDate(i.issueDate)}` : 'Not issued'}
          {i.dueDate ? ` · due ${formatDate(i.dueDate)}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">{formatINR(open ? i.amountDue : i.total)}</p>
        <p className="text-xs text-muted">
          {open ? `of ${formatINR(i.total)}` : i.displayStatus === 'paid' ? 'paid' : 'total'}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
    </Link>
  );
}
