import { Button } from './Button.js';

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav className="flex items-center justify-between gap-3 pt-4" aria-label="Pagination">
      <p className="text-sm text-muted">
        {from}–{to} of {total}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={to >= total} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}
