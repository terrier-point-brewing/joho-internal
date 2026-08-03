"use client";
/** Shared 50/page pager footer for the Transactions ledgers. Renders nothing when totalPages <= 1. */
export default function Pagination({
  page, totalPages, total, unit = "rows", onPageChange,
}: {
  page: number; totalPages: number; total: number; unit?: string;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="shrink-0 border-t border-line mx-4 sm:mx-6 py-3 flex items-center justify-between">
      <span className="text-xs text-faint">Page {page} of {totalPages} · {total} {unit}</span>
      <div className="flex gap-2">
        <button onClick={() => onPageChange(page - 1)} disabled={page === 1} className="btn-secondary">← Prev</button>
        <button onClick={() => onPageChange(page + 1)} disabled={page === totalPages} className="btn-secondary">Next →</button>
      </div>
    </div>
  );
}
